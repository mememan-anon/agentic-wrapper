import { paymentMiddlewareFromHTTPServer, x402ResourceServer } from "@x402/express";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type PaywallConfig,
  type RouteConfig,
} from "@x402/core/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";

import { env } from "./config/env";
import { serviceDescriptions } from "./descriptions";
import { estimateAuthorizationPriceUsd } from "./model-pricing";

const INFERENCE_ROUTE_PATHS = new Set(["/v1/responses", "/v1/chat/completions"]);

function createFacilitatorClient(): HTTPFacilitatorClient {
  const isCdpFacilitator = env.x402FacilitatorUrl.includes("api.cdp.coinbase.com");

  if (isCdpFacilitator) {
    return new HTTPFacilitatorClient(
      createFacilitatorConfig(env.cdpApiKeyId || undefined, env.cdpApiKeySecret || undefined),
    );
  }

  return new HTTPFacilitatorClient({
    url: env.x402FacilitatorUrl,
  });
}

function getBodyFromContext(context: HTTPRequestContext): unknown {
  return context.adapter.getBody ? context.adapter.getBody() : {};
}

function createDynamicPrice(context: HTTPRequestContext): string {
  const body = getBodyFromContext(context);
  const requestedModel =
    body && typeof body === "object" && typeof (body as { model?: unknown }).model === "string"
      ? ((body as { model?: string }).model || env.openaiModel).trim()
      : env.openaiModel;

  return `$${estimateAuthorizationPriceUsd(requestedModel, body)}`;
}

function getAuthorizationAmountUsd(context: HTTPRequestContext): number {
  return Number(createDynamicPrice(context).slice(1));
}

function createUnpaidResponseBody(context: HTTPRequestContext) {
  return {
    contentType: "application/json",
    body: {
      error: "Payment required",
      code: "PAYMENT_REQUIRED",
      description: serviceDescriptions.paymentRequired,
      maxAuthorizationUsd: getAuthorizationAmountUsd(context),
      network: env.x402Network,
    },
  };
}

function createSettlementFailedResponseBody(
  context: HTTPRequestContext,
  settleResult: {
    errorReason: string;
    errorMessage?: string;
  },
) {
  return {
    contentType: "application/json",
    body: {
      error: "Payment required",
      code: "PAYMENT_SETTLEMENT_FAILED",
      description: serviceDescriptions.settlementFailed,
      errorReason: settleResult.errorReason,
      errorMessage: settleResult.errorMessage,
      maxAuthorizationUsd: getAuthorizationAmountUsd(context),
      network: env.x402Network,
    },
  };
}

type PaymentRequiredHeaderShape = {
  error?: string;
  accepts?: Array<{
    amount?: string;
    asset?: string;
    network?: string;
    payTo?: string;
  }>;
};

type ExtensionResponseStatus =
  | {
      extension?: string;
      status?: string;
      reason?: string;
      message?: string;
    }
  | Record<string, unknown>;

function decodePaymentRequiredHeader(headerValue: string | undefined): PaymentRequiredHeaderShape | null {
  if (!headerValue) {
    return null;
  }

  try {
    const decoded = Buffer.from(headerValue, "base64url").toString("utf8");
    return JSON.parse(decoded) as PaymentRequiredHeaderShape;
  } catch {
    return null;
  }
}

function getHeaderIgnoreCase(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct) {
    return direct;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }

  return undefined;
}

function tryParseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function decodeExtensionResponsesHeader(headerValue: string | undefined): ExtensionResponseStatus[] | null {
  if (!headerValue) {
    return null;
  }

  const plainJson = tryParseJson<unknown>(headerValue);
  if (Array.isArray(plainJson)) {
    return plainJson as ExtensionResponseStatus[];
  }

  const decoded = (() => {
    try {
      return Buffer.from(headerValue, "base64url").toString("utf8");
    } catch {
      return null;
    }
  })();

  if (!decoded) {
    return null;
  }

  const decodedJson = tryParseJson<unknown>(decoded);
  return Array.isArray(decodedJson) ? (decodedJson as ExtensionResponseStatus[]) : null;
}

