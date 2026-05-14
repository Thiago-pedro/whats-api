# CONTEXT — whats-api × Instanzia

Este arquivo resume o backend e decisões recentes para qualquer sessão nova no Cursor ou clone do repo.

**Sugestão:** em conversas novas, pedir para ler este arquivo antes de alterar webhooks ou fluxo de sessão.

---

## Produto

Backend Node.js (**Express + Baileys** `@whiskeysockets/baileys`) para WhatsApp multi-sessão. O painel **Instanzia** (stack Lovable) consome a API e, em muitos casos, eventos via **webhook** (`INSTANZIA_EVENTS_URL`).

**Nomenclatura:** no Instanzia cada cartão é uma **instância**; neste repo isso é a **sessão** Baileys — o id é o **`sessionId`** (query `?session=`, pasta `auth/<sessionId>/`). Regex: 3–60 caracteres `[a-zA-Z0-9_-]`.

**Vários usuários:** cada login pode ter sessões novas (histórias isoladas). O `index.js` **não impõe** teto de instâncias; um limite (ex.: 15 clientes) é **regra de produto** no Instanzia ou, se desejado, uma validação futura no `/start`. Várias sessões no mesmo processo aumentam RAM/CPU.

---

## Dois modos no repositório

| Modo | Comando | Uso |
|------|---------|-----|
| **Monolítico** | `npm start` → **`index.js`** | Deploy comum no **Render**: tudo (HTTP + Baileys) no mesmo processo. |
| **API + Worker** | `npm run start:api` + `npm run start:worker` | Fila **BullMQ** / Redis; webhooks e lógica rica costumam estar em **`worker.js`**. |

**Na prática atual (Instanzia + Render “whats-api”):** o serviço que roda costuma ser **`node index.js`**. Alterações de webhook/QR/sessão recentes estão em **`index.js`**, não necessariamente espelhadas no `worker.js`.

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
| `INSTANZIA_EVENTS_URL` | URL do webhook (POST JSON). **Preferida.** |
| `INSTANZIA_WEBHOOK_SECRET` | Opcional; header `x-webhook-secret`. **Preferida.** |
| `LOVABLE_EVENTS_URL` / `LOVABLE_WEBHOOK_SECRET` | **Legado:** lidos se as variáveis `INSTANZIA_*` estiverem vazias. |
| `WHATSAPP_AUTH_ROOT` | Raiz das pastas de auth no disco. |
| `ALWAYS_REQUIRE_QR` | `true` → todo `/start` apaga credenciais e força novo QR (como `force=1`). |
| `WEBHOOK_UPSERT_ONLY_NOTIFY` | `true` → só encaminha `messages.upsert` com `type === "notify"` (menos spam de sync). |
| `WEBHOOK_MAX_MESSAGE_AGE_MINUTES` | Ex.: `15` → ignora no webhook mensagens mais antigas que N minutos. |
| `WEBHOOK_DEBUG` | `1` / `true` → loga cada webhook **bem-sucedido** (URL + preview). **Default:** silencioso em sucesso; mantém `console.error` em falha. |
| `RECONNECT_BACKOFF_*` / `RECONNECT_COOLDOWN_MS` | Backoff de reconexão (não-401). |
| `RECONNECT_RESTART_REQUIRED_MS` | Delay curto após **515** “restart required” (pós-QR). Default ~1200 ms. |
| `WHATSAPP_SYNC_HISTORY` | `1` / `true` → Baileys baixa **histórico completo** (mais RAM; pode dar **timeout** em host fraco). **Default:** histórico desligado. |
| `JSON_BODY_LIMIT` | Limite do body JSON (ex. `32mb`) para `arquivoBase64` em `/send`. |
| `MEDIA_MAX_BYTES` | Tamanho máximo do arquivo (base64 decodificado ou download); default ~25 MB. |
| `MEDIA_FETCH_ALLOWED_HOSTS` | Lista separada por vírgula/espaço: **somente** esses hosts podem ser usados em `url` no `/send` de mídia (HTTPS). Sem isso, **download por URL fica desligado** (base64 continua ok). |

Outras envs (`DATABASE_URL`, `QUEUE_NAME`, …) pertencem a **`api.js` / `worker.js` / lib** — o **`index.js` não lê** `AUTH_BASE_PATH` (usar `WHATSAPP_AUTH_ROOT`).

---

## API HTTP (resumo do contrato `index.js`)

Todas as rotas abaixo exigem **`x-api-key`** (incluindo **`GET /health`**).

| Método | Rota | Notas |
|--------|------|--------|
| `GET` / `POST` | `/start?session=&force=0\|1` | Idempotente; `force=1` ou `ALWAYS_REQUIRE_QR` limpa auth e reinicia. |
| `POST` | `/warmup?session=` | Boot rápido; `{ warming \| alreadyRunning }`. |
| `POST` | `/send` | Texto e **mídia** (ver secção abaixo). |
| `GET` | `/qr?session=&wait=N` | Long-poll JSON; sem `wait`, **JSON por default**; HTML só com `format=html`. |
| `DELETE` | `/session?session=` | Remove sessão em memória **e** limpa pasta auth no disco. |
| `GET` | `/events?session=` | SSE (opcional). |
| `GET` | `/health` | `{ ok, data: { status, uptimeSeconds, activeSessions } }`. |

