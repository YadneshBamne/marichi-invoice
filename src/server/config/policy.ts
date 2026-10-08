// Admin-editable policy values. The code constants (POLICY, OFFER, ...) stay the defaults and the single place every module
// reads from; an override row in app_settings is applied onto those same live objects. A missing row = the code default.
// Every change needs a reason, is versioned in settings_history, and is mirrored to the audit log.
import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { appSettings, auditLog, settingsHistory } from "../db/schema";
import { COLLECTIONS } from "../collections/waterfall";
import { DISBURSE } from "../disbursements/service";
import { RULES } from "../invoices/service";
import { OFFER } from "../offers/pricing";
import { FRAUD } from "../fraud/engine";
import { ML } from "../underwriting/ml";
import { MARKET } from "../marketplace/service";
import { SLA_HOURS } from "../support/policy";
import { POLICY, type Grade } from "../underwriting/policy";
import { formatINR, rupeesToPaise, toDecimal } from "../../lib/money";

/** int = whole number, hours = whole hours, percent = stored as basis points, rupees = stored as paise. */
export type Kind = "int" | "hours" | "percent" | "rupees";
type Num = number | bigint;
export type Def = {
  key: string; group: string; label: string; help?: string; kind: Kind; min: Num; max: Num;
  get: () => Num; set: (v: Num) => void; fallback: Num;
};

// The live objects are typed as readonly in places; settings write through this loose view.
type Bag = Record<string, Num>;
const def = (key: string, group: string, label: string, kind: Kind, min: Num, max: Num, bag: Bag, prop: string, help?: string): Def =>
  ({ key, group, label, help, kind, min, max, get: () => bag[prop], set: (v) => { bag[prop] = v; }, fallback: bag[prop] });

const P = POLICY as unknown as Bag, O = OFFER as unknown as Bag, D = DISBURSE as unknown as Bag, C = COLLECTIONS as unknown as Bag, R = RULES as unknown as Bag;
const F = FRAUD as unknown as Bag, M = ML as unknown as Bag, K = MARKET as unknown as Bag;
const GRADES: Grade[] = ["A", "B", "C", "D", "E"];

