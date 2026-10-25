// Standalone worker (run: npm run worker). Next.js can't host long-running/retrying jobs.
// pg-boss uses the same Postgres, so no extra infra. Handlers below are stubs, filled per module.
import { PgBoss } from "pg-boss";
import { db } from "../server/db/client";
import { refreshPolicy } from "../server/config/policy";
import { refreshFlags } from "../server/flags/service";
import { revalidatePendingIrns } from "../server/invoices/service";
import { runTicketSla } from "../server/support/service";
import { deliverQueued } from "../server/notify";
import { notifyNewCases } from "../server/fraud/service";
import { scanPending } from "../server/fraud/engine";
import { deliverWebhooks } from "../server/erp/events";
import { expireBids } from "../server/marketplace/service";
import { runDueReports } from "../server/analytics/service";
import { runAutoBids } from "../server/marketplace/auto";
import { expireEarlyPayments } from "../server/earlypay/service";
import { runReconciliation } from "../server/recon/service";
import { runCollectionsSweep, runSurplusPayouts } from "../server/collections/service";
import { presentDebits, sendPreDebitNotices } from "../server/collections/nach";
import { runDisbursements } from "../server/disbursements/service";
import { prepareAllAccepted } from "../server/agreements/service";
import { runRegistryFilings } from "../server/registry/service";
import { rescoreLimits } from "../server/underwriting/rescore";
import { recheckIrns, remindDocuments, remindLicences, rescreenParties, runRekyc } from "../server/compliance/monitoring";
import { expireOffers, generateOffers } from "../server/offers/service";
import { underwriteEligible } from "../server/underwriting/service";
import { dispatchValidated, runConfirmationSla } from "../server/confirmations/service";

const boss = new PgBoss((process.env.DATABASE_URL_DIRECT ?? process.env.DATABASE_URL)!); // job queue wants a direct, session-capable connection
boss.on("error", (e) => console.error("[boss]", e));

const jobs: Record<string, { cron: string; run: () => Promise<void> }> = {
  "ledger.daily-accrual": { cron: "5 0 * * *", run: async () => { await runCollectionsSweep(db); } }, // Module 10: accrual is posted by the collections sweep (idempotent per day)
  "bank.reconcile": { cron: "30 23 * * *", run: async () => { await runReconciliation(db, new Date().toISOString().slice(0, 10)); } }, // Module 10
  "invoice.dispatch-validated": { cron: "*/5 * * * *", run: async () => { await dispatchValidated(db); } }, // Module 4
  "underwriting.run": { cron: "*/5 * * * *", run: async () => { await underwriteEligible(db); } },       // Module 5
  "offers.generate": { cron: "*/5 * * * *", run: async () => { await generateOffers(db); } },            // Module 6 (lite)
  "offers.expire": { cron: "*/10 * * * *", run: async () => { await expireOffers(db); } },
  "agreements.prepare": { cron: "*/5 * * * *", run: async () => { await prepareAllAccepted(db); } },    // Module 7
  "registry.file": { cron: "*/5 * * * *", run: async () => { await runRegistryFilings(db); } },        // file assignments at the registry (CERSAI, PACRA); payouts wait where the country requires it
  "disbursements.run": { cron: "*/2 * * * *", run: async () => { await runDisbursements(db); } },       // Module 8
  "invoice.sla-escalation": { cron: "*/15 * * * *", run: async () => { await runConfirmationSla(db); } },   // Module 4 (24h/48h/72h)
  "collections.sweep": { cron: "0 9 * * *", run: async () => { await runCollectionsSweep(db); } },        // Module 9: accrual, reminders, recourse
  "collections.nach-notices": { cron: "30 8 * * *", run: async () => { await sendPreDebitNotices(db); } },   // auto-pay: the day-before notice
  "collections.nach-debits": { cron: "0 10 * * *", run: async () => { await presentDebits(db); } },        // auto-pay: present debits for invoices due today
  "collections.surplus-payouts": { cron: "*/10 * * * *", run: async () => { await runSurplusPayouts(db); } },
  "notifications.deliver": { cron: "* * * * *", run: async () => { await deliverQueued(db); } },          // Module 13: retry with backoff
  "support.sla": { cron: "*/15 * * * *", run: async () => { await runTicketSla(db); } },                    // Module 16: SLA breach -> escalate
  "webhooks.deliver": { cron: "* * * * *", run: async () => { await deliverWebhooks(db); } },               // Phase 2: push status changes to companies' systems
  "earlypay.expire": { cron: "*/10 * * * *", run: async () => { await expireEarlyPayments(db); } },              // Phase 3: lapse unanswered or unpaid early-payment proposals
  "reports.run": { cron: "0 6 * * *", run: async () => { await runDueReports(db); } },                          // Phase 3: build the scheduled reports that are due
  "bids.auto": { cron: "*/5 * * * *", run: async () => { await runAutoBids(db); } },                              // standing bids from financiers that switched them on
  "bids.expire": { cron: "*/10 * * * *", run: async () => { await expireBids(db); } },                         // Phase 2: close marketplace bids that ran out of time
  "fraud.scan": { cron: "*/5 * * * *", run: async () => { await scanPending(db); } },                         // Phase 2: score every new invoice for fraud signals
  "fraud.notify-new-cases": { cron: "*/5 * * * *", run: async () => { await notifyNewCases(db); } },     // Module 12
  "irn.retry-pending": { cron: "*/15 * * * *", run: async () => { await revalidatePendingIrns(db); } }, // PRD 12.4
  "irn.recheck": { cron: "0 3 * * *", run: async () => { await recheckIrns(db); } },          // PRD 12.4: detect post-financing cancellation
  "aml.rescreen": { cron: "0 2 * * *", run: async () => { await rescreenParties(db); } },     // PRD 12.10: ongoing sanctions monitoring (each company again after a week, a batch a night)
  "limits.rescore": { cron: "0 5 * * *", run: async () => { await rescoreLimits(db); } },          // PRD Module 5: periodic review of seller credit limits
  "kyb.rekyc": { cron: "0 4 * * *", run: async () => { await runRekyc(db); } },               // PRD Module 1: periodic re-verification
  "licences.expiry": { cron: "30 4 * * *", run: async () => { await remindLicences(db); await remindDocuments(db); } },  // financier licence and company document expiry notices
};

// No top-level await: tsx compiles this package as CommonJS (no "type": "module").
async function main() {
  await boss.start();
  for (const [name, j] of Object.entries(jobs)) {
    await boss.createQueue(name);
    await boss.work(name, async () => { await refreshPolicy(db, true); await refreshFlags(db, true); await j.run(); }); // always run with the latest policy
    await boss.schedule(name, j.cron);
  }
  console.log("worker up:", Object.keys(jobs).join(", "));
}
main().catch((e) => { console.error("[worker] failed to start:", e); process.exit(1); });
