import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { toClientEvmSigner } from "@x402/evm";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, formatUnits, getContract, http } from "viem";
import { base, baseSepolia } from "viem/chains";

dotenv.config();

type FinalResponseBody = {
  output_text?: string;
};

type PaymentRequiredShape = {
  error?: string;
  accepts?: Array<{
    amount?: string;
    asset?: string;
    network?: string;
    payTo?: string;
  }>;
};

const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const;
const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function getNetwork(): "eip155:8453" | "eip155:84532" {
  const configured = process.env.X402_NETWORK?.trim();
  return configured === "eip155:84532" ? "eip155:84532" : "eip155:8453";
}

function getRpcUrl(network: "eip155:8453" | "eip155:84532"): string {
  const configured = process.env.BUYER_RPC_URL?.trim();
  if (configured) {
    return configured;
  }

  return network === "eip155:84532" ? "https://sepolia.base.org" : "https://mainnet.base.org";
}

function getBodyForTarget(targetUrl: string, prompt: string): string {
  const model = process.env.BUYER_MODEL?.trim();

  if (targetUrl.endsWith("/v1/chat/completions")) {
    return JSON.stringify({
      ...(model ? { model } : {}),
      messages: [{ role: "user", content: prompt }],
    });
  }

  return JSON.stringify({
    ...(model ? { model } : {}),
    input: prompt,
  });
}

async function callEndpoint(
  targetUrl: string,
  body: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(targetUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
    body,
  });
}

function getOutputText(responseText: string): string | null {
  try {
    const parsed = JSON.parse(responseText) as FinalResponseBody;
    return typeof parsed.output_text === "string" && parsed.output_text.trim() !== "" ? parsed.output_text : null;
  } catch {
    return null;
  }
}

function decodePaymentRequired(headerValue: string | null): PaymentRequiredShape | null {
  if (!headerValue) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue, "base64url").toString("utf8");
    return JSON.parse(decoded) as PaymentRequiredShape;
  } catch {
    return null;
  }
}

function describePaymentFailure(code: string | undefined): string {
  if (code?.includes("insufficient_funds")) {
    return "The wallet does not hold enough supported USDC to pay for this api.zeno.finance request.";
  }

  if (code === "permit2_insufficient_balance") {
    return "The wallet does not hold enough supported USDC to pay for this api.zeno.finance request.";
  }

  if (code === "permit2_insufficient_allowance") {
    return "The wallet has not approved enough supported USDC for this api.zeno.finance request.";
  }

  return "The paid retry did not settle successfully.";
}

function printPaidResponse(responseText: string): void {
  const outputText = getOutputText(responseText);
  if (outputText) {
    console.log("Output:", outputText);
    return;
  }

  console.log("Paid response body:", responseText);
}

async function inspectTokenState(input: {
  publicClient: ReturnType<typeof createPublicClient>;
  buyerAddress: `0x${string}`;
  assetAddress?: string;
}): Promise<{
  balanceAtomic: string;
  balanceFormatted: string;
  allowanceAtomic: string;
  allowanceFormatted: string;
} | null> {
  if (!input.assetAddress || !input.assetAddress.startsWith("0x")) {
    return null;
  }

  const token = getContract({
    address: input.assetAddress as `0x${string}`,
    abi: ERC20_READ_ABI,
    client: input.publicClient,
  });

  const [balance, allowance] = await Promise.all([
    token.read.balanceOf([input.buyerAddress]),
    token.read.allowance([input.buyerAddress, PERMIT2_ADDRESS]),
  ]);

  return {
    balanceAtomic: balance.toString(),
    balanceFormatted: formatUnits(balance, 6),
    allowanceAtomic: allowance.toString(),
    allowanceFormatted: formatUnits(allowance, 6),
  };
}

async function main(): Promise<void> {
  const buyerPrivateKey = requireEnv("BUYER_PRIVATE_KEY") as `0x${string}`;
  const targetUrl = process.env.BUYER_TARGET_URL?.trim() || "http://localhost:4021/v1/responses";
  const prompt = process.env.BUYER_PROMPT?.trim() || "What is 2+2?";
  const buyerModel = process.env.BUYER_MODEL?.trim() || "server-default";
  const network = getNetwork();
  const rpcUrl = getRpcUrl(network);

  const account = privateKeyToAccount(buyerPrivateKey);
  const publicClient = createPublicClient({
    chain: network === "eip155:84532" ? baseSepolia : base,
    transport: http(rpcUrl),
  });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client().register(network, new UptoEvmScheme(signer));
  const httpClient = new x402HTTPClient(client);

  const body = getBodyForTarget(targetUrl, prompt);
  const initialResponse = await callEndpoint(targetUrl, body);
  const initialText = await initialResponse.text();

  console.log("Buyer address:", account.address);
  console.log("Target URL:", targetUrl);
  console.log("Requested model:", buyerModel);
  console.log("Initial status:", initialResponse.status);

  if (initialResponse.status !== 402) {
    printPaidResponse(initialText);
    return;
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => initialResponse.headers.get(name));
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const paidResponse = await callEndpoint(targetUrl, body, paymentHeaders);
  const paidText = await paidResponse.text();

  console.log("Paid status:", paidResponse.status);

  if (!paidResponse.ok) {
    const retryPaymentRequired = decodePaymentRequired(paidResponse.headers.get("payment-required"));
    const retryAccept = retryPaymentRequired?.accepts?.[0];
    const tokenState = await inspectTokenState({
      publicClient,
      buyerAddress: account.address,
      assetAddress: retryAccept?.asset,
    });

    console.log(describePaymentFailure(retryPaymentRequired?.error));
    if (retryAccept?.amount) {
      console.log("Required amount (atomic):", retryAccept.amount);
    }
    if (retryAccept?.network) {
      console.log("Payment network:", retryAccept.network);
    }
    if (retryAccept?.asset) {
      console.log("Payment asset:", retryAccept.asset);
    }
    if (tokenState) {
      console.log("Wallet token balance (atomic):", tokenState.balanceAtomic);
      console.log("Wallet token balance:", tokenState.balanceFormatted);
      console.log("Permit2 allowance (atomic):", tokenState.allowanceAtomic);
      console.log("Permit2 allowance:", tokenState.allowanceFormatted);
    }
    console.log("Paid response body:", paidText);
    return;
  }

  printPaidResponse(paidText);
}

main().catch((error) => {
  console.error("Buyer test failed");
  console.error(error);
  process.exitCode = 1;
});
