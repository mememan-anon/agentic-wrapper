import express from "express";

import { env } from "./config/env";
import { serviceDescriptions } from "./descriptions";
import { listAvailableModelPricing } from "./model-pricing";
import { prepaidAuthMiddleware } from "./middleware/prepaid-auth";
import { generateRouter } from "./routes/generate";
import { walletRouter } from "./routes/wallet";
import { createTopUpPaymentMiddleware } from "./x402";
import { notFoundHandler, errorHandler } from "./middleware/error-handler";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: serviceDescriptions.serviceName,
    defaultModel: env.openaiModel,
    availableModels: listAvailableModelPricing().map((pricing) => ({
      id: pricing.model,
      priceUsd: pricing.priceUsd,
    })),
    endpoints: {
      models: "GET /v1/models",
      balance: "GET /v1/x402/balance/:walletAddress",
      topUp: "POST /v1/x402/top-up",
      chatCompletions: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
    },
  });
});

app.use(createTopUpPaymentMiddleware());
app.use("/v1", walletRouter);
app.post("/v1/chat/completions", prepaidAuthMiddleware);
app.post("/v1/responses", prepaidAuthMiddleware);
app.use("/v1", generateRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`Paid AI seller API listening on http://localhost:${env.port}`);
  console.log(`x402 network: ${env.x402Network}`);
  console.log("Wallet-authenticated routes: POST /v1/chat/completions and POST /v1/responses");
  console.log("Top-up route: POST /v1/x402/top-up");
});
