# CONTEXT — whats-api × Instanzia

Este arquivo resume o backend e decisões recentes para qualquer sessão nova no Cursor ou clone do repo.

**Sugestão:** em conversas novas, pedir para ler este arquivo antes de alterar webhooks ou fluxo de sessão.

---

## Produto

Backend Node.js (**Express + Baileys** `@whiskeysockets/baileys`) para WhatsApp multi-sessão. O painel **Instanzia** (stack Lovable) consome a API e, em muitos casos, eventos via **webhook** (`INSTANZIA_EVENTS_URL`).

**Nomenclatura:** no Instanzia cada cartão é uma **instância**; neste repo isso é a **sessão** Baileys — o id é o **`sessionId`** (query `?session=`, pasta `auth/<sessionId>/`). Regex: 3–60 caracteres `[a-zA-Z0-9_-]`.

**Vários usuários:** cada login pode ter sessões novas (histórias isoladas). O `index.js` **não impõe** teto de instâncias; um limite (ex.: 15 clientes) é **regra de produto** no Instanzia ou, se desejado, uma validação futura no `/start`. Várias sessões no mesmo processo aumentam RAM/CPU.

### Integração “plug and play” (site externo, ex. Le Chef)

- **`INSTANZIA_EVENTS_URL`** (ex. `…/whatsapp-events`) é **entrada de eventos**: o **Render** faz POST **para** o Instanzia. **Não** é o endpoint público para o site do cliente **enviar** mensagem.
- **Envio** para o WhatsApp no motor atual: **`POST https://<render>/send`** com **`x-api-key`** = `API_KEY` do Render e body `session` + `numero` + `mensagem` (ver secção API).
- Para o **comprador final** não mexer com `API_KEY` do Render: implementar no **Instanzia** (Lovable) uma **API pública** (edge function) que valida chave tipo `cfy_…` + instância no banco e **reencaminha** para o Render **só no servidor** (secret), como no Le Chef.
- **Nunca** colocar `API_KEY` do Render nem segredos em código de página que roda no browser.

---

## Dois modos no repositório

| Modo | Comando | Uso |
|------|---------|-----|
| **Monolítico** | `npm start` → **`index.js`** | Deploy comum no **Render**: tudo (HTTP + Baileys) no mesmo processo. |
| **API + Worker** | `npm run start:api` + `npm run start:worker` | Fila **BullMQ** / Redis; webhooks e lógica rica costumam estar em **`worker.js`**. |

**Na prática atual (Instanzia + Render “whats-api”):** o serviço que roda costuma ser **`node index.js`**. Alterações de webhook/QR/sessão, **mídia no `/send`**, **fila de envio** e **`contentType`** nos upserts estão em **`index.js`**. O **`worker.js`** usa `postInstanziaWebhook` e envs `INSTANZIA_*` (fallback `LOVABLE_*`), mas **não replica** a fila de `/send` nem o contrato estendido de mídia do monólito — se um dia o deploy usar **API + worker**, alinhar explicitamente.

**Código remoto:** pushes na branch **`main`** do repositório GitHub ligado ao projeto; o Render costuma redeployar automaticamente após o push.

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
| `SEND_MIN_INTERVAL_MS` | Pausa mínima **entre** cada `sendMessage` na **mesma** `session` (fila global por sessão). Default **5000**. Use **0** para desligar (ex.: debug). |

Outras envs (`DATABASE_URL`, `QUEUE_NAME`, …) pertencem a **`api.js` / `worker.js` / lib** — o **`index.js` não lê** `AUTH_BASE_PATH` (usar `WHATSAPP_AUTH_ROOT`).

---

## API HTTP (resumo do contrato `index.js`)

Todas as rotas abaixo exigem **`x-api-key`** (incluindo **`GET /health`**).

| Método | Rota | Notas |
|--------|------|--------|
| `GET` / `POST` | `/start?session=&force=0\|1` | Idempotente; `force=1` ou `ALWAYS_REQUIRE_QR` limpa auth e reinicia. |
| `POST` | `/warmup?session=` | Boot rápido; `{ warming \| alreadyRunning }`. |
| `POST` | `/send` | Texto e **mídia**; **fila por `session`** se `SEND_MIN_INTERVAL_MS` > 0 (ver secção abaixo). |
| `GET` | `/qr?session=&wait=N` | Long-poll JSON; sem `wait`, **JSON por default**; HTML só com `format=html`. |
| `GET` / `POST` | `/disconnect?session=` | **Pausa** conexão (fecha socket); **mantém** credenciais em `auth/` — reconectar com `/start` sem `force` evita novo QR (estilo Zapster). |
| `DELETE` | `/session?session=` | Remove sessão **e** apaga credenciais (exige novo QR). Não usar no botão “Desconectar” do painel. |
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
- **Fila de envio (anti-disparo em massa):** por `session`, o servidor **serializa** todos os `POST /send` e impõe **pelo menos** `SEND_MIN_INTERVAL_MS` milissegundos entre o fim de um envio e o início do próximo (default 5 s). Vários pedidos em paralelo entram na fila; a resposta HTTP **só volta depois** da vez daquele pedido na fila. Quando a fila está ativa, a resposta pode incluir **`filaIntervaloMs`** (valor do intervalo) para o front mostrar progresso.

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

