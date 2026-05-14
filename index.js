const express = require("express")
const cors = require("cors")
const axios = require("axios")
const fs = require("fs")
const path = require("path")
const { URL } = require("url")
require("dotenv").config()
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    extractMessageContent,
    getContentType
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")
const QRCode = require("qrcode")

const app = express()

const PORT = Number(process.env.PORT) || 3000
const API_KEY = process.env.API_KEY
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"
const ALWAYS_REQUIRE_QR =
    typeof process.env.ALWAYS_REQUIRE_QR === "string" &&
    ["1", "true", "yes", "on"].includes(process.env.ALWAYS_REQUIRE_QR.trim().toLowerCase())

const RECONNECT_BACKOFF_BASE_MS = Number(process.env.RECONNECT_BACKOFF_BASE_MS)
const RECONNECT_BACKOFF_MAX_MS = Number(process.env.RECONNECT_BACKOFF_MAX_MS)
const RECONNECT_COOLDOWN_MS = Number(process.env.RECONNECT_COOLDOWN_MS)
const reconnectBackoffBaseMs = Number.isFinite(RECONNECT_BACKOFF_BASE_MS) ? RECONNECT_BACKOFF_BASE_MS : 2000
const reconnectBackoffMaxMs = Number.isFinite(RECONNECT_BACKOFF_MAX_MS) ? RECONNECT_BACKOFF_MAX_MS : 60000
const reconnectCooldownMs = Number.isFinite(RECONNECT_COOLDOWN_MS) ? RECONNECT_COOLDOWN_MS : 3000
const RECONNECT_RESTART_REQUIRED_MS_RAW = Number(process.env.RECONNECT_RESTART_REQUIRED_MS)
const reconnectRestartRequiredMs =
    Number.isFinite(RECONNECT_RESTART_REQUIRED_MS_RAW) && RECONNECT_RESTART_REQUIRED_MS_RAW >= 0
        ? RECONNECT_RESTART_REQUIRED_MS_RAW
        : 1200

/** Só encaminhar webhook de mensagens “notify” (reduz rajada de sync/histórico; pode omitir alguns eventos) */
const WEBHOOK_UPSERT_ONLY_NOTIFY =
    typeof process.env.WEBHOOK_UPSERT_ONLY_NOTIFY === "string" &&
    ["1", "true", "yes", "on"].includes(process.env.WEBHOOK_UPSERT_ONLY_NOTIFY.trim().toLowerCase())

const WEBHOOK_MAX_MSG_AGE_MIN = Number(process.env.WEBHOOK_MAX_MESSAGE_AGE_MINUTES)
const webhookMaxMessageAgeMinutes =
    Number.isFinite(WEBHOOK_MAX_MSG_AGE_MIN) && WEBHOOK_MAX_MSG_AGE_MIN > 0 ? WEBHOOK_MAX_MSG_AGE_MIN : 0

/**
 * Sync completo de histórico no Baileys gera muitos "got history notification" e pode estourar
 * "timed out waiting for message" em VPS/Render com pouca RAM. Para API só precisamos de mensagens novas.
 * Ativar: WHATSAPP_SYNC_HISTORY=1
 */
const WHATSAPP_SYNC_HISTORY =
    typeof process.env.WHATSAPP_SYNC_HISTORY === "string" &&
    ["1", "true", "yes", "on"].includes(process.env.WHATSAPP_SYNC_HISTORY.trim().toLowerCase())

/** Logs por webhook em caso de sucesso (URL + preview). Ruído em produção. Ativar: WEBHOOK_DEBUG=1 */
const WEBHOOK_DEBUG =
    typeof process.env.WEBHOOK_DEBUG === "string" &&
    ["1", "true", "yes", "on"].includes(process.env.WEBHOOK_DEBUG.trim().toLowerCase())

function shouldForwardUpsertToWebhook({ type, messageTimestamp }) {
    if (WEBHOOK_UPSERT_ONLY_NOTIFY && type !== "notify") {
        return false
    }
    if (webhookMaxMessageAgeMinutes <= 0) {
        return true
    }
    if (typeof messageTimestamp !== "number" || !Number.isFinite(messageTimestamp)) {
        return true
    }
    const tsSec = messageTimestamp > 1e12 ? messageTimestamp / 1000 : messageTimestamp
    const ageSec = Date.now() / 1000 - tsSec
    return ageSec <= webhookMaxMessageAgeMinutes * 60
}

const rawAuthRoot = typeof process.env.WHATSAPP_AUTH_ROOT === "string" ? process.env.WHATSAPP_AUTH_ROOT.trim() : ""
/** Produção Render: igual ao Mount Path do Persistent Disk ou env WHATSAPP_AUTH_ROOT */
const AUTH_ROOT = path.resolve(rawAuthRoot || path.join(__dirname, "auth"))

const MEDIA_MAX_BYTES_RAW = Number(process.env.MEDIA_MAX_BYTES)
const mediaMaxBytes =
    Number.isFinite(MEDIA_MAX_BYTES_RAW) && MEDIA_MAX_BYTES_RAW > 0 ? MEDIA_MAX_BYTES_RAW : 25 * 1024 * 1024

const JSON_BODY_LIMIT_RAW = typeof process.env.JSON_BODY_LIMIT === "string" ? process.env.JSON_BODY_LIMIT.trim() : ""
const JSON_BODY_LIMIT = JSON_BODY_LIMIT_RAW || "32mb"

/** Pausa mínima entre envios na mesma sessão (fila). 0 = desliga. Default 5000 ms. */
const SEND_MIN_INTERVAL_MS_RAW = Number(process.env.SEND_MIN_INTERVAL_MS)
const sendMinIntervalMs =
    Number.isFinite(SEND_MIN_INTERVAL_MS_RAW) && SEND_MIN_INTERVAL_MS_RAW >= 0 ? SEND_MIN_INTERVAL_MS_RAW : 5000

