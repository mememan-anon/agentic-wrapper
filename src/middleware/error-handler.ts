import type { NextFunction, Request, Response } from "express";

type ErrorWithStatus = Error & {
  statusCode?: number;
  status?: number;
  code?: string;
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: {
      message: `Route not found: ${req.method} ${req.originalUrl}`,
      code: "ROUTE_NOT_FOUND",
    },
  });
}

export function errorHandler(
  error: ErrorWithStatus,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const statusCode = Number.isInteger(error?.statusCode)
    ? Number(error.statusCode)
    : Number.isInteger(error?.status)
      ? Number(error.status)
      : 500;

  const isProviderError =
    statusCode >= 400 &&
    statusCode < 500 &&
    (req.originalUrl === "/v1/chat/completions" || req.originalUrl === "/v1/responses");

  if (statusCode >= 500) {
    console.error("Unhandled request error", {
      method: req.method,
      url: req.originalUrl,
      message: error?.message,
    });
  }

  res.status(statusCode).json({
    ok: false,
    error: {
      code: error?.code || (isProviderError ? "MODEL_PROVIDER_ERROR" : "REQUEST_FAILED"),
      message: error?.message || "An unexpected error occurred.",
      statusCode,
    },
  });
}
