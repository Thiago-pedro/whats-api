function isValidSessionId(sessionId) {
    return typeof sessionId === "string" && /^[a-zA-Z0-9_-]{3,60}$/.test(sessionId)
}

function normalizePhoneNumber(value) {
    if (typeof value !== "string") return null
    const digitsOnly = value.replace(/\D/g, "")
    if (digitsOnly.length < 10 || digitsOnly.length > 15) return null
    return digitsOnly
}

function isValidTenantId(tenantId) {
    return typeof tenantId === "string" && /^[a-zA-Z0-9_-]{2,60}$/.test(tenantId)
}

module.exports = {
    isValidSessionId,
    normalizePhoneNumber,
    isValidTenantId
}