function getInstanziaEventsUrl() {
    const fromNew =
        typeof process.env.INSTANZIA_EVENTS_URL === "string" ? process.env.INSTANZIA_EVENTS_URL.trim() : ""
    if (fromNew) return fromNew
    const legacy =
        typeof process.env.LOVABLE_EVENTS_URL === "string" ? process.env.LOVABLE_EVENTS_URL.trim() : ""
    return legacy
}

function getInstanziaWebhookSecret() {
    const fromNew =
        typeof process.env.INSTANZIA_WEBHOOK_SECRET === "string"
            ? process.env.INSTANZIA_WEBHOOK_SECRET.trim()
            : ""
    if (fromNew) return fromNew
    const legacy =
        typeof process.env.LOVABLE_WEBHOOK_SECRET === "string" ? process.env.LOVABLE_WEBHOOK_SECRET.trim() : ""
    return legacy
}

function authStateDir(sessionId) {
    return path.join(AUTH_ROOT, sessionId)
}

app.use(express.json({ limit: JSON_BODY_LIMIT }))
app.use(cors({ origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN }))

if (!API_KEY) {
    console.error("❌ API_KEY não definida no .env")
    process.exit(1)
}

function sendError(res, statusCode, message) {
    return res.status(statusCode).json({
        ok: false,
        error: message
    })
}

function sendSuccess(res, statusCode, data) {
    return res.status(statusCode).json({
        ok: true,
        data
    })
}

function authMiddleware(req, res, next) {
    const apiKey = req.headers["x-api-key"]

    if (!apiKey || apiKey !== API_KEY) {
        return sendError(res, 401, "nao autorizado")
    }

    next()
}

function isValidSessionId(sessionId) {
    return typeof sessionId === "string" && /^[a-zA-Z0-9_-]{3,60}$/.test(sessionId)
}

function normalizePhoneNumber(value) {
    if (typeof value !== "string") return null
    const digitsOnly = value.replace(/\D/g, "")
    if (digitsOnly.length < 10 || digitsOnly.length > 15) return null
    return digitsOnly
}

function getMessagePreviewText(msg) {
    try {
        const extracted = extractMessageContent(msg?.message)
        if (!extracted) return ""
        const type = getContentType(extracted)
        if (!type) return ""
        const part = extracted[type]
        if (type === "conversation" && typeof part === "string") return part
        if (part && typeof part === "object") {
            if (typeof part.text === "string") return part.text
            if (typeof part.caption === "string") return part.caption
        }
        return ""
    } catch {
        return ""
    }
}

/** Tipo Baileys (ex.: audioMessage, imageMessage) — útil no painel para contar mídia quando `text` vem vazio */
function getMessageContentTypeTag(msg) {
    try {
        const extracted = extractMessageContent(msg?.message)
        if (extracted) {
            const t = getContentType(extracted)
            if (typeof t === "string" && t) return t
        }
    } catch {
        /* ignore */
    }
    const raw = msg?.message
    if (!raw || typeof raw !== "object") return null
    const keys = Object.keys(raw).filter((k) => k.endsWith("Message") || k === "conversation")
    return keys[0] ?? null
}

function logLastDisconnect(sessionId, lastDisconnect) {
    if (!lastDisconnect) {
        console.log(`🔌 lastDisconnect [${sessionId}]: (sem detalhes)`)
        return
    }
    const err = lastDisconnect.error
    const statusCode =
        err?.output?.statusCode ??
        err?.statusCode ??
        (typeof err?.code === "number" ? err.code : null)
    let reason = ""
    if (typeof err?.message === "string" && err.message) {
        reason = err.message
    } else if (err && typeof err.toString === "function") {
        reason = err.toString()
    }
    const maxLen = 400
    if (reason.length > maxLen) {
        reason = reason.slice(0, maxLen) + "…"
    }
    const when = lastDisconnect.date
        ? new Date(lastDisconnect.date).toISOString()
        : null
    const name = typeof err?.name === "string" ? err.name : null
    console.log(
        `🔌 lastDisconnect [${sessionId}]`,
        JSON.stringify({
            statusCode: statusCode ?? null,
            name,
            reason: reason || null,
            at: when
        })
    )
}

function webhookEventLabel(payload) {
    if (!payload || typeof payload !== "object") return "(sem tipo)"
    return payload.event ?? payload.type ?? "(sem event/type)"
}

function parseMediaUrlAllowedHosts() {
    const raw = process.env.MEDIA_FETCH_ALLOWED_HOSTS
    if (!raw || typeof raw !== "string") return []
    return raw
        .split(/[,;\s]+/)
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0)
}

function hostnameAllowedForMediaUrl(hostname) {
    const host = String(hostname)
        .toLowerCase()
        .replace(/\.$/, "")
    const list = parseMediaUrlAllowedHosts()
    if (!list.length) return false
    for (const rule of list) {
        if (host === rule) return true
        if (host.endsWith("." + rule)) return true
    }
    return false
}

function decodeDataOrBase64(arquivoBase64) {
    if (typeof arquivoBase64 !== "string" || !arquivoBase64.trim()) {
        return { error: "arquivoBase64 ausente ou invalido" }
    }
    const s = arquivoBase64.trim()
    const m = /^data:([^;]+);base64,(.+)$/is.exec(s)
    if (m) {
        try {
            const buf = Buffer.from(m[2].replace(/\s/g, ""), "base64")
            if (!buf.length) return { error: "base64 vazio (data uri)" }
            return { buffer: buf, mimeHint: m[1].trim().toLowerCase().split(";")[0] }
        } catch {
            return { error: "base64 invalido (data uri)" }
        }
    }
    try {
        const buf = Buffer.from(s.replace(/\s/g, ""), "base64")
        if (buf.length < 8) return { error: "arquivo muito pequeno ou base64 invalido" }
        return { buffer: buf }
    } catch {
        return { error: "base64 invalido" }
    }
}

