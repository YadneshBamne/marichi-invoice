// Figures an underwriter wants from a bank statement, and checks that the statement itself is whole and unedited.
// Pure functions on parsed lines: no database, no clock. Money is integer paise (bigint); shares are whole basis points.
import { formatMoney } from "../../lib/money";
import type { StatementLine } from "./parse";

export type Flag = { code: string; severity: "low" | "medium" | "high"; text: string };
export type Party = { name: string; total: bigint; count: number };
export type Tally = { count: number; amount: bigint };
export type MonthFigures = { month: string; credits: bigint; debits: bigint; avgBalance: bigint | null; minBalance: bigint | null };
export type Summary = {
  rows: number; periodFrom: string; periodTo: string;
  months: number; // calendar months from the first to the last transaction, both ends counted
  totalCredits: bigint; totalDebits: bigint;
  avgMonthlyTurnover: bigint; // money in per month: total credits / months
  avgBalance: bigint | null; // average of each day's closing balance (days without a transaction keep the last balance)
  minBalance: bigint | null; // the lowest balance shown on any row
  byMonth: MonthFigures[];
  inwardReturns: Tally; // our own payments or cheques that bounced, or the charges for it
  outwardReturns: Tally; // cheques or payments we received that came back
  cashDeposits: bigint; cashShareBps: number; // share of all money in
  topPayers: Party[]; topPayees: Party[]; topPayerShareBps: number;
  roundTrips: Tally & { shareBps: number }; // money in that went out again, same amount, within 2 days
  daysCovered: number; daysNegative: number; daysLow: number; // days whose closing balance was below zero / below LOW_BALANCE
  integrity: { balanceRows: number; balanceBreaks: number; outOfOrder: number; duplicates: number };
  flags: Flag[];
};

const RS = (n: number) => BigInt(n) * 100n;
export const LOW_BALANCE = RS(10_000);
const ROUND_TRIP_MIN = RS(10_000); // smaller amounts go in and out all the time
const DAY = 86_400_000;
const dayNum = (iso: string) => Date.parse(iso) / DAY;
const bps = (a: bigint, b: bigint) => (b > 0n ? Number((a * 10_000n) / b) : 0);
const pct = (b: number) => `${(b / 100).toFixed(b % 100 ? 1 : 0)}%`;

// ---------- reading the narration ----------

const RETURN_RE = /\b(RTN|RET|RETURN(?:ED)?|BOUNCE[D]?|UNPAID|DISHONOU?RED?|INSUFFICIENT|INSUFF)\b|CHQ\s*RET|CHEQUE\s*RET|ECS\s*RET|NACH\s*RET/;
const OUTWARD_RE = /\bO\/?W\b|OUTWARD|CHQ\s*DEP|DEPOSIT/; // a cheque we deposited came back
const INWARD_RE = /INSUFF|\bI\/?W\b|INWARD|(?:NACH|ECS|ACH|MANDATE).*(?:CHG|CHARGE|FEE|PENALTY)|(?:CHG|CHARGE|FEE|PENALTY).*(?:RET|RTN|BOUNCE|UNPAID)/;
const CASH_RE = /\bCASH\s*-?\s*(?:DEP|DEPOSIT|DEPOSITED)|\bCDM\b|\bBY\s+CASH\b|\bCSH\s*DEP/;
const CHANNEL_RE = /\b(UPI|NEFT|RTGS|IMPS)\b/;
const WORDS = /^(UPI|NEFT|RTGS|IMPS|CR|DR|MMT|TPT|IB|INF|INFT|BY|TO|FROM|TRANSFER|P2A|P2M|P2P)( (CR|DR|IN|OUT|TRANSFER))?$/;
const BANK_CODE = /^[A-Z]{4}0[A-Z0-9]{6}$/; // IFSC

/** The name of the other side of a UPI, NEFT, RTGS or IMPS transfer: the first piece of the narration that is not a code or a reference. */
export function counterparty(narration: string): string | null {
  const n = narration.toUpperCase();
  if (!CHANNEL_RE.test(n)) return null;
  for (const raw of n.split(/[\/\-*|:]/)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (t.length < 3 || WORDS.test(t) || BANK_CODE.test(t) || t.includes("@")) continue;
    if (!/\s/.test(t) && /\d/.test(t)) continue; // a reference number
    if (!/[A-Z]{3}/.test(t)) continue;
    return t.replace(/[.,]+$/, "");
  }
  return null;
}

function top(lines: StatementLine[], side: "credit" | "debit"): Party[] {
  const by = new Map<string, Party>();
  for (const l of lines) {
    const amt = l[side];
    const name = amt > 0n ? counterparty(l.narration) : null;
    if (!name) continue;
    const p = by.get(name) ?? { name, total: 0n, count: 0 };
    p.total += amt; p.count++;
    by.set(name, p);
  }
  return [...by.values()].sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0)).slice(0, 5);
}