function logExtensionResponses(
  phase: "verify" | "settle",
  context: HTTPRequestContext,
  headers: Record<string, string>,
): void {
  const headerValue = getHeaderIgnoreCase(headers, "extension-responses");
  const decoded = decodeExtensionResponsesHeader(headerValue);

  if (!decoded || decoded.length === 0) {
    return;
  }

  console.info("x402 extension responses", {
    phase,
    method: context.method,
    path: context.path,
    routePattern: context.routePattern,
    responses: decoded,
  });
}

function atomicUsdcToUsd(amountAtomic: string | undefined): number | null {
  if (!amountAtomic || !/^\d+$/.test(amountAtomic)) {
    return null;
  }

  return Number(amountAtomic) / 1_000_000;
}

function describePaymentError(code: string | undefined): string {
  if (code === "permit2_insufficient_balance") {
    return "The wallet does not hold enough supported USDC to pay for this request.";
  }

  if (code === "permit2_insufficient_allowance") {
    return "The wallet has not approved enough supported USDC to pay for this request.";
  }

  return serviceDescriptions.settlementFailed;
}

function createPaidRetryFailureBody(
  context: HTTPRequestContext,
  result: Extract<HTTPProcessResult, { type: "payment-error" }>,
) {
  const paymentRequired = decodePaymentRequiredHeader(
    getHeaderIgnoreCase(result.response.headers, "payment-required"),
  );
  const accept = paymentRequired?.accepts?.[0];
  const requiredAmountUsd = atomicUsdcToUsd(accept?.amount);

  return {
    error: "Payment required",
    code: "PAYMENT_SETTLEMENT_FAILED",
    reason: paymentRequired?.error || "payment_not_settled",
    description: describePaymentError(paymentRequired?.error),
    maxAuthorizationUsd: getAuthorizationAmountUsd(context),
    requiredAmountAtomic: accept?.amount,
    requiredAmountUsd,
    paymentNetwork: accept?.network || env.x402Network,
    paymentAsset: accept?.asset,
    payTo: accept?.payTo || env.payToAddress,
  };
}

function wrapInferenceProcess(httpServer: x402HTTPResourceServer): void {
  const originalProcessHTTPRequest = httpServer.processHTTPRequest.bind(httpServer);
  const originalProcessSettlement = httpServer.processSettlement.bind(httpServer);

  httpServer.processHTTPRequest = (async (
    context: HTTPRequestContext,
    paywallConfig?: PaywallConfig,
  ): Promise<HTTPProcessResult> => {
    const result = await originalProcessHTTPRequest(context, paywallConfig);

    if (result.type === "payment-error") {
      logExtensionResponses("verify", context, result.response.headers);
    }

    if (
      result.type === "payment-error" &&
      INFERENCE_ROUTE_PATHS.has(context.path) &&
      Boolean(context.paymentHeader) &&
      result.response.status === 402
    ) {
      return {
        ...result,
        response: {
          ...result.response,
          body: createPaidRetryFailureBody(context, result),
        },
      };
    }

    return result;
  }) as typeof httpServer.processHTTPRequest;

  httpServer.processSettlement = (async (...args) => {
    const result = await originalProcessSettlement(...args);
    const transportContext = args[3];

    if (transportContext?.request) {
      logExtensionResponses("settle", transportContext.request, result.headers);
    }

    return result;
  }) as typeof httpServer.processSettlement;
}