async function loadMediaBuffer(body) {
    const url = typeof body.url === "string" ? body.url.trim() : ""
    const hasUrl = Boolean(url)
    const hasB64 =
        body.arquivoBase64 != null &&
        typeof body.arquivoBase64 === "string" &&
        body.arquivoBase64.trim().length > 0

    if (hasUrl && hasB64) {
        return { error: "use apenas url ou arquivoBase64, nao os dois" }
    }
    if (!hasUrl && !hasB64) {
        return { error: "informe url ou arquivoBase64" }
    }

    if (hasUrl) {
        if (!/^https:/i.test(url)) {
            return { error: "url de midia deve ser https" }
        }
        let parsed
        try {
            parsed = new URL(url)
        } catch {
            return { error: "url invalida" }
        }
        if (!hostnameAllowedForMediaUrl(parsed.hostname)) {
            return {
                error:
                    "host da url nao permitido. defina MEDIA_FETCH_ALLOWED_HOSTS (ex: cdn.seudominio.com,storage.supabase.co)"
            }
        }
        try {
            const res = await axios.get(url, {
                responseType: "arraybuffer",
                maxContentLength: mediaMaxBytes,
                maxBodyLength: mediaMaxBytes,
                timeout: 45000,
                maxRedirects: 3,
                validateStatus: (st) => st >= 200 && st < 300
            })
            const buffer = Buffer.from(res.data)
            if (buffer.length > mediaMaxBytes) {
                return { error: `arquivo maior que limite (${mediaMaxBytes} bytes)` }
            }
            const ct = String(res.headers["content-type"] || "")
                .split(";")[0]
                .trim()
                .toLowerCase()
            return { buffer, mimeHint: ct || null }
        } catch (e) {
            const msg = e?.response?.status ? `download http ${e.response.status}` : e?.message || "download falhou"
            return { error: msg }
        }
    }

    const dec = decodeDataOrBase64(body.arquivoBase64)
    if (dec.error) return dec
    if (dec.buffer.length > mediaMaxBytes) {
        return { error: `arquivo maior que limite (${mediaMaxBytes} bytes)` }
    }
    return { buffer: dec.buffer, mimeHint: dec.mimeHint || null }
}

function normalizeMimeType(m) {
    if (typeof m !== "string") return ""
    return m.split(";")[0].trim().toLowerCase()
}

const RISKY_MEDIA_MIME = /javascript|html\+|\/html$|x-msdownload|mshta|xbap/i

function mimeAllowedForMediaKind(kind, mime) {
    const m = normalizeMimeType(mime)
    if (!m || RISKY_MEDIA_MIME.test(m)) return false
    if (kind === "image") return /^image\/(jpeg|jpg|png|gif|webp)$/.test(m)
    if (kind === "video") return /^video\/(mp4|quicktime|3gpp|webm)$/.test(m)
    if (kind === "audio") {
        return (
            /^audio\/(mpeg|mp3|mp4|ogg|opus|aac|webm|wav|x-wav|m4a|x-m4a|3gpp)$/.test(m) || m === "audio/ogg"
        )
    }
    if (kind === "document") return m.length > 1 && m.length < 180
    return false
}

function defaultMimeForMediaKind(kind, ptt) {
    if (kind === "image") return "image/jpeg"
    if (kind === "video") return "video/mp4"
    if (kind === "audio") return ptt ? "audio/ogg" : "audio/mpeg"
    if (kind === "document") return "application/pdf"
    return "application/octet-stream"
}

async function postInstanziaWebhook(payload) {
    const url = getInstanziaEventsUrl()
    if (!url) {
        console.error(
            "[WEBHOOK] INSTANZIA_EVENTS_URL (ou LOVABLE_EVENTS_URL legado) nao definida — evento descartado:",
            webhookEventLabel(payload)
        )
        return
    }

    const secret = getInstanziaWebhookSecret()
    const headers = { "Content-Type": "application/json" }
    if (secret) headers["x-webhook-secret"] = secret

    const eventLabel = webhookEventLabel(payload)

    try {
        const res = await axios.post(url, payload, { timeout: 15000, headers, validateStatus: () => true })
        const data = res.data
        const preview =
            typeof data === "string"
                ? data.length > 200
                    ? data.slice(0, 200) + "…"
                    : data
                : JSON.stringify(data).length > 200
                  ? JSON.stringify(data).slice(0, 200) + "…"
                  : JSON.stringify(data)

        const ct = String(res.headers["content-type"] || "")
        const looksLikeHtml = ct.includes("text/html") || (typeof data === "string" && /^\s*</.test(data))

        if (WEBHOOK_DEBUG) {
            console.log(
                `[WEBHOOK] ok=${res.status >= 200 && res.status < 300} status=${res.status} event=${eventLabel} url=${url} body_preview=${preview}`
            )
        }
        if (looksLikeHtml && res.status >= 200 && res.status < 300) {
            console.error(
                "[WEBHOOK] A resposta parece HTML (SPA), nao JSON de API — confira se INSTANZIA_EVENTS_URL aponta para o endpoint correto."
            )
        }
        if (res.status < 200 || res.status >= 300) {
            console.error(
                "[WEBHOOK] resposta HTTP nao OK:",
                JSON.stringify({ url, method: "POST", status: res.status, event: eventLabel, body_preview: preview })
            )
        }
    } catch (error) {
        const status = error.response?.status
        const respData = error.response?.data
        let preview = ""
        try {
            const s = typeof respData === "string" ? respData : JSON.stringify(respData)
            preview = s.length > 200 ? s.slice(0, 200) + "…" : s
        } catch {
            preview = "(sem corpo)"
        }
        console.error(
            "[WEBHOOK] falha:",
            JSON.stringify({
                url,
                event: eventLabel,
                message: error?.message || String(error),
                status: status ?? null,
                body_preview: preview || null
            })
        )
    }
}