// ---------- balances by day ----------

/** Each day's closing balance from the first to the last transaction day; a quiet day keeps the previous balance. */
function dailyBalances(lines: StatementLine[]): { day: string; balance: bigint }[] {
  const close = new Map<string, bigint>();
  for (const l of lines) if (l.balance !== null) close.set(l.on, l.balance);
  if (close.size === 0) return [];
  const days = lines.map((l) => dayNum(l.on));
  const out: { day: string; balance: bigint }[] = [];
  let cur: bigint | null = null;
  for (let d = Math.min(...days); d <= Math.max(...days); d++) {
    const iso = new Date(d * DAY).toISOString().slice(0, 10);
    cur = close.get(iso) ?? cur;
    if (cur !== null) out.push({ day: iso, balance: cur });
  }
  return out;
}

const mean = (xs: bigint[]) => (xs.length ? xs.reduce((a, b) => a + b, 0n) / BigInt(xs.length) : null);
const minOf = (xs: bigint[]) => (xs.length ? xs.reduce((a, b) => (b < a ? b : a)) : null);

// ---------- the summary ----------

/** `lines` must be in statement order, oldest first (the parser does that). At least one line. */
export function analyse(lines: StatementLine[]): Summary {
  const dates = lines.map((l) => l.on).sort();
  const periodFrom = dates[0], periodTo = dates[dates.length - 1];
  const months = (Number(periodTo.slice(0, 4)) - Number(periodFrom.slice(0, 4))) * 12 + Number(periodTo.slice(5, 7)) - Number(periodFrom.slice(5, 7)) + 1;
  const totalCredits = lines.reduce((a, l) => a + l.credit, 0n);
  const totalDebits = lines.reduce((a, l) => a + l.debit, 0n);
  const daily = dailyBalances(lines);
  const withBalance = lines.filter((l) => l.balance !== null).map((l) => l.balance!);

  const byMonth: MonthFigures[] = [];
  for (let i = 0, y = Number(periodFrom.slice(0, 4)), m = Number(periodFrom.slice(5, 7)); i < months; i++, m++) {
    if (m > 12) { m = 1; y++; }
    const key = `${y}-${String(m).padStart(2, "0")}`;
    const inMonth = lines.filter((l) => l.on.startsWith(key));
    const bals = inMonth.filter((l) => l.balance !== null).map((l) => l.balance!);
    byMonth.push({
      month: key, credits: inMonth.reduce((a, l) => a + l.credit, 0n), debits: inMonth.reduce((a, l) => a + l.debit, 0n),
      avgBalance: mean(daily.filter((d) => d.day.startsWith(key)).map((d) => d.balance)), minBalance: minOf(bals),
    });
  }

  const inward: Tally = { count: 0, amount: 0n }, outward: Tally = { count: 0, amount: 0n };
  let cash = 0n;
  for (const l of lines) {
    const n = l.narration.toUpperCase();
    if (l.debit > 0n && RETURN_RE.test(n)) {
      const t = !OUTWARD_RE.test(n) && INWARD_RE.test(n) ? inward : outward;
      t.count++; t.amount += l.debit;
    }
    if (l.credit > 0n && CASH_RE.test(n)) cash += l.credit;
  }

  // Money in that goes straight out again: a credit and a later debit of exactly the same amount, at most 2 days apart.
  const outs = new Map<bigint, number[]>();
  lines.forEach((l, i) => { if (l.debit >= ROUND_TRIP_MIN) outs.set(l.debit, [...(outs.get(l.debit) ?? []), i]); });
  const trips: Tally & { shareBps: number } = { count: 0, amount: 0n, shareBps: 0 };
  lines.forEach((l, i) => {
    const list = outs.get(l.credit);
    if (l.credit < ROUND_TRIP_MIN || !list) return;
    const at = list.findIndex((j) => j > i && dayNum(lines[j].on) - dayNum(l.on) >= 0 && dayNum(lines[j].on) - dayNum(l.on) <= 2);
    if (at < 0) return;
    list.splice(at, 1); // each payment out pairs with one payment in
    trips.count++; trips.amount += l.credit;
  });
  trips.shareBps = bps(trips.amount, totalCredits);

  const topPayers = top(lines, "credit");
  const integrity = { balanceRows: 0, balanceBreaks: 0, outOfOrder: 0, duplicates: 0 };
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1], b = lines[i];
    if (b.on < a.on) integrity.outOfOrder++;
    if (a.balance !== null && b.balance !== null) {
      integrity.balanceRows++;
      if (a.balance + b.credit - b.debit !== b.balance) integrity.balanceBreaks++;
    }
  }
  integrity.duplicates = lines.length - new Set(lines.map((l) => `${l.on}|${l.narration}|${l.debit}|${l.credit}|${l.balance}`)).size;

  const s: Summary = {
    rows: lines.length, periodFrom, periodTo, months, totalCredits, totalDebits,
    avgMonthlyTurnover: totalCredits / BigInt(months),
    avgBalance: mean(daily.map((d) => d.balance)), minBalance: minOf(withBalance), byMonth,
    inwardReturns: inward, outwardReturns: outward,
    cashDeposits: cash, cashShareBps: bps(cash, totalCredits),
    topPayers, topPayees: top(lines, "debit"), topPayerShareBps: topPayers.length ? bps(topPayers[0].total, totalCredits) : 0,
    roundTrips: trips,
    daysCovered: daily.length, daysNegative: daily.filter((d) => d.balance < 0n).length, daysLow: daily.filter((d) => d.balance < LOW_BALANCE).length,
    integrity, flags: [],
  };
  s.flags = flagsOf(s);
  return s;
}

