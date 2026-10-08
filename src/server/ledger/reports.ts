import { sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { xirr } from "./xirr";
import { ACCOUNTS } from "./accounts";

const rows = <T,>(r: unknown) => (r as { rows: T[] }).rows;

export type TbRow = { code: string; debit: bigint; credit: bigint; balance: bigint };

/** Trial balance as of a moment (default: now). `balanced` must always be true; the DB trigger makes imbalance impossible. */
export async function trialBalance(db: Database, asOf = new Date()) {
  const r = rows<{ code: string; debit: string; credit: string }>(await db.execute(sql`
    select a.code,
      coalesce(sum(case when e.direction = 'debit' then e.amount end), 0)::text as debit,
      coalesce(sum(case when e.direction = 'credit' then e.amount end), 0)::text as credit
    from ledger_accounts a
    left join (ledger_entries e join ledger_transactions t on t.id = e.transaction_id and t.created_at <= ${asOf.toISOString()}::timestamptz)
      on e.account_id = a.id
    group by a.code order by a.code`));
  const out: TbRow[] = r.map((x) => ({ code: x.code, debit: BigInt(x.debit), credit: BigInt(x.credit), balance: BigInt(x.debit) - BigInt(x.credit) }));
  const debit = out.reduce((a, x) => a + x.debit, 0n);
  const credit = out.reduce((a, x) => a + x.credit, 0n);
  return { rows: out, totalDebit: debit, totalCredit: credit, balanced: debit === credit };
}

/** General-ledger lines for a date range (UTC dates, inclusive), oldest first. */
export async function generalLedger(db: Database, from: string, to: string) {
  return rows<{ at: string; ref: string; type: string; account: string; debit: string; credit: string }>(await db.execute(sql`
    select t.created_at::text as at, t.ref, t.type, a.code as account,
      case when e.direction = 'debit' then e.amount::text else '0' end as debit,
      case when e.direction = 'credit' then e.amount::text else '0' end as credit
    from ledger_entries e
    join ledger_transactions t on t.id = e.transaction_id
    join ledger_accounts a on a.id = e.account_id
    where t.created_at >= ${from}::date and t.created_at < (${to}::date + 1)
    order by t.created_at, t.ref, a.code`));
}

/** Platform income for a period, straight from the ledger (revenue recognition). Income accounts are credit-normal. */
export async function revenueReport(db: Database, from: string, to: string) {
  const r = rows<{ code: string; net: string }>(await db.execute(sql`
    select a.code, sum(case when e.direction = 'credit' then e.amount else -e.amount end)::text as net
    from ledger_entries e
    join ledger_transactions t on t.id = e.transaction_id
    join ledger_accounts a on a.id = e.account_id
    where a.code in (${ACCOUNTS.feeIncome}, ${ACCOUNTS.discountIncome}, ${ACCOUNTS.penalIncome}, ${ACCOUNTS.creditLoss}, ${ACCOUNTS.gstPayable})
      and t.created_at >= ${from}::date and t.created_at < (${to}::date + 1)
    group by a.code`));
  const get = (c: string) => BigInt(r.find((x) => x.code === c)?.net ?? "0");
  const feeIncome = get(ACCOUNTS.feeIncome), discountIncome = get(ACCOUNTS.discountIncome), penalIncome = get(ACCOUNTS.penalIncome);
  const creditLoss = -get(ACCOUNTS.creditLoss); // expense is debit-normal, so flip the sign
  return { feeIncome, discountIncome, penalIncome, creditLoss, gstCollected: get(ACCOUNTS.gstPayable), netRevenue: feeIncome + discountIncome + penalIncome - creditLoss };
}

/**
 * Realised annualised yield (XIRR) on the platform's money, over invoices that have fully repaid.
 * Out: net cash paid to the seller. In: principal + discount + penal received (the seller's surplus isn't ours).
 */
export async function portfolioXirr(db: Database) {
  const out = rows<{ d: string; amt: string }>(await db.execute(sql`
    select to_char(d.completed_at at time zone 'UTC', 'YYYY-MM-DD') as d, (-d.amount)::text as amt
    from disbursements d join financing_offers o on o.id = d.offer_id join invoices i on i.id = o.invoice_id
    where d.status = 'succeeded' and i.status = 'paid'`));
  const inn = rows<{ d: string; amt: string }>(await db.execute(sql`
    select to_char(r.received_at at time zone 'UTC', 'YYYY-MM-DD') as d,
      ((r.allocation->>'principal')::numeric + (r.allocation->>'discount')::numeric + (r.allocation->>'penal')::numeric)::text as amt
    from repayments r join invoices i on i.id = r.invoice_id where i.status = 'paid'`));
  const flows = [...out, ...inn].map((x) => ({ date: x.d, amount: Number(x.amt) / 100 }));
  const rate = xirr(flows);
  return { xirr: rate, flows: flows.length };
}

/** CSV with formula-injection neutralised (cells starting = + - @ are prefixed) and RFC-4180 quoting. */
export function toCsv(table: (string | number | bigint)[][]) {
  const cell = (v: string | number | bigint) => {
    let s = String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return table.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
