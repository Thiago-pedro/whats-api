# CONTEXT — whats-api × Chatfy / Lovable

Este arquivo resume o backend e decisões recentes para qualquer sessão nova no Cursor ou clone do repo.

**Sugestão:** em conversas novas, pedir para ler este arquivo antes de alterar webhooks ou fluxo de sessão.

---

## Produto

Backend Node.js (**Express + Baileys** `@whiskeysockets/baileys`) para WhatsApp multi-sessão. Frontend **Chatfy** / **Instanzia** (Lovable) consome a API e, em muitos casos, eventos via **webhook** (`LOVABLE_EVENTS_URL`).

**Nomenclatura:** no Instanzia cada cartão é uma **instância**; neste repo isso é a **sessão** Baileys — o id é o **`sessionId`** (query `?session=`, pasta `auth/<sessionId>/`). Regex: 3–60 caracteres `[a-zA-Z0-9_-]`.

**Vários usuários no Lovable:** cada login pode ter sessões novas (histórias isoladas). O `index.js` **não impõe** teto de instâncias; um limite (ex.: 15 clientes) é **regra de produto** no Lovable ou, se desejado, uma validação futura no `/start`. Várias sessões no mesmo processo aumentam RAM/CPU.

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
| `WEBHOOK_DEBUG` | `1` / `true` → loga cada webhook **bem-sucedido** (URL + preview). **Default:** silencioso em sucesso; mantém `console.error` em falha. |
| `RECONNECT_BACKOFF_BASE_MS` / `RECONNECT_BACKOFF_MAX_MS` / `RECONNECT_COOLDOWN_MS` | Backoff de reconexão (não-401). |
| `RECONNECT_RESTART_REQUIRED_MS` | Delay curto após **515** “restart required” (pós-QR). Default ~1200 ms. |
| `WHATSAPP_SYNC_HISTORY` | `1` / `true` → Baileys baixa **histórico completo** (mais RAM; pode dar **timeout** em host fraco). **Default (omitido):** histórico desligado (`shouldSyncHistoryMessage: () => false`, `syncFullHistory: false`). |

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

No **`index.js` atual**, as rotas desta tabela (incluindo **`/health`**) passam pelo **`authMiddleware`** (`x-api-key`). Se algum README antigo disser “health sem auth”, está desatualizado em relação ao código.

**`activeSessions` em `/health`** = apenas sessões **em memória** no processo atual (não espelha Supabase/Chatfy).

---

## Webhooks enviados por `index.js` (POST JSON)

- **`connection.update`** — `sessionId`, `connection`, `hasQr`, `disconnectStatusCode`; com **`connection === "open"`** também envia **`me`** (JID) e **`phone_number`** (só dígitos) para o front atualizar o cartão após reconexão sem QR.
- **`qr`** — após gerar imagem: `sessionId`, `qr` (data URL), `updatedAt`.
- **`messages.upsert`** — por mensagem (filtros opcionais acima). O payload inclui `upsertType` (ex.: **`notify`** em tempo real; **`append`** em batches de histórico). **`type === "append"`** é ignorado no handler (return antecipado) para não encaminhar rajadas típicas de sync.
- **`messages.update`** — por atualização: `fromMe`, `from`, `messageId`, `timestamp`, **`status`** (número, enum WA/Baileys). Útil no Lovable para **entregue / lida** em mensagens **enviadas por você** (`fromMe: true`); deduplicar por `messageId` para não contar o mesmo update várias vezes. Só **`messages.upsert`** não preenche essas séries no gráfico.

Em **`connection === "close"`** com **401**, o servidor remove sessão e **`clearAuthState`** (credenciais inválidas).

### Alertas (produto) vs este backend

| Caso | O que existe hoje |
|------|-------------------|
| Instância **desconectada** | Webhook **`connection.update`** + SSE **`disconnected`**; logs **`lastDisconnect`**. |
| Instância **banida** / conta com problema | **Sem** evento dedicado; inferir por **`disconnectStatusCode`** e mensagem no log (ex. códigos 401/403 conforme cenário). |
| **Webhook com falha** | `postLovableWebhook` em `index.js` só faz **`console.log`** em erro — **não** notifica o Instanzia; para alerta automático seria preciso instrumentação extra (métrica, fila ou URL interna). |

Logs de diagnóstico: linha **`🔌 lastDisconnect [sessionId]`** com `statusCode`, `reason`, `at` (sem dados sensíveis).

Reconexão automática: **515** usa delay curto; outros códigos usam backoff + cooldown.

---

## Comportamento esperado (operacional)

- **Sync / histórico** após login: muitos eventos `messages.upsert` e logs Baileys level 30 — **normal**, não é necessariamente erro.
- **QR no terminal (ASCII):** só diagnóstico; o cliente deve usar **`/qr`** ou webhook **`qr`**.
- **Card “Conectada” no Chatfy** vs **`activeSessions: 0`:** estado da UI costuma vir do **banco/Lovable**; `/health` só conta RAM — podem divergir até o webhook/front atualizar.
- **Uptime “do sistema” (ex. vários dias)** no canto do painel costuma ser **uptime do serviço/host**, não “tempo 100% sincronizado” daquela instância WhatsApp.

### Celular recebe/envia, mas o painel não atualiza

Possíveis causas (ordem prática):

1. **Socket Baileys “zumbi”** — UI ainda mostra conectado, mas o processo não recebe mais `messages.upsert`. **Teste:** desconectar/reconectar a instância ou novo `/start` com o mesmo `sessionId`.
2. **`LOVABLE_EVENTS_URL` falhando** — eventos gerados no Node, mas POST falha (só log `LOVABLE webhook falhou`). Conferir logs do Render e a edge function.
3. **Env `WEBHOOK_UPSERT_ONLY_NOTIFY` / `WEBHOOK_MAX_MESSAGE_AGE_MINUTES`** — reduzem o que é encaminhado; conferir deploy.
4. Mensagens só como **`append`** — o código **não** envia webhook para `append` (por design). Cenário raro para mensagem “nova”; se suspeitar, logar temporariamente `type` nos upserts.

**Aparelho vinculado (iPhone):** notificações no iOS podem mudar com sessão linkada sempre ativa (semelhante ao Web desktop); não é configuração específica deste arquivo.

### Múltiplos webhooks (até 3 por instância)

**Não implementado** neste repo. Hoje há uma URL global (`LOVABLE_EVENTS_URL`). Evolução possível: lista de URLs no `.env` (fan-out simples) ou até 3 URLs **por `sessionId`** (exige armazenar na sessão + API para cadastrar). O ponto de acoplamento único continua sendo a função que hoje chama `axios.post` uma vez.

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
- Documentação alinhada a **Instanzia**: instância = sessão; métricas entregue/lida via **`messages.update`**; limitações de alerta (webhook falho, ban); diagnóstico painel parado; multi-usuário Lovable sem teto no API; ideia de múltiplos webhooks como evolução.

Se o deploy de produção migrar para **API+Worker**, revisar também **`worker.js`** e alinhar payloads com este documento.

---

*Última revisão deste arquivo: 2026-05-13.*

*Pedir explicitamente “ler `CONTEXT.md`” em chats novos após clone, se o time usar essa convenção.*
