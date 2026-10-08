import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Database, Tx } from "../db/client";
import { auditLog, businesses, invoiceDisputes, invoices, ticketMessages, tickets } from "../db/schema";
import { gateway, type Adapters } from "../integrations/gateway";
import { notifyBusiness, notifyStaff } from "../notify";
import { grievanceOfficer, OMBUDSMAN } from "../../lib/grievance";
import { canWork, LEVEL_ROLES, MAX_LEVEL, slaDates, STAFF_ROLES, ticketNo, type Kind } from "./policy";

export type Actor = { id: string; role: string; businessId: string | null; email?: string };
type Ticket = typeof tickets.$inferSelect;
const CUSTOMER_ROLES = ["seller", "buyer", "financier"];
const REOPEN_WINDOW_MS = 7 * 24 * 3_600_000;
const isStaff = (a: Actor) => (STAFF_ROLES as string[]).includes(a.role);
const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

/** Insert a ticket + its opening message. Shared by customer tickets and disputes; runs inside the caller's transaction. */
export async function insertTicket(
  tx: Database | Tx,
  p: { kind: Kind; subject: string; description: string; businessId: string; raisedBy: string; raisedByRole: string; invoiceId?: string; now: Date },
) {
  const [t] = await tx.insert(tickets).values({
    kind: p.kind, subject: p.subject.trim(), description: p.description.trim(), businessId: p.businessId, raisedBy: p.raisedBy,
    invoiceId: p.invoiceId, ...slaDates(p.kind, p.now), createdAt: p.now, updatedAt: p.now,
  }).returning();
  await tx.insert(ticketMessages).values({ ticketId: t.id, authorId: p.raisedBy, authorRole: p.raisedByRole, body: p.description.trim(), createdAt: p.now });
  await tx.insert(auditLog).values({ actorId: p.raisedBy, action: "ticket.open", entity: "ticket", entityId: t.id, after: { kind: p.kind, invoiceId: p.invoiceId ?? null } });
  return t;
}

/** Acknowledge the raiser and alert level-1 staff. Grievances get the officer's details (mandatory disclosure). */
export async function announceTicket(db: Database, ticketId: string, gw: Adapters = gateway) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t) throw new Error("ticket not found");
  const no = ticketNo(t.seq);
  if (t.kind === "grievance") {
    const o = grievanceOfficer();
    await notifyBusiness(db, t.businessId, "grievance_ack", { ticketNo: no, due: fmt(t.resolveDueAt), officer: o.name, officerEmail: o.email, officerPhone: o.phone }, gw);
  } else {
    await notifyBusiness(db, t.businessId, "ticket_opened", { ticketNo: no, subject: t.subject, due: fmt(t.firstResponseDueAt) }, gw);
  }
  await notifyStaff(db, LEVEL_ROLES[t.level], "ticket_staff_new", { ticketNo: no, kind: t.kind, subject: t.subject }, gw);
}

/** A customer opens a query/complaint/grievance, optionally tied to one of their invoices. (Disputes have their own entry point.) */
export async function openTicket(
  db: Database, actor: Actor, p: { kind: Exclude<Kind, "dispute">; subject: string; description: string; invoiceId?: string },
  gw: Adapters = gateway, now = new Date(),
) {
  if (!CUSTOMER_ROLES.includes(actor.role) || !actor.businessId) throw new Error("forbidden");
  if (!["query", "complaint", "grievance"].includes(p.kind)) throw new Error("invalid ticket type; invoice disputes are raised from the invoice");
  if (!p.subject.trim() || !p.description.trim()) throw new Error("subject and description are required");
  if (p.invoiceId) {
    const [inv] = await db.select({ s: invoices.sellerId, b: invoices.buyerId }).from(invoices).where(eq(invoices.id, p.invoiceId));
    if (!inv || (inv.s !== actor.businessId && inv.b !== actor.businessId)) throw new Error("FORBIDDEN"); // can't attach someone else's invoice
  }
  const t = await db.transaction((tx) => insertTicket(tx, { ...p, businessId: actor.businessId!, raisedBy: actor.id, raisedByRole: actor.role, now }));
  await announceTicket(db, t.id, gw);
  return t;
}

/** Customer-side access: the raising business, or either party to the ticket's invoice (so a seller can answer a buyer's dispute). */
export async function canView(db: Database, a: Actor, t: Ticket) {
  if (isStaff(a)) return true;
  if (!a.businessId) return false;
  if (t.businessId === a.businessId) return true;
  if (!t.invoiceId) return false;
  const [inv] = await db.select({ s: invoices.sellerId, b: invoices.buyerId }).from(invoices).where(eq(invoices.id, t.invoiceId));
  return inv?.s === a.businessId || inv?.b === a.businessId;
}

