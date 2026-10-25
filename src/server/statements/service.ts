// A seller's own bank statement: stored in the vault, read, analysed, and kept with its figures. Nothing here approves or declines anyone;
// the figures and flags are for the credit team and for the seller to see what we see.
import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { auditLog, businessStatementLines, businessStatements } from "../db/schema";
import { assertCan } from "../permissions";
import { MAX_DOC_BYTES, putStatementFile } from "../vault";
import { analyse, summaryFromJson, summaryToJson } from "./analyse";
import { parseStatement, StatementError, type ParsedStatement } from "./parse";

export type Actor = { id: string; role: string; orgRole?: string | null; businessId: string | null };
const CSV_MIME = new Set(["text/csv", "application/csv", "application/vnd.ms-excel", "text/plain", "text/comma-separated-values"]);

/** PDF or CSV, judged by the type the browser sent and, failing that, the file name. */
function kindOf(mime: string, fileName: string): "pdf" | "csv" {
  if (mime === "application/pdf" || /\.pdf$/i.test(fileName)) return "pdf";
  if (CSV_MIME.has(mime) || /\.(csv|txt)$/i.test(fileName)) return "csv";
  throw new Error("Upload the statement as a PDF or a CSV file.");
}

export async function uploadStatement(db: Database, actor: Actor, p: { bytes: Buffer; mime: string; fileName: string }) {
  assertCan(actor, "invoice.upload");
  if (actor.role !== "seller" || !actor.businessId) throw new Error("Only a seller company can upload a bank statement.");
  const businessId = actor.businessId;
  if (p.bytes.length === 0) throw new Error("The file is empty.");
  if (p.bytes.length > MAX_DOC_BYTES) throw new Error("The file is over 4 MB. Download a shorter period, or the CSV version.");
  const kind = kindOf(p.mime, p.fileName);
  const { ref } = await putStatementFile(p.bytes, kind);

  let parsed: ParsedStatement | null = null;
  let failure: string | null = null;
  try { parsed = await parseStatement(p.bytes, kind, p.fileName); }
  catch (e) { failure = e instanceof StatementError ? e.message : "We could not read this file. Download the statement again from net banking, or use the CSV export."; }
  const summary = parsed ? analyse(parsed.lines) : null;

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(businessStatements).values({
      businessId, uploadedBy: actor.id, documentRef: ref, fileName: p.fileName.slice(0, 120),
      bankName: parsed?.bankName ?? null, accountLast4: parsed?.accountLast4 ?? null, periodFrom: parsed?.periodFrom ?? null, periodTo: parsed?.periodTo ?? null,
      status: parsed ? "parsed" : "failed", failure, summary: summary ? summaryToJson(summary) : null,
    }).returning();
    if (parsed) for (let i = 0; i < parsed.lines.length; i += 1000) // keeps each insert under the database's parameter limit
      await tx.insert(businessStatementLines).values(parsed.lines.slice(i, i + 1000).map((l) => ({ statementId: row.id, on: l.on, narration: l.narration, debit: l.debit, credit: l.credit, balance: l.balance })));
    await tx.insert(auditLog).values({ actorId: actor.id, action: "statement.uploaded", entity: "business", entityId: businessId, after: { statementId: row.id, status: row.status, rows: parsed?.lines.length ?? 0 } });
    return row;
  });
}

/** A company's statements, newest first. */
export const listStatements = (db: Database, businessId: string) =>
  db.select().from(businessStatements).where(eq(businessStatements.businessId, businessId)).orderBy(desc(businessStatements.createdAt));

/** The figures of the newest statement that could be read, with the row they belong to. Null when there is none. */
export async function latestSummary(db: Database, businessId: string) {
  const [row] = await db.select().from(businessStatements)
    .where(and(eq(businessStatements.businessId, businessId), eq(businessStatements.status, "parsed"))).orderBy(desc(businessStatements.createdAt)).limit(1);
  return row?.summary ? { statement: row, summary: summaryFromJson(row.summary) } : null;
}
