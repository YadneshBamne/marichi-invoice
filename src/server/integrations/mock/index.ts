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
  // Magic input: an account number ending 0000 has no funds, so its debits fail. Anything else succeeds at once.
  mandates: {
    async register(p) { return { mandateRef: `MOCKMD-${p.idempotencyKey}`, status: "pending" }; },
    async debit(p) {
      if (p.mandateRef.endsWith("FAIL")) return { debitRef: `MOCKDB-${p.idempotencyKey}`, status: "failed", reason: "insufficient funds" };
      return { debitRef: `MOCKDB-${p.idempotencyKey}`, status: "succeeded", utr: `NACH${createHash("sha1").update(p.idempotencyKey).digest("hex").slice(0, 12).toUpperCase()}` };
    },
    async cancel() {},
  },
  // Fixed sandbox rates (rupees per unit, micro). A real adapter reads the bank's or a treasury feed's live rate.
  fx: {
    async rate(currency) {
      const r: Record<string, bigint> = { USD: 83_500_000n, EUR: 90_200_000n, GBP: 105_800_000n, AED: 22_730_000n, SGD: 62_000_000n };
      if (!r[currency]) throw new Error(`no rate for ${currency}`);
      return { midMicro: r[currency], asOf: new Date().toISOString() };
    },
  },
  // Sandbox reading: plausible values derived from the file itself, flagged as simulated so the UI says so.
  ocr: {
    async extractInvoice({ bytes }) {
      const h = createHash("sha1").update(bytes).digest("hex");
      const n = parseInt(h.slice(0, 6), 16);
      const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
      return {
        simulated: true,
        fields: {
          invoiceNumber: `INV-${h.slice(0, 5).toUpperCase()}`, invoiceDate: day(-7), dueDate: day(53), totalAmount: String(100000 + (n % 900000)), currency: "INR",
          sellerName: null, sellerGstin: null, buyerName: null, buyerGstin: null, irn: null, poReference: `PO-${h.slice(5, 9).toUpperCase()}`,
        },
      };
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
