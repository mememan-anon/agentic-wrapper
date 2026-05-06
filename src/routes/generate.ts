import { Router, type Request, type Response, type NextFunction } from "express";
import OpenAI from "openai";
import { setSettlementOverrides } from "@x402/express";

import { env } from "../config/env";
import {
  calculateUsagePriceUsd,
  estimateAuthorizationPriceUsd,
  estimateRawAuthorizationPriceUsd,
  formatUsdPrice,
  getDefaultMaxOutputTokens,
  getMaximumChargeUsd,
  getMinimumChargeUsd,
  getModelDescriptor,
  isConfiguredModel,
  listAvailableModelPricing,
  resolveMaxOutputTokens,
  resolveRequestedModel,
} from "../model-pricing";

type ErrorWithStatus = Error & {
  statusCode?: number;
  status?: number;
};

type MessageLike = {
  role: string;
  content: unknown;
};

type SimplifiedResponsesPayload = {
  output_text: string;
};

type ChatCompletionCompatPayload = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: string | null;
  }>;
  usage?: unknown;
};

const client = new OpenAI({
  apiKey: env.openaiApiKey,
  baseURL: env.openaiBaseUrl,
  defaultHeaders: env.openaiBaseUrl.includes("azure.com")
    ? {
        "api-key": env.openaiApiKey,
      }
    : undefined,
});

export const generateRouter = Router();

generateRouter.get("/models", (_req: Request, res: Response) => {
  res.json({
    object: "list",
    service: "api.zeno.finance",
    overview: "OpenAI-compatible wallet-paid inference for agentic reasoning, summarization, and structured generation.",
    payment: {
      protocol: "x402",
      network: env.x402Network,
      min_charge_usd: getMinimumChargeUsd(),
      max_charge_usd: getMaximumChargeUsd(),
      settlement: "usage-settled up to the advertised authorization cap",
    },
    compatibility: {
      response_formats: ["responses", "chat.completions"],
      auth: "wallet-paid",
      api_key_required: false,
    },
    data: listAvailableModelPricing().map((pricing) => ({
      id: pricing.model,
      object: "model",
      owned_by: "configured-provider",
      price_usd: pricing.priceUsd,
      tier: getModelDescriptor(pricing.model).tier,
      best_for: getModelDescriptor(pricing.model).bestFor,
      positioning: getModelDescriptor(pricing.model).outputStyle,
      pricing_source: pricing.source,
      pricing_basis: pricing.pricingBasis
        ? {
          input_usd_per_1m: pricing.pricingBasis.inputUsdPer1M,
            output_usd_per_1m: pricing.pricingBasis.outputUsdPer1M,
            assumed_input_tokens: pricing.pricingBasis.assumedInputTokens,
            assumed_output_tokens: pricing.pricingBasis.assumedOutputTokens,
            markup_multiplier: pricing.pricingBasis.markupMultiplier,
          estimated_provider_cost_usd: pricing.pricingBasis.estimatedProviderCostUsd,
        }
        : null,
    })),
    default_model: env.openaiModel,
  });
});

function badRequest(message: string): ErrorWithStatus {
  const error = new Error(message) as ErrorWithStatus;
  error.statusCode = 400;
  return error;
}

function ensureSupportedModel(model: string): void {
  if (!isConfiguredModel(model)) {
    throw badRequest(
      `Unsupported model '${model}'. Choose one of: ${env.openaiModels.join(", ")}.`,
    );
  }
}

function ensureRequestWithinChargeCap(model: string, body: unknown): void {
  const estimatedMaxChargeUsd = estimateRawAuthorizationPriceUsd(model, body);
  if (estimatedMaxChargeUsd === null) {
    return;
  }

  if (estimatedMaxChargeUsd > getMaximumChargeUsd()) {
    throw badRequest(
      `Requested usage exceeds the maximum allowed charge of ${formatUsdPrice(
        getMaximumChargeUsd(),
      )}. Reduce your input size or max output tokens.`,
    );
  }
}

function normalizeChatMessages(messages: unknown, fallbackInput: unknown): MessageLike[] {
  if (Array.isArray(messages) && messages.length > 0) {
    return messages as MessageLike[];
  }

  if (typeof fallbackInput === "string" && fallbackInput.trim() !== "") {
    return [
      {
        role: "user",
        content: fallbackInput.trim(),
      },
    ];
  }

  throw badRequest("Request body must include a non-empty 'messages' array or an 'input' string.");
}

function extractResponseOutputText(response: Record<string, unknown>): string {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return response.output_text;
  }

  if (!Array.isArray(response.output)) {
    return "";
  }

  return response.output
    .flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [] as string[];
      }

      const typedItem = item as { content?: unknown };

      if (Array.isArray(typedItem.content)) {
        return typedItem.content
          .map((contentItem) => {
            if (!contentItem || typeof contentItem !== "object") {
              return "";
            }

            const typedContentItem = contentItem as { text?: unknown };
            return typeof typedContentItem.text === "string" ? typedContentItem.text : "";
          })
          .filter(Boolean);
      }

      return [] as string[];
    })
    .join("\n");
}

