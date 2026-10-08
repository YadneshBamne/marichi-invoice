// Model monitor: how often the scoring model and the rules agree, and, as invoices settle, which predicted the outcome better.
import { eq, desc } from "drizzle-orm";
import type { Database } from "../db/client";
import { invoices, mlScores } from "../db/schema";
import { gradeGap } from "./ml";
import type { Grade } from "./policy";

const GRADES: Grade[] = ["A", "B", "C", "D", "E"];
export type Settled = "paid" | "bad" | "open"; // bad = overdue or written off
const settledOf = (status: string): Settled => (status === "paid" ? "paid" : status === "overdue" || status === "written_off" ? "bad" : "open");

export async function modelReport(db: Database) {
  const rows = await db.select({ m: mlScores, number: invoices.invoiceNumber, status: invoices.status, amount: invoices.amount }).from(mlScores)
    .innerJoin(invoices, eq(invoices.id, mlScores.invoiceId)).orderBy(desc(mlScores.createdAt));

  const matrix: Record<string, Record<string, number>> = Object.fromEntries(GRADES.map((r) => [r, Object.fromEntries(GRADES.map((m) => [m, 0]))]));
  for (const { m } of rows) matrix[m.rulesGrade][m.grade]++;
  const agree = rows.filter(({ m }) => m.rulesGrade === m.grade).length;
  const disagreements = rows.map((r) => ({ ...r, gap: gradeGap(r.m.rulesGrade as Grade, r.m.grade as Grade) })).filter((r) => Math.abs(r.gap) >= 2);

  // Outcomes by grade, from the rules and from the model. Only meaningful once invoices have settled.
  const by = (key: "rulesGrade" | "grade") => GRADES.map((g) => {
    const mine = rows.filter(({ m }) => m[key] === g);
    const s = mine.map((r) => settledOf(r.status));
    return { grade: g, invoices: mine.length, paid: s.filter((x) => x === "paid").length, bad: s.filter((x) => x === "bad").length, open: s.filter((x) => x === "open").length };
  });
  return { total: rows.length, agree, agreementPct: rows.length ? Math.round((agree / rows.length) * 100) : null, matrix, disagreements: disagreements.slice(0, 25), rulesOutcomes: by("rulesGrade"), modelOutcomes: by("grade"), settled: rows.filter((r) => settledOf(r.status) !== "open").length };
}
