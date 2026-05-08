# CONTEXT — whats-api × Chatfy / Lovable

Este arquivo resume decisões atuais do backend para qualquer sessão nova no Cursor ou clone do repo.

## Produto

Backend Node.js (**Express + Baileys**) para WhatsApp multi-sessão. Frontend **Chatfy** montado no **Lovable**, consome eventos via webhook HTTP.

## Execução (importante para deploy)

Dois modos coexistem:

| Modo | Comando típico | Uso |
|------|----------------|-----|
| Monolítico | `npm start` → `index.js` | MVP / testes; webhook antigo (`event`: `messages.upsert`, etc.). |
| API + Worker | `npm run start:api` + `npm run start:worker` | **Produção Render** típica do Chatfy: sessões na fila **BullMQ**, sockets no **worker**. |

Na prática do projeto com Chatfy em produção, mudanças críticas de webhook costumam estar no **`worker.js`**.

## Variáveis de ambiente (webhook Chatfy/Lovable Cloud)

No Render (worker e/ou api conforme setup):

- `LOVABLE_EVENTS_URL` — URL absoluta do endpoint público que recebe eventos (ex.: path `/api/public/v1/whatsapp-events` no app Lovable).
- `LOVABLE_WEBHOOK_SECRET` — opcional; se definido, enviamos header `x-webhook-secret`.

Sem `LOVABLE_EVENTS_URL` o worker não dispara webhook.

Referência genérica de env: `.env.example` e `README.md`.

## Formato atual enviado pelo worker (`worker.js`)

O cliente HTTP usa `fetch` + `application/json`; payload serializado com suporte a `bigint` nos timestamps onde aplicável.

Log de diagnóstico antes do POST:

```text
[WEBHOOK OUT] <json>
```

### `type: "connection"`

Disparado em mudanças de sessão WhatsApp (`connection.update`):

- Campos típicos: `sessionId`, `type`, `status` (`open`, `logged_out`, `disconnected`), `phone_number`, `me`, `sockUserId`.

### `type: "message"`

Disparado apenas para **mensagens consideradas “reais”** após filtro em `messages.upsert`:

- Ignora stubs (`messageStubType`), `status@broadcast`, wrappers que não são conversa/conteúdo usuário (protocolo, reações, distribuição de chaves de grupo, polls de atualização só, pins, ephemeral settings só, etc.).
- Permite apenas tipos alinhados a texto/mídia/contato/local/interações de UI (lista em `WEBHOOK_ALLOW_MESSAGE_KEYS` no código).
- `direction`: **`inbound`** ou **`outbound`** (compatível com parser Lovable que aceita também `in`/`out` legado só no front).
- Campos úteis: `from`, `to`, `senderPn`, `recipientPn`, `fromPn`, `toPn`, `me`, `phone_number`, `sockUserId`, `text`, `message_id`, `timestamp`, `message_type`.

Texto (`text`) é extraído com `unwrapMessageNode` + `extractMessageText` (texto simples/longo, legendas, respostas de botão/lista/template, alguns previews de contact/interactive).

Números **`@lid`**: tentativa de resolver via `sock.signalRepository.lidMapping.getPNForLID`; falha → `null` nos campos de dígitos (sem mandar `@lid` cru onde o fluxo usa resolução).

### `type: "message.status"`

Origem: evento **`messages.update`** quando existe `update.status` (delivered/read, etc.). O Chatfy usa para atualizar mensagem já existente, não inflar feed com upserts falsos.

## Auth Baileys (UI “dispositivos conectados”)

Cliente Baileys usa algo como `browser: ["Windows", "Chrome", "10.0"]` — só afeta o nome exibido no WhatsApp nos aparelhos conectados.

## Scripts úteis

```bash
npm start              # index.js (monólito)
npm run start:api      # api.js
npm run start:worker   # worker.js
```

## Fluxo rápido de alteração → produção

1. Commit em `main` neste repo.
2. Render: redeploy do(s) serviço(s) afetado(s) (**worker** obrigatório quando mudar `worker.js`; API separada se mudar `api.js`).
3. Se dois serviços (`web` + `worker`), confirmar commit em **ambos**.

## Histórico de problema já endereçado aqui

- Payload com `text` vazio em recebidas: extração de texto ampliada + filtros para não mandar protocol/receipt-like como mensagem.
- Spam no feed por excesso de `messages.upsert`: filtro allow/deny por tipo protobuf + envio de status via `message.status`.
- Logs Baileys “histórico / FULL sync”: comportamento normal pós-conexão, não é erro por si só.

---

Ao abrir este projeto em uma conversa nova no Cursor: **pedir explicitamente para ler `CONTEXT.md`** ou incluir nas *rules* algo como “before changing webhooks, read CONTEXT.md”. O assistente não injeta o arquivo automaticamente em todo chat após clone.
