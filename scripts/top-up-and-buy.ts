import dotenv from "dotenv";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createPermit2ApprovalTx, toClientEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, createWalletClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";

dotenv.config();

type SiwxChallenge = {
  info: {
    domain: string;
    uri: string;
    version: string;
    nonce: string;
    issuedAt: string;
    expirationTime: string;
    statement: string;
  };
  supportedChains: Array<{
    chainId: string;
    type: "eip191";
  }>;
};

type ChallengeResponse = {
  siwxChallenge?: SiwxChallenge;
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

type BalanceResponse = {
  success?: boolean;
  data?: {
    walletAddress?: string;
    balanceUsd?: number;
    canConsume?: boolean;
    minimumBalanceUsd?: number;
    minimumTopUpUsd?: number;
    suggestedTopUpUsd?: number;
  };
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function getNetwork(): "eip155:8453" | "eip155:84532" {
  const configured = process.env.X402_NETWORK?.trim();
  return configured === "eip155:8453" ? "eip155:8453" : "eip155:84532";
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

function decodePaymentRequired(headerValue: string | null): PaymentRequiredShape | null {
  if (!headerValue) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(headerValue, "base64url").toString("utf8")) as PaymentRequiredShape;
  } catch {
    return null;
  }
}

async function callEndpoint(url: string, body: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(headers || {}),
    },
    body,
  });
}

async function createSignInWithXHeader(privateKey: `0x${string}`, challenge: SiwxChallenge): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  const matchingChain = challenge.supportedChains.find((chain) => chain.type === "eip191");
  if (!matchingChain) {
    throw new Error("SIWX challenge did not include an eip191 supported chain.");
  }

  const payload = await createSIWxPayload(
    {
      ...challenge.info,
      chainId: matchingChain.chainId,
      type: matchingChain.type,
    },
    account,
  );

  return encodeSIWxHeader(payload);
}

async function fetchChallenge(url: string, body?: string): Promise<SiwxChallenge> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body,
  });
  const text = await response.text();
  const json = JSON.parse(text) as ChallengeResponse;

  if (!json.siwxChallenge) {
    throw new Error(`Expected SIWX challenge from ${url}. Received: ${text}`);
  }

  return json.siwxChallenge;
}