/**
 * Eco em formato messages.upsert para o Instanzia contar envios (texto/midia) mesmo se o upsert do Baileys atrasar ou for filtrado.
 * Deduplicar por messageId se o servidor tambem receber o mesmo evento nativo.
 */
async function emitOutboundUpsertForCounters(sessionId, remoteJid, sent, { text, contentType }) {
    const messageId = sent?.key?.id
    if (!messageId) return
    const rawTs = sent?.messageTimestamp
    const ts =
        typeof rawTs === "number" && Number.isFinite(rawTs)
            ? rawTs
            : Math.floor(Date.now() / 1000)
    await postInstanziaWebhook({
        event: "messages.upsert",
        sessionId,
        fromMe: true,
        from: remoteJid,
        text: typeof text === "string" ? text : "",
        contentType: contentType ?? null,
        messageId,
        timestamp: ts,
        upsertType: "notify",
        source: "api_send"
    })
}

app.use(["/start", "/send", "/qr", "/session", "/warmup", "/health", "/events"], authMiddleware)

const sessions = {}
/** Fila por sessão: garante intervalo mínimo entre cada `sendMessage` (disparos em massa). */
/** @type {Map<string, Promise<void>>} */
const spacedSendTailBySession = new Map()
/** @type {Map<string, Array<{ resolve: Function, timer: NodeJS.Timeout }>>} */
const qrWaiters = new Map()
/** @type {Map<string, Set<import('http').ServerResponse>>} */
const sseClients = new Map()

let baileysVersionPromise = null
function getBaileysVersionCached() {
    if (!baileysVersionPromise) {
        baileysVersionPromise = fetchLatestBaileysVersion().then((r) => r.version)
    }
    return baileysVersionPromise
}

function createSessionRecord() {
    return {
        sock: null,
        connected: false,
        starting: true,
        qrCode: null,
        qrUpdatedAt: null,
        connectionState: "connecting",
        startedAt: new Date().toISOString(),
        reconnectAttempt: 0,
        reconnectTimerId: null
    }
}

function clearAuthState(sessionId) {
    const dir = authStateDir(sessionId)
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    } catch (error) {
        console.log("⚠️ Falha ao limpar auth state:", error?.message || error)
    }
}

function closeSocketSafely(sock) {
    if (!sock) return
    try {
        if (typeof sock.ws?.close === "function") {
            sock.ws.close()
        }
        if (typeof sock.end === "function") {
            sock.end()
        }
    } catch (error) {
        console.log("⚠️ Falha ao encerrar socket:", error?.message || error)
    }
}

function resetSession(sessionId) {
    const existing = sessions[sessionId]
    if (!existing) return false
    if (existing.reconnectTimerId) {
        clearTimeout(existing.reconnectTimerId)
        existing.reconnectTimerId = null
    }
    closeSocketSafely(existing.sock)
    spacedSendTailBySession.delete(sessionId)
    delete sessions[sessionId]
    return true
}

/**
 * Fila por sessionId: um envio só começa depois do anterior terminar + pausa mínima (anti-flood).
 * SEND_MIN_INTERVAL_MS=0 desliga a fila.
 */
function enqueueSpacedSend(sessionId, task) {
    if (sendMinIntervalMs <= 0) {
        return Promise.resolve(task())
    }
    const prev = spacedSendTailBySession.get(sessionId) || Promise.resolve()
    const scheduled = prev.then(() => task())
    spacedSendTailBySession.set(
        sessionId,
        scheduled.finally(() => new Promise((r) => setTimeout(r, sendMinIntervalMs))).catch(() => {})
    )
    return scheduled
}

function scheduleReconnect(sessionId, sock, statusCode) {
    if (sessions[sessionId]?.sock !== sock) {
        return
    }
    const rec = sessions[sessionId]
    if (!rec) return

    if (rec.reconnectTimerId) {
        clearTimeout(rec.reconnectTimerId)
        rec.reconnectTimerId = null
    }

    /** 515 = restart required (comum logo após escanear QR; backoff grande deixa o celular "conectando" à toa) */
    const isRestartRequired = statusCode === 515

    let delayMs

    if (isRestartRequired) {
        delayMs = reconnectRestartRequiredMs
        console.log(
            `🔄 Reinício rápido (${delayMs}ms) — código 515 após pareamento/restart WA (não sobe tentativa de backoff)`
        )
    } else {
        rec.reconnectAttempt = (rec.reconnectAttempt || 0) + 1
        const attempt = rec.reconnectAttempt
        const exponential = reconnectBackoffBaseMs * 2 ** Math.min(Math.max(attempt - 1, 0), 12)
        delayMs = Math.min(reconnectBackoffMaxMs, exponential)
        if (reconnectCooldownMs > 0) {
            delayMs = Math.max(delayMs, reconnectCooldownMs)
        }
        console.log(
            `🔄 Reconexão agendada em ${delayMs}ms (tentativa ${attempt}, code ${statusCode ?? "n/a"})`
        )
    }

    rec.starting = true
    rec.connectionState = "connecting"

    rec.reconnectTimerId = setTimeout(() => {
        const s = sessions[sessionId]
        if (!s || s.sock !== sock) {
            return
        }
        s.reconnectTimerId = null
        startSession(sessionId)
    }, delayMs)
}

