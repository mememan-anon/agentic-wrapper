import crypto from "node:crypto";

import {
  parseSIWxHeader,
  validateSIWxMessage,
  verifySIWxSignature,
  type SIWxPayload,
} from "@x402/extensions/sign-in-with-x";

import { env } from "./config/env";
import { serviceDescriptions } from "./descriptions";
import { db } from "./storage";

type SiwxChallenge = {
  info: {
    domain: string;
    uri: string;
    version: string;
    nonce: string;
    issuedAt: string;
    expirationTime: string;
    statement: string;
  };
  supportedChains: Array<{
    chainId: string;
    type: "eip191" | "eip1271";
  }>;
};

function createNonce(length = 21): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(length);
  let nonce = "";

  for (let index = 0; index < length; index += 1) {
    nonce += alphabet[bytes[index] % alphabet.length];
  }

  return nonce;
}

function getDomainFromResourceUri(resourceUri: string): string {
  return new URL(resourceUri).hostname;
}

function cleanupExpiredNonces(): void {
  db.prepare("DELETE FROM siwx_nonces WHERE expires_at <= ?").run(new Date().toISOString());
}

function isNonceUnused(nonce: string): boolean {
  cleanupExpiredNonces();

  const row = db
    .prepare("SELECT nonce FROM siwx_nonces WHERE nonce = ?")
    .get(nonce) as { nonce: string } | undefined;

  return !row;
}

function markNonceUsed(nonce: string, expirationTime: string): void {
  cleanupExpiredNonces();

  db.prepare(
    `INSERT INTO siwx_nonces (nonce, expires_at, used_at)
     VALUES (?, ?, ?)`,
  ).run(nonce, expirationTime, new Date().toISOString());
}

export function buildSiwxChallenge(resourceUri: string): SiwxChallenge {
  const issuedAt = new Date();

  return {
    info: {
      domain: getDomainFromResourceUri(resourceUri),
      uri: resourceUri,
      version: "1",
      nonce: createNonce(),
      issuedAt: issuedAt.toISOString(),
      expirationTime: new Date(issuedAt.getTime() + 5 * 60 * 1000).toISOString(),
      statement: serviceDescriptions.siwxStatement,
    },
    supportedChains: [
      {
        chainId: env.x402Network,
        type: "eip191",
      },
      {
        chainId: env.x402Network,
        type: "eip1271",
      },
    ],
  };
}

export function readSiwxHeader(headers: {
  get(name: string): string | undefined | null;
}): string | null {
  return (
    headers.get("x-sign-in-with-x") ||
    headers.get("sign-in-with-x") ||
    headers.get("X-Sign-In-With-X") ||
    headers.get("SIGN-IN-WITH-X") ||
    null
  );
}

export async function verifySiwxHeader(headerValue: string, resourceUri: string): Promise<{
  address?: string;
  payload?: SIWxPayload;
  error?: string;
}> {
  let payload: SIWxPayload;

  try {
    payload = parseSIWxHeader(headerValue);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid Sign-In-With-X payload.",
    };
  }

  const validation = await validateSIWxMessage(payload, resourceUri, {
    checkNonce: isNonceUnused,
  });

  if (!validation.valid) {
    return {
      error: validation.error || "SIWX validation failed.",
    };
  }

  const verification = await verifySIWxSignature(payload);
  if (!verification.valid || !verification.address) {
    return {
      error: verification.error || "SIWX signature verification failed.",
    };
  }

  try {
    markNonceUsed(
      payload.nonce,
      payload.expirationTime || new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    );
  } catch {
    return {
      error: "SIWX nonce has already been used.",
    };
  }

  return {
    address: verification.address,
    payload,
  };
}