function createChatCompletionCompatResponse(
  response: Record<string, unknown>,
  model: string,
  outputText: string,
): ChatCompletionCompatPayload {
  return {
    id: typeof response.id === "string" ? response.id : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: outputText,
        },
        finish_reason: "stop",
      },
    ],
    ...(response.usage ? { usage: response.usage } : {}),
  };
}

generateRouter.post(
  "/chat/completions",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const {
        messages,
        input,
        temperature,
        max_tokens,
        max_completion_tokens,
        stream,
        ...rest
      } = req.body || {};

      if (stream === true) {
        throw badRequest("Streaming is not supported in this starter. Use stream=false or omit it.");
      }

      const normalizedMessages = normalizeChatMessages(messages, input);
      const selectedModel = resolveRequestedModel(req.body);
      ensureSupportedModel(selectedModel);
      ensureRequestWithinChargeCap(selectedModel, req.body);
      const maxTokens = Number.isInteger(max_tokens)
        ? max_tokens
        : Number.isInteger(max_completion_tokens)
          ? max_completion_tokens
          : resolveMaxOutputTokens(req.body);

      const requestBody: Record<string, unknown> = {
        ...rest,
        model: selectedModel,
        input: normalizedMessages,
        instructions: env.systemPrompt,
        stream: false,
        max_output_tokens: maxTokens,
      };

      if (typeof temperature === "number") {
        requestBody.temperature = temperature;
      }

      const response = await client.responses.create(requestBody as never);
      const serializedResponse = response as unknown as Record<string, unknown>;
      const outputText = extractResponseOutputText(serializedResponse);
      const authorizedPriceUsd = estimateAuthorizationPriceUsd(selectedModel, req.body);
      const settledPriceUsd = Math.min(calculateUsagePriceUsd(selectedModel, serializedResponse), authorizedPriceUsd);
      setSettlementOverrides(res, { amount: formatUsdPrice(settledPriceUsd) });
      res.setHeader("X-Zeno-Charged-Usd", formatUsdPrice(settledPriceUsd));

      res.json(createChatCompletionCompatResponse(serializedResponse, selectedModel, outputText));
    } catch (error) {
      const typedError = error as ErrorWithStatus;
      if (typedError && typeof typedError === "object" && Number(typedError.status) >= 400) {
        typedError.statusCode = Number(typedError.status);
      }

      next(typedError);
    }
  },
);

generateRouter.post(
  "/responses",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const {
        input,
        messages,
        instructions,
        temperature,
        max_output_tokens,
        stream,
        ...rest
      } = req.body || {};

      if (stream === true) {
        throw badRequest("Streaming is not supported in this starter. Use stream=false or omit it.");
      }

      const normalizedInput = input || normalizeChatMessages(messages, input);
      const selectedModel = resolveRequestedModel(req.body);
      ensureSupportedModel(selectedModel);
      ensureRequestWithinChargeCap(selectedModel, req.body);
      const resolvedMaxOutputTokens = Number.isInteger(max_output_tokens)
        ? max_output_tokens
        : getDefaultMaxOutputTokens();

      const requestBody: Record<string, unknown> = {
        ...rest,
        model: selectedModel,
        input: normalizedInput,
        instructions:
          typeof instructions === "string" && instructions.trim() !== ""
            ? instructions
            : env.systemPrompt,
        stream: false,
        max_output_tokens: resolvedMaxOutputTokens,
      };

      if (typeof temperature === "number") {
        requestBody.temperature = temperature;
      }

      const response = await client.responses.create(requestBody as never);

      const serializedResponse = response as unknown as Record<string, unknown>;
      const outputText = extractResponseOutputText(serializedResponse);
      const authorizedPriceUsd = estimateAuthorizationPriceUsd(selectedModel, req.body);
      const settledPriceUsd = Math.min(calculateUsagePriceUsd(selectedModel, serializedResponse), authorizedPriceUsd);
      setSettlementOverrides(res, { amount: formatUsdPrice(settledPriceUsd) });
      res.setHeader("X-Zeno-Charged-Usd", formatUsdPrice(settledPriceUsd));

      const simplifiedResponse: SimplifiedResponsesPayload = {
        output_text: outputText,
      };

      res.json(simplifiedResponse);
    } catch (error) {
      const typedError = error as ErrorWithStatus;
      if (typedError && typeof typedError === "object" && Number(typedError.status) >= 400) {
        typedError.statusCode = Number(typedError.status);
      }

      next(typedError);
    }
  },
);
