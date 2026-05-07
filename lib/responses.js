function sendError(res, statusCode, message, details) {
    return res.status(statusCode).json({
        ok: false,
        error: message,
        ...(details ? { details } : {})
    })
}

function sendSuccess(res, statusCode, data) {
    return res.status(statusCode).json({
        ok: true,
        data
    })
}

module.exports = {
    sendError,
    sendSuccess
}
