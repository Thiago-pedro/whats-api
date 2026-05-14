const path = require("path")
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys")
const { Worker } = require("bullmq")
const QRCode = require("qrcode")
const qrcodeTerminal = require("qrcode-terminal")
const config = require("./lib/config")
const { connection } = require("./lib/redis")
const { updateSession, getSession, registerEvent } = require("./lib/sessionStore")
const { initDb } = require("./lib/db")

function jsonSafeStringify(obj) {
    return JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
}

function webhookEventLabel(payload) {
    if (!payload || typeof payload !== "object") return "(sem tipo)"
    return payload.event ?? payload.type ?? "(sem event/type)"
}

async function postLovableWebhook(payload) {
    const urlRaw = process.env.LOVABLE_EVENTS_URL
    if (!urlRaw || typeof urlRaw !== "string") {
        console.error("[WEBHOOK] LOVABLE_EVENTS_URL não definida — evento descartado:", webhookEventLabel(payload))
        return
    }

    const url = urlRaw.trim()
    const eventLabel = webhookEventLabel(payload)
    const bodyStr = jsonSafeStringify(payload)

    try {
        const headers = {
            "Content-Type": "application/json"
        }

        if (process.env.LOVABLE_WEBHOOK_SECRET) {
            headers["x-webhook-secret"] = process.env.LOVABLE_WEBHOOK_SECRET
        }

        const res = await fetch(url, {
            method: "POST",
            headers,
            body: bodyStr
        })

        const text = await res.text()
        const preview = text.length > 200 ? text.slice(0, 200) + "…" : text
        const looksLikeHtml = /^\s*</.test(text) || (res.headers.get("content-type") || "").includes("text/html")

        console.log(
            `[WEBHOOK] ok=${res.ok} status=${res.status} event=${eventLabel} url=${url} body_preview=${JSON.stringify(preview)}`
        )
        if (looksLikeHtml && res.ok) {
            console.error(
                "[WEBHOOK] A resposta parece HTML (SPA), não JSON de API — confira se LOVABLE_EVENTS_URL aponta para o endpoint real (ex.: função serverless / API), não só para o domínio do site."
            )
        }

        if (!res.ok) {
            console.error(
                "[WEBHOOK] resposta HTTP não OK:",
                JSON.stringify({ url, method: "POST", status: res.status, event: eventLabel, body_preview: preview })
            )
        }
    } catch (error) {
        console.error(
            "[WEBHOOK] falha de rede ou exceção:",
            JSON.stringify({
                url,
                event: eventLabel,
                message: error?.message || String(error)
            })
        )
    }
}

function toDigitsPn(jidLike) {
    if (jidLike == null || jidLike === "") return null
    const head = String(jidLike).split("@")[0].split(":")[0]
    const digits = head.replace(/\D/g, "")
    return digits || null
}

async function resolveJidToPn(sock, jid) {
    if (!jid) return null
    const j = String(jid)
    if (j.endsWith("@lid")) {
        try {
            const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid)
            if (pn) return toDigitsPn(pn)
        } catch (e) {
            console.error("lid resolve fail", e)
        }
        return null
    }
    return toDigitsPn(j)
}

function unwrapMessageNode(m, depth = 0) {
    if (!m || typeof m !== "object" || depth > 10) return m
    const inner =
        m.ephemeralMessage?.message ??
        m.viewOnceMessage?.message ??
        m.viewOnceMessageV2?.message ??
        m.viewOnceMessageV2Extension?.message ??
        m.documentWithCaptionMessage?.message ??
        m.deviceSentMessage?.message ??
        m.editedMessage?.message
    if (inner) return unwrapMessageNode(inner, depth + 1)
    return m
}

const WEBHOOK_DENY_MESSAGE_KEYS = new Set([
    "protocolMessage",
    "reactionMessage",
    "senderKeyDistributionMessage",
    "pollUpdateMessage",
    "keepInChatMessage",
    "pinInChatMessage",
    "ephemeralSettingMessage"
])

const WEBHOOK_ALLOW_MESSAGE_KEYS = new Set([
    "conversation",
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "documentWithCaptionMessage",
    "stickerMessage",
    "contactMessage",
    "contactsArrayMessage",
    "locationMessage",
    "liveLocationMessage",
    "buttonsResponseMessage",
    "listResponseMessage",
    "templateButtonReplyMessage",
    "interactiveResponseMessage"
])

function getInnerSubstantiveKeys(inner) {
    if (!inner || typeof inner !== "object") return []
    return Object.keys(inner).filter((k) => k !== "messageContextInfo")
}

function classifyInnerForWebhook(inner) {
    const keys = getInnerSubstantiveKeys(inner)
    if (keys.length === 0) return null
    if (keys.some((k) => WEBHOOK_DENY_MESSAGE_KEYS.has(k))) return null
    const allowedKey = keys.find((k) => WEBHOOK_ALLOW_MESSAGE_KEYS.has(k))
    if (!allowedKey) return null
    return { allowedKey }
}

function shouldForwardUpsertToChatfy(msg) {
    if (msg.messageStubType != null) return false
    if (msg.key?.remoteJid === "status@broadcast") return false
    if (!msg.message || typeof msg.message !== "object") return false
    const inner = unwrapMessageNode(msg.message)
    return classifyInnerForWebhook(inner) != null
}

function extractMessageText(msg) {
    const m = msg?.message
    if (!m || typeof m !== "object") return ""

    const inner = unwrapMessageNode(m)

    return (
        inner.conversation ??
        inner.extendedTextMessage?.text ??
        inner.imageMessage?.caption ??
        inner.videoMessage?.caption ??
        inner.documentMessage?.caption ??
        inner.buttonsResponseMessage?.selectedDisplayText ??
        inner.templateButtonReplyMessage?.selectedDisplayText ??
        inner.listResponseMessage?.title ??
        inner.listResponseMessage?.singleSelectReply?.selectedRowId ??
        inner.interactiveResponseMessage?.body?.text ??
        inner.contactMessage?.displayName ??
        inner.contactsArrayMessage?.contacts?.[0]?.displayName ??
        ""
    )
}

function buildConnectionWebhookPayload(sessionId, sock, status) {
    const userId = sock.user?.id
    return {
        sessionId,
        type: "connection",
        status,
        phone_number: userId?.split("@")[0]?.split(":")[0],
        me: userId,
        sockUserId: userId
    }
}

function buildMessageWebhookPayload(sessionId, sock, params) {
    const userId = sock.user?.id
    const {
        direction,
        fromDigits,
        toDigits,
        text,
        message_id,
        timestamp,
        message_type
    } = params
    return {
        sessionId,
        type: "message",
        direction,
        from: fromDigits,
        to: toDigits,
        senderPn: fromDigits,
        recipientPn: toDigits,
        fromPn: fromDigits,
        toPn: toDigits,
        me: userId,
        phone_number: userId?.split("@")[0]?.split(":")[0],
        sockUserId: userId,
        text,
        message_id,
        timestamp,
        message_type: message_type ?? null
    }
}

const sockets = new Map()

async function startSession(sessionId, tenantId) {
    const authPath = path.join(config.AUTH_BASE_PATH, sessionId)
    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        auth: state,
        version,
        browser: ["Windows", "Chrome", "10.0"]
    })

    sockets.set(sessionId, sock)

    await updateSession(sessionId, {
        status: "starting",
        starting: true,
        connected: false,
        workerId: config.WORKER_ID,
        lastError: null
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
        const { connection: status, qr, lastDisconnect } = update

        if (qr) {
            const qrCode = await QRCode.toDataURL(qr)
            await updateSession(sessionId, {
                status: "qr_ready",
                starting: false,
                connected: false,
                qrCode,
                qrUpdatedAt: new Date().toISOString(),
                lastError: null
            })
            await registerEvent(sessionId, tenantId, "qr_updated")
            console.log(`📲 QR da sessao ${sessionId}`)
            qrcodeTerminal.generate(qr, { small: true })
        }

        if (status === "open") {
            await updateSession(sessionId, {
                status: "connected",
                connected: true,
                starting: false,
                qrCode: null,
                qrUpdatedAt: null,
                lastError: null
            })
            await registerEvent(sessionId, tenantId, "connected")
            postLovableWebhook(buildConnectionWebhookPayload(sessionId, sock, "open"))
            console.log(`✅ Sessao ${sessionId} conectada`)
        }

        if (status === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const loggedOut = statusCode === 401

            await updateSession(sessionId, {
                status: loggedOut ? "logged_out" : "disconnected",
                connected: false,
                starting: !loggedOut,
                qrCode: null,
                qrUpdatedAt: null,
                lastError: lastDisconnect?.error?.message || null
            })

            await registerEvent(sessionId, tenantId, "disconnected", {
                statusCode: statusCode || null,
                loggedOut
            })
            postLovableWebhook(
                buildConnectionWebhookPayload(
                    sessionId,
                    sock,
                    loggedOut ? "logged_out" : "disconnected"
                )
            )

            if (loggedOut) {
                sockets.delete(sessionId)
                console.log(`🚫 Sessao ${sessionId} deslogada`)
                return
            }

            setTimeout(() => {
                startSession(sessionId, tenantId).catch((error) => {
                    console.error(`❌ Falha reconexao ${sessionId}:`, error?.message || error)
                })
            }, 2000)
        }
    })

    sock.ev.on("messages.update", async (updates) => {
        const userId = sock.user?.id
        for (const u of updates || []) {
            if (!u?.key) continue
            const st = u.update?.status
            if (st == null) continue

            postLovableWebhook({
                sessionId,
                type: "message.status",
                me: userId,
                sockUserId: userId,
                phone_number: userId?.split("@")[0]?.split(":")[0],
                message_id: u.key.id,
                remoteJid: u.key.remoteJid,
                fromMe: !!u.key.fromMe,
                status: st,
                timestamp: u.update?.messageTimestamp
            })
        }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages || []) {
            if (!msg?.message) continue
            if (!shouldForwardUpsertToChatfy(msg)) continue

            const texto = extractMessageText(msg)
            const inner = unwrapMessageNode(msg.message)
            const classified = classifyInnerForWebhook(inner)
            const messageType = classified?.allowedKey ?? null

            const instanceDigits = await resolveJidToPn(sock, sock.user?.id)
            const isGroup = msg.key.remoteJid?.endsWith("@g.us")

            let peerDigits
            if (isGroup) {
                peerDigits =
                    (await resolveJidToPn(sock, msg.key.senderPn)) ||
                    (await resolveJidToPn(sock, msg.key.participant))
            } else {
                peerDigits =
                    (await resolveJidToPn(sock, msg.key.senderPn)) ||
                    (await resolveJidToPn(sock, msg.key.participant)) ||
                    (await resolveJidToPn(sock, msg.key.remoteJid))
            }

            const remoteChatDigits = await resolveJidToPn(sock, msg.key.remoteJid)

            let fromDigits
            let toDigits
            let direction

            if (msg.key.fromMe) {
                fromDigits = instanceDigits
                toDigits = isGroup ? remoteChatDigits : peerDigits
                direction = "outbound"
            } else {
                fromDigits = peerDigits
                toDigits = instanceDigits
                direction = "inbound"
            }

            const numeroLog = msg.key.fromMe ? toDigits || "" : fromDigits || ""

            if (!msg.key.fromMe) {
                await registerEvent(sessionId, tenantId, "incoming_message", {
                    numero: numeroLog || "",
                    texto
                })
            }

            postLovableWebhook(
                buildMessageWebhookPayload(sessionId, sock, {
                    direction,
                    fromDigits,
                    toDigits,
                    text: texto,
                    message_id: msg.key.id,
                    timestamp: msg.messageTimestamp,
                    message_type: messageType
                })
            )

            console.log("📩 Nova mensagem", {
                sessionId,
                numero: numeroLog,
                fromMe: !!msg.key.fromMe,
                direction,
                texto
            })
        }
    })
}

