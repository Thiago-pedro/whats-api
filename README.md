# WhatsApp API Backend

Backend em Node.js (Express + Baileys) em modo simples de 1 servico
(API + conexao WhatsApp no mesmo processo), ideal para MVP e primeiros clientes.

## Configuracao

1. Copie `.env.example` para `.env`
2. Defina uma `API_KEY` forte
3. (Opcional) Defina `CORS_ORIGIN` com a URL do app frontend

## Rodando localmente

```bash
npm install
npm start
```

API em `http://localhost:3000`.

## Autenticacao

Rotas protegidas exigem headers:

`x-api-key: SUA_API_KEY`

## Endpoints

- `GET /health` (sem auth)
- `GET /start?session=nome_sessao` (com auth + tenant)
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

## Fluxo recomendado

1. Chamar `GET /start?session=<id_cliente>`
2. Chamar `GET /qr?session=<id_cliente>` e escanear QR
3. Aguardar conexao da sessao
4. Chamar `POST /send` para envio

## Escalabilidade

Este modo e indicado para iniciar com baixo custo.
Quando atingir cerca de 15-20 clientes ativos, a recomendacao e migrar para
arquitetura desacoplada (API + worker + fila + persistencia externa).
