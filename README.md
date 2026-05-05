# WhatsApp API Backend

Backend em Node.js (Express + Baileys) pronto para integrar com frontend no Lovable.

## Configuracao

1. Copie `.env.example` para `.env`
2. Defina uma `API_KEY` forte
3. (Opcional) Defina `CORS_ORIGIN` com a URL do app no Lovable

## Rodando localmente

```bash
npm install
npm start
```

API disponivel em `http://localhost:3000`.

## Autenticacao

As rotas protegidas exigem header:

`x-api-key: SUA_API_KEY`

## Endpoints

- `GET /health` (sem auth)
- `GET /start?session=nome_sessao` (com auth)
- `GET /qr?session=nome_sessao` (com auth)
- `POST /send` (com auth)

### Payload `/send`

```json
{
  "session": "cliente_1",
  "numero": "5511999999999",
  "mensagem": "Ola!"
}
```

## Respostas principais

- `401`: api key invalida/ausente
- `400`: validacao de dados
- `404`: sessao nao encontrada
- `409`: sessao inicializando ou nao conectada
- `200`: mensagem enviada

## Fluxo recomendado para Lovable

1. Chamar `GET /start?session=<id_cliente>`
2. Escanear QR no terminal do backend
3. Aguardar conexao da sessao
4. Chamar `POST /send` para envio de mensagens
