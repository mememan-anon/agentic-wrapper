import dotenv from "dotenv";
import { createSIWxPayload, encodeSIWxHeader } from "@x402/extensions/sign-in-with-x";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config();

type FinalResponseBody = {
  output_text?: string;
};

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

type InitialAuthResponse = {
  error?: string;
  code?: string;
  siwxChallenge?: SiwxChallenge;
};

type InsufficientBalanceResponse = {
  error?: string;
  code?: string;
  reason?: string;
  currentBalanceUsd?: number;
  minimumBalanceUsd?: number;
  minimumTopUpUsd?: number;
  suggestedTopUpUsd?: number;
  selectedModel?: string;
  requestPriceUsd?: number;
  topUpInstructions?: {
    step1?: string;
    step2?: string;
    step3?: string;
    receiverWallet?: string;
    tokenAddress?: string | null;
    tokenDecimals?: number;
    network?: string;
    minimumAmountUsd?: number;
  };
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
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

async function createSignInWithXHeader(
  privateKey: `0x${string}`,
  challenge: SiwxChallenge,
): Promise<string> {
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

function getTopUpPath(targetUrl: string): string {
  return new URL("/v1/x402/top-up", new URL(targetUrl)).toString();
}

function printPaidResponse(responseText: string): void {
  const outputText = getOutputText(responseText);
  if (outputText) {
    console.log("Output:", outputText);
    return;
  }

  console.log("Response body:", responseText);
}

async function main(): Promise<void> {
  const buyerPrivateKey = requireEnv("BUYER_PRIVATE_KEY") as `0x${string}`;
  const targetUrl = process.env.BUYER_TARGET_URL?.trim() || "http://localhost:4021/v1/responses";
  const prompt = process.env.BUYER_PROMPT?.trim() || "Tell me about the capital of France?";
  const buyerModel = process.env.BUYER_MODEL?.trim() || "server-default";

  const account = privateKeyToAccount(buyerPrivateKey);
  const body = getBodyForTarget(targetUrl, prompt);

  const initialResponse = await callEndpoint(targetUrl, body);
  const initialText = await initialResponse.text();

  if (initialResponse.status !== 402) {
    console.log("Wallet address:", account.address);
    console.log("Target URL:", targetUrl);
    console.log("Model:", buyerModel);
    console.log("Status:", initialResponse.status, initialResponse.statusText);
    console.log("");
    printPaidResponse(initialText);
    return;
  }

  const initialJson = JSON.parse(initialText) as InitialAuthResponse;
  if (!initialJson.siwxChallenge) {
    throw new Error(`Expected SIWX challenge. Received: ${initialText}`);
  }

  const siwxHeader = await createSignInWithXHeader(buyerPrivateKey, initialJson.siwxChallenge);
  const authedResponse = await callEndpoint(targetUrl, body, {
    "X-Sign-In-With-X": siwxHeader,
  });
  const authedText = await authedResponse.text();

  console.log("Wallet address:", account.address);
  console.log("Target URL:", targetUrl);
  console.log("Model:", buyerModel);

  if (authedResponse.ok) {
    console.log("Status:", authedResponse.status, authedResponse.statusText);
    printPaidResponse(authedText);
    return;
  }

  if (authedResponse.status !== 402) {
    console.log("Status:", authedResponse.status, authedResponse.statusText);
    console.log("");
    console.log("Raw response follows:");
    console.log(authedText);
    return;
  }

  const insufficientBalance = JSON.parse(authedText) as InsufficientBalanceResponse;

  console.log("Balance USD:", insufficientBalance.currentBalanceUsd ?? 0);
  console.log("Can consume:", false);
  console.log("Minimum top-up USD:", insufficientBalance.minimumTopUpUsd ?? "unknown");
  console.log("Suggested top-up USD:", insufficientBalance.suggestedTopUpUsd ?? "unknown");
  console.log("Status:", authedResponse.status, authedResponse.statusText || "Payment Required");
  console.log("");
  console.log("Wallet auth succeeded, but the wallet does not have enough local x402 balance to buy this request.");
  console.log("Top up path:", getTopUpPath(targetUrl));
  console.log("");
  console.log("Raw response follows:");
  console.log(authedText);
}

main().catch((error) => {
  console.error("Buyer test failed");
  console.error(error);
  process.exitCode = 1;
});
