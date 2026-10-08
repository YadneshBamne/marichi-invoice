import { createHash, randomUUID } from "node:crypto";
import type { Adapters } from "../gateway";

// Deterministic fakes. Magic inputs let tests drive failure paths:
//   (IRN magic prefixes: see getIrn)
//   PAN with 0 as its 9th char (last digit) => invalid; name containing "SANCTION" => AML hit; IRN starting "CANCEL" => cancelled.
const done = new Map<string, { bankRef: string; status: "succeeded" }>();

export const mock: Adapters = {
  kyc: {
    async verifyPan(pan, name) {
      return { valid: /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) && pan[8] !== "0", nameMatch: name.length > 0 };
    },
    async verifyBankAccount(acct, _ifsc, name) {
      return { exists: acct.length >= 9, nameMatch: name.length > 0 };
    },
    async screenAml(name) {
      const hit = name.toUpperCase().includes("SANCTION");
      return { score: hit ? 95 : 3, hit };
    },
  },
  irn: {
    // Echoes the claim as canonical, so dev flows work. Magic prefixes drive failure paths:
    //   NOTFOUND => null, CANCEL => cancelled, DOWN => provider outage, MISMATCH => amount differs.
    async getIrn(irn, hint) {
      if (irn.startsWith("DOWN")) throw new Error("IRP unavailable");
      if (irn.startsWith("NOTFOUND")) return null;
      const c = hint ?? { amount: 0n, buyerGstin: "", sellerGstin: "", date: "" };
      return { ...c, amount: irn.startsWith("MISMATCH") ? c.amount + 1n : c.amount, cancelled: irn.startsWith("CANCEL") };
    },
  },
  bureau: {
    async pull(pan) {
      const n = parseInt(createHash("sha1").update(pan).digest("hex").slice(0, 4), 16);
      return pan.startsWith("NOHIT") ? { score: null, noHit: true } : { score: 600 + (n % 250), noHit: false };
    },
  },
  payments: {
    async payout(p) {
      const prev = done.get(p.idempotencyKey);
      if (prev) return prev; // idempotent replay
      const r = { bankRef: `MOCK-${p.idempotencyKey}`, status: "succeeded" as const };
      done.set(p.idempotencyKey, r);
      return r;
    },
    async payoutStatus() {
      return "succeeded";
    },
    async issueVirtualAccount(p) {
      const digits = BigInt("0x" + createHash("sha1").update(p.idempotencyKey).digest("hex").slice(0, 12)) % 10n ** 12n;
      return { accountNumber: `MARI${digits.toString().padStart(12, "0")}`, ifsc: "MOCK0000001" };
    },
  },
  esign: {
    async request(p) {
      return { requestId: `MOCKSIGN-${p.idempotencyKey}` };
    },
  },
  // ponytail: the mock bank has no statement feed, so reconciliation is exercised in tests with injected lines.
  statements: { async fetch() { return []; } },
  notify: {
    async send() {
      return { providerRef: `MOCKMSG-${randomUUID()}` };
    },
  },
};
