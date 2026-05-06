# Paid AI Seller API

TypeScript Express server that sells OpenAI-compatible inference behind `x402` on Base mainnet.

## What this repo is

This repo is the **seller** side of the flow:

- it exposes paid endpoints at `POST /v1/chat/completions` and `POST /v1/responses`
- it returns `402 Payment Required` until the buyer attaches a valid x402 payment
- after payment, it forwards the request to an OpenAI-compatible provider with the server's private API key

This means buyers do **not** need your provider key. They need a wallet. The server needs the provider key.

## What is in the repo

- [src/server.ts](/e:/bizwax/Testing/ai-model/src/server.ts) boots the Express app
- [src/x402.ts](/e:/bizwax/Testing/ai-model/src/x402.ts) defines paid routes and x402 middleware
- [src/routes/generate.ts](/e:/bizwax/Testing/ai-model/src/routes/generate.ts) implements the paid OpenAI-compatible endpoints
- [src/config/env.ts](/e:/bizwax/Testing/ai-model/src/config/env.ts) loads and validates environment variables
- [scripts/test-buyer.ts](/e:/bizwax/Testing/ai-model/scripts/test-buyer.ts) runs the local buyer retry flow against this server

## How the payment flow works

1. A buyer sends a request to this server.
2. The server responds with `402 Payment Required`.
3. The buyer signs the x402 payment payload.
4. The buyer retries with the payment header.
5. The server settles the x402 payment and then calls the upstream AI provider.
6. The server returns the model response.

That is the flow exercised by [scripts/test-buyer.ts](/e:/bizwax/Testing/ai-model/scripts/test-buyer.ts).

## Current network and payment mode

- network: `eip155:8453` Base mainnet
- facilitator default: `https://api.cdp.coinbase.com/platform/v2/x402`
- payment scheme: `upto`
- pricing: usage-settled with a minimum of `$0.001` and a maximum request cap of `$6`

The x402 metadata is registered in [src/x402.ts](/e:/bizwax/Testing/ai-model/src/x402.ts).

## Required environment

Copy [`.env.example`](/e:/bizwax/Testing/ai-model/.env.example) to [`.env`](/e:/bizwax/Testing/ai-model/.env) and fill in real values.

### Seller-side x402 values

- `PAY_TO_ADDRESS`
- `X402_NETWORK=eip155:8453`
- `X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
- `CDP_API_KEY_ID`
- `CDP_API_KEY_SECRET`

### Seller-side provider values

Use one OpenAI-compatible provider configuration.

Standard OpenAI-compatible:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- `OPENAI_MODEL`

Azure-compatible:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_DEPLOYMENT`

Compatibility fallbacks currently accepted by [src/config/env.ts](/e:/bizwax/Testing/ai-model/src/config/env.ts):

- `GPT_5.5_KEY`
- `AZURE_OPENAI_MODEL`
- `WALLET`
- `wallet`

### Buyer test values

- `BUYER_PRIVATE_KEY`
- `BUYER_RPC_URL` optional, defaults to `https://mainnet.base.org`
- `BUYER_TARGET_URL` optional, defaults to `https://api.zeno.finance/v1/responses`
- `BUYER_PROMPT` optional

## Install and run

```bash
npm install
npm run dev
```

Default local server URL:

```text
http://localhost:4021
```

Build and run compiled output:

```bash
npm run build
npm start
```

Run under PM2:

```bash
npm run pm2:start
npm run pm2:status
npm run pm2:logs
```

Common PM2 management commands:

```bash
npm run pm2:restart
npm run pm2:reload
npm run pm2:stop
npm run pm2:delete
```

PM2 uses [ecosystem.config.cjs](/e:/bizwax/Testing/ai-model/ecosystem.config.cjs) and writes process logs to:

- [server.log](/e:/bizwax/Testing/ai-model/server.log)
- [server.err.log](/e:/bizwax/Testing/ai-model/server.err.log)

## Paid endpoints

### `POST /v1/chat/completions`

OpenAI-style chat endpoint. `messages` is preferred, but the route also accepts an `input` string and converts it into a single user message.

Example:

```json
{
  "messages": [
    { "role": "user", "content": "Write a short product pitch." }
  ]
}
```

### `POST /v1/responses`

OpenAI-style responses endpoint. `input` is preferred, but `messages` is also accepted.

Example:

```json
{
  "input": "Write a short product pitch."
}
```

### Current behavior limits

- `stream=true` is rejected
- the configured server model is used when `model` is omitted
- the upstream provider response is returned mostly as-is
- `/v1/responses` also adds a flattened `output_text` field

## Test the real x402 buy flow

Run:

```bash
npm run test:buyer
```

That script:

1. calls your configured paid endpoint with no payment
2. expects `402 Payment Required`
3. builds and signs the x402 payment payload from `BUYER_PRIVATE_KEY`
4. retries the same request with payment headers
5. prints the final response

By default it targets the live endpoint at `https://api.zeno.finance/v1/responses`. Set `BUYER_TARGET_URL` if you want to point it at a local or alternate deployment instead.

## Bazaar discovery metadata

[src/x402.ts](/e:/bizwax/Testing/ai-model/src/x402.ts) publishes discovery metadata for:

- `POST /v1/chat/completions`
- `POST /v1/responses`

The metadata includes:

- payment scheme and price
- input schema hints
- output schema hints
- agent-marketplace tags

## Notes

- Keep `.env` private.
- Do not commit real API keys or private keys.
- This repo is currently configured for Base mainnet with the CDP facilitator.
