import crypto from "node:crypto";
import dotenv from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config();

type VeniceBalanceResponse = {
  success?: boolean;
  data?: {
    walletAddress?: string;
    balanceUsd?: number;
    canConsume?: boolean;
    minimumTopUpUsd?: number;
    suggestedTopUpUsd?: number;
    diemBalanceUsd?: number;
  };
};

type VeniceChatResponse = {
  id?: string;
  model?: string;
  usage?: Record<string, unknown>;
  venice_parameters?: Record<string, unknown>;
  choices?: Array<{
    message?: {
      role?: string;
      content?: unknown;
      reasoning_content?: unknown;
    };
    finish_reason?: string | null;
  }>;
};

function readFirstDefined(names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return "";
}

function requireEnv(names: string[], label: string): string {
  const value = readFirstDefined(names);

  if (!value) {
    throw new Error(`Missing ${label}. Expected one of: ${names.join(", ")}`);
  }

  return value;
}

function generateNonce(length = 16): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(length);
  let nonce = "";

  for (let index = 0; index < length; index += 1) {
    nonce += alphabet[bytes[index] % alphabet.length];
  }

  return nonce;
}

function createSiweMessage(input: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  statement: string;
}): string {
  return `${input.domain} wants you to sign in with your Ethereum account:
${input.address}

${input.statement}

URI: ${input.uri}
Version: 1
Chain ID: ${input.chainId}
Nonce: ${input.nonce}
Issued At: ${input.issuedAt}
Expiration Time: ${input.expirationTime}`;
}

async function createSignInWithXHeader(
  privateKey: `0x${string}`,
  resourceUrl: string,
): Promise<{ walletAddress: string; headerValue: string }> {
  const account = privateKeyToAccount(privateKey);
  const now = new Date();
  const chainId = 8453;
  const message = createSiweMessage({
    domain: "api.venice.ai",
    address: account.address,
    statement: "Sign in to Venice AI",
    uri: resourceUrl,
    chainId,
    nonce: generateNonce(),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
  });

  const signature = await account.signMessage({
    message,
  });

  const headerValue = Buffer.from(
    JSON.stringify({
      address: account.address,
      message,
      signature,
      timestamp: now.getTime(),
      chainId,
    }),
    "utf8",
  ).toString("base64");

  return {
    walletAddress: account.address,
    headerValue,
  };
}

async function fetchBalance(
  walletAddress: string,
  signInHeader: string,
): Promise<VeniceBalanceResponse> {
  const response = await fetch(`https://api.venice.ai/api/v1/x402/balance/${walletAddress}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Sign-In-With-X": signInHeader,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Venice balance check failed with ${response.status}: ${text}`);
  }

  return JSON.parse(text) as VeniceBalanceResponse;
}

function extractAssistantContent(json: VeniceChatResponse): string {
  const content = json.choices?.[0]?.message?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }

        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function main(): Promise<void> {
  const url = process.argv[2] || "https://api.venice.ai/api/v1/chat/completions";
  const privateKey = requireEnv(
    ["VENICE_PRIVATE_KEY", "EVM_PRIVATE_KEY", "BUYER_PRIVATE_KEY"],
    "Venice wallet private key",
  ) as `0x${string}`;
  const model = readFirstDefined(["VENICE_MODEL"]) || "zai-org-glm-5-1";
  const prompt = readFirstDefined(["VENICE_PROMPT"]) || "What is 2+2? Answer briefly.";

  const { walletAddress, headerValue: balanceHeaderValue } = await createSignInWithXHeader(
    privateKey,
    `https://api.venice.ai/api/v1/x402/balance/${privateKeyToAccount(privateKey).address}`,
  );
  const balance = await fetchBalance(walletAddress, balanceHeaderValue);
  const balanceData = balance.data;

  console.log("Wallet address:", walletAddress);
  console.log("Chat URL:", url);
  console.log("Model:", model);
  console.log("Balance USD:", balanceData?.balanceUsd ?? "unknown");
  console.log("Can consume:", balanceData?.canConsume ?? "unknown");

  if (typeof balanceData?.minimumTopUpUsd === "number") {
    console.log("Minimum top-up USD:", balanceData.minimumTopUpUsd);
  }

  if (typeof balanceData?.suggestedTopUpUsd === "number") {
    console.log("Suggested top-up USD:", balanceData.suggestedTopUpUsd);
  }

  const { headerValue: chatHeaderValue } = await createSignInWithXHeader(privateKey, url);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Sign-In-With-X": chatHeaderValue,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
    }),
  });

  console.log(`Status: ${response.status} ${response.statusText}`);

  const text = await response.text();

  if (response.status === 402) {
    console.log("\nWallet auth succeeded, but the wallet does not have enough Venice x402 balance to buy this request.");
    console.log("Top up path: POST https://api.venice.ai/api/v1/x402/top-up");
    console.log("\nRaw response follows:\n");
    console.log(text);
    return;
  }

  if (response.status === 401) {
    console.log("\nVenice rejected the SIWE header. Rebuild the request and ensure the system clock is correct.");
    console.log("\nRaw response follows:\n");
    console.log(text);
    return;
  }

  try {
    const json = JSON.parse(text) as VeniceChatResponse;
    const answer = extractAssistantContent(json);

    if (answer) {
      console.log("\nAssistant answer:\n");
      console.log(answer);
    }

    if (json.choices?.[0]?.message?.reasoning_content) {
      console.log("\nReasoning content:\n");
      console.log(json.choices[0].message.reasoning_content);
    }

    if (json.usage) {
      console.log("\nUsage:\n");
      console.log(JSON.stringify(json.usage, null, 2));
    }

    if (json.venice_parameters) {
      console.log("\nVenice parameters returned:\n");
      console.log(JSON.stringify(json.venice_parameters, null, 2));
    }

    console.log("\nRaw JSON follows:\n");
    console.log(JSON.stringify(json, null, 2));
    return;
  } catch {
    console.log("\nRaw response follows:\n");
    console.log(text);
  }
}

main().catch((error) => {
  console.error("Failed to call Venice chat completions with wallet auth");
  console.error(error);
  process.exitCode = 1;
});
