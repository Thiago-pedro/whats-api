const express = require("express")
const cors = require("cors")
require("dotenv").config()
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")

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

app.use(["/start", "/send"], authMiddleware)

// armazena sessões ativas
const sessions = {}

// ===============================
// 🚀 INICIAR SESSÃO
// ===============================
async function startSession(sessionId) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(`auth/${sessionId}`)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            auth: state,
            version,
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        })

        if (!sessions[sessionId]) {
            sessions[sessionId] = {
                sock: null,
                connected: false,
                starting: true
            }
        }

        sessions[sessionId].sock = sock
        sessions[sessionId].connected = false

        sock.ev.on("creds.update", saveCreds)

        sock.ev.on("connection.update", async (update) => {
            const { connection, qr, lastDisconnect } = update

            // 📲 QR CODE
            if (qr) {
                if (sessions[sessionId]) {
                    sessions[sessionId].starting = false
                }
                console.log(`\n📲 QR da sessão ${sessionId}:`)
                qrcode.generate(qr, { small: true })
            }

            // ✅ CONECTOU
            if (connection === "open") {
                if (sessions[sessionId]) {
                    sessions[sessionId].connected = true
                    sessions[sessionId].starting = false
                }
                console.log(`✅ Sessão ${sessionId} conectada`)
            }

            // ❌ DESCONECTOU
            if (connection === "close") {
                console.log(`❌ Sessão ${sessionId} desconectada`)
                if (sessions[sessionId]) {
                    sessions[sessionId].connected = false
                }

                const statusCode = lastDisconnect?.error?.output?.statusCode

                // só reconecta se NÃO foi logout (401)
                if (statusCode !== 401) {
                    console.log("🔄 Tentando reconectar...")
                    if (sessions[sessionId]) {
                        sessions[sessionId].starting = true
                    }

                    setTimeout(() => {
                        startSession(sessionId)
                    }, 2000)
                } else {
                    console.log("🚫 Sessão deslogada, precisa escanear QR novamente")
                    delete sessions[sessionId]
                }
            }
        })

        // ===============================
        // 📩 RECEBER MENSAGENS
        // ===============================
        sock.ev.on("messages.upsert", async ({ messages }) => {
            const msg = messages[0]

            if (!msg.message) return
            if (msg.key.fromMe) return

            let numero = msg.key.remoteJid
            const nome = msg.pushName || "Desconhecido"

            // trata número normal
            if (numero.includes("@s.whatsapp.net")) {
                numero = numero.replace("@s.whatsapp.net", "")
            }

            // trata LID (quando aparece aquele número estranho)
            if (numero.includes("@lid")) {
                numero = "Número oculto (LID)"
            }

            const texto =
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                "[mensagem não suportada]"

            console.log("\n📩 Nova mensagem!")
            console.log("Sessão:", sessionId)
            console.log("Nome:", nome)
            console.log("Número:", numero)
            console.log("Mensagem:", texto)
        })
    } catch (error) {
        console.log(`❌ Falha ao iniciar sessão ${sessionId}:`, error?.message || error)
        delete sessions[sessionId]
    }
}

// ===============================
// 🌐 ROTA INICIAR SESSÃO
// ===============================
app.get("/start", async (req, res) => {
    const sessionId = req.query.session?.toString()

    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida. use 3-60 caracteres: letras, numeros, _ ou -")
    }

    if (sessions[sessionId]) {
        return sendSuccess(res, 200, { message: "sessao ja iniciada", session: sessionId })
    }

    sessions[sessionId] = {
        sock: null,
        connected: false,
        starting: true
    }

    startSession(sessionId)

    return sendSuccess(res, 202, {
        message: "sessao iniciada",
        session: sessionId
    })
})

// ===============================
// 📤 ROTA ENVIAR MENSAGEM
// ===============================
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

app.get("/health", (req, res) => {
    return sendSuccess(res, 200, {
        status: "up",
        uptimeSeconds: Math.floor(process.uptime()),
        activeSessions: Object.keys(sessions).length
    })
})

// ===============================
// 🚀 START SERVIDOR
// ===============================
app.listen(PORT, () => {
    console.log(`🚀 API rodando em http://localhost:${PORT}`)
})