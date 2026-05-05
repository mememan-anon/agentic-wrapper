import { env } from "./config/env";

type PricingBasis = {
  inputUsdPer1M: number;
  cachedInputUsdPer1M?: number;
  outputUsdPer1M: number;
  assumedInputTokens: number;
  assumedOutputTokens: number;
  markupMultiplier: number;
};

type UsageShape = {
  input_tokens?: unknown;
  prompt_tokens?: unknown;
  output_tokens?: unknown;
  completion_tokens?: unknown;
  input_tokens_details?: {
    cached_tokens?: unknown;
  };
  prompt_tokens_details?: {
    cached_tokens?: unknown;
  };
};

export type ModelPricing = {
  model: string;
  priceUsd: number;
  source: "override" | "derived" | "fallback";
  pricingBasis?: PricingBasis & {
    estimatedProviderCostUsd: number;
  };
};

const DEFAULT_MAX_OUTPUT_TOKENS = 512;
const INPUT_TOKEN_BUFFER = 100;
const INPUT_TOKEN_MULTIPLIER = 1.25;
const MINIMUM_CHARGE_USD = 0.001;
const MAXIMUM_CHARGE_USD = 10;

const knownPricingBasis: Record<string, PricingBasis> = {
  "gpt-5.5": {
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    assumedInputTokens: 1000,
    assumedOutputTokens: 300,
    markupMultiplier: 1,
  },
  "gpt-5.4": {
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
    assumedInputTokens: 1000,
    assumedOutputTokens: 300,
    markupMultiplier: 1,
  },
  "gpt-5.4-pro": {
    inputUsdPer1M: 30,
    outputUsdPer1M: 180,
    assumedInputTokens: 1000,
    assumedOutputTokens: 300,
    markupMultiplier: 1,
  },
};

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundUpUsd(value: number): number {
  return Math.ceil(value * 1_000_000) / 1_000_000;
}

function roundUpToCent(value: number): number {
  return Math.ceil(value * 100) / 100;
}

function clampChargeUsd(value: number): number {
  return roundUsd(Math.min(MAXIMUM_CHARGE_USD, Math.max(MINIMUM_CHARGE_USD, value)));
}

function estimateProviderCostUsd(basis: PricingBasis): number {
  const inputCost = (basis.assumedInputTokens / 1_000_000) * basis.inputUsdPer1M;
  const outputCost = (basis.assumedOutputTokens / 1_000_000) * basis.outputUsdPer1M;
  return roundUsd(inputCost + outputCost);
}

function normalizeModel(model: string): string {
  return model.trim();
}

function getUsage(response: Record<string, unknown>): UsageShape | null {
  const usage = response.usage;
  return usage && typeof usage === "object" ? (usage as UsageShape) : null;
}

function toInteger(value: unknown): number {
  return Number.isInteger(value) ? Number(value) : 0;
}

function getPricingBasis(model: string): PricingBasis | null {
  return knownPricingBasis[normalizeModel(model)] || null;
}

function resolveDerivedPricing(model: string): ModelPricing | null {
  const basis = getPricingBasis(model);
  if (!basis) {
    return null;
  }

  const estimatedProviderCostUsd = estimateProviderCostUsd(basis);

  return {
    model,
    priceUsd: clampChargeUsd(
      basis.markupMultiplier === 1
        ? estimatedProviderCostUsd
        : roundUpToCent(estimatedProviderCostUsd * basis.markupMultiplier),
    ),
    source: "derived",
    pricingBasis: {
      ...basis,
      estimatedProviderCostUsd,
    },
  };
}

function extractRelevantText(body: Record<string, unknown>): string {
  const candidate = {
    input: body.input,
    messages: body.messages,
    instructions: body.instructions,
  };

  return JSON.stringify(candidate);
}

function estimateInputTokens(body: Record<string, unknown>): number {
  const relevantText = extractRelevantText(body);
  if (!relevantText) {
    return 0;
  }

  return Math.ceil(relevantText.length / 4) + 32;
}

export function formatUsdPrice(value: number): string {
  return `$${roundUsd(value)}`;
}

export function getMinimumChargeUsd(): number {
  return MINIMUM_CHARGE_USD;
}

export function getMaximumChargeUsd(): number {
  return MAXIMUM_CHARGE_USD;
}

export function estimateRawAuthorizationPriceUsd(model: string, body: unknown): number | null {
  const basis = getPricingBasis(model);
  if (!basis || !body || typeof body !== "object") {
    return null;
  }

  const estimatedInputTokens = estimateInputTokens(body as Record<string, unknown>);
  const bufferedInputTokens = Math.max(
    Math.ceil(estimatedInputTokens * INPUT_TOKEN_MULTIPLIER),
    estimatedInputTokens + INPUT_TOKEN_BUFFER,
  );
  const outputTokens = resolveMaxOutputTokens(body);

  const inputCost = (bufferedInputTokens / 1_000_000) * basis.inputUsdPer1M;
  const outputCost = (outputTokens / 1_000_000) * basis.outputUsdPer1M;
  return roundUpUsd(inputCost + outputCost);
}

export function resolveRequestedModel(body: unknown): string {
  if (!body || typeof body !== "object") {
    return env.openaiModel;
  }

  const typedBody = body as { model?: unknown };
  return typeof typedBody.model === "string" && typedBody.model.trim() !== ""
    ? typedBody.model.trim()
    : env.openaiModel;
}

export function isConfiguredModel(model: string): boolean {
  return env.openaiModels.includes(normalizeModel(model));
}

export function getDefaultMaxOutputTokens(): number {
  return DEFAULT_MAX_OUTPUT_TOKENS;
}

export function resolveMaxOutputTokens(body: unknown): number {
  if (!body || typeof body !== "object") {
    return DEFAULT_MAX_OUTPUT_TOKENS;
  }

  const typedBody = body as {
    max_output_tokens?: unknown;
    max_completion_tokens?: unknown;
    max_tokens?: unknown;
  };

  const explicitMax = Number.isInteger(typedBody.max_output_tokens)
    ? Number(typedBody.max_output_tokens)
    : Number.isInteger(typedBody.max_completion_tokens)
      ? Number(typedBody.max_completion_tokens)
      : Number.isInteger(typedBody.max_tokens)
        ? Number(typedBody.max_tokens)
        : DEFAULT_MAX_OUTPUT_TOKENS;

  return explicitMax > 0 ? explicitMax : DEFAULT_MAX_OUTPUT_TOKENS;
}

export function getModelPricing(model: string): ModelPricing {
  const normalizedModel = normalizeModel(model);
  const overridePrice = env.modelPriceOverridesUsd[normalizedModel];
  const derivedPricing = resolveDerivedPricing(normalizedModel);

  if (typeof overridePrice === "number") {
    return {
      model: normalizedModel,
      priceUsd: clampChargeUsd(overridePrice),
      source: "override",
      pricingBasis: derivedPricing?.pricingBasis,
    };
  }

  if (derivedPricing) {
    return derivedPricing;
  }

  return {
    model: normalizedModel,
    priceUsd: clampChargeUsd(env.prepaidRequestCostUsd),
    source: "fallback",
  };
}

export function listAvailableModelPricing(): ModelPricing[] {
  return env.openaiModels.map((model) => getModelPricing(model));
}

export function getHighestEstimatedPriceUsd(): number {
  return listAvailableModelPricing().reduce((highest, pricing) => Math.max(highest, pricing.priceUsd), 0);
}

export function estimateAuthorizationPriceUsd(model: string, body: unknown): number {
  const rawEstimateUsd = estimateRawAuthorizationPriceUsd(model, body);
  if (rawEstimateUsd === null) {
    return clampChargeUsd(getModelPricing(model).priceUsd);
  }

  return clampChargeUsd(rawEstimateUsd);
}

export function calculateUsagePriceUsd(model: string, response: Record<string, unknown>): number {
  const basis = getPricingBasis(model);
  const usage = getUsage(response);

  if (!basis || !usage) {
    return clampChargeUsd(getModelPricing(model).priceUsd);
  }

  const inputTokens = toInteger(usage.input_tokens) || toInteger(usage.prompt_tokens);
  const outputTokens = toInteger(usage.output_tokens) || toInteger(usage.completion_tokens);
  const cachedTokens =
    toInteger(usage.input_tokens_details?.cached_tokens) || toInteger(usage.prompt_tokens_details?.cached_tokens);
  const nonCachedInputTokens = Math.max(inputTokens - cachedTokens, 0);

  const standardInputCost = (nonCachedInputTokens / 1_000_000) * basis.inputUsdPer1M;
  const cachedInputCost =
    (cachedTokens / 1_000_000) * (basis.cachedInputUsdPer1M ?? basis.inputUsdPer1M);
  const outputCost = (outputTokens / 1_000_000) * basis.outputUsdPer1M;
  const totalCostUsd = standardInputCost + cachedInputCost + outputCost;

  return clampChargeUsd(totalCostUsd > 0 ? totalCostUsd : getModelPricing(model).priceUsd);
}