function isSessionBusy(sessionId) {
    const s = sessions[sessionId]
    if (!s) return false
    if (s.starting) return true
    if (s.sock) return true
    return false
}

function notifyQrWaiters(sessionId, payload) {
    const list = qrWaiters.get(sessionId)
    if (!list?.length) return
    qrWaiters.delete(sessionId)
    for (const { resolve, timer } of list) {
        clearTimeout(timer)
        resolve(payload)
    }
}

function sseBroadcast(sessionId, type, data) {
    const clients = sseClients.get(sessionId)
    if (!clients?.size) return
    const payload = JSON.stringify({ type, data })
    const chunk = `event: ${type}\ndata: ${payload}\n\n`
    for (const res of clients) {
        try {
            res.write(chunk)
        } catch {
            clients.delete(res)
        }
    }
}

async function startSession(sessionId) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(authStateDir(sessionId))
        const version = await getBaileysVersionCached()

        const socketOpts = {
            auth: state,
            version,
            browser: ["Windows", "Chrome", "10.0"],
            getMessage: async () => undefined
        }
        if (!WHATSAPP_SYNC_HISTORY) {
            socketOpts.shouldSyncHistoryMessage = () => false
            socketOpts.syncFullHistory = false
        }
        const sock = makeWASocket(socketOpts)

        if (!sessions[sessionId]) {
            sessions[sessionId] = createSessionRecord()
        }

        const rec = sessions[sessionId]
        rec.sock = sock
        rec.connected = false
        rec.connectionState = "connecting"
        if (!rec.startedAt) {
            rec.startedAt = new Date().toISOString()
        }

        sock.ev.on("creds.update", saveCreds)

        sock.ev.on("messages.upsert", ({ messages, type }) => {
            if (type === "append") return

            for (const msg of messages || []) {
                if (!msg?.key) continue
                if (msg.key.remoteJid === "status@broadcast") continue
                if (!shouldForwardUpsertToWebhook({ type, messageTimestamp: msg.messageTimestamp })) {
                    continue
                }

                const text = getMessagePreviewText(msg)
                const contentType = getMessageContentTypeTag(msg)
                postInstanziaWebhook({
                    event: "messages.upsert",
                    sessionId,
                    fromMe: !!msg.key.fromMe,
                    from: msg.key.remoteJid,
                    text,
                    contentType,
                    timestamp: msg.messageTimestamp,
                    messageId: msg.key.id,
                    upsertType: type
                })
            }
        })

        sock.ev.on("messages.update", (updates) => {
            for (const u of updates || []) {
                if (!u?.key) continue
                postInstanziaWebhook({
                    event: "messages.update",
                    sessionId,
                    fromMe: !!u.key.fromMe,
                    from: u.key.remoteJid,
                    messageId: u.key.id,
                    timestamp: u.update?.messageTimestamp,
                    status: u.update?.status
                })
            }
        })

        sock.ev.on("connection.update", async (update) => {
            const { connection, qr, lastDisconnect } = update

            if (connection !== undefined && sessions[sessionId]) {
                sessions[sessionId].connectionState = connection
            }

            if (connection !== undefined || lastDisconnect !== undefined) {
                const payload = {
                    event: "connection.update",
                    sessionId,
                    connection: connection ?? null,
                    hasQr: !!qr,
                    disconnectStatusCode: lastDisconnect?.error?.output?.statusCode ?? null
                }
                if (connection === "open" && sock.user?.id) {
                    const wid = String(sock.user.id)
                    payload.me = wid
                    payload.phone_number = wid.split("@")[0].split(":")[0]
                }
                postInstanziaWebhook(payload)
            }

            if (qr) {
                if (sessions[sessionId]) {
                    sessions[sessionId].starting = false
                    sessions[sessionId].qrCode = await QRCode.toDataURL(qr)
                    sessions[sessionId].qrUpdatedAt = new Date().toISOString()
                }
                const qrDataUrl = sessions[sessionId]?.qrCode
                postInstanziaWebhook({
                    event: "qr",
                    sessionId,
                    qr: qrDataUrl,
                    updatedAt: sessions[sessionId]?.qrUpdatedAt ?? null
                })
                notifyQrWaiters(sessionId, { kind: "qr" })
                sseBroadcast(sessionId, "qr", { qr: qrDataUrl })
                console.log(`\n📲 QR da sessão ${sessionId}:`)
                qrcode.generate(qr, { small: true })
            }

            if (connection === "open") {
                if (sessions[sessionId]) {
                    if (sessions[sessionId].reconnectTimerId) {
                        clearTimeout(sessions[sessionId].reconnectTimerId)
                        sessions[sessionId].reconnectTimerId = null
                    }
                    sessions[sessionId].reconnectAttempt = 0
                    sessions[sessionId].connected = true
                    sessions[sessionId].starting = false
                    sessions[sessionId].qrCode = null
                    sessions[sessionId].qrUpdatedAt = null
                    sessions[sessionId].connectionState = "open"
                }
                notifyQrWaiters(sessionId, { kind: "connected" })
                sseBroadcast(sessionId, "connected", {})
                console.log(`✅ Sessão ${sessionId} conectada`)
            }

            if (connection === "close") {
                console.log(`❌ Sessão ${sessionId} desconectada`)
                logLastDisconnect(sessionId, lastDisconnect)
                if (sessions[sessionId]) {
                    sessions[sessionId].connected = false
                    sessions[sessionId].qrCode = null
                    sessions[sessionId].qrUpdatedAt = null
                    sessions[sessionId].connectionState = "close"
                }

                const statusCode = lastDisconnect?.error?.output?.statusCode
                sseBroadcast(sessionId, "disconnected", {
                    statusCode: statusCode ?? null
                })

                if (statusCode !== 401) {
                    if (sessions[sessionId]?.sock !== sock) {
                        return
                    }
                    scheduleReconnect(sessionId, sock, statusCode)
                } else {
                    console.log("🚫 Sessão deslogada — removendo credenciais salvas para permitir novo QR")
                    qrWaiters.delete(sessionId)
                    if (sessions[sessionId]?.reconnectTimerId) {
                        clearTimeout(sessions[sessionId].reconnectTimerId)
                        sessions[sessionId].reconnectTimerId = null
                    }
                    clearAuthState(sessionId)
                    spacedSendTailBySession.delete(sessionId)
                    delete sessions[sessionId]
                }
            }
        })
    } catch (error) {
        console.log(`❌ Falha ao iniciar sessão ${sessionId}:`, error?.message || error)
        qrWaiters.delete(sessionId)
        if (sessions[sessionId]?.reconnectTimerId) {
            clearTimeout(sessions[sessionId].reconnectTimerId)
            sessions[sessionId].reconnectTimerId = null
        }
        spacedSendTailBySession.delete(sessionId)
        delete sessions[sessionId]
    }
}