export const DEFS: Def[] = [
  def("invoice.maxAgeDays", "Invoice rules", "Oldest invoice accepted (days)", "int", 1, 365, R, "maxAgeDays", "Invoices older than this are rejected on upload."),
  def("invoice.minTicket", "Invoice rules", "Smallest invoice", "rupees", rupeesToPaise("1000"), rupeesToPaise("10000000"), R, "minTicket"),
  def("invoice.maxTicket", "Invoice rules", "Largest invoice", "rupees", rupeesToPaise("10000"), rupeesToPaise("1000000000"), R, "maxTicket"),

  def("uw.minBureauScore", "Underwriting", "Minimum bureau score", "int", 300, 900, P, "minBureauScore"),
  def("uw.maxDpdAllowed", "Underwriting", "Decline if any obligation is past due by (days)", "int", 0, 365, P, "maxDpdAllowed"),
  def("uw.minTenorDays", "Underwriting", "Shortest time to due date (days)", "int", 1, 365, P, "minTenorDays"),
  def("uw.maxTenorDays", "Underwriting", "Longest time to due date (days)", "int", 1, 365, P, "maxTenorDays"),
  def("uw.defaultSellerLimit", "Underwriting", "Default seller limit", "rupees", rupeesToPaise("100000"), rupeesToPaise("100000000000"), P, "defaultSellerLimit", "Used for sellers with no individual limit."),
  def("uw.defaultBuyerCap", "Underwriting", "Default exposure cap per seller and buyer pair", "rupees", rupeesToPaise("100000"), rupeesToPaise("100000000000"), P, "defaultBuyerCap"),
  def("uw.noIrnAdvanceCutBps", "Underwriting", "Advance reduction when there is no e-invoice number", "percent", 0, 5000, P, "noIrnAdvanceCutBps", "Percentage points taken off the advance rate."),
  ...GRADES.flatMap((g) => {
    const m = POLICY.matrix[g] as unknown as Bag;
    return [
      def(`uw.matrix.${g}.advanceBps`, "Pricing by grade", `Grade ${g}: advance`, "percent", 0, 10000, m, "advanceBps"),
      def(`uw.matrix.${g}.discountBps`, "Pricing by grade", `Grade ${g}: discount per year`, "percent", 0, 6000, m, "discountBps"),
      def(`uw.matrix.${g}.autoMax`, "Pricing by grade", `Grade ${g}: auto-approve up to`, "rupees", 0, rupeesToPaise("1000000000"), m, "autoMax", "Zero means every invoice at this grade is reviewed by a person."),
    ];
  }),

  def("ml.mode", "Underwriting", "Scoring model: 0 off, 1 shadow, 2 assist", "int", 0, 2, M, "mode", "Shadow records the model beside the rules and changes nothing. Assist may only send an approval to a person when the model rates it two or more grades worse."),

  def("market.bidValidityHours", "Marketplace", "A bid stays open for (hours)", "hours", 1, 168, K, "bidValidityHours"),
  def("market.minDiscountBps", "Marketplace", "Lowest discount a financier may bid", "percent", 0, 6000, K, "minDiscountBps", "A year, as a percentage."),
  def("market.maxDiscountBps", "Marketplace", "Highest discount a financier may bid", "percent", 0, 6000, K, "maxDiscountBps", "The cap on what a seller can be charged."),
  def("market.platformShareBps", "Marketplace", "Platform share of discount and penal charges", "percent", 0, 10000, K, "platformShareBps", "Kept by the platform on financier-funded deals, besides the processing fee."),

  def("offer.validityHours", "Offers", "Offer stays open for (hours)", "hours", 1, 168, O, "validityHours"),
  def("offer.processingFeeBps", "Offers", "Processing fee (before GST)", "percent", 0, 1000, O, "processingFeeBps"),
  def("offer.defaultPlatformCapital", "Offers", "Platform capital available", "rupees", 0, rupeesToPaise("1000000000000"), O, "defaultPlatformCapital", "Ignored when the PLATFORM_CAPITAL_PAISE environment variable is set."),

  def("offer.minPartialAdvance", "Offers", "Smallest advance when financing part of an invoice", "rupees", 0, rupeesToPaise("1000000"), O, "minPartialAdvance"),

  def("disburse.approvalThreshold", "Payouts", "A second person must approve payouts above", "rupees", 0, rupeesToPaise("1000000000"), D, "approvalThreshold"),
  def("disburse.autoAttempts", "Payouts", "Automatic payout attempts before manual review", "int", 1, 10, D, "autoAttempts"),

  def("fraud.caseThreshold", "Fraud engine", "Score that opens a fraud case", "int", 10, 300, F, "caseThreshold", "Each signal adds points; any single high-severity signal also opens a case."),
  def("fraud.velocityPerDay", "Fraud engine", "Invoices from one seller in a day that count as a burst", "int", 2, 500, F, "velocityPerDay"),
  def("fraud.outlierMultiple", "Fraud engine", "Invoice this many times the seller's average is unusual", "int", 2, 100, F, "outlierMultiple"),
  def("fraud.newSellerDays", "Fraud engine", "A seller account is new for (days)", "int", 1, 180, F, "newSellerDays"),
  def("fraud.newSellerTicket", "Fraud engine", "A new seller raising at least this much is a signal", "rupees", rupeesToPaise("10000"), rupeesToPaise("1000000000"), F, "newSellerTicket"),

  def("collections.graceDays", "Collections", "Grace period after the due date (days)", "int", 0, 30, C, "graceDays"),
  def("collections.penalBps", "Collections", "Penal rate on overdue principal (per year)", "percent", 0, 6000, C, "penalBps"),
  def("collections.writeOffAfterDpd", "Collections", "Review for write-off after (days past due)", "int", 30, 365, C, "writeOffAfterDpd"),

  ...(["query", "complaint", "dispute", "grievance"] as const).flatMap((k) => [
    def(`sla.${k}.firstResponse`, "Support timers", `${k[0].toUpperCase()}${k.slice(1)}: first response (hours)`, "hours", 1, 720, SLA_HOURS[k] as unknown as Bag, "firstResponse"),
    def(`sla.${k}.resolve`, "Support timers", `${k[0].toUpperCase()}${k.slice(1)}: resolve within (hours)`, "hours", 1, 2160, SLA_HOURS[k] as unknown as Bag, "resolve", k === "grievance" ? "RBI expects grievances to be resolved within 30 days (720 hours)." : undefined),
  ]),
];
export const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));

// ---- value conversion -------------------------------------------------------------------------------------------------
const toJson = (v: Num) => (typeof v === "bigint" ? v.toString() : v);
const fromJson = (d: Def, j: unknown): Num => (typeof d.fallback === "bigint" ? BigInt(String(j)) : Number(j));

/** Number shown in the form: percent for bps, rupees for paise. */
export function toInput(d: Def, v: Num): string {
  if (d.kind === "percent") return String(Number(v) / 100);
  if (d.kind === "rupees") return toDecimal(v as bigint).replace(/\.00$/, "");
  return String(v);
}
export function display(d: Def, v: Num): string {
  if (d.kind === "percent") return `${Number(v) / 100}%`;
  if (d.kind === "rupees") return formatINR(v as bigint);
  if (d.kind === "hours") return `${v} h`;
  return String(v);
}
/** Parse what the admin typed into the stored unit, or throw a readable error. */
export function parseInput(d: Def, raw: string): Num {
  const t = raw.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) throw new Error(`${d.label}: enter a number`);
  let v: Num;
  if (d.kind === "rupees") v = rupeesToPaise(t);
  else if (d.kind === "percent") v = Math.round(parseFloat(t) * 100);
  else { if (t.includes(".")) throw new Error(`${d.label}: whole numbers only`); v = parseInt(t, 10); }
  if (v < d.min || v > d.max) throw new Error(`${d.label}: must be between ${display(d, d.min)} and ${display(d, d.max)}`);
  return v;
}

