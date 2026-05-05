import { Router, type Request, type Response } from "express";

import { env } from "../config/env";
import { serviceDescriptions } from "../descriptions";
import { estimateAuthorizationPriceUsd } from "../model-pricing";
import { prepaidLedger } from "../prepaid-ledger";
import { buildSiwxChallenge } from "../siwx";
import { readSiwxHeader, verifySiwxHeader } from "../siwx";
import { getRequestedTopUpAmountUsd, getTopUpTokenAddress } from "../x402";

function buildResourceUri(req: Request): string {
  return `${req.protocol}://${req.headers.host}${req.originalUrl}`;
}

export const walletRouter = Router();

walletRouter.get("/x402/balance/:walletAddress", async (req: Request, res: Response) => {
  const resourceUri = buildResourceUri(req);
  const siwxHeader = readSiwxHeader({
    get: (name) => req.header(name),
  });

  if (!siwxHeader) {
    res.status(401).json({
      error: "Missing X-Sign-In-With-X header.",
      code: "SIGN_IN_WITH_X_REQUIRED",
      siwxChallenge: buildSiwxChallenge(resourceUri),
    });
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

  const routeWalletAddress = Array.isArray(req.params.walletAddress)
    ? req.params.walletAddress[0]
    : req.params.walletAddress;

  if (verification.address.toLowerCase() !== routeWalletAddress.toLowerCase()) {
    res.status(403).json({
      error: "Wallet address does not match the SIWX signer.",
      code: "WALLET_ADDRESS_MISMATCH",
    });
    return;
  }

  const balanceUsd = prepaidLedger.getBalanceUsd(verification.address);
  const requestedModel = typeof req.query.model === "string" ? req.query.model : env.openaiModel;
  const estimatedRequestPriceUsd = estimateAuthorizationPriceUsd(requestedModel, {
    model: requestedModel,
    input: "What is 2+2?",
  });

  res.json({
    success: true,
    data: {
      walletAddress: verification.address,
      balanceUsd,
      canConsume: balanceUsd >= env.prepaidMinimumBalanceUsd,
      minimumBalanceUsd: env.prepaidMinimumBalanceUsd,
      estimatedRequestPriceUsd,
      minimumTopUpUsd: env.prepaidMinimumTopUpUsd,
      suggestedTopUpUsd: env.prepaidSuggestedTopUpUsd,
    },
  });
});

walletRouter.post("/x402/top-up", (req: Request, res: Response) => {
  const creditedUsd = getRequestedTopUpAmountUsd(req.body);

  res.json({
    success: true,
    message: serviceDescriptions.topUpSettled,
    creditedUsd,
    supportedTokens: ["USDC"],
    supportedChains: [env.x402Network],
    tokenAddress: getTopUpTokenAddress(env.x402Network),
  });
});
