export const serviceDescriptions = {
  serviceName: "Zeno",
  serviceDomain: "api.zeno.finance",
  serviceOverview:
    "General-purpose AI inference for wallet-native agents and apps.",
  marketplaceTagline:
    "OpenAI-compatible wallet-paid inference on Base.",
  marketplaceUseCases: [
    "Run general-purpose prompting and reasoning tasks",
    "Generate concise JSON or plain-text outputs for agent workflows",
    "Support chat-style and responses-style OpenAI-compatible requests",
    "Use wallet-paid inference without managing a separate provider API key",
  ],
  responsesBazaarDescription:
    "General-purpose Responses API from api.zeno.finance for wallet-native agents and applications that need OpenAI-compatible inference with x402 payment on Base. Pricing starts at $0.001 and is usage-settled up to a $6 per-request cap. Buyers send prompt or structured input and receive a concise machine-friendly JSON response with output text, token usage, and request cost. Suitable for agent workflows, automations, assistants, and applications that want paid inference without managing a separate provider API key.",
  chatCompletionsBazaarDescription:
    "General-purpose Chat Completions API from api.zeno.finance for agents and applications that need OpenAI-compatible conversational inference with wallet-paid access. Pricing starts at $0.001 and is usage-settled up to a $6 per-request cap. Buyers pay per request with x402 on Base and receive a standard chat.completion response plus token usage and request cost for assistants, copilots, and multi-step agent loops without needing a separate provider API key.",
  paymentRequired:
    "This api.zeno.finance AI endpoint requires a valid x402 payment before inference will run. Sign the payment requirements with an x402-compatible wallet or agent client, then retry the same request with the PAYMENT-SIGNATURE header.",
  settlementFailed:
    "The x402 payment for this api.zeno.finance AI request could not be settled. Ensure the wallet has enough supported USDC and retry with a fresh payment signature.",
} as const;
