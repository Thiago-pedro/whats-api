require("dotenv").config()

const config = {
    PORT: Number(process.env.PORT) || 3000,
    API_KEY: process.env.API_KEY,
    CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
    REDIS_URL: process.env.REDIS_URL,
    DATABASE_URL: process.env.DATABASE_URL || null,
    QUEUE_NAME: process.env.QUEUE_NAME || "whatsapp-jobs",
    MAX_SESSIONS_PER_TENANT: Number(process.env.MAX_SESSIONS_PER_TENANT || 2),
    AUTH_BASE_PATH: process.env.AUTH_BASE_PATH || "auth",
    WORKER_ID: process.env.WORKER_ID || `worker-${process.pid}`
}

if (!config.API_KEY) {
    console.error("❌ API_KEY não definida no .env")
    process.exit(1)
}

if (!config.REDIS_URL) {
    console.error("❌ REDIS_URL não definida no .env")
    process.exit(1)
}

module.exports = config
