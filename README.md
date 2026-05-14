# WhatsApp API Backend

Backend em Node.js (Express + Baileys) com dois modos de execucao.

## Modo oficial (recomendado agora)

`index.js` (API + conexao WhatsApp no mesmo processo).

Este e o modo padrao do projeto e o usado por `npm start` (Instanzia + deploy simples no Render).

## Modo alternativo (futuro/escala)

`api.js` + `worker.js` (API separada do processamento com fila/Redis).

Use este modo quando quiser escalar para maior volume de sessoes e processamento desacoplado.

## Configuracao

1. Copie `.env.example` para `.env`
2. Defina uma `API_KEY` forte
3. (Opcional) Defina `CORS_ORIGIN` com a URL do frontend
4. (Opcional) Defina `INSTANZIA_EVENTS_URL` e `INSTANZIA_WEBHOOK_SECRET` para receber eventos (ou as variaveis legado `LOVABLE_*`)

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

- `GET /health` (com `x-api-key`, como as demais rotas do modo oficial)
- `GET /start?session=nome_sessao` (com auth)
- `GET /qr?session=nome_sessao` (com auth)
- `POST /send` (com auth)
- `DELETE /session?session=nome_sessao` (com auth)

### Payload `/send`

**Texto**

```json
{
  "session": "cliente_1",
  "numero": "5511999999999",
  "mensagem": "Ola!"
}
```

**Imagem (base64)** — defina `JSON_BODY_LIMIT` no servidor se o arquivo for grande.

```json
{
  "session": "cliente_1",
  "numero": "5511999999999",
  "tipo": "image",
  "mimeType": "image/jpeg",
  "arquivoBase64": "<base64 ou data:image/jpeg;base64,...>",
  "caption": "opcional"
}
```

**Documento por URL** — no Render, defina `MEDIA_FETCH_ALLOWED_HOSTS` com o host do arquivo (apenas HTTPS).

```json
{
  "session": "cliente_1",
  "numero": "5511999999999",
  "tipo": "document",
  "url": "https://cdn.exemplo.com/arquivo.pdf",
  "mimeType": "application/pdf",
  "nomeArquivo": "proposta.pdf"
}
```

**Mensagem de voz (PTT)**

```json
{
  "session": "cliente_1",
  "numero": "5511999999999",
  "tipo": "audio",
  "ptt": true,
  "mimeType": "audio/ogg",
  "arquivoBase64": "<base64>"
}
```

Tipos suportados: `text` (default), `image`, `video`, `audio`, `document`. Ver `CONTEXT.md` para limites e seguranca.

## Fluxo recomendado

1. Chamar `GET /start?session=<id_cliente>`
2. Chamar `GET /qr?session=<id_cliente>` e escanear o QR
3. Aguardar conexao da sessao
4. Chamar `POST /send` para envio de mensagem

## Observacao para Render + Instanzia

- Com `npm start`, o servico e o `index.js` descrito acima.
- Alteracoes no modo alternativo (`api.js` + `worker.js`) nao afetam o fluxo atual enquanto voce nao trocar o comando de inicializacao/deploy.
