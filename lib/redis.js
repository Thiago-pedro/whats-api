const IORedis = require("ioredis")
const config = require("./config")

const connection = new IORedis(config.REDIS_URL, {
    maxRetriesPerRequest: null
})

connection.on("error", (error) => {
    console.error("❌ Erro Redis:", error?.message || error)
})

module.exports = {
    connection
}