async function load(db: Database | Tx, id: string) {
  const [t] = await db.select().from(tickets).where(eq(tickets.id, id));
  if (!t) throw new Error("ticket not found");
  return t;
}

/** Everything the thread page needs. Internal notes are stripped for customers. */
export async function getTicket(db: Database, a: Actor, id: string) {
  const t = await load(db, id);
  if (!(await canView(db, a, t))) throw new Error("not found"); // same error as missing: no ticket enumeration
  const msgs = await db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, id)).orderBy(ticketMessages.createdAt);
  const [inv] = t.invoiceId ? await db.select().from(invoices).where(eq(invoices.id, t.invoiceId)) : [];
  const [dispute] = await db.select().from(invoiceDisputes).where(eq(invoiceDisputes.ticketId, id));
  return { ticket: t, no: ticketNo(t.seq), messages: isStaff(a) ? msgs : msgs.filter((m) => !m.internal), invoice: inv ?? null, dispute: dispute ?? null };
}

/** Customer's own tickets (including disputes against their invoices). */
export async function listMyTickets(db: Database, a: Actor) {
  if (!a.businessId) return [];
  const mine = await db.select({ id: invoices.id }).from(invoices).where(or(eq(invoices.sellerId, a.businessId), eq(invoices.buyerId, a.businessId)));
  const ids = mine.map((i) => i.id);
  return db.select().from(tickets)
    .where(ids.length ? or(eq(tickets.businessId, a.businessId), inArray(tickets.invoiceId, ids)) : eq(tickets.businessId, a.businessId))
    .orderBy(desc(tickets.createdAt)).limit(100);
}

/** Staff queue with filters. `breached` = SLA already missed. */
export async function staffQueue(db: Database, f: { level?: number; kind?: Kind; open?: boolean; breached?: boolean } = {}) {
  const conds = [
    f.level ? eq(tickets.level, f.level) : undefined,
    f.kind ? eq(tickets.kind, f.kind) : undefined,
    f.open === false ? eq(tickets.status, "resolved") : f.open ? inArray(tickets.status, ["open", "in_progress", "awaiting_customer"]) : undefined,
    f.breached ? sql`(${tickets.slaBreachedAt} is not null or ${tickets.frBreachedAt} is not null)` : undefined,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const rows = await db.select({ t: tickets, biz: businesses.legalName }).from(tickets)
    .innerJoin(businesses, eq(businesses.id, tickets.businessId)).where(conds.length ? and(...conds) : undefined)
    .orderBy(tickets.resolveDueAt).limit(200);
  return rows.map(({ t, biz }) => ({ ...t, no: ticketNo(t.seq), business: biz }));
}

async function otherParty(db: Database | Tx, t: Ticket) {
  if (!t.invoiceId) return [];
  const [inv] = await db.select({ s: invoices.sellerId, b: invoices.buyerId }).from(invoices).where(eq(invoices.id, t.invoiceId));
  return [inv?.s, inv?.b].filter((x): x is string => !!x && x !== t.businessId);
}

/** Post a message. Staff must be allowed to work the ticket's level; internal notes are staff-only. */
export async function postMessage(db: Database, p: { ticketId: string; actor: Actor; body: string; internal?: boolean }, gw: Adapters = gateway, now = new Date()) {
  const body = p.body.trim();
  if (!body) throw new Error("message is empty");
  const t = await load(db, p.ticketId);
  const staff = isStaff(p.actor);
  if (!(await canView(db, p.actor, t))) throw new Error("not found");
  if (staff && !canWork(p.actor.role, t.level)) throw new Error("forbidden: this ticket is at a level you don't handle");
  if (p.internal && !staff) throw new Error("forbidden");
  if (t.status === "resolved") throw new Error("ticket is resolved; reopen it to reply");

  await db.transaction(async (tx) => {
    await tx.insert(ticketMessages).values({ ticketId: t.id, authorId: p.actor.id, authorRole: p.actor.role, body, internal: !!p.internal, createdAt: now });
    const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: now };
    if (staff && !p.internal) {
      patch.status = "awaiting_customer";
      if (!t.firstResponseAt) patch.firstResponseAt = now;
      if (!t.assignedTo) patch.assignedTo = p.actor.id;
    } else if (!staff && t.status === "awaiting_customer") patch.status = "in_progress";
    await tx.update(tickets).set(patch).where(eq(tickets.id, t.id));
  });

  if (p.internal) return;
  const data = { ticketNo: ticketNo(t.seq), subject: t.subject };
  if (staff) {
    for (const b of [t.businessId, ...(await otherParty(db, t))]) await notifyBusiness(db, b, "ticket_reply", data, gw, now);
  } else {
    await notifyStaff(db, LEVEL_ROLES[t.level], "ticket_reply", data, gw, now);
  }
}

