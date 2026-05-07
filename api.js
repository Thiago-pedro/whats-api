const express = require("express")
const cors = require("cors")
const config = require("./lib/config")
const { sendError, sendSuccess } = require("./lib/responses")
const { isValidSessionId, normalizePhoneNumber, isValidTenantId } = require("./lib/validation")
const { enqueueStartSession, enqueueSendMessage, queue } = require("./lib/queue")
const { connection } = require("./lib/redis")
const { getSession, ensureSession, countTenantSessions } = require("./lib/sessionStore")
const { initDb } = require("./lib/db")

const app = express()

app.use(express.json())
app.use(cors({ origin: config.CORS_ORIGIN === "*" ? true : config.CORS_ORIGIN }))

function authMiddleware(req, res, next) {
    const apiKey = req.headers["x-api-key"]

    if (!apiKey || apiKey !== config.API_KEY) {
        return sendError(res, 401, "nao autorizado")
    }

    next()
}

function tenantMiddleware(req, res, next) {
    const rawTenant = req.headers["x-tenant-id"]?.toString() || "default"
    if (!isValidTenantId(rawTenant)) {
        return sendError(res, 400, "tenant invalido")
    }
    req.tenantId = rawTenant
    next()
}

app.use(["/start", "/send", "/qr", "/session"], authMiddleware, tenantMiddleware)

app.get("/start", async (req, res) => {
    const sessionId = req.query.session?.toString()
    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida. use 3-60 caracteres: letras, numeros, _ ou -")
    }

    const tenantId = req.tenantId
    const existing = await getSession(sessionId)
    if (existing) {
        if (existing.tenantId !== tenantId) {
            return sendError(res, 403, "sessao pertence a outro tenant")
        }
        return sendSuccess(res, 200, { message: "sessao ja iniciada", session: sessionId })
    }

    const tenantSessions = await countTenantSessions(tenantId)
    if (tenantSessions >= config.MAX_SESSIONS_PER_TENANT) {
        return sendError(res, 429, "limite de sessoes por tenant atingido", {
            maxSessionsPerTenant: config.MAX_SESSIONS_PER_TENANT
        })
    }

    await ensureSession(sessionId, tenantId)
    await enqueueStartSession(sessionId, tenantId)

    return sendSuccess(res, 202, {
        message: "sessao enfileirada para inicializacao",
        session: sessionId
    })
})

app.get("/session", async (req, res) => {
    const sessionId = req.query.session?.toString()
    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida")
    }

    const sessionData = await getSession(sessionId)
    if (!sessionData) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    if (sessionData.tenantId !== req.tenantId) {
        return sendError(res, 403, "sessao pertence a outro tenant")
    }

    return sendSuccess(res, 200, sessionData)
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

    const sessionData = await getSession(session)
    if (!sessionData) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    if (sessionData.tenantId !== req.tenantId) {
        return sendError(res, 403, "sessao pertence a outro tenant")
    }

    if (!sessionData.connected) {
        return sendError(res, 409, "sessao ainda nao conectada ao whatsapp")
    }

    const job = await enqueueSendMessage({
        sessionId: session,
        tenantId: req.tenantId,
        numero: normalizedNumber,
        mensagem: mensagem.trim()
    })

    return sendSuccess(res, 202, {
        status: "enfileirado",
        session,
        numero: normalizedNumber,
        jobId: job.id
    })
})

app.get("/qr", async (req, res) => {
    const sessionId = req.query.session?.toString()
    if (!isValidSessionId(sessionId)) {
        return sendError(res, 400, "session invalida")
    }

    const sessionData = await getSession(sessionId)
    if (!sessionData) {
        return sendError(res, 404, "sessao nao encontrada")
    }

    if (sessionData.tenantId !== req.tenantId) {
        return sendError(res, 403, "sessao pertence a outro tenant")
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

app.get("/health", async (req, res) => {
    let redisOk = true
    try {
        await connection.ping()
    } catch (error) {
        redisOk = false
    }

    const waiting = await queue.getWaitingCount()
    const active = await queue.getActiveCount()

    return sendSuccess(res, 200, {
        status: "up",
        uptimeSeconds: Math.floor(process.uptime()),
        redis: redisOk ? "up" : "down",
        queue: {
            waiting,
            active
        }
    })
})

async function start() {
    await initDb()
    app.listen(config.PORT, () => {
        console.log(`🚀 API rodando em http://localhost:${config.PORT}`)
    })
}

start().catch((error) => {
    console.error("❌ Falha ao iniciar API:", error?.message || error)
    process.exit(1)
})
