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

async function postLovableWebhook(payload) {
    const url = process.env.LOVABLE_EVENTS_URL
    if (!url) return

    try {
        const headers = {
            "Content-Type": "application/json"
        }

        if (process.env.LOVABLE_WEBHOOK_SECRET) {
            headers["x-webhook-secret"] = process.env.LOVABLE_WEBHOOK_SECRET
        }

        await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
        })
    } catch (error) {
        console.log("⚠️ LOVABLE webhook falhou:", error?.message || error)
    }
}

async function resolveJid(sock, jid) {
    if (!jid) return null
    if (jid.endsWith("@lid")) {
        try {
            const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid)
            if (pn) return pn.split("@")[0].split(":")[0]
        } catch (e) {
            console.error("lid resolve fail", e)
        }
        return jid.split("@")[0]
    }
    return jid.split("@")[0].split(":")[0]
}

function withLovableConnectionPayload(payload, sessionId, sock) {
    const pn = sock.user?.id?.split("@")[0]?.split(":")[0]
    return {
        ...payload,
        session: sessionId,
        sessionId,
        phone_number: pn,
        me: pn,
        sockUserId: sock.user?.id ?? null
    }
}

function withLovableMessagePayload(payload, sessionId, sock, instancePn, from, to) {
    return {
        ...payload,
        session: sessionId,
        sessionId,
        from,
        to,
        senderPn: from,
        recipientPn: to,
        fromPn: from,
        toPn: to,
        me: instancePn,
        sockUserId: sock.user?.id ?? null,
        phone_number: instancePn
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
            postLovableWebhook(
                withLovableConnectionPayload(
                    {
                        event: "connection.update",
                        status: "connected"
                    },
                    sessionId,
                    sock
                )
            )
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
                withLovableConnectionPayload(
                    {
                        event: "connection.update",
                        status: loggedOut ? "logged_out" : "disconnected"
                    },
                    sessionId,
                    sock
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

    sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages || []) {
            if (!msg?.message) continue

            const texto =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "[mensagem nao suportada]"

            const instancePn = await resolveJid(sock, sock.user?.id)
            const peerJid =
                msg.key.senderPn ||
                msg.key.participant ||
                msg.key.remoteJid
            const resolvedPeer = await resolveJid(sock, peerJid)
            const resolvedRemote = await resolveJid(sock, msg.key.remoteJid)

            let from
            let to
            let direction

            if (msg.key.fromMe) {
                from = instancePn
                to = resolvedRemote
                direction = "out"
            } else {
                from = resolvedPeer
                to = instancePn
                direction = "in"
            }

            const numeroLog = msg.key.fromMe ? to : from

            if (!msg.key.fromMe) {
                await registerEvent(sessionId, tenantId, "incoming_message", {
                    numero: numeroLog || "",
                    texto
                })
            }

            postLovableWebhook(
                withLovableMessagePayload(
                    {
                        event: "messages.upsert",
                        fromMe: !!msg.key.fromMe,
                        direction,
                        text: texto,
                        messageId: msg.key.id,
                        timestamp: msg.messageTimestamp
                    },
                    sessionId,
                    sock,
                    instancePn,
                    from,
                    to
                )
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

    await sock.sendMessage(`${numero}@s.whatsapp.net`, { text: mensagem })
    await registerEvent(sessionId, tenantId, "message_sent", { numero })
    const instancePn = await resolveJid(sock, sock.user?.id)
    const toResolved = await resolveJid(sock, `${numero}@s.whatsapp.net`)
    const toVal = toResolved || numero
    postLovableWebhook(
        withLovableMessagePayload(
            {
                event: "messages.upsert",
                fromMe: true,
                direction: "out",
                text: mensagem,
                timestamp: Math.floor(Date.now() / 1000)
            },
            sessionId,
            sock,
            instancePn,
            instancePn,
            toVal
        )
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

    console.log(`👷 Worker ${config.WORKER_ID} ouvindo fila ${config.QUEUE_NAME}`)
}

bootstrapWorker().catch((error) => {
    console.error("❌ Falha ao iniciar worker:", error?.message || error)
    process.exit(1)
})