function handleStart(req, res) {
    const sessionId = req.query.session?.toString()
    const forceStart = req.query.force?.toString() === "1"
    const shouldForceRestart = forceStart || ALWAYS_REQUIRE_QR

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida. use 3-60 caracteres: letras, numeros, _ ou -")
    }

    if (shouldForceRestart) {
        if (ALWAYS_REQUIRE_QR && !forceStart) {
            console.log(`🔒 ALWAYS_REQUIRE_QR ativo: forçando novo QR para sessao ${sessionId}`)
        } else {
            console.log(`🔁 Reinicio forcado da sessao ${sessionId}`)
        }
        resetSession(sessionId)
        clearAuthState(sessionId)
    } else if (isSessionBusy(sessionId)) {
        return res.status(200).json({
            ok: true,
            message: "already running",
            session: sessionId
        })
    } else if (sessions[sessionId]) {
        spacedSendTailBySession.delete(sessionId)
        delete sessions[sessionId]
    }

    sessions[sessionId] = createSessionRecord()

    startSession(sessionId)

    if (shouldForceRestart) {
        return res.status(202).json({
            ok: true,
            message: "sessao reiniciada",
            session: sessionId
        })
    }

    return res.status(202).json({
        ok: true,
        message: "sessao iniciada",
        session: sessionId
    })
}

app.get("/start", handleStart)
app.post("/start", handleStart)

app.post("/warmup", (req, res) => {
    const sessionId = req.query.session?.toString()

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida. use 3-60 caracteres: letras, numeros, _ ou -")
    }

    if (isSessionBusy(sessionId)) {
        return res.status(200).json({
            ok: true,
            alreadyRunning: true,
            session: sessionId
        })
    }

    if (sessions[sessionId]) {
        spacedSendTailBySession.delete(sessionId)
        delete sessions[sessionId]
    }

    return res.status(202).json({
        ok: true,
        warming: true,
        session: sessionId
    })
})

app.delete("/session", (req, res) => {
    const sessionId = req.query.session?.toString()

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida")
    }

    qrWaiters.delete(sessionId)
    const removed = resetSession(sessionId)
    if (!removed) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    clearAuthState(sessionId)

    return sendSuccess(res, 200, {
        message: "sessao removida",
        session: sessionId
    })
})

