export const serviceDescriptions = {
  serviceName: "paid-ai-seller-api",
  bazaarTopUp:
    "Prepaid USDC top-up for wallet-authenticated OpenAI-compatible AI inference. Buyers and agents fund a local prepaid balance through x402, authenticate with Sign-In-With-X, then spend that balance on POST /v1/responses and POST /v1/chat/completions without receiving the seller's provider API key. Available models include gpt-5.5, gpt-5.4-pro, and gpt-5.4; use GET /v1/models for the live model list and current per-request pricing.",
  topUpAmountUsd:
    "USDC-denominated prepaid balance amount to add for wallet-authenticated AI inference.",
  topUpSettled:
    "Top-up settled. The wallet can now spend prepaid balance on OpenAI-compatible chat and responses inference endpoints.",
  authenticationRequired:
    "Wallet authentication is required to use this paid AI inference API. Sign the included SIWX challenge, then retry the same request with the X-Sign-In-With-X header.",
  insufficientBalance:
    "This wallet is authenticated, but its prepaid API balance is too low to buy this AI request. The service sells OpenAI-compatible chat and responses inference using prepaid USDC top-ups, so agents can authenticate once with SIWX, top up balance through x402, and then call paid model endpoints without exposing provider API keys.",
  topUpInsufficientFunds:
    "The wallet is authenticated, but it does not hold enough USDC to fund this prepaid API top-up. Add USDC on the supported chain, then retry the top-up request with a freshly signed x402 payment.",
  topUpInsufficientAllowance:
    "The wallet is authenticated, but it has not approved enough USDC to complete this prepaid API top-up. Approve or sign a fresh x402 payment for the requested amount, then retry the top-up request.",
  siwxStatement: "Sign in to access prepaid AI responses",
} as const;
