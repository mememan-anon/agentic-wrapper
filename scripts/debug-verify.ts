import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { createFacilitatorConfig } from "@coinbase/x402";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";

dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getNetwork(): "eip155:8453" | "eip155:84532" {
  return process.env.X402_NETWORK?.trim() === "eip155:84532" ? "eip155:84532" : "eip155:8453";
}

function getRpcUrl(network: "eip155:8453" | "eip155:84532"): string {
  const configured = process.env.BUYER_RPC_URL?.trim();
  if (configured) {
    return configured;
  }

  return network === "eip155:84532" ? "https://sepolia.base.org" : "https://mainnet.base.org";
}

function getDebugTargetUrl(): string {
  return process.env.DEBUG_TARGET_URL?.trim() || "http://localhost:4023/v1/responses";
}

function getDebugBody(targetUrl: string): string {
  const model = process.env.BUYER_MODEL?.trim() || "gpt-5.4";
  const prompt = process.env.BUYER_PROMPT?.trim() || "2+2?";

  if (targetUrl.endsWith("/v1/chat/completions")) {
    return JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    });
  }

  return JSON.stringify({
    model,
    input: prompt,
  });
}

async function main(): Promise<void> {
  const buyerPrivateKey = requireEnv("BUYER_PRIVATE_KEY") as `0x${string}`;
  const network = getNetwork();
  const rpcUrl = getRpcUrl(network);
  const targetUrl = getDebugTargetUrl();
  const body = getDebugBody(targetUrl);

  const account = privateKeyToAccount(buyerPrivateKey);
  const publicClient = createPublicClient({
    chain: network === "eip155:84532" ? baseSepolia : base,
    transport: http(rpcUrl),
  });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client().register(network, new UptoEvmScheme(signer));
  const httpClient = new x402HTTPClient(client);
  const facilitatorConfig = createFacilitatorConfig(
    process.env.CDP_API_KEY_ID || undefined,
    process.env.CDP_API_KEY_SECRET || undefined,
  );

  const unpaid = await fetch(targetUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  console.log("Buyer address:", account.address);
  console.log("Target URL:", targetUrl);
  console.log("Initial status:", unpaid.status);

  if (unpaid.status !== 402) {
    console.log("Unexpected non-402 response:");
    console.log(await unpaid.text());
    return;
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => unpaid.headers.get(name));
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);

  console.log("Payment requirements:");
  console.log(JSON.stringify(paymentRequired, null, 2));
  console.log("Payment payload:");
  console.log(JSON.stringify(paymentPayload, null, 2));

  const authHeaders = await facilitatorConfig.createAuthHeaders();
  const verifyResponse = await fetch("https://api.cdp.coinbase.com/platform/v2/x402/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders.verify,
    },
    body: JSON.stringify({
      x402Version: paymentPayload.x402Version,
      paymentPayload,
      paymentRequirements: paymentPayload.accepted,
    }),
  });

  console.log("Facilitator verify status:", verifyResponse.status);
  console.log("Facilitator verify body:");
  console.log(await verifyResponse.text());
}

main().catch((error) => {
  console.error("Debug verify failed");
  console.error(error);
  process.exitCode = 1;
});