app.post("/send", async (req, res) => {
    const body = req.body || {}
    const { session, numero } = body
    const tipoRaw = body.tipo
    const tipo =
        typeof tipoRaw === "string" && tipoRaw.trim()
            ? tipoRaw.trim().toLowerCase()
            : "text"

    if (!isValidSessionId(session)) {
        return sendError(res, 400, "session invalida")
    }

    const normalizedNumber = normalizePhoneNumber(numero)
    if (!normalizedNumber) {
        return sendError(res, 400, "numero invalido")
    }

    const sessionData = sessions[session]
    const sock = sessionData?.sock

    if (!sessionData) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    if (sessionData.starting || !sock) {
        return sendError(res, 409, "sessao inicializando, aguarde alguns segundos")
    }

    if (!sessionData.connected) {
        return sendError(res, 409, "sessao iniciada, mas ainda nao conectada ao whatsapp")
    }

    const jid = `${normalizedNumber}@s.whatsapp.net`

    const httpThrow = (statusCode, message) => {
        const e = new Error(message)
        e.httpStatus = statusCode
        e.httpError = message
        throw e
    }

    try {
        if (tipo === "text") {
            const { mensagem } = body
            if (typeof mensagem !== "string" || mensagem.trim().length === 0 || mensagem.length > 4000) {
                return sendError(res, 400, "mensagem invalida")
            }
            const trimmed = mensagem.trim()
            const data = await enqueueSpacedSend(session, async () => {
                const rec = sessions[session]
                const s = rec?.sock
                if (!rec || rec.starting || !s) {
                    httpThrow(409, "sessao inicializando, aguarde alguns segundos")
                }
                if (!rec.connected) {
                    httpThrow(409, "sessao iniciada, mas ainda nao conectada ao whatsapp")
                }
                const sent = await s.sendMessage(jid, { text: trimmed })
                await emitOutboundUpsertForCounters(session, jid, sent, {
                    text: trimmed,
                    contentType: "conversation"
                })
                return {
                    status: "enviado",
                    session,
                    numero: normalizedNumber,
                    messageId: sent?.key?.id ?? null
                }
            })
            if (sendMinIntervalMs > 0) {
                data.filaIntervaloMs = sendMinIntervalMs
            }
            return sendSuccess(res, 200, data)
        }

        const validKinds = ["image", "video", "audio", "document"]
        if (!validKinds.includes(tipo)) {
            return sendError(res, 400, "tipo invalido. use: text, image, video, audio, document")
        }

        const loaded = await loadMediaBuffer(body)
        if (loaded.error) {
            return sendError(res, 400, loaded.error)
        }

        const ptt =
            tipo === "audio" &&
            (body.ptt === true ||
                body.ptt === "true" ||
                body.ptt === 1 ||
                String(body.ptt || "")
                    .toLowerCase()
                    .trim() === "1")

        let mime = normalizeMimeType(body.mimeType || body.mimetype || loaded.mimeHint || "")
        if (!mimeAllowedForMediaKind(tipo, mime)) {
            mime = defaultMimeForMediaKind(tipo, ptt)
        }
        if (!mimeAllowedForMediaKind(tipo, mime)) {
            return sendError(res, 400, "mimeType invalido para este tipo; informe mimeType explicitamente")
        }

        const captionRaw = body.caption ?? body.legenda
        let caption = ""
        if (typeof captionRaw === "string" && captionRaw.trim()) {
            caption = captionRaw.trim().slice(0, 1024)
        }

        const nomeArquivo =
            typeof body.nomeArquivo === "string" && body.nomeArquivo.trim()
                ? body.nomeArquivo.trim().slice(0, 255)
                : tipo === "document"
                  ? "documento"
                  : undefined

        let contentPayload
        let contentTypeForWebhook
        if (tipo === "image") {
            contentPayload = { image: loaded.buffer, caption: caption || undefined }
            if (mime) contentPayload.mimetype = mime
            contentTypeForWebhook = "imageMessage"
        } else if (tipo === "video") {
            contentPayload = { video: loaded.buffer, mimetype: mime, caption: caption || undefined }
            contentTypeForWebhook = "videoMessage"
        } else if (tipo === "audio") {
            contentPayload = {
                audio: loaded.buffer,
                mimetype: ptt ? "audio/ogg; codecs=opus" : mime,
                ptt: !!ptt
            }
            contentTypeForWebhook = "audioMessage"
        } else {
            contentPayload = {
                document: loaded.buffer,
                mimetype: mime,
                fileName: nomeArquivo || "arquivo",
                caption: caption || undefined
            }
            contentTypeForWebhook = "documentMessage"
        }

        const data = await enqueueSpacedSend(session, async () => {
            const rec = sessions[session]
            const s = rec?.sock
            if (!rec || rec.starting || !s) {
                httpThrow(409, "sessao inicializando, aguarde alguns segundos")
            }
            if (!rec.connected) {
                httpThrow(409, "sessao iniciada, mas ainda nao conectada ao whatsapp")
            }
            const sent = await s.sendMessage(jid, contentPayload)
            await emitOutboundUpsertForCounters(session, jid, sent, {
                text: caption,
                contentType: contentTypeForWebhook
            })
            return {
                status: "enviado",
                session,
                numero: normalizedNumber,
                tipo,
                messageId: sent?.key?.id ?? null
            }
        })
        if (sendMinIntervalMs > 0) {
            data.filaIntervaloMs = sendMinIntervalMs
        }
        return sendSuccess(res, 200, data)
    } catch (err) {
        if (err && typeof err.httpStatus === "number" && err.httpError) {
            return sendError(res, err.httpStatus, err.httpError)
        }
        console.log(err)
        return sendError(res, 500, tipo === "text" ? "falha ao enviar" : "falha ao enviar midia")
    }
})

function removeQrWaiter(sessionId, entry) {
    const list = qrWaiters.get(sessionId)
    if (!list) return
    const idx = list.indexOf(entry)
    if (idx >= 0) list.splice(idx, 1)
    if (!list.length) qrWaiters.delete(sessionId)
}

function subscribeQrWait(sessionId, timeoutMs) {
    return new Promise((resolve) => {
        const entry = { resolve, timer: null }
        entry.timer = setTimeout(() => {
            removeQrWaiter(sessionId, entry)
            resolve({ kind: "timeout" })
        }, timeoutMs)
        if (!qrWaiters.has(sessionId)) {
            qrWaiters.set(sessionId, [])
        }
        qrWaiters.get(sessionId).push(entry)
    })
}