async function fetchBalance(targetUrl: string, walletAddress: string, siwxHeader: string): Promise<BalanceResponse> {
  const balanceUrl = new URL(`/v1/x402/balance/${walletAddress}`, new URL(targetUrl)).toString();
  const response = await fetch(balanceUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Sign-In-With-X": siwxHeader,
    },
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Balance check failed with ${response.status}: ${text}`);
  }

  return JSON.parse(text) as BalanceResponse;
}

function printPaymentFailure(response: Response, responseText: string): PaymentRequiredShape | null {
  const paymentRequired = decodePaymentRequired(response.headers.get("payment-required"));
  const accept = paymentRequired?.accepts?.[0];

  console.log("Top-up failed:", response.status, response.statusText);
  if (paymentRequired?.error) {
    console.log("Facilitator error:", paymentRequired.error);
  }
  if (accept?.amount) {
    console.log("Required amount atomic:", accept.amount);
  }
  if (accept?.asset) {
    console.log("Token address:", accept.asset);
  }
  if (accept?.network) {
    console.log("Network:", accept.network);
  }
  console.log("Raw response:", responseText);

  return paymentRequired;
}

async function approvePermit2(input: {
  tokenAddress: `0x${string}`;
  account: ReturnType<typeof privateKeyToAccount>;
  chain: typeof base | typeof baseSepolia;
  rpcUrl: string;
  publicClient: ReturnType<typeof createPublicClient>;
}): Promise<void> {
  const walletClient = createWalletClient({
    account: input.account,
    chain: input.chain,
    transport: http(input.rpcUrl),
  });
  const approvalTx = createPermit2ApprovalTx(input.tokenAddress);

  console.log("Submitting Permit2 approval transaction...");
  console.log("Approval token:", input.tokenAddress);
  console.log("Approval transaction target:", approvalTx.to);

  const hash = await walletClient.sendTransaction({
    to: approvalTx.to,
    data: approvalTx.data,
  });

  console.log("Permit2 approval tx:", hash);
  console.log("Waiting for Permit2 approval confirmation...");
  const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
  console.log("Permit2 approval confirmed in block:", receipt.blockNumber.toString());
}

async function main(): Promise<void> {
  const buyerPrivateKey = requireEnv("BUYER_PRIVATE_KEY") as `0x${string}`;
  const targetUrl = process.env.BUYER_TARGET_URL?.trim() || "http://localhost:4021/v1/responses";
  const prompt = process.env.BUYER_PROMPT?.trim() || "What is 2+2?";
  const rpcUrl = process.env.BUYER_RPC_URL?.trim() || "https://sepolia.base.org";
  const topUpAmountUsd = Number(process.env.BUYER_TOP_UP_USD?.trim() || "3");
  const network = getNetwork();

  if (!Number.isFinite(topUpAmountUsd) || topUpAmountUsd <= 0) {
    throw new Error("BUYER_TOP_UP_USD must be a positive number.");
  }

  const account = privateKeyToAccount(buyerPrivateKey);
  const chain = network === "eip155:8453" ? base : baseSepolia;
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });
  const signer = toClientEvmSigner(account, publicClient);
  const client = new x402Client().register(network, new ExactEvmScheme(signer));
  const httpClient = new x402HTTPClient(client);

  const body = getBodyForTarget(targetUrl, prompt);
  const topUpUrl = new URL("/v1/x402/top-up", new URL(targetUrl)).toString();
  const topUpBody = JSON.stringify({ amountUsd: topUpAmountUsd });

  console.log("Wallet address:", account.address);
  console.log("Target URL:", targetUrl);
  console.log("Top-up URL:", topUpUrl);
  console.log("Top-up USD:", topUpAmountUsd);

  const topUpRequiredResponse = await callEndpoint(topUpUrl, topUpBody);
  const topUpRequiredText = await topUpRequiredResponse.text();
  console.log("Top-up preflight status:", topUpRequiredResponse.status, topUpRequiredResponse.statusText);

  if (topUpRequiredResponse.status !== 402) {
    console.log("Top-up preflight body:", topUpRequiredText);
    return;
  }

  const paymentRequired = httpClient.getPaymentRequiredResponse((name) => topUpRequiredResponse.headers.get(name));
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

  const topUpPaidResponse = await callEndpoint(topUpUrl, topUpBody, paymentHeaders);
  const topUpPaidText = await topUpPaidResponse.text();
  console.log("Top-up paid status:", topUpPaidResponse.status, topUpPaidResponse.statusText);

  if (!topUpPaidResponse.ok) {
    const paymentFailure = printPaymentFailure(topUpPaidResponse, topUpPaidText);
    const accept = paymentFailure?.accepts?.[0];

    if (
      paymentFailure?.error?.includes("allowance_required") &&
      accept?.asset?.startsWith("0x")
    ) {
      await approvePermit2({
        tokenAddress: accept.asset as `0x${string}`,
        account,
        chain,
        rpcUrl,
        publicClient,
      });

      console.log("Retrying top-up after Permit2 approval...");
      const retryPaymentPayload = await httpClient.createPaymentPayload(paymentRequired);
      const retryPaymentHeaders = httpClient.encodePaymentSignatureHeader(retryPaymentPayload);
      const retryTopUpPaidResponse = await callEndpoint(topUpUrl, topUpBody, retryPaymentHeaders);
      const retryTopUpPaidText = await retryTopUpPaidResponse.text();
      console.log("Retry top-up paid status:", retryTopUpPaidResponse.status, retryTopUpPaidResponse.statusText);

      if (!retryTopUpPaidResponse.ok) {
        printPaymentFailure(retryTopUpPaidResponse, retryTopUpPaidText);
        return;
      }

      console.log("Top-up response:", retryTopUpPaidText);
    } else {
      return;
    }

  } else {
    console.log("Top-up response:", topUpPaidText);
  }

  const balanceChallenge = await fetchChallenge(new URL(`/v1/x402/balance/${account.address}`, new URL(targetUrl)).toString());
  const balanceSiwxHeader = await createSignInWithXHeader(buyerPrivateKey, balanceChallenge);
  const balance = await fetchBalance(targetUrl, account.address, balanceSiwxHeader);
  console.log("Balance after top-up:", balance.data?.balanceUsd ?? "unknown");

  const requestChallenge = await fetchChallenge(targetUrl, body);
  const requestSiwxHeader = await createSignInWithXHeader(buyerPrivateKey, requestChallenge);
  const paidResponse = await callEndpoint(targetUrl, body, {
    "X-Sign-In-With-X": requestSiwxHeader,
  });
  const paidText = await paidResponse.text();

  console.log("Paid request status:", paidResponse.status, paidResponse.statusText);
  console.log("Paid response:", paidText);
}

main().catch((error) => {
  console.error("Top-up and buy test failed");
  console.error(error);
  process.exitCode = 1;
});