// ---- applying and reading ---------------------------------------------------------------------------------------------
function applyRows(rows: { key: string; value: unknown }[]) {
  const over = new Map(rows.map((r) => [r.key, r.value]));
  for (const d of DEFS) d.set(over.has(d.key) ? fromJson(d, over.get(d.key)) : d.fallback);
}

let loadedAt = 0;
/** Bring this process up to date with the database. Cheap: one query at most every 30 seconds per instance. */
export async function refreshPolicy(db: Database, force = false, now = Date.now()) {
  if (!force && now - loadedAt < 30_000) return;
  loadedAt = now;
  applyRows(await db.select({ key: appSettings.key, value: appSettings.value }).from(appSettings));
}

export async function listSettings(db: Database) {
  const [rows, hist] = await Promise.all([
    db.select().from(appSettings),
    db.select().from(settingsHistory).orderBy(settingsHistory.createdAt),
  ]);
  const row = new Map(rows.map((r) => [r.key, r]));
  return DEFS.map((d) => ({ def: d, current: row.has(d.key) ? fromJson(d, row.get(d.key)!.value) : d.fallback, overridden: row.has(d.key), updatedAt: row.get(d.key)?.updatedAt ?? null, version: row.get(d.key)?.version ?? 0 }))
    .map((s) => ({ ...s, history: hist.filter((h) => h.key === s.def.key).length }));
}

export const recentChanges = (db: Database, limit = 30) =>
  db.select().from(settingsHistory).orderBy(settingsHistory.createdAt).then((r) => r.reverse().slice(0, limit));

type Admin = { id: string; role: string };
function crossCheck(values: Map<string, Num>, current: (k: string) => Num) {
  const v = (k: string) => (values.has(k) ? values.get(k)! : current(k));
  if (v("uw.minTenorDays") > v("uw.maxTenorDays")) throw new Error("Shortest time to due date cannot be longer than the longest");
  if (v("invoice.minTicket") >= v("invoice.maxTicket")) throw new Error("Smallest invoice must be below the largest");
  for (const k of ["query", "complaint", "dispute", "grievance"]) if (v(`sla.${k}.firstResponse`) > v(`sla.${k}.resolve`)) throw new Error(`${k}: first response cannot be later than the resolution time`);
}

/** Save changed values. `inputs` maps key -> what the admin typed; unchanged values are ignored. Atomic, versioned, audited. */
export async function updateSettings(db: Database, actor: Admin, inputs: Record<string, string>, note: string) {
  if (actor.role !== "admin") throw new Error("only an administrator can change policy values");
  if (note.trim().length < 5) throw new Error("explain the reason for the change (at least 5 characters)");
  const changes = new Map<string, Num>();
  for (const [key, raw] of Object.entries(inputs)) {
    const d = DEF_BY_KEY.get(key);
    if (!d) throw new Error(`unknown setting: ${key}`);
    const v = parseInput(d, raw);
    if (v !== d.get()) changes.set(key, v);
  }
  if (changes.size === 0) return { changed: 0 };
  crossCheck(changes, (k) => DEF_BY_KEY.get(k)!.get());

  await db.transaction(async (tx) => {
    for (const [key, v] of changes) {
      const d = DEF_BY_KEY.get(key)!;
      const [prev] = await tx.select().from(appSettings).where(eq(appSettings.key, key));
      const version = (prev?.version ?? 0) + 1;
      await tx.insert(appSettings).values({ key, value: toJson(v), version, updatedBy: actor.id })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: toJson(v), version, updatedBy: actor.id, updatedAt: new Date() } });
      await tx.insert(settingsHistory).values({ key, version, before: toJson(prev ? fromJson(d, prev.value) : d.get()), after: toJson(v), note: note.trim(), changedBy: actor.id });
      await tx.insert(auditLog).values({ actorId: actor.id, action: "policy.changed", entity: "setting", entityId: key, before: { value: toJson(d.get()) }, after: { value: toJson(v), note: note.trim() } });
    }
  });
  for (const [key, v] of changes) DEF_BY_KEY.get(key)!.set(v); // this process sees it immediately; others within 30 s
  return { changed: changes.size };
}

/** Remove an override so the code default applies again. */
export async function resetSetting(db: Database, actor: Admin, key: string, note: string) {
  if (actor.role !== "admin") throw new Error("only an administrator can change policy values");
  if (note.trim().length < 5) throw new Error("explain the reason for the change (at least 5 characters)");
  const d = DEF_BY_KEY.get(key);
  if (!d) throw new Error(`unknown setting: ${key}`);
  await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(appSettings).where(eq(appSettings.key, key));
    if (!prev) return;
    await tx.delete(appSettings).where(eq(appSettings.key, key));
    await tx.insert(settingsHistory).values({ key, version: prev.version + 1, before: prev.value, after: null, note: note.trim(), changedBy: actor.id });
    await tx.insert(auditLog).values({ actorId: actor.id, action: "policy.reset", entity: "setting", entityId: key, before: { value: prev.value }, after: { note: note.trim() } });
  });
  d.set(d.fallback);
}

/** Tests only: put every value back to the code defaults. */
export const resetPolicyForTests = () => { for (const d of DEFS) d.set(d.fallback); loadedAt = 0; };