## Desconexões (diagnóstico rápido)

- O `index.js` registra **`lastDisconnect [sessionId]`** com `statusCode`, `reason`, `at` (ver `logLastDisconnect`).
- **`401`:** sessão deslogada; credenciais apagadas; novo QR necessário.
- **`515`:** “restart required” (comum após pareamento); reconexão rápida configurável (`RECONNECT_RESTART_REQUIRED_MS`).
- **`428`** com *Connection Terminated* (ou mensagem equivalente): encerramento do **WebSocket** pelo WhatsApp ou rede; em geral **transitório** — o serviço agenda reconexão. Causa raiz exata raramente vem além do código/mensagem; correlacionar com deploy no Render ou instabilidade de rede.

**Logs verbosos do Baileys:** mensagens com `SessionEntry`, ratchet, `chainKey`, buffers etc. costumam ser **criptografia Signal** (rotação de sessão), comuns após envio — **não** indicam por si só falha de entrega. Linhas `url generation failed` podem ser internas (mídia/URL); se texto entrega ok, muitas vezes é ruído. Preocupar-se com `lastDisconnect`, **401** e falhas reais no `/send`.

---

## Comportamento esperado (operacional)

- **Contadores / gráfico:** contar **`messages.upsert`** por `messageId` (dedupe), usando **`contentType` ou `text`** (mídia costuma ter `text` vazio).
- **Card “Conectada”** vs **`activeSessions: 0`:** estado da UI costuma vir do **banco**; `/health` só conta RAM.
- **`LOVABLE_EVENTS_URL` falhando** (deploys antigos): mesmo sintoma; migrar para **`INSTANZIA_EVENTS_URL`**.

### Múltiplos webhooks por instância

**Neste repo:** uma URL global (`INSTANZIA_EVENTS_URL`) — **um** POST por evento saindo do Render.

**No produto Instanzia (até 3 URLs por instância):** o fan-out (replicar o mesmo evento para 2–3 destinos) deve ficar **no Instanzia** após receber o POST. Assim a carga do Render **não** multiplica com o número de webhooks. Só pesaria o Render se o backend fosse alterado para disparar vários POSTs por evento.

---

## Fluxo rápido alteração → produção (`index.js` no Render)

1. Commit em `main`.
2. Push → redeploy.
3. Conferir env (`WHATSAPP_AUTH_ROOT`, `INSTANZIA_EVENTS_URL`, `SEND_MIN_INTERVAL_MS`, `MEDIA_FETCH_ALLOWED_HOSTS` se usar `url` em mídia).
4. Validar logs de boot (`📁 Auth Baileys…`, `🔗 Webhook Instanzia…`, linha da **fila** `/send` se aplicável).

---

## Histórico já registrado neste repo

- **`POST /disconnect`:** desconectar manualmente sem apagar `auth/`; **`DELETE /session`** só para remover instância / novo QR.
- Fluxo **plug and play** documentado: eventos → `INSTANZIA_EVENTS_URL`; envio público → edge Instanzia + secret; fan-out de webhooks → **Instanzia**, não multiplicar POSTs no Render.
- `POST /send` com **mídia** (base64 ou URL com allowlist), limites `JSON_BODY_LIMIT` / `MEDIA_MAX_BYTES`.
- **Fila por sessão** em `/send` com `SEND_MIN_INTERVAL_MS` (default 5 s entre envios).
- Eco **`messages.upsert`** com `source: "api_send"` para métricas de envio.
- Webhook **`INSTANZIA_*`** com fallback **`LOVABLE_*`**; nomenclatura Instanzia (sem Chatfy).
- Filtros opcionais de webhook; `contentType` nos upserts (contadores de mídia no Instanzia devem usar **`messageId` + (`text` ou `contentType`)**, não só `text`); QR JSON default; 515 reconexão rápida.

### Retomada sugerida (próxima sessão de trabalho)

- Instanzia: página **Integração** (chave `cfy_…` + instância + exemplo tipo Le Chef), API edge que repassa para o Render com secret; **logs de webhooks** na UI; campanhas com **fila + UX de progresso**.
- Opcional: alinhar **`api.js` / `worker.js`** com fila de envio e mesmo contrato de mídia do monólito, se o deploy migrar do `index.js`.

---

*Última revisão deste arquivo: 2026-05-20 (`/disconnect`, integração plug and play, fan-out webhooks).*

*Pedir explicitamente “ler `CONTEXT.md`” em chats novos após clone, se o time usar essa convenção.*
