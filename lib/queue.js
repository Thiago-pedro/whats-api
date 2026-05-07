const { Queue } = require("bullmq")
const config = require("./config")
const { connection } = require("./redis")

const queue = new Queue(config.QUEUE_NAME, {
    connection
})

async function enqueueStartSession(sessionId, tenantId) {
    return queue.add(
        "start-session",
        { sessionId, tenantId },
        {
            jobId: `start:${sessionId}`,
            removeOnComplete: true,
            attempts: 3,
            backoff: {
                type: "exponential",
                delay: 2000
            }
        }
    )
}

async function enqueueSendMessage({ sessionId, tenantId, numero, mensagem }) {
    return queue.add(
        "send-message",
        { sessionId, tenantId, numero, mensagem },
        {
            removeOnComplete: true,
            attempts: 3,
            backoff: {
                type: "exponential",
                delay: 1000
            }
        }
    )
}

module.exports = {
    queue,
    enqueueStartSession,
    enqueueSendMessage
}
