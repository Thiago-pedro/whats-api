const { connection } = require("./redis")
const { upsertSessionSnapshot, insertSessionEvent } = require("./db")

function sessionKey(sessionId) {
    return `wa:session:${sessionId}`
}

function tenantSessionsKey(tenantId) {
    return `wa:tenant:${tenantId}:sessions`
}

async function ensureSession(sessionId, tenantId) {
    const key = sessionKey(sessionId)
    const exists = await connection.exists(key)
    if (!exists) {
        await connection.hset(key, {
            sessionId,
            tenantId,
            status: "starting",
            connected: "false",
            qrCode: "",
            qrUpdatedAt: "",
            starting: "true",
            workerId: "",
            lastError: "",
            updatedAt: new Date().toISOString()
        })
        await connection.sadd(tenantSessionsKey(tenantId), sessionId)
    }
}

async function getSession(sessionId) {
    const data = await connection.hgetall(sessionKey(sessionId))
    if (!data || Object.keys(data).length === 0) return null

    return {
        sessionId: data.sessionId,
        tenantId: data.tenantId,
        status: data.status,
        connected: data.connected === "true",
        starting: data.starting === "true",
        qrCode: data.qrCode || null,
        qrUpdatedAt: data.qrUpdatedAt || null,
        workerId: data.workerId || null,
        lastError: data.lastError || null,
        updatedAt: data.updatedAt || null
    }
}

async function updateSession(sessionId, updates) {
    const current = await getSession(sessionId)
    if (!current) return null

    const merged = {
        ...current,
        ...updates,
        updatedAt: new Date().toISOString()
    }

    await connection.hset(sessionKey(sessionId), {
        sessionId: merged.sessionId,
        tenantId: merged.tenantId,
        status: merged.status || "",
        connected: String(Boolean(merged.connected)),
        starting: String(Boolean(merged.starting)),
        qrCode: merged.qrCode || "",
        qrUpdatedAt: merged.qrUpdatedAt || "",
        workerId: merged.workerId || "",
        lastError: merged.lastError || "",
        updatedAt: merged.updatedAt
    })

    await upsertSessionSnapshot({
        sessionId: merged.sessionId,
        tenantId: merged.tenantId,
        status: merged.status,
        connected: merged.connected,
        qrUpdatedAt: merged.qrUpdatedAt,
        lastError: merged.lastError
    })

    return merged
}

async function countTenantSessions(tenantId) {
    return connection.scard(tenantSessionsKey(tenantId))
}

async function registerEvent(sessionId, tenantId, eventName, payload) {
    await insertSessionEvent({
        sessionId,
        tenantId,
        eventName,
        payload
    })
}

module.exports = {
    ensureSession,
    getSession,
    updateSession,
    countTenantSessions,
    registerEvent
}