export async function assignTicket(db: Database, ticketId: string, staff: Actor, now = new Date()) {
  const t = await load(db, ticketId);
  if (!isStaff(staff) || !canWork(staff.role, t.level)) throw new Error("forbidden");
  if (t.status === "resolved") throw new Error("ticket is resolved");
  await db.update(tickets).set({ assignedTo: staff.id, status: t.status === "open" ? "in_progress" : t.status, updatedAt: now }).where(eq(tickets.id, ticketId));
  await db.insert(auditLog).values({ actorId: staff.id, action: "ticket.assign", entity: "ticket", entityId: ticketId });
}

async function escalate(db: Database, t: Ticket, reason: string, actorId: string | null, gw: Adapters, now: Date) {
  if (t.level >= MAX_LEVEL) return false;
  const level = t.level + 1;
  await db.transaction(async (tx) => {
    await tx.update(tickets).set({ level, assignedTo: null, status: t.status === "resolved" ? t.status : "in_progress", updatedAt: now }).where(eq(tickets.id, t.id));
    await tx.insert(ticketMessages).values({ ticketId: t.id, authorId: actorId, authorRole: actorId ? "staff" : "system", body: `Escalated to level ${level}: ${reason}`, internal: true, createdAt: now });
    await tx.insert(auditLog).values({ actorId, action: "ticket.escalate", entity: "ticket", entityId: t.id, after: { level, reason } });
  });
  await notifyStaff(db, LEVEL_ROLES[level], "ticket_escalated", { ticketNo: ticketNo(t.seq), kind: t.kind, subject: t.subject, level: String(level), reason }, gw, now);
  return true;
}

/** Manual escalation along the matrix: support -> relationship manager -> credit/compliance. */
export async function escalateTicket(db: Database, ticketId: string, staff: Actor, reason: string, gw: Adapters = gateway, now = new Date()) {
  const t = await load(db, ticketId);
  if (!isStaff(staff) || !canWork(staff.role, t.level)) throw new Error("forbidden");
  if (!reason.trim()) throw new Error("a reason is required");
  if (t.status === "resolved") throw new Error("ticket is resolved");
  if (!(await escalate(db, t, reason.trim(), staff.id, gw, now))) throw new Error("already at the highest level");
}

/** Resolve a non-dispute ticket. Disputes close through resolveDispute so the invoice is released/updated in the same step. */
export async function resolveTicket(db: Database, ticketId: string, staff: Actor, note: string, gw: Adapters = gateway, now = new Date()) {
  const t = await load(db, ticketId);
  if (!isStaff(staff) || !canWork(staff.role, t.level)) throw new Error("forbidden");
  if (t.kind === "dispute") throw new Error("resolve disputes with an outcome (resolveDispute)");
  if (!note.trim()) throw new Error("a resolution note is required");
  if (t.status === "resolved") throw new Error("already resolved");
  await db.transaction(async (tx) => {
    await tx.update(tickets).set({ status: "resolved", resolvedAt: now, updatedAt: now, firstResponseAt: t.firstResponseAt ?? now }).where(eq(tickets.id, t.id));
    await tx.insert(ticketMessages).values({ ticketId: t.id, authorId: staff.id, authorRole: staff.role, body: note.trim(), createdAt: now });
    await tx.insert(auditLog).values({ actorId: staff.id, action: "ticket.resolve", entity: "ticket", entityId: t.id });
  });
  await notifyBusiness(db, t.businessId, "ticket_resolved", { ticketNo: ticketNo(t.seq), subject: t.subject, note: note.trim() }, gw, now);
}

