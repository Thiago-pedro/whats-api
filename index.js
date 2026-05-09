const express = require("express")
const cors = require("cors")
const axios = require("axios")
const fs = require("fs")
const path = require("path")
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

const rawAuthRoot = typeof process.env.WHATSAPP_AUTH_ROOT === "string" ? process.env.WHATSAPP_AUTH_ROOT.trim() : ""
/** Produção Render: igual ao Mount Path do Persistent Disk ou env WHATSAPP_AUTH_ROOT */
const AUTH_ROOT = path.resolve(rawAuthRoot || path.join(__dirname, "auth"))

function authStateDir(sessionId) {
    return path.join(AUTH_ROOT, sessionId)
}

app.use(express.json())
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

async function postLovableWebhook(payload) {
    const url = process.env.LOVABLE_EVENTS_URL
    if (!url || typeof url !== "string") return

    const secret = process.env.LOVABLE_WEBHOOK_SECRET
    const headers = { "Content-Type": "application/json" }
    if (secret) headers["x-webhook-secret"] = secret

    try {
        await axios.post(url.trim(), payload, { timeout: 15000, headers })
    } catch (error) {
        console.log("⚠️ LOVABLE webhook falhou:", error?.message || error)
    }
}

app.use(["/start", "/send", "/qr", "/session", "/warmup", "/health", "/events"], authMiddleware)

const sessions = {}
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
        startedAt: new Date().toISOString()
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
    closeSocketSafely(existing.sock)
    delete sessions[sessionId]
    return true
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

        const sock = makeWASocket({
            auth: state,
            version,
            browser: ["Windows", "Chrome", "10.0"]
        })

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

                const text = getMessagePreviewText(msg)
                postLovableWebhook({
                    event: "messages.upsert",
                    sessionId,
                    fromMe: !!msg.key.fromMe,
                    from: msg.key.remoteJid,
                    text,
                    timestamp: msg.messageTimestamp,
                    messageId: msg.key.id,
                    upsertType: type
                })
            }
        })

        sock.ev.on("messages.update", (updates) => {
            for (const u of updates || []) {
                if (!u?.key) continue
                postLovableWebhook({
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
                postLovableWebhook({
                    event: "connection.update",
                    sessionId,
                    connection: connection ?? null,
                    hasQr: !!qr,
                    disconnectStatusCode: lastDisconnect?.error?.output?.statusCode ?? null
                })
            }

            if (qr) {
                if (sessions[sessionId]) {
                    sessions[sessionId].starting = false
                    sessions[sessionId].qrCode = await QRCode.toDataURL(qr)
                    sessions[sessionId].qrUpdatedAt = new Date().toISOString()
                }
                const qrDataUrl = sessions[sessionId]?.qrCode
                postLovableWebhook({
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
                    console.log("🔄 Tentando reconectar...")
                    if (sessions[sessionId]) {
                        sessions[sessionId].starting = true
                        sessions[sessionId].connectionState = "connecting"
                    }
                    setTimeout(() => startSession(sessionId), 2000)
                } else {
                    console.log("🚫 Sessão deslogada — removendo credenciais salvas para permitir novo QR")
                    qrWaiters.delete(sessionId)
                    clearAuthState(sessionId)
                    delete sessions[sessionId]
                }
            }
        })
    } catch (error) {
        console.log(`❌ Falha ao iniciar sessão ${sessionId}:`, error?.message || error)
        qrWaiters.delete(sessionId)
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
        delete sessions[sessionId]
    }

    sessions[sessionId] = createSessionRecord()
    setImmediate(() => startSession(sessionId))

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
    const { session, numero, mensagem } = req.body || {}

    if (!isValidSessionId(session)) {
        return sendError(res, 400, "session invalida")
    }

    const normalizedNumber = normalizePhoneNumber(numero)
    if (!normalizedNumber) {
        return sendError(res, 400, "numero invalido")
    }

    if (typeof mensagem !== "string" || mensagem.trim().length === 0 || mensagem.length > 4000) {
        return sendError(res, 400, "mensagem invalida")
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

    try {
        await sock.sendMessage(normalizedNumber + "@s.whatsapp.net", {
            text: mensagem.trim()
        })

        return sendSuccess(res, 200, {
            status: "enviado",
            session,
            numero: normalizedNumber
        })
    } catch (err) {
        console.log(err)
        return sendError(res, 500, "falha ao enviar")
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
    console.log(`🚀 API rodando em http://localhost:${PORT}`)
})