const SEVERITY = { high: 0, medium: 1, low: 2 } as const;

function flagsOf(s: Summary): Flag[] {
  const f: Flag[] = [];
  const add = (code: string, severity: Flag["severity"], text: string) => f.push({ code, severity, text });
  const i = s.integrity;
  if (i.balanceBreaks > 0) add("balance_break", "high", `The running balance does not add up on ${i.balanceBreaks} of ${i.balanceRows} rows. A statement straight from the bank always adds up, so this one may have been edited or may be missing rows.`);
  if (i.outOfOrder > 0) add("dates_out_of_order", "medium", `${i.outOfOrder} row${i.outOfOrder === 1 ? " is" : "s are"} dated earlier than the row before. A bank prints transactions in date order.`);
  if (i.duplicates > 0) add("duplicate_rows", "medium", `${i.duplicates} row${i.duplicates === 1 ? " appears" : "s appear"} twice with the same date, narration, amount and balance, which looks like copying.`);
  if (s.minBalance === null) add("no_balance", "low", "The statement has no balance column, so balances could not be worked out and the running-balance check was skipped.");
  if (s.inwardReturns.count > 0) add("inward_returns", s.inwardReturns.count >= 3 ? "high" : "medium", `${s.inwardReturns.count} payment${s.inwardReturns.count === 1 ? "" : "s"} from this account bounced or were charged for it (${formatMoney(s.inwardReturns.amount)}), such as cheques or auto-debits returned for lack of funds.`);
  if (s.outwardReturns.count > 0) add("outward_returns", s.outwardReturns.count >= 3 ? "high" : "medium", `${s.outwardReturns.count} cheque${s.outwardReturns.count === 1 ? "" : "s"} or payment${s.outwardReturns.count === 1 ? "" : "s"} received came back unpaid (${formatMoney(s.outwardReturns.amount)}).`);
  if (s.cashShareBps >= 4_000) add("cash_heavy", s.cashShareBps >= 7_000 ? "high" : "medium", `${pct(s.cashShareBps)} of the money coming in is cash deposits, which is hard to trace to customers.`);
  if (s.topPayerShareBps >= 6_000) add("concentrated_credits", s.topPayerShareBps >= 8_000 ? "high" : "medium", `${pct(s.topPayerShareBps)} of the money coming in is from one payer (${s.topPayers[0].name}), so the business depends on that one customer.`);
  if (s.roundTrips.count > 0) {
    const sev = s.roundTrips.shareBps >= 3_000 ? "high" : s.roundTrips.shareBps >= 1_000 ? "medium" : "low";
    add("round_trips", sev, `${s.roundTrips.count} amount${s.roundTrips.count === 1 ? "" : "s"} (${formatMoney(s.roundTrips.amount)}, ${pct(s.roundTrips.shareBps)} of money in) went out again for exactly the same amount within 2 days. Money moved in a circle can make turnover look larger than it is.`);
  }
  if (s.daysNegative > 0) add("negative_balance", s.daysNegative >= 10 ? "high" : "medium", `The balance was below zero on ${s.daysNegative} day${s.daysNegative === 1 ? "" : "s"}.`);
  if (s.daysCovered > 0 && s.daysLow * 5 >= s.daysCovered) add("low_balance", s.daysLow * 2 >= s.daysCovered ? "medium" : "low", `The balance was below ${formatMoney(LOW_BALANCE)} on ${s.daysLow} of ${s.daysCovered} days.`);
  if (s.months < 6) add("short_history", "low", `The statement covers ${s.months} month${s.months === 1 ? "" : "s"}. Six months or more gives a fairer picture.`);
  return f.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);
}

/** The flags an underwriter should see first: everything except the minor notes, worst first. */
export const statementSignals = (s: Summary): Flag[] => s.flags.filter((f) => f.severity !== "low").sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]).slice(0, 6);

// ---------- storing the summary as JSON (it holds bigints) ----------

export const summaryToJson = (s: Summary): unknown => JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
export const summaryFromJson = (j: unknown): Summary => JSON.parse(JSON.stringify(j), (_k, v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
