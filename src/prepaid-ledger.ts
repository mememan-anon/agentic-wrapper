import { randomUUID } from "node:crypto";

import { db } from "./storage";

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function nowIso(): string {
  return new Date().toISOString();
}

type ReservationRow = {
  address: string;
  amount_usd: number;
  status: "reserved" | "committed" | "released";
};

class SqlitePrepaidLedger {
  getBalanceUsd(address: string): number {
    const row = db
      .prepare("SELECT balance_usd FROM prepaid_balances WHERE address = ?")
      .get(normalizeAddress(address)) as { balance_usd: number } | undefined;

    return roundUsd(row?.balance_usd ?? 0);
  }

  canConsume(address: string, amountUsd: number): boolean {
    const balanceUsd = this.getBalanceUsd(address);
    return balanceUsd >= amountUsd;
  }

  reserve(address: string, amountUsd: number): string | null {
    const normalizedAddress = normalizeAddress(address);
    const roundedAmountUsd = roundUsd(amountUsd);
    const timestamp = nowIso();
    const reservationId = randomUUID();

    const reserveTransaction = db.transaction(() => {
      const currentBalance = this.getBalanceUsd(normalizedAddress);
      if (currentBalance < roundedAmountUsd) {
        return null;
      }

      db.prepare(
        `INSERT INTO prepaid_balances (address, balance_usd, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           balance_usd = excluded.balance_usd,
           updated_at = excluded.updated_at`,
      ).run(normalizedAddress, roundUsd(currentBalance - roundedAmountUsd), timestamp);

      db.prepare(
        `INSERT INTO prepaid_reservations (id, address, amount_usd, status, created_at, updated_at)
         VALUES (?, ?, ?, 'reserved', ?, ?)`,
      ).run(reservationId, normalizedAddress, roundedAmountUsd, timestamp, timestamp);

      return reservationId;
    });

    return reserveTransaction();
  }

  credit(address: string, amountUsd: number): number {
    const normalizedAddress = normalizeAddress(address);
    const roundedAmountUsd = roundUsd(amountUsd);
    const timestamp = nowIso();

    const creditTransaction = db.transaction(() => {
      const nextBalance = roundUsd(this.getBalanceUsd(normalizedAddress) + roundedAmountUsd);
      db.prepare(
        `INSERT INTO prepaid_balances (address, balance_usd, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           balance_usd = excluded.balance_usd,
           updated_at = excluded.updated_at`,
      ).run(normalizedAddress, nextBalance, timestamp);

      return nextBalance;
    });

    return creditTransaction();
  }

  creditSettlement(input: {
    settlementKey: string;
    address: string;
    amountUsd: number;
    transactionHash?: string;
    network?: string;
  }): { credited: boolean; balanceUsd: number } {
    const normalizedAddress = normalizeAddress(input.address);
    const roundedAmountUsd = roundUsd(input.amountUsd);
    const timestamp = nowIso();

    const creditTransaction = db.transaction(() => {
      const insertResult = db.prepare(
        `INSERT OR IGNORE INTO top_up_settlements
           (settlement_key, address, amount_usd, transaction_hash, network, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.settlementKey,
        normalizedAddress,
        roundedAmountUsd,
        input.transactionHash || null,
        input.network || null,
        timestamp,
      );

      if (insertResult.changes === 0) {
        return {
          credited: false,
          balanceUsd: this.getBalanceUsd(normalizedAddress),
        };
      }

      return {
        credited: true,
        balanceUsd: this.credit(normalizedAddress, roundedAmountUsd),
      };
    });

    return creditTransaction();
  }

  commitReservation(reservationId: string, settledAmountUsd?: number): boolean {
    const timestamp = nowIso();

    const commitTransaction = db.transaction(() => {
      const reservation = db
        .prepare("SELECT address, amount_usd, status FROM prepaid_reservations WHERE id = ?")
        .get(reservationId) as ReservationRow | undefined;

      if (!reservation || reservation.status !== "reserved") {
        return false;
      }

      const reservedAmountUsd = roundUsd(reservation.amount_usd);
      const capturedAmountUsd =
        typeof settledAmountUsd === "number" && Number.isFinite(settledAmountUsd)
          ? roundUsd(Math.max(0, Math.min(settledAmountUsd, reservedAmountUsd)))
          : reservedAmountUsd;
      const refundedAmountUsd = roundUsd(reservedAmountUsd - capturedAmountUsd);

      db.prepare(
        `UPDATE prepaid_reservations
         SET amount_usd = ?, status = 'committed', updated_at = ?
         WHERE id = ?`,
      ).run(capturedAmountUsd, timestamp, reservationId);

      if (refundedAmountUsd > 0) {
        this.credit(reservation.address, refundedAmountUsd);
      }

      return true;
    });

    return commitTransaction();
  }

  releaseReservation(reservationId: string): boolean {
    const timestamp = nowIso();

    const releaseTransaction = db.transaction(() => {
      const reservation = db
        .prepare("SELECT address, amount_usd, status FROM prepaid_reservations WHERE id = ?")
        .get(reservationId) as ReservationRow | undefined;

      if (!reservation || reservation.status !== "reserved") {
        return false;
      }

      db.prepare(
        `UPDATE prepaid_reservations
         SET status = 'released', updated_at = ?
         WHERE id = ?`,
      ).run(timestamp, reservationId);

      this.credit(reservation.address, reservation.amount_usd);
      return true;
    });

    return releaseTransaction();
  }
}

export const prepaidLedger = new SqlitePrepaidLedger();
