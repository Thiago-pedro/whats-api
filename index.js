const express = require("express")
const cors = require("cors")
const axios = require("axios")
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

app.use(["/start", "/send", "/qr", "/session"], authMiddleware)

const sessions = {}

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

async function startSession(sessionId) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(`auth/${sessionId}`)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            auth: state,
            version,
            browser: ["Windows", "Chrome", "10.0"]
        })

        if (!sessions[sessionId]) {
            sessions[sessionId] = {
                sock: null,
                connected: false,
                starting: true,
                qrCode: null,
                qrUpdatedAt: null
            }
        }

        sessions[sessionId].sock = sock
        sessions[sessionId].connected = false

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
                console.log(`\n📲 QR da sessão ${sessionId}:`)
                qrcode.generate(qr, { small: true })
            }

            if (connection === "open") {
                if (sessions[sessionId]) {
                    sessions[sessionId].connected = true
                    sessions[sessionId].starting = false
                    sessions[sessionId].qrCode = null
                    sessions[sessionId].qrUpdatedAt = null
                }
                console.log(`✅ Sessão ${sessionId} conectada`)
            }

            if (connection === "close") {
                console.log(`❌ Sessão ${sessionId} desconectada`)
                if (sessions[sessionId]) {
                    sessions[sessionId].connected = false
                    sessions[sessionId].qrCode = null
                    sessions[sessionId].qrUpdatedAt = null
                }

                const statusCode = lastDisconnect?.error?.output?.statusCode

                if (statusCode !== 401) {
                    if (sessions[sessionId]?.sock !== sock) {
                        return
                    }
                    console.log("🔄 Tentando reconectar...")
                    if (sessions[sessionId]) {
                        sessions[sessionId].starting = true
                    }
                    setTimeout(() => startSession(sessionId), 2000)
                } else {
                    console.log("🚫 Sessão deslogada, precisa escanear QR novamente")
                    delete sessions[sessionId]
                }
            }
        })
    } catch (error) {
        console.log(`❌ Falha ao iniciar sessão ${sessionId}:`, error?.message || error)
        delete sessions[sessionId]
    }
}

app.get("/start", async (req, res) => {
    const sessionId = req.query.session?.toString()
    const forceStart = req.query.force?.toString() === "1"

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida. use 3-60 caracteres: letras, numeros, _ ou -")
    }

    if (sessions[sessionId]) {
        if (!forceStart) {
            return sendSuccess(res, 200, { message: "sessao ja iniciada", session: sessionId })
        }
        console.log(`🔁 Reinicio forcado da sessao ${sessionId}`)
        resetSession(sessionId)
    }

    sessions[sessionId] = {
        sock: null,
        connected: false,
        starting: true,
        qrCode: null,
        qrUpdatedAt: null
    }

    startSession(sessionId)

    if (forceStart) {
        return sendSuccess(res, 202, {
            message: "sessao reiniciada",
            session: sessionId
        })
    }

    return sendSuccess(res, 202, {
        message: "sessao iniciada",
        session: sessionId
    })
})

app.delete("/session", (req, res) => {
    const sessionId = req.query.session?.toString()

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida")
    }

    const removed = resetSession(sessionId)
    if (!removed) {
        return sendError(res, 404, "sessao nao encontrada")
    }

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

app.get("/qr", (req, res) => {
    const sessionId = req.query.session?.toString()

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida")
    }

    const sessionData = sessions[sessionId]
    if (!sessionData) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    if (sessionData.connected) {
        return sendSuccess(res, 200, {
            session: sessionId,
            connected: true,
            message: "sessao conectada, nao precisa de qr"
        })
    }

    if (!sessionData.qrCode) {
        return sendError(res, 404, "qr indisponivel no momento, tente novamente em alguns segundos")
    }

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
})

app.get("/health", (req, res) => {
    return sendSuccess(res, 200, {
        status: "up",
        uptimeSeconds: Math.floor(process.uptime()),
        activeSessions: Object.keys(sessions).length
    })
})

app.listen(PORT, () => {
    console.log(`🚀 API rodando em http://localhost:${PORT}`)
})