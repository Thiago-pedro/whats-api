const express = require("express")
const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys")
const qrcode = require("qrcode-terminal")

const app = express()
const PORT = 3000

app.use(express.json())

// armazena sessões ativas
const sessions = {}

// ===============================
// 🚀 INICIAR SESSÃO
// ===============================
async function startSession(sessionId) {
    const { state, saveCreds } = await useMultiFileAuthState(`auth/${sessionId}`)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        auth: state,
        version,
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    })

    sessions[sessionId] = sock

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", async (update) => {
        const { connection, qr, lastDisconnect } = update

        // 📲 QR CODE
        if (qr) {
            console.log(`\n📲 QR da sessão ${sessionId}:`)
            qrcode.generate(qr, { small: true })
        }

        // ✅ CONECTOU
        if (connection === "open") {
            console.log(`✅ Sessão ${sessionId} conectada`)
        }

        // ❌ DESCONECTOU
        if (connection === "close") {
            console.log(`❌ Sessão ${sessionId} desconectada`)

            delete sessions[sessionId]

            const statusCode = lastDisconnect?.error?.output?.statusCode

            // só reconecta se NÃO foi logout (401)
            if (statusCode !== 401) {
                console.log("🔄 Tentando reconectar...")

                setTimeout(() => {
                    startSession(sessionId)
                }, 2000)
            } else {
                console.log("🚫 Sessão deslogada, precisa escanear QR novamente")
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
}

// ===============================
// 🌐 ROTA INICIAR SESSÃO
// ===============================
app.get("/start", async (req, res) => {
    const sessionId = req.query.session

    if (!sessionId) {
        return res.send("❌ informe ?session=nome")
    }

    if (sessions[sessionId]) {
        return res.send("⚠️ sessão já iniciada")
    }

    startSession(sessionId)

    res.send(`🚀 Sessão ${sessionId} iniciada`)
})

// ===============================
// 📤 ROTA ENVIAR MENSAGEM
// ===============================
app.post("/send", async (req, res) => {
    const { session, numero, mensagem } = req.body

    const sock = sessions[session]

    if (!sock) {
        return res.json({ erro: "sessao nao conectada" })
    }

    if (!numero || !mensagem) {
        return res.json({ erro: "numero e mensagem obrigatórios" })
    }

    try {
        await sock.sendMessage(numero + "@s.whatsapp.net", {
            text: mensagem
        })

        res.json({ status: "enviado" })
    } catch (err) {
        console.log(err)
        res.json({ erro: "falha ao enviar" })
    }
})

// ===============================
// 🚀 START SERVIDOR
// ===============================
app.listen(PORT, () => {
    console.log(`🚀 API rodando em http://localhost:${PORT}`)
})