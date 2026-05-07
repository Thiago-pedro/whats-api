# WhatsApp API Backend (API + Worker)

Backend em Node.js (Express + Baileys) com arquitetura desacoplada:

- **API** stateless para receber requests e enfileirar jobs
- **Worker** para manter conexoes WhatsApp e processar envios
- **Redis** para fila e estado de sessao
- **Postgres** opcional para auditoria e snapshots de sessao

## Configuracao

1. Copie `.env.example` para `.env`
2. Defina uma `API_KEY` forte
3. Defina `REDIS_URL`
4. (Opcional) Defina `DATABASE_URL` para auditoria
5. Ajuste `MAX_SESSIONS_PER_TENANT` conforme seu plano

## Variaveis de ambiente

- `PORT=3000`
- `API_KEY=...`
- `CORS_ORIGIN=*`
- `REDIS_URL=redis://127.0.0.1:6379`
- `DATABASE_URL=` (opcional)
- `QUEUE_NAME=whatsapp-jobs`
- `MAX_SESSIONS_PER_TENANT=2`
- `AUTH_BASE_PATH=auth`
- `WORKER_ID=worker-1`

## Rodando localmente

```bash
npm install
npm run worker
npm start
```

- API em `http://localhost:3000`
- Worker processa fila e mantem sockets WhatsApp

## Autenticacao e tenant

Rotas protegidas exigem headers:

- `x-api-key: SUA_API_KEY`
- `x-tenant-id: id_do_tenant` (se omitido, usa `default`)

## Endpoints

- `GET /health` (sem auth)
- `GET /start?session=nome_sessao` (com auth + tenant)
- `GET /session?session=nome_sessao` (com auth + tenant)
- `GET /qr?session=nome_sessao` (com auth + tenant)
- `POST /send` (com auth + tenant)

### Payload `/send`

```json
{
  "session": "cliente_1",
  "numero": "5511999999999",
  "mensagem": "Ola!"
}
```

## Comportamento de escala implementado

- Limite por tenant em `/start` (`MAX_SESSIONS_PER_TENANT`)
- Sessao isolada por tenant
- Estado da sessao fora da memoria local (Redis)
- Envio assíncrono em fila (`/send` responde `202 enfileirado`)

## Deploy (Render)

Para producao, crie ao menos dois servicos:

1. **API service**: comando `npm start`
2. **Worker service**: comando `npm run worker`

Ambos devem compartilhar o mesmo `REDIS_URL` e `API_KEY`.
Use disco persistente para `AUTH_BASE_PATH` se quiser manter login entre reinicios.
