import express from "express";

import { env } from "./config/env";
import { serviceDescriptions } from "./descriptions";
import { getMaximumChargeUsd, getMinimumChargeUsd, getModelDescriptor, listAvailableModelPricing } from "./model-pricing";
import { generateRouter } from "./routes/generate";
import { createInferencePaymentMiddleware } from "./x402";
import { notFoundHandler, errorHandler } from "./middleware/error-handler";

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: serviceDescriptions.serviceName,
    overview: serviceDescriptions.serviceOverview,
    tagline: serviceDescriptions.marketplaceTagline,
    use_cases: serviceDescriptions.marketplaceUseCases,
    network: "BASE",
    payment: {
      protocol: "x402",
      network: env.x402Network,
      api_key_required: false,
      min_charge_usd: getMinimumChargeUsd(),
      max_charge_usd: getMaximumChargeUsd(),
      settlement: "usage-settled up to the request authorization cap",
    },
    compatibility: {
      openai_compatible: true,
      response_formats: ["responses", "chat.completions"],
    },
    defaultModel: env.openaiModel,
    availableModels: listAvailableModelPricing().map((pricing) => ({
      id: pricing.model,
      priceUsd: pricing.priceUsd,
      tier: getModelDescriptor(pricing.model).tier,
    })),
    endpoints: {
      models: "GET /v1/models",
      chatCompletions: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
    },
  });
});

app.use(createInferencePaymentMiddleware());
app.use("/v1", generateRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`api.zeno.finance API listening on http://localhost:${env.port}`);
  console.log(`x402 network: ${env.x402Network}`);
  console.log("Paid routes: POST /v1/chat/completions and POST /v1/responses");
});