/** The raiser can reopen within 7 days if the fix didn't work. */
export async function reopenTicket(db: Database, ticketId: string, actor: Actor, gw: Adapters = gateway, now = new Date()) {
  const t = await load(db, ticketId);
  if (t.businessId !== actor.businessId) throw new Error("not found");
  if (t.kind === "dispute") throw new Error("a resolved dispute can't be reopened; raise a new ticket");
  if (t.status !== "resolved" || !t.resolvedAt) throw new Error("ticket is not resolved");
  if (now.getTime() - t.resolvedAt.getTime() > REOPEN_WINDOW_MS) throw new Error("the 7-day reopen window has passed; please raise a new ticket");
  await db.transaction(async (tx) => {
    await tx.update(tickets).set({ status: "in_progress", resolvedAt: null, updatedAt: now }).where(eq(tickets.id, t.id));
    await tx.insert(ticketMessages).values({ ticketId: t.id, authorId: actor.id, authorRole: actor.role, body: "Customer reopened this ticket.", createdAt: now });
  });
  await notifyStaff(db, LEVEL_ROLES[t.level], "ticket_reply", { ticketNo: ticketNo(t.seq), subject: t.subject }, gw, now);
}

/**
 * Ombudsman escalation (PRD Module 16 grievance path). Open to the customer once the resolution time has passed,
 * or after we've marked the ticket resolved and they remain dissatisfied.
 */
export async function escalateToOmbudsman(db: Database, ticketId: string, actor: Actor, gw: Adapters = gateway, now = new Date()) {
  const t = await load(db, ticketId);
  if (t.businessId !== actor.businessId) throw new Error("not found");
  if (!["grievance", "complaint"].includes(t.kind)) throw new Error("only complaints and grievances can go to the Ombudsman");
  if (t.ombudsmanEscalatedAt) throw new Error("already escalated to the Ombudsman");
  if (t.status !== "resolved" && now <= t.resolveDueAt) throw new Error(`available once the ${t.kind} is resolved unsatisfactorily or its resolution time (${fmt(t.resolveDueAt)}) has passed`);
  await db.transaction(async (tx) => {
    await tx.update(tickets).set({ ombudsmanEscalatedAt: now, updatedAt: now }).where(eq(tickets.id, t.id));
    await tx.insert(ticketMessages).values({
      ticketId: t.id, authorId: null, authorRole: "system", createdAt: now,
      body: `You may file this with the ${OMBUDSMAN.name} (${OMBUDSMAN.url}) ${OMBUDSMAN.when}. Our compliance team has been informed and will provide our response.`,
    });
    await tx.insert(auditLog).values({ actorId: actor.id, action: "ticket.ombudsman", entity: "ticket", entityId: t.id });
  });
  await notifyStaff(db, ["compliance", "admin"], "ombudsman_escalated", { ticketNo: ticketNo(t.seq), subject: t.subject }, gw, now);
}

/**
 * Worker: SLA enforcement. A missed first-response or resolution time is flagged once and escalates the ticket one level
 * (relationship manager, then credit/compliance). At the top level it alerts instead. Re-running changes nothing.
 */
export async function runTicketSla(db: Database, gw: Adapters = gateway, now = new Date()) {
  const open = inArray(tickets.status, ["open", "in_progress", "awaiting_customer"]);
  const noResponse = await db.select().from(tickets).where(and(open, isNull(tickets.firstResponseAt), isNull(tickets.frBreachedAt), lte(tickets.firstResponseDueAt, now)));
  const late = await db.select().from(tickets).where(and(open, isNull(tickets.slaBreachedAt), lte(tickets.resolveDueAt, now)));
  let n = 0;
  const escalatedNow = new Set<string>(); // at most one level per ticket per sweep
  for (const t of noResponse) {
    escalatedNow.add(t.id);
    await db.update(tickets).set({ frBreachedAt: now }).where(eq(tickets.id, t.id));
    if (!(await escalate(db, t, "first-response time missed", null, gw, now))) await notifyStaff(db, ["compliance", "admin"], "ticket_escalated", { ticketNo: ticketNo(t.seq), kind: t.kind, subject: t.subject, level: String(t.level), reason: "first-response time missed (top level)" }, gw, now);
    n++;
  }
  for (const t of late) {
    const [cur] = await db.select().from(tickets).where(eq(tickets.id, t.id)); // may have just been escalated above
    await db.update(tickets).set({ slaBreachedAt: now }).where(eq(tickets.id, t.id));
    if (escalatedNow.has(t.id)) { n++; continue; }
    if (!(await escalate(db, cur, "resolution time missed", null, gw, now))) await notifyStaff(db, ["compliance", "admin"], "ticket_escalated", { ticketNo: ticketNo(t.seq), kind: t.kind, subject: t.subject, level: String(cur.level), reason: "resolution time missed (top level)" }, gw, now);
    n++;
  }
  return n;
}
