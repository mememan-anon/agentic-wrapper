import { paymentMiddlewareFromHTTPServer, x402ResourceServer } from "@x402/express";
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type PaywallConfig,
  type RouteConfig,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";

import { env } from "./config/env";
import { serviceDescriptions } from "./descriptions";
import { prepaidLedger } from "./prepaid-ledger";

const USDC_DECIMALS = 6;

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

function roundUsd(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function resolveRequestedTopUpAmountUsd(body: unknown): number {
  const typedBody = body && typeof body === "object" ? (body as { amountUsd?: unknown }) : {};
  const rawAmount = typedBody.amountUsd;

  if (typeof rawAmount === "number" && Number.isFinite(rawAmount)) {
    return Math.max(env.prepaidMinimumTopUpUsd, roundUsd(rawAmount));
  }

  if (typeof rawAmount === "string" && rawAmount.trim() !== "") {
    const parsedAmount = Number(rawAmount.trim());
    if (Number.isFinite(parsedAmount) && parsedAmount > 0) {
      return Math.max(env.prepaidMinimumTopUpUsd, roundUsd(parsedAmount));
    }
  }

  return env.prepaidMinimumTopUpUsd;
}

function atomicToUsd(amountAtomic: string, decimals = USDC_DECIMALS): number {
  const normalized = amountAtomic.trim();
  if (!/^\d+$/.test(normalized)) {
    return 0;
  }

  const divisor = 10 ** decimals;
  return Math.round((Number(normalized) / divisor) * 1000) / 1000;
}

function resolveSettledTopUpAmountUsd(context: {
  requirements: {
    amount: string;
  };
  result: {
    amount?: string;
  };
}): number {
  const settledAtomicAmount = context.result.amount || context.requirements.amount;
  return atomicToUsd(settledAtomicAmount);
}

function createSettlementKey(context: {
  requirements: {
    amount: string;
    payTo?: string;
  };
  result: {
    amount?: string;
    transaction?: string;
    network?: string;
    payer?: string;
  };
}): string {
  if (context.result.transaction) {
    return `${context.result.network || env.x402Network}:${context.result.transaction}`;
  }

  return [
    context.result.network || env.x402Network,
    context.result.payer || "unknown-payer",
    context.requirements.payTo || env.payToAddress,
    context.result.amount || context.requirements.amount,
  ].join(":");
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

function formatSupportedChain(network: string | undefined): string {
  if (network === "eip155:8453") {
    return "base";
  }

  if (network === "eip155:84532") {
    return "base-sepolia";
  }

  return network || "unknown";
}

function createTopUpFailureBody(result: Extract<HTTPProcessResult, { type: "payment-error" }>) {
  const paymentRequired = decodePaymentRequiredHeader(
    result.response.headers["payment-required"] || result.response.headers["Payment-Required"],
  );
  const topUpRequirement = paymentRequired?.accepts?.[0];
  const requestedTopUpUsd = topUpRequirement?.amount ? atomicToUsd(topUpRequirement.amount) : env.prepaidMinimumTopUpUsd;
  const supportedNetwork = topUpRequirement?.network || env.x402Network;
  const topUpTokenAddress = getTopUpTokenAddress(supportedNetwork) || getTopUpTokenAddress(env.x402Network);
  const rawError = paymentRequired?.error;

  const description =
    rawError === "permit2_insufficient_allowance"
      ? serviceDescriptions.topUpInsufficientAllowance
      : serviceDescriptions.topUpInsufficientFunds;

  return {
    error: "Payment required",
    code: "PAYMENT_REQUIRED",
    reason: "insufficient_balance",
    currentBalanceUsd: 0,
    minimumBalanceUsd: requestedTopUpUsd,
    description,
    suggestedTopUpUsd: env.prepaidSuggestedTopUpUsd,
    minimumTopUpUsd: env.prepaidMinimumTopUpUsd,
    requestedTopUpUsd,
    supportedTokens: ["USDC"],
    supportedChains: [formatSupportedChain(supportedNetwork)],
    topUpInstructions: {
      step1: `Fund the wallet with at least $${requestedTopUpUsd} of USDC on ${formatSupportedChain(
        supportedNetwork,
      )}.`,
      step2: "POST /v1/x402/top-up with no payment header to receive x402 payment requirements for the desired top-up amount.",
      step3: "Retry POST /v1/x402/top-up with the signed payment header from an x402-compatible wallet or agent client.",
      receiverWallet: topUpRequirement?.payTo || env.payToAddress,
      tokenAddress: topUpRequirement?.asset || topUpTokenAddress,
      tokenDecimals: 6,
      network: supportedNetwork,
      minimumAmountUsd: env.prepaidMinimumTopUpUsd,
    },
  };
}

function wrapTopUpProcess(httpServer: x402HTTPResourceServer): void {
  const originalProcessHTTPRequest = httpServer.processHTTPRequest.bind(httpServer);

  httpServer.processHTTPRequest = (async (
    context: HTTPRequestContext,
    paywallConfig?: PaywallConfig,
  ): Promise<HTTPProcessResult> => {
    const result = await originalProcessHTTPRequest(context, paywallConfig);

    if (
      result.type === "payment-error" &&
      context.path === "/v1/x402/top-up" &&
      Boolean(context.paymentHeader) &&
      result.response.status === 402
    ) {
      return {
        ...result,
        response: {
          ...result.response,
          body: createTopUpFailureBody(result),
        },
      };
    }

    return result;
  }) as typeof httpServer.processHTTPRequest;
}

export function getTopUpTokenAddress(network: string): string | null {
  if (network === "eip155:8453") {
    return "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  }

  if (network === "eip155:84532") {
    return "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  }

  return null;
}

function createTopUpRouteConfig(): RouteConfig {
  return {
    accepts: [
      {
        scheme: "exact",
        price: (context: HTTPRequestContext) => {
          const amountUsd = resolveRequestedTopUpAmountUsd(getBodyFromContext(context));
          return `$${amountUsd}`;
        },
        network: env.x402Network as `${string}:${string}`,
        payTo: env.payToAddress,
        extra: {
          assetTransferMethod: "permit2",
        },
      },
    ],
    description: serviceDescriptions.bazaarTopUp,
    mimeType: "application/json",
    extensions: {
      ...declareDiscoveryExtension({
        input: {
          amountUsd: env.prepaidMinimumTopUpUsd,
        },
        inputSchema: {
          properties: {
            amountUsd: {
              type: "number",
              minimum: env.prepaidMinimumTopUpUsd,
              description: serviceDescriptions.topUpAmountUsd,
            },
          },
          required: ["amountUsd"],
        },
        bodyType: "json",
        output: {
          example: {
            success: true,
            message: serviceDescriptions.topUpSettled,
            creditedUsd: env.prepaidMinimumTopUpUsd,
            supportedTokens: ["USDC"],
            supportedChains: [env.x402Network],
            tokenAddress: getTopUpTokenAddress(env.x402Network),
          },
        },
      }),
    },
  };
}

export function createTopUpPaymentMiddleware() {
  const facilitatorClient = createFacilitatorClient();
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(env.x402Network as `${string}:${string}`, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension)
    .onAfterSettle(async (context) => {
      const payerAddress = context.result.payer;
      if (!payerAddress) {
        return;
      }

      const creditedUsd = resolveSettledTopUpAmountUsd(context);
      if (creditedUsd <= 0) {
        return;
      }

      prepaidLedger.creditSettlement({
        settlementKey: createSettlementKey(context),
        address: payerAddress,
        amountUsd: creditedUsd,
        transactionHash: context.result.transaction,
        network: context.result.network,
      });
    });

  const routes = {
    "POST /v1/x402/top-up": createTopUpRouteConfig(),
  };

  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  wrapTopUpProcess(httpServer);

  return paymentMiddlewareFromHTTPServer(httpServer);
}

export function getRequestedTopUpAmountUsd(body: unknown): number {
  return resolveRequestedTopUpAmountUsd(body);
}