app.get("/qr", async (req, res) => {
    const sessionId = req.query.session?.toString()
    const waitParam = req.query.wait
    const waitSec = waitParam !== undefined ? Number(waitParam) : NaN
    const useLongPoll = Number.isFinite(waitSec) && waitSec > 0
    const waitMs = Math.min(Math.max(waitSec * 1000, 0), 120000)
    // Sem format=html, responder JSON (SPA). Aceitar só HTML no browser com ?format=html.
    const wantsHtml = !useLongPoll && req.query.format === "html"

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida")
    }

    const sessionData = sessions[sessionId]
    if (!sessionData) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    if (sessionData.connected) {
        if (useLongPoll) {
            return res.status(200).json({
                ok: true,
                data: {
                    connected: true,
                    session: sessionId,
                    message: "sessao conectada, nao precisa de qr"
                }
            })
        }
        return sendSuccess(res, 200, {
            session: sessionId,
            connected: true,
            message: "sessao conectada, nao precisa de qr"
        })
    }

    if (useLongPoll) {
        if (sessionData.qrCode) {
            return res.status(200).json({
                ok: true,
                data: { qr: sessionData.qrCode }
            })
        }

        const result = await subscribeQrWait(sessionId, waitMs)
        const fresh = sessions[sessionId]

        if (fresh?.connected || result.kind === "connected") {
            return res.status(200).json({
                ok: true,
                data: {
                    connected: true,
                    session: sessionId,
                    message: "sessao conectada, nao precisa de qr"
                }
            })
        }

        if (fresh?.qrCode || result.kind === "qr") {
            return res.status(200).json({
                ok: true,
                data: { qr: fresh?.qrCode }
            })
        }

        return sendError(res, 404, "qr indisponivel")
    }

    if (!sessionData.qrCode) {
        return sendError(res, 404, "qr indisponivel no momento, tente novamente em alguns segundos")
    }

    if (wantsHtml) {
        return res.status(200).send(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>QR da sessao ${sessionId}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; text-align: center; background: #0f172a; color: #e2e8f0; }
    .card { max-width: 520px; margin: 0 auto; background: #1e293b; border-radius: 12px; padding: 20px; }
    img { width: 100%; max-width: 420px; height: auto; background: #fff; border-radius: 8px; padding: 10px; }
    .meta { margin-top: 12px; font-size: 14px; color: #94a3b8; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Escaneie o QR da sessao: ${sessionId}</h2>
    <img src="${sessionData.qrCode}" alt="QR Code WhatsApp" />
    <p class="meta">Atualizado em: ${sessionData.qrUpdatedAt || "agora"}</p>
    <p class="meta">Se nao funcionar, recarregue esta pagina para pegar um QR novo.</p>
  </div>
</body>
</html>`)
    }

    return res.status(200).json({
        ok: true,
        data: { qr: sessionData.qrCode }
    })
})

app.get("/events", (req, res) => {
    const sessionId = req.query.session?.toString()

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida")
    }

    const sessionData = sessions[sessionId]
    if (!sessionData) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache, no-transform")
    res.setHeader("Connection", "keep-alive")
    res.setHeader("X-Accel-Buffering", "no")
    if (typeof res.flushHeaders === "function") {
        res.flushHeaders()
    }

    if (!sseClients.has(sessionId)) {
        sseClients.set(sessionId, new Set())
    }
    sseClients.get(sessionId).add(res)

    const hello = JSON.stringify({
        type: "hello",
        data: {
            session: sessionId,
            connected: !!sessionData.connected,
            hasQr: !!sessionData.qrCode
        }
    })
    res.write(`event: hello\ndata: ${hello}\n\n`)

    if (sessionData.qrCode && !sessionData.connected) {
        const payload = JSON.stringify({ type: "qr", data: { qr: sessionData.qrCode } })
        res.write(`event: qr\ndata: ${payload}\n\n`)
    }
    if (sessionData.connected) {
        const payload = JSON.stringify({ type: "connected", data: {} })
        res.write(`event: connected\ndata: ${payload}\n\n`)
    }

    const ping = setInterval(() => {
        try {
            res.write(`: ping\n\n`)
        } catch {
            clearInterval(ping)
        }
    }, 25000)

    req.on("close", () => {
        clearInterval(ping)
        sseClients.get(sessionId)?.delete(res)
    })
})

app.get("/health", (req, res) => {
    return sendSuccess(res, 200, {
        status: "up",
        uptimeSeconds: Math.floor(process.uptime()),
        activeSessions: Object.keys(sessions).length
    })
})

app.listen(PORT, () => {
    try {
        fs.mkdirSync(AUTH_ROOT, { recursive: true })
    } catch (error) {
        console.log("⚠️ Não consegui garantir pasta AUTH_ROOT:", error?.message || error)
    }
    console.log(`📁 Auth Baileys (persistente): ${AUTH_ROOT}`)
    if (WEBHOOK_UPSERT_ONLY_NOTIFY) {
        console.log("📨 Webhook: apenas upsert type=notify (menos spam de sync)")
    }
    if (webhookMaxMessageAgeMinutes > 0) {
        console.log(
            `📨 Webhook: ignorando mensagens com mais de ${webhookMaxMessageAgeMinutes} min (histórico)`
        )
    }
    if (!WHATSAPP_SYNC_HISTORY) {
        console.log(
            "📚 Baileys: sincronização de histórico desligada (evita timeout em sync pesado). WHATSAPP_SYNC_HISTORY=1 para ativar."
        )
    }
    const eventsUrl = getInstanziaEventsUrl()
    if (eventsUrl) {
        const short = eventsUrl.length > 72 ? `${eventsUrl.slice(0, 72)}…` : eventsUrl
        console.log(`🔗 Webhook Instanzia (POST): ${short}`)
    } else {
        console.log("⚠️ INSTANZIA_EVENTS_URL nao definida — webhooks nao serao enviados")
    }
    console.log(`📦 JSON body limit: ${JSON_BODY_LIMIT} | midia max: ${mediaMaxBytes} bytes`)
    const hosts = parseMediaUrlAllowedHosts()
    if (hosts.length) {
        console.log(`🌐 MEDIA_FETCH_ALLOWED_HOSTS: ${hosts.join(", ")}`)
    } else {
        console.log("🌐 Download de midia por URL: desligado (defina MEDIA_FETCH_ALLOWED_HOSTS para permitir https)")
    }
    if (sendMinIntervalMs > 0) {
        console.log(
            `⏱️ POST /send: fila por sessao — intervalo minimo ${sendMinIntervalMs}ms entre cada envio (SEND_MIN_INTERVAL_MS)`
        )
    } else {
        console.log("⏱️ POST /send: intervalo entre envios desligado (SEND_MIN_INTERVAL_MS=0)")
    }
    console.log(`🚀 API rodando em http://localhost:${PORT}`)
})
