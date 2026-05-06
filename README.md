# Paid AI Seller API

TypeScript Express server that sells OpenAI-compatible inference behind `x402` on Base Sepolia.

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

- network: `eip155:84532` Base Sepolia
- facilitator default: `https://x402.org/facilitator`
- payment scheme: `exact`
- default price: `$0.01`

The x402 metadata is registered in [src/x402.ts](/e:/bizwax/Testing/ai-model/src/x402.ts).

## Required environment

Copy [`.env.example`](/e:/bizwax/Testing/ai-model/.env.example) to [`.env`](/e:/bizwax/Testing/ai-model/.env) and fill in real values.

### Seller-side x402 values

- `PAY_TO_ADDRESS`
- `X402_NETWORK=eip155:84532`
- `X402_FACILITATOR_URL=https://x402.org/facilitator`
- `X402_PRICE_USD=$0.01`

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
- `BUYER_RPC_URL` optional, defaults to `https://sepolia.base.org`
- `BUYER_TARGET_URL` optional, defaults to `http://localhost:4021/v1/responses`
- `BUYER_PROMPT` optional

### Venice direct-check values

- `VENICE_API_KEY` for `npm run check:venice:chat`
- `VENICE_MODEL` optional
- `VENICE_PROMPT` optional

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

1. calls your local paid endpoint with no payment
2. expects `402 Payment Required`
3. builds and signs the x402 payment payload from `BUYER_PRIVATE_KEY`
4. retries the same request with payment headers
5. prints the final response

If you want to verify the actual purchase path in this repo, this is the script to use.

## Venice scripts

Run:

```bash
npm run check:venice
npm run check:venice:chat
```

Important distinction:

- `scripts/test-buyer.ts` tests **this repo's x402 purchase flow**
- `scripts/check-venice-chat.ts` does **not** test this repo's buyer flow
- `scripts/check-venice-chat.ts` sends a direct bearer-token request to Venice using `VENICE_API_KEY`

So even if you are comparing against Venice's x402 story, the script in this repo is still using their provider API key path. That means it can still hit Venice directly and may still incur provider-side usage charges. It is a comparison/probe script, not the local x402 buy test.

If you want "just like the test buy", use `npm run test:buyer`, not the Venice chat checker.

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
- The repo is currently testnet-first.
- `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` are loaded in env, but the current server path is still configured around `https://x402.org/facilitator`.
