import { sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { ledgerAccounts } from "../db/schema";

// Chart of accounts (debit-normal assets, credit-normal liabilities/income):
//   escrow_cash            asset      cash in the regulated escrow/nodal account
//   receivable:<sellerId>  asset      advances owed by that seller (principal outstanding)
//   fee_income             income     processing fees earned
//   platform_capital       equity     own balance-sheet capital put into escrow
export const ACCOUNTS = {
  escrow: "escrow_cash",
  feeIncome: "fee_income",
  capital: "platform_capital",
  receivable: (sellerId: string) => `receivable:${sellerId}`,
  discountIncome: "discount_income", // recognised daily as it accrues (Dr accrued_discount, Cr discount_income)
  accruedDiscount: "accrued_discount_receivable", // asset: discount earned but not yet collected; always equals sum(invoice_collections.discount)
  gstPayable: "gst_payable", // liability: GST collected inside processing fees
  penalIncome: "penal_income",
  creditLoss: "credit_loss", // expense: principal written off
  sellerPayable: (sellerId: string) => `seller_payable:${sellerId}`, // surplus owed back to the seller
} as const;

/** Accounts are created explicitly (never by a typo inside postEntry). Idempotent. */
export async function ensureAccounts(tx: Database | Tx, codes: string[]) {
  for (const code of codes) await tx.insert(ledgerAccounts).values({ code }).onConflictDoNothing({ target: ledgerAccounts.code });
}

/** debits - credits, as paise. Positive = debit balance (assets), negative = credit balance. */
export async function balance(db: Database | Tx, code: string): Promise<bigint> {
  const r = await db.execute(sql`
    select coalesce(sum(case e.direction when 'debit' then e.amount else -e.amount end), 0)::text as bal
    from ledger_entries e join ledger_accounts a on a.id = e.account_id where a.code = ${code}`);
  const row = (r as unknown as { rows: { bal: string }[] }).rows[0];
  return BigInt(row.bal);
}
