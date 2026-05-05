import type { NextFunction, Request, Response } from "express";

import { env } from "../config/env";
import { serviceDescriptions } from "../descriptions";
import { estimateAuthorizationPriceUsd, resolveRequestedModel } from "../model-pricing";
import { prepaidLedger } from "../prepaid-ledger";
import { buildSiwxChallenge, readSiwxHeader, verifySiwxHeader } from "../siwx";
import { getTopUpTokenAddress } from "../x402";

function formatSupportedChain(network: string): string {
  if (network === "eip155:8453") {
    return "base";
  }

  if (network === "eip155:84532") {
    return "base-sepolia";
  }

  return network;
}

function buildResourceUri(req: Request): string {
  return `${req.protocol}://${req.headers.host}${req.originalUrl}`;
}

function sendAuthenticationRequired(req: Request, res: Response): void {
  const resourceUri = buildResourceUri(req);

  res.status(402).json({
    error: "Authentication required",
    code: "AUTHENTICATION_REQUIRED",
    description: serviceDescriptions.authenticationRequired,
    siwxChallenge: buildSiwxChallenge(resourceUri),
  });
}

function sendInsufficientBalance(
  req: Request,
  res: Response,
  walletAddress: string,
  selectedModel: string,
  requestPriceUsd: number,
): void {
  const resourceUri = buildResourceUri(req);
  const currentBalanceUsd = prepaidLedger.getBalanceUsd(walletAddress);
  const minimumBalanceUsd = Math.max(env.prepaidMinimumBalanceUsd, requestPriceUsd);
  const topUpTokenAddress = getTopUpTokenAddress(env.x402Network);

  res.status(402).json({
    error: "Payment required",
    code: "PAYMENT_REQUIRED",
    reason: "insufficient_balance",
    currentBalanceUsd,
    minimumBalanceUsd,
    description: serviceDescriptions.insufficientBalance,
    suggestedTopUpUsd: env.prepaidSuggestedTopUpUsd,
    minimumTopUpUsd: env.prepaidMinimumTopUpUsd,
    selectedModel,
    requestPriceUsd,
    supportedTokens: ["USDC"],
    supportedChains: [formatSupportedChain(env.x402Network)],
    topUpInstructions: {
      step1: "POST /v1/x402/top-up with no payment header to receive x402 payment requirements.",
      step2: "Sign a USDC payment for the requested top-up amount using an x402-compatible wallet or agent client.",
      step3: "Retry POST /v1/x402/top-up with the signed payment header, then retry the original AI request with a fresh X-Sign-In-With-X header.",
      receiverWallet: env.payToAddress,
      tokenAddress: topUpTokenAddress,
      tokenDecimals: 6,
      network: env.x402Network,
      minimumAmountUsd: env.prepaidMinimumTopUpUsd,
    },
    siwxChallenge: buildSiwxChallenge(resourceUri),
  });
}

export async function prepaidAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.method !== "POST") {
    next();
    return;
  }

  const resourceUri = buildResourceUri(req);
  const siwxHeader = readSiwxHeader({
    get: (name) => req.header(name),
  });

  if (!siwxHeader) {
    sendAuthenticationRequired(req, res);
    return;
  }

  const verification = await verifySiwxHeader(siwxHeader, resourceUri);
  if (!verification.address) {
    res.status(401).json({
      error: verification.error || "Invalid Sign-In-With-X payload.",
      code: "SIGN_IN_WITH_X_INVALID",
      siwxChallenge: buildSiwxChallenge(resourceUri),
    });
    return;
  }

  const selectedModel = resolveRequestedModel(req.body);
  const requestPriceUsd = estimateAuthorizationPriceUsd(selectedModel, req.body);
  const requiredBalanceUsd = Math.max(env.prepaidMinimumBalanceUsd, requestPriceUsd);

  if (!prepaidLedger.canConsume(verification.address, requiredBalanceUsd)) {
    sendInsufficientBalance(
      req,
      res,
      verification.address,
      selectedModel,
      requestPriceUsd,
    );
    return;
  }

  const reservationId = prepaidLedger.reserve(verification.address, requestPriceUsd);
  if (!reservationId) {
    sendInsufficientBalance(
      req,
      res,
      verification.address,
      selectedModel,
      requestPriceUsd,
    );
    return;
  }

  let finalized = false;
  res.locals.walletAddress = verification.address;
  res.locals.prepaidReservationId = reservationId;
  res.locals.selectedModel = selectedModel;
  res.locals.requestPriceUsd = requestPriceUsd;

  const finalizeReservation = (mode: "commit" | "release"): void => {
    if (finalized) {
      return;
    }

    finalized = true;

    if (mode === "commit") {
      const finalChargeUsd =
        typeof res.locals.finalChargeUsd === "number" && Number.isFinite(res.locals.finalChargeUsd)
          ? Number(res.locals.finalChargeUsd)
          : undefined;
      prepaidLedger.commitReservation(reservationId, finalChargeUsd);
      return;
    }

    prepaidLedger.releaseReservation(reservationId);
  };

  res.once("finish", () => {
    finalizeReservation(res.statusCode < 400 ? "commit" : "release");
  });

  res.once("close", () => {
    finalizeReservation("release");
  });

  next();
}