async function sendMessage({ sessionId, tenantId, numero, mensagem }) {
    const state = await getSession(sessionId)
    if (!state) {
        throw new Error("sessao nao encontrada")
    }

    if (!state.connected) {
        throw new Error("sessao nao conectada")
    }

    const sock = sockets.get(sessionId)
    if (!sock) {
        throw new Error("sessao conectada em outro worker ou nao inicializada localmente")
    }

    const sent = await sock.sendMessage(`${numero}@s.whatsapp.net`, {
        text: mensagem
    })
    await registerEvent(sessionId, tenantId, "message_sent", { numero })
    const instanceDigits = await resolveJidToPn(sock, sock.user?.id)
    const toDigits =
        (await resolveJidToPn(sock, `${numero}@s.whatsapp.net`)) ||
        toDigitsPn(numero)
    postLovableWebhook(
        buildMessageWebhookPayload(sessionId, sock, {
            direction: "outbound",
            fromDigits: instanceDigits,
            toDigits,
            text: mensagem,
            message_id: sent?.key?.id ?? null,
            timestamp: Math.floor(Date.now() / 1000),
            message_type: "api_text"
        })
    )
}

async function bootstrapWorker() {
    await initDb()

    const worker = new Worker(
        config.QUEUE_NAME,
        async (job) => {
            if (job.name === "start-session") {
                const { sessionId, tenantId } = job.data
                await startSession(sessionId, tenantId)
                return { ok: true }
            }

            if (job.name === "send-message") {
                await sendMessage(job.data)
                return { ok: true }
            }

            throw new Error(`job desconhecido: ${job.name}`)
        },
        {
            connection,
            concurrency: 10
        }
    )

    worker.on("failed", async (job, error) => {
        if (!job) return
        const sessionId = job.data?.sessionId
        if (sessionId) {
            await updateSession(sessionId, {
                status: "error",
                starting: false,
                connected: false,
                lastError: error?.message || "erro desconhecido"
            })
        }
        console.error(`❌ Job falhou (${job?.name}):`, error?.message || error)
    })

    worker.on("completed", (job) => {
        console.log(`✅ Job concluido: ${job.name} (${job.id})`)
    })

    const hookUrl = process.env.LOVABLE_EVENTS_URL
    if (!hookUrl || !String(hookUrl).trim()) {
        console.error(
            "❌ LOVABLE_EVENTS_URL vazia — o worker conecta o Baileys mas NÃO enviará eventos para o Instanzia. Defina a URL completa (ex.: …/api/public/v1/whatsapp-events)."
        )
    } else {
        console.log(`🔗 Webhook destino: ${String(hookUrl).trim()}`)
    }

    console.log(`👷 Worker ${config.WORKER_ID} ouvindo fila ${config.QUEUE_NAME}`)
}

bootstrapWorker().catch((error) => {
    console.error("❌ Falha ao iniciar worker:", error?.message || error)
    process.exit(1)
})
