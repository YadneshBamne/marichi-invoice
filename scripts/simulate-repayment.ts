// Dev tool: simulate the buyer paying an invoice, by sending the bank-credit webhook the real bank would send.
// Goes through the real endpoint (HMAC-signed), so it exercises the same path as production.
// usage: npx tsx --env-file=.env scripts/simulate-repayment.ts [invoiceNumber] [--on YYYY-MM-DD] [--amount rupees] [--url http://localhost:3002]
//   --on      day the payment "arrives" (default: the invoice's due date, so the full discount accrues)
//   --amount  rupees paid (default: the invoice amount)
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/server/db/client";
import { invoiceCollections, invoices, repayments, virtualAccounts } from "../src/server/db/schema";
import { formatMoney, rupeesToPaise } from "../src/lib/money";

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const number = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "INV-001";

async function main() {
  const secret = process.env.PAYMENTS_WEBHOOK_SECRET;
  if (!secret) throw new Error("PAYMENTS_WEBHOOK_SECRET is not set in .env");
  const base = (flag("url") ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");

  const [row] = await db.select({ i: invoices, va: virtualAccounts }).from(invoices)
    .innerJoin(virtualAccounts, eq(virtualAccounts.invoiceId, invoices.id)).where(eq(invoices.invoiceNumber, number));
  if (!row) throw new Error(`no invoice ${number} with a collection account (has it been offered and signed?)`);
  if (!["financed", "due", "overdue"].includes(row.i.status)) throw new Error(`${number} is ${row.i.status}; only financed invoices can be repaid`);

  const on = flag("on") ?? row.i.dueDate;
  const amount = flag("amount") ? rupeesToPaise(flag("amount")!) : row.i.amount;
  const body = JSON.stringify({
    accountNumber: row.va.accountNumber, amountPaise: amount.toString(), utr: `SIM${Date.now()}`, receivedAt: `${on}T10:00:00.000Z`,
  });
  const res = await fetch(`${base}/api/webhooks/collections`, {
    method: "POST", body, headers: { "content-type": "application/json", "x-signature": createHmac("sha256", secret).update(body).digest("hex") },
  });
  console.log(`webhook -> ${res.status} ${await res.text()}`);
  if (!res.ok) throw new Error("the webhook was rejected; is the dev server running at " + base + "?");

  const [rep] = await db.select().from(repayments).where(eq(repayments.invoiceId, row.i.id));
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, row.i.id));
  const [col] = await db.select().from(invoiceCollections).where(eq(invoiceCollections.invoiceId, row.i.id));
  const al = (rep?.allocation ?? {}) as Record<string, string>;
  console.log(`\n${number}: paid ${formatMoney(amount)} on ${on}`);
  console.log(`  principal  ${formatMoney(BigInt(al.principal ?? 0))}`);
  console.log(`  discount   ${formatMoney(BigInt(al.discount ?? 0))}`);
  console.log(`  penal      ${formatMoney(BigInt(al.penal ?? 0))}`);
  console.log(`  surplus to seller  ${formatMoney(BigInt(al.surplus ?? 0))}`);
  console.log(`  invoice status: ${inv.status}${col?.closedAt ? " (closed)" : ""}`);
  await pool.end();
}
main().catch((e) => { console.error("ERROR:", e.message ?? e); process.exit(1); });