**`activeSessions` em `/health`** = apenas sessões **em memória** no processo atual (não espelha banco Instanzia).

### `POST /send`

- **Texto (default):** `tipo` omitido ou `"text"`; `mensagem` (até 4000 caracteres).
- **Mídia:** `tipo`: `image` | `video` | `audio` | `document` + `session` + `numero` + **`arquivoBase64`** (ou data URI `data:...;base64,...`) **ou** `url` (HTTPS; host deve estar em `MEDIA_FETCH_ALLOWED_HOSTS`).
- **`mimeType`** recomendado para mídia (ex. `audio/ogg`, `application/pdf`). Se ausente, tenta cabeçalho do download ou um default seguro.
- **`caption` / `legenda`:** opcional (imagem, vídeo, documento); até 1024 caracteres.
- **`nomeArquivo`:** recomendado para `document`.
- **Áudio tipo “figurinha de voz”:** `tipo: "audio"` + `ptt: true` (WhatsApp usa OGG Opus no envio).

Após envio bem-sucedido (texto ou mídia), o backend envia um **`messages.upsert`** sintético com `source: "api_send"` e o mesmo **`messageId`** retornado pelo Baileys, para o Instanzia **contar envios** mesmo se o eco nativo atrasar ou for filtrado. **Deduplicar por `messageId`** se também processarem o upsert nativo do Baileys (evita contagem dupla).

---

## Webhooks enviados por `index.js` (POST JSON)

Função interna: **`postInstanziaWebhook`** → URL `INSTANZIA_EVENTS_URL` (fallback legado `LOVABLE_EVENTS_URL`).

- **`connection.update`** — `sessionId`, `connection`, `hasQr`, `disconnectStatusCode`; com **`connection === "open"`** também **`me`** (JID) e **`phone_number`**.
- **`qr`** — `sessionId`, `qr` (data URL), `updatedAt`.
- **`messages.upsert`** — `text`, **`contentType`** (ex. `audioMessage`, `conversation`), `messageId`, `timestamp`, `fromMe`, `from`, `upsertType`. Opcionalmente **`source: "api_send"`** (eco pós-`/send`).
- **`messages.update`** — entregue / lida (`status`); deduplicar por `messageId`.

Em **`connection === "close"`** com **401**, o servidor remove sessão e **`clearAuthState`**.

### Alertas (produto) vs este backend

| Caso | O que existe hoje |
|------|-------------------|
| Instância **desconectada** | Webhook **`connection.update`** + SSE **`disconnected`**; logs **`lastDisconnect`**. |
| **Webhook com falha** | `postInstanziaWebhook` só registra erro em log — não notifica o painel automaticamente. |

---

## Comportamento esperado (operacional)

- **Contadores / gráfico:** contar **`messages.upsert`** por `messageId` (dedupe), usando **`contentType` ou `text`** (mídia costuma ter `text` vazio).
- **Card “Conectada”** vs **`activeSessions: 0`:** estado da UI costuma vir do **banco**; `/health` só conta RAM.
- **`LOVABLE_EVENTS_URL` falhando** (deploys antigos): mesmo sintoma; migrar para **`INSTANZIA_EVENTS_URL`**.

### Múltiplos webhooks por instância

**Não implementado.** Hoje uma URL global. Evolução: fan-out no `.env` ou URLs por sessão.

---

## Fluxo rápido alteração → produção (`index.js` no Render)

1. Commit em `main`.
2. Push → redeploy.
3. Conferir env (`WHATSAPP_AUTH_ROOT`, `INSTANZIA_EVENTS_URL`, `MEDIA_FETCH_ALLOWED_HOSTS` se usar `url`).
4. Validar logs de boot (`📁 Auth Baileys…`, `🔗 Webhook Instanzia…`).

---

## Histórico já registrado neste repo

- `POST /send` com **mídia** (base64 ou URL com allowlist), limites `JSON_BODY_LIMIT` / `MEDIA_MAX_BYTES`.
- Eco **`messages.upsert`** com `source: "api_send"` para métricas de envio.
- Webhook **`INSTANZIA_*`** com fallback **`LOVABLE_*`**; nomenclatura Instanzia (sem Chatfy).
- Filtros opcionais de webhook; `contentType` nos upserts; QR JSON default; 515 reconexão rápida.

Se o deploy migrar para **API+Worker**, revisar **`worker.js`** e alinhar payloads.

---

*Última revisão deste arquivo: 2026-05-14.*

*Pedir explicitamente “ler `CONTEXT.md`” em chats novos após clone, se o time usar essa convenção.*
