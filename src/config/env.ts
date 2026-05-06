import dotenv from "dotenv";

dotenv.config();

function readFirstDefined(keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }

  return fallback;
}

function requireEnv(keys: string[], label: string): string {
  const value = readFirstDefined(keys);

  if (!value) {
    throw new Error(
      `Missing required environment variable for ${label}. Expected one of: ${keys.join(", ")}`,
    );
  }

  return value;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function readPositiveNumber(keys: string[], fallback: number): number {
  const value = readFirstDefined(keys);

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive number for one of: ${keys.join(", ")}`);
  }

  return parsed;
}

function readBoolean(keys: string[], fallback: boolean): boolean {
  const value = readFirstDefined(keys);
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Expected a boolean value for one of: ${keys.join(", ")}`);
}

function readStringList(keys: string[], fallback: string[] = []): string[] {
  const value = readFirstDefined(keys);
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function readNumberMap(keys: string[]): Record<string, number> {
  const value = readFirstDefined(keys);
  if (!value) {
    return {};
  }

  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const result: Record<string, number> = {};

  for (const entry of entries) {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(
        `Expected key:value pairs for one of: ${keys.join(", ")}. Received invalid entry: ${entry}`,
      );
    }

    const key = entry.slice(0, separatorIndex).trim();
    const rawValue = entry.slice(separatorIndex + 1).trim();
    const parsedValue = Number(rawValue);

    if (!key || !Number.isFinite(parsedValue) || parsedValue <= 0) {
      throw new Error(
        `Expected positive numeric values in one of: ${keys.join(", ")}. Received invalid entry: ${entry}`,
      );
    }

    result[key] = parsedValue;
  }

  return result;
}

export interface AppEnv {
  nodeEnv: string;
  port: number;
  payToAddress: string;
  x402Network: string;
  x402FacilitatorUrl: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  openaiModels: string[];
  modelPriceOverridesUsd: Record<string, number>;
  systemPrompt: string;
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
  fallbackRequestCostUsd: number;
  x402EnableBazaar: boolean;
}

export const env: AppEnv = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 4021),
  payToAddress: requireEnv(["PAY_TO_ADDRESS", "WALLET", "wallet"], "receiving wallet address"),
  x402Network: readFirstDefined(["X402_NETWORK"], "eip155:8453"),
  x402FacilitatorUrl: readFirstDefined(["X402_FACILITATOR_URL"], "https://api.cdp.coinbase.com/platform/v2/x402"),
  openaiBaseUrl: normalizeBaseUrl(
    readFirstDefined(["OPENAI_BASE_URL", "AZURE_OPENAI_ENDPOINT"], "https://api.openai.com/v1"),
  ),
  openaiApiKey: requireEnv(
    ["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "GPT_5.5_KEY"],
    "OpenAI-compatible API key",
  ),
  openaiModel: requireEnv(
    ["OPENAI_MODEL", "AZURE_OPENAI_DEPLOYMENT", "AZURE_OPENAI_MODEL"],
    "OpenAI-compatible model name",
  ),
  openaiModels: [],
  modelPriceOverridesUsd: readNumberMap(["MODEL_PRICE_USD_BY_NAME", "OPENAI_MODEL_PRICES_USD"]),
  systemPrompt: readFirstDefined(
    ["SYSTEM_PROMPT"],
    "You are a helpful AI assistant for a paid API product.",
  ),
  cdpApiKeyId: readFirstDefined(["CDP_API_KEY_ID"], ""),
  cdpApiKeySecret: readFirstDefined(["CDP_API_KEY_SECRET"], ""),
  fallbackRequestCostUsd: readPositiveNumber(
    ["X402_FALLBACK_PRICE_USD", "REQUEST_COST_USD"],
    0.1,
  ),
  x402EnableBazaar: readBoolean(["X402_ENABLE_BAZAAR"], true),
};

env.openaiModels = Array.from(
  new Set([
    env.openaiModel,
    ...readStringList(["OPENAI_MODELS", "AZURE_OPENAI_DEPLOYMENTS", "AZURE_OPENAI_MODELS"]),
  ]),
);

if (!Number.isInteger(env.port) || env.port <= 0) {
  throw new Error("PORT must be a positive integer");
}
