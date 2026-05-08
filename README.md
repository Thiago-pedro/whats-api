# WhatsApp API Backend

Backend em Node.js (Express + Baileys) com dois modos de execucao.

## Modo oficial (recomendado agora)

`index.js` (API + conexao WhatsApp no mesmo processo).

Este e o modo padrao do projeto e o usado por `npm start` (ideal para fase de testes com Lovable e deploy simples no Render).

## Modo alternativo (futuro/escala)

`api.js` + `worker.js` (API separada do processamento com fila/Redis).

Use este modo quando quiser escalar para maior volume de sessoes e processamento desacoplado.

## Configuracao

1. Copie `.env.example` para `.env`
2. Defina uma `API_KEY` forte
3. (Opcional) Defina `CORS_ORIGIN` com a URL do frontend
4. (Opcional) Defina `LOVABLE_EVENTS_URL` e `LOVABLE_WEBHOOK_SECRET` para receber eventos

## Scripts

```bash
npm start         # modo oficial (index.js)
npm run dev       # modo oficial (index.js)
npm run start:api # modo alternativo - API
npm run start:worker # modo alternativo - worker
```

## Rodando localmente (modo oficial)

```bash
npm install
npm start
```

API em `http://localhost:3000`.

## Autenticacao

Rotas protegidas exigem header:

`x-api-key: SUA_API_KEY`

## Endpoints (modo oficial)

- `GET /health` (sem auth)
- `GET /start?session=nome_sessao` (com auth)
- `GET /qr?session=nome_sessao` (com auth)
- `POST /send` (com auth)
- `DELETE /session?session=nome_sessao` (com auth)

### Payload `/send`

```json
{
  "session": "cliente_1",
  "numero": "5511999999999",
  "mensagem": "Ola!"
}
```

## Fluxo recomendado

1. Chamar `GET /start?session=<id_cliente>`
2. Chamar `GET /qr?session=<id_cliente>` e escanear o QR
3. Aguardar conexao da sessao
4. Chamar `POST /send` para envio de mensagem

## Observacao para Render + Lovable

- Se continuar usando `npm start`, o comportamento atual nao muda.
- Alteracoes no modo alternativo (`api.js` + `worker.js`) nao afetam o fluxo atual enquanto voce nao trocar o comando de inicializacao/deploy.
