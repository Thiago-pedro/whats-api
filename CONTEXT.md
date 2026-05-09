# CONTEXT — whats-api × Chatfy / Lovable

Este arquivo resume o backend e decisões recentes para qualquer sessão nova no Cursor ou clone do repo.

**Sugestão:** em conversas novas, pedir para ler este arquivo antes de alterar webhooks ou fluxo de sessão.

---

## Produto

Backend Node.js (**Express + Baileys** `@whiskeysockets/baileys`) para WhatsApp multi-sessão. Frontend **Chatfy** (Lovable) consome a API e, em muitos casos, eventos via **webhook** (`LOVABLE_EVENTS_URL`).

---

## Dois modos no repositório

| Modo | Comando | Uso |
|------|---------|-----|
| **Monolítico** | `npm start` → **`index.js`** | Deploy comum no **Render** descrito nas sessões recentes: tudo (HTTP + Baileys) no mesmo processo. |
| **API + Worker** | `npm run start:api` + `npm run start:worker` | Fila **BullMQ** / Redis; webhooks e lógica rica costumam estar em **`worker.js`**. |

**Na prática atual (Chatfy + Render “whats-api”):** o serviço que roda costuma ser **`node index.js`**. Alterações de webhook/QR/sessão feitas em 2025–2026 estão em **`index.js`**, não necessariamente espelhadas no `worker.js`.

---

## Auth e persistência (Render)

- Por padrão, credenciais Baileys ficam em `auth/<sessionId>/` relativo ao app.
- Para **disco persistente** no Render: montar **Persistent Disk** e definir:
  - **`WHATSAPP_AUTH_ROOT`** = mesmo path absoluto do mount (ex.: `/var/data/whatsapp-auth`).
- No boot, o log deve mostrar: `📁 Auth Baileys (persistente): <caminho>`.
- Não usar `/tmp` para sessão se quiser sobreviver a deploy.

---

## Variáveis de ambiente relevantes (`index.js`)

| Variável | Função |
|----------|--------|
| `API_KEY` | Obrigatória. Header **`x-api-key`** nas rotas protegidas. |
| `PORT` | Render injeta (ex. 10000). |
| `CORS_ORIGIN` | CORS; default `*`. |
| `LOVABLE_EVENTS_URL` | URL do webhook; sem isso não envia POST. |
| `LOVABLE_WEBHOOK_SECRET` | Opcional; header `x-webhook-secret`. |
| `WHATSAPP_AUTH_ROOT` | Raiz das pastas de auth no disco. |
| `ALWAYS_REQUIRE_QR` | `true` → todo `/start` apaga credenciais e força novo QR (como `force=1`). |
| `WEBHOOK_UPSERT_ONLY_NOTIFY` | `true` → só encaminha `messages.upsert` com `type === "notify"` (menos spam de sync). |
| `WEBHOOK_MAX_MESSAGE_AGE_MINUTES` | Ex.: `15` → ignora no webhook mensagens mais antigas que N minutos. |
| `RECONNECT_BACKOFF_BASE_MS` / `RECONNECT_BACKOFF_MAX_MS` / `RECONNECT_COOLDOWN_MS` | Backoff de reconexão (não-401). |
| `RECONNECT_RESTART_REQUIRED_MS` | Delay curto após **515** “restart required” (pós-QR). Default ~1200 ms. |

Outras envs (`DATABASE_URL`, `QUEUE_NAME`, `MAX_SESSIONS_PER_TENANT`, `WORKER_ID`, `AUTH_BASE_PATH`) pertencem a **`api.js` / `worker.js` / lib** — o **`index.js` não lê** `AUTH_BASE_PATH` (usar `WHATSAPP_AUTH_ROOT`).

---

## API HTTP (resumo do contrato `index.js`)

Todas as rotas abaixo exigem **`x-api-key`** (incluindo **`GET /health`**).

| Método | Rota | Notas |
|--------|------|--------|
| `GET` / `POST` | `/start?session=&force=0\|1` | Idempotente; `force=1` ou `ALWAYS_REQUIRE_QR` limpa auth e reinicia. |
| `POST` | `/warmup?session=` | Boot rápido; `{ warming \| alreadyRunning }`. |
| `POST` | `/send` | Body: `session`, `numero`, `mensagem`. |
| `GET` | `/qr?session=&wait=N` | Long-poll JSON; sem `wait`, **JSON por default**; HTML só com `format=html`. |
| `DELETE` | `/session?session=` | Remove sessão em memória **e** limpa pasta auth no disco. |
| `GET` | `/events?session=` | SSE (opcional). |
| `GET` | `/health` | `{ ok, data: { status, uptimeSeconds, activeSessions } }`. |

**`activeSessions` em `/health`** = apenas sessões **em memória** no processo atual (não espelha Supabase/Chatfy).

---

## Webhooks enviados por `index.js` (POST JSON)

- **`connection.update`** — `sessionId`, `connection`, `hasQr`, `disconnectStatusCode`.
- **`qr`** — após gerar imagem: `sessionId`, `qr` (data URL), `updatedAt`.
- **`messages.upsert`** — por mensagem (filtros opcionais acima).
- **`messages.update`** — atualizações de status, etc.

Em **`connection === "close"`** com **401**, o servidor remove sessão e **`clearAuthState`** (credenciais inválidas).

Logs de diagnóstico: linha **`🔌 lastDisconnect [sessionId]`** com `statusCode`, `reason`, `at` (sem dados sensíveis).

Reconexão automática: **515** usa delay curto; outros códigos usam backoff + cooldown.

---

## Comportamento esperado (operacional)

- **Sync / histórico** após login: muitos eventos `messages.upsert` e logs Baileys level 30 — **normal**, não é necessariamente erro.
- **QR no terminal (ASCII):** só diagnóstico; o cliente deve usar **`/qr`** ou webhook **`qr`**.
- **Card “Conectada” no Chatfy** vs **`activeSessions: 0`:** estado da UI costuma vir do **banco/Lovable**; `/health` só conta RAM — podem divergir até o webhook/front atualizar.

---

## Fluxo rápido alteração → produção (`index.js` no Render)

1. Commit em `main`.
2. Push GitHub → redeploy automático ou **Manual Deploy** no Render.
3. Conferir env (`WHATSAPP_AUTH_ROOT`, flags opcionais).
4. Validar logs de boot (`📁 Auth Baileys (persistente): …`).

---

## Histórico já registrado neste repo / conversas

- Otimizações: **`POST /warmup`**, `/start` idempotente, **`GET /qr` long-polling**, **`GET /events` SSE**, cache versão Baileys.
- **`/qr`** passou a responder **JSON por default** para SPAs; HTML com `?format=html` (evita front preso em “aguardando QR” por `Accept: */*`).
- **401 / DELETE:** limpeza de pasta `auth` no disco.
- **515 pós-pareamento:** reconexão rápida para não deixar o celular em “conectando” à toa.
- Filtros opcionais de webhook para reduzir rajada na “atividade recente”.

Se o deploy de produção migrar para **API+Worker**, revisar também **`worker.js`** e alinhar payloads com este documento.

---

*Pedir explicitamente “ler `CONTEXT.md`” em chats novos após clone, se o time usar essa convenção.*