function createResponsesRouteConfig(): RouteConfig {
  return {
    accepts: [
      {
        scheme: "upto",
        price: createDynamicPrice,
        network: env.x402Network as `${string}:${string}`,
        payTo: env.payToAddress,
        extra: {
          assetTransferMethod: "permit2",
        },
      },
    ],
    description: serviceDescriptions.responsesBazaarDescription,
    mimeType: "application/json",
    unpaidResponseBody: createUnpaidResponseBody,
    settlementFailedResponseBody: createSettlementFailedResponseBody,
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          model: env.openaiModel,
          input:
            "Extract the three most important market-moving events from this note and return a concise agent-ready summary.",
          instructions: "Return plain text with one short line per event.",
          max_output_tokens: 256,
        },
        inputSchema: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "Configured model name to run, such as gpt-5.5 or gpt-5.4-pro.",
            },
            input: {
              type: "string",
              description: "Prompt or instruction to send to the Responses API.",
            },
            instructions: {
              type: "string",
              description: "Optional system-style instructions for the response.",
            },
            max_output_tokens: {
              type: "number",
              minimum: 1,
              description: "Maximum number of output tokens to generate.",
            },
          },
          required: ["input"],
          additionalProperties: true,
        },
        bodyType: "json",
        output: {
          example: {
            output_text:
              "1. Softer inflation data lifted US equities at the open.\n2. Treasury yields eased across the curve.\n3. Mega-cap tech outperformed on AI infrastructure demand.",
          },
          schema: {
            type: "object",
            properties: {
              output_text: {
                type: "string",
                description: "Plain-text model output returned by api.zeno.finance.",
              },
            },
            required: ["output_text"],
            additionalProperties: false,
          },
        },
      }),
    },
  };
}

function createChatCompletionsRouteConfig(): RouteConfig {
  return {
    accepts: [
      {
        scheme: "upto",
        price: createDynamicPrice,
        network: env.x402Network as `${string}:${string}`,
        payTo: env.payToAddress,
        extra: {
          assetTransferMethod: "permit2",
        },
      },
    ],
    description: serviceDescriptions.chatCompletionsBazaarDescription,
    mimeType: "application/json",
    unpaidResponseBody: createUnpaidResponseBody,
    settlementFailedResponseBody: createSettlementFailedResponseBody,
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          model: env.openaiModel,
          messages: [
            { role: "system", content: "You are a concise finance assistant." },
            {
              role: "user",
              content: "Explain what the yield curve is and why an inversion matters for markets.",
            },
          ],
          max_tokens: 180,
        },
        inputSchema: {
          type: "object",
          properties: {
            model: {
              type: "string",
              description: "Configured model name to run, such as gpt-5.5 or gpt-5.4.",
            },
            messages: {
              type: "array",
              description: "OpenAI-compatible chat message list.",
              minItems: 1,
              items: {
                type: "object",
                properties: {
                  role: {
                    type: "string",
                    enum: ["system", "user", "assistant", "developer"],
                  },
                  content: {
                    type: "string",
                  },
                },
                required: ["role", "content"],
                additionalProperties: false,
              },
            },
            max_tokens: {
              type: "number",
              minimum: 1,
              description: "Maximum number of completion tokens to generate.",
            },
          },
          required: ["messages"],
        },
        bodyType: "json",
        output: {
          example: {
            id: "chatcmpl_demo",
            object: "chat.completion",
            created: 1735689600,
            model: env.openaiModel,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "The yield curve plots bond yields across maturities, and an inversion matters because it can signal tighter financial conditions and rising recession risk expectations.",
                },
                finish_reason: "stop",
              },
            ],
          },
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              object: { type: "string" },
              created: { type: "number" },
              model: { type: "string" },
              choices: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    index: { type: "number" },
                    message: {
                      type: "object",
                      properties: {
                        role: { type: "string" },
                        content: { type: "string" },
                      },
                      required: ["role", "content"],
                      additionalProperties: false,
                    },
                    finish_reason: { type: ["string", "null"] },
                  },
                  required: ["index", "message"],
                  additionalProperties: false,
                },
              },
            },
            required: ["id", "object", "created", "model", "choices"],
            additionalProperties: true,
          },
        },
      }),
    },
  };
}

export function createInferencePaymentMiddleware() {
  const facilitatorClient = createFacilitatorClient();
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(env.x402Network as `${string}:${string}`, new UptoEvmScheme())
    .registerExtension(bazaarResourceServerExtension);

  const routes = {
    "POST /v1/responses": createResponsesRouteConfig(),
    "POST /v1/chat/completions": createChatCompletionsRouteConfig(),
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  wrapInferenceProcess(httpServer);

  return paymentMiddlewareFromHTTPServer(httpServer);
}
