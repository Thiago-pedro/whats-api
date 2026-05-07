const { Pool } = require("pg")
const config = require("./config")

let pool = null

if (config.DATABASE_URL) {
    pool = new Pool({
        connectionString: config.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    })
}

async function initDb() {
    if (!pool) return

    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
            session_id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            status TEXT NOT NULL,
            connected BOOLEAN NOT NULL DEFAULT FALSE,
            qr_updated_at TIMESTAMPTZ NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_error TEXT NULL
        );
    `)

    await pool.query(`
        CREATE TABLE IF NOT EXISTS whatsapp_session_events (
            id BIGSERIAL PRIMARY KEY,
            session_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            event_name TEXT NOT NULL,
            payload_json JSONB NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `)
}

async function upsertSessionSnapshot(snapshot) {
    if (!pool) return
    await pool.query(
        `
        INSERT INTO whatsapp_sessions (
            session_id, tenant_id, status, connected, qr_updated_at, updated_at, last_error
        )
        VALUES ($1, $2, $3, $4, $5, NOW(), $6)
        ON CONFLICT (session_id) DO UPDATE
        SET
            tenant_id = EXCLUDED.tenant_id,
            status = EXCLUDED.status,
            connected = EXCLUDED.connected,
            qr_updated_at = EXCLUDED.qr_updated_at,
            updated_at = NOW(),
            last_error = EXCLUDED.last_error;
        `,
        [
            snapshot.sessionId,
            snapshot.tenantId,
            snapshot.status,
            snapshot.connected,
            snapshot.qrUpdatedAt || null,
            snapshot.lastError || null
        ]
    )
}

async function insertSessionEvent(event) {
    if (!pool) return
    await pool.query(
        `
        INSERT INTO whatsapp_session_events (
            session_id, tenant_id, event_name, payload_json
        )
        VALUES ($1, $2, $3, $4);
        `,
        [event.sessionId, event.tenantId, event.eventName, event.payload || null]
    )
}

module.exports = {
    initDb,
    upsertSessionSnapshot,
    insertSessionEvent
}
