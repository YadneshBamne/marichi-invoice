# Deploying to Vercel

The web app runs on Vercel. The background worker does not (see step 5). Files are stored in Vercel Blob.

> This build runs with `INTEGRATIONS_MODE=mock`: banks, KYC, e-sign and messaging are simulated. It is safe to host as a
> demo or pilot sandbox. It must not take real money or real customers until real providers and licences are in place,
> and the Terms and Privacy pages are drafts that need legal review.

## 1. Database (Neon)
1. Create a **separate Neon project or branch for production**. Do not point production at your dev data.
2. Choose the closest region (Singapore matches `vercel.json`; Mumbai is better for an Indian regulated lender).
   Turn **scale-to-zero off** for production, or the first request after a quiet period waits for the database to wake.
3. Copy two connection strings: the **pooled** one (host contains `-pooler`) for `DATABASE_URL`, and the **direct** one for
   `DATABASE_URL_DIRECT` (migrations and the worker use it).
4. Apply the schema once from your machine, with the production strings in your local `.env` temporarily:
   ```bash
   npm run db:migrate
   ```
5. Create the first admin (staff cannot self-register):
   ```bash
   npx tsx --env-file=.env scripts/seed-staff.ts you@company.com "<a long password>" admin "Your Name"
   ```
   Then put your dev strings back in `.env`.

## 2. Vercel project
1. Push this repo to GitHub, then **Add New Project** in Vercel and import it. The framework (Next.js) and the Singapore
   region come from `vercel.json`.
2. **Storage > Create > Blob**, choose **Private**, and connect it to the project. Vercel adds `BLOB_READ_WRITE_TOKEN`
   to the project automatically. Without it, uploads fail in production on purpose.
3. Add the environment variables below (Production scope).

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon **pooled** string |
| `DATABASE_URL_DIRECT` | Neon **direct** string |
| `BETTER_AUTH_SECRET` | new random value: `openssl rand -base64 32` (never reuse the dev one) |
| `BETTER_AUTH_URL` | your public URL, e.g. `https://app.example.com` (no trailing slash). Sign-in fails if it does not match the domain |
| `ESIGN_WEBHOOK_SECRET`, `PAYMENTS_WEBHOOK_SECRET`, `NOTIFY_WEBHOOK_SECRET`, `MANDATE_WEBHOOK_SECRET` | four different random values |
| `OCR_PROVIDER`, `OCR_LLM_URL`, `OCR_LLM_MODEL`, `OCR_LLM_KEY`, `ANTHROPIC_API_KEY` (all optional) | Invoice reading is free and open source by default (no key). `OCR_LLM_URL` adds any OpenAI-compatible model (Ollama, LM Studio, vLLM, a free tier) as a second opinion; `OCR_PROVIDER=claude` with `ANTHROPIC_API_KEY` uses Claude instead |
| `RESEND_API_KEY`, `MAIL_FROM` (optional) | Both set = email is sent for real. Without them emails are only recorded. SMS stays simulated either way |
| `DATA_ENCRYPTION_KEY` | `openssl rand -base64 32`. Encrypts PAN and bank account numbers. **Keep a copy: losing it makes them unreadable** |
| `INTEGRATIONS_MODE` | `mock` for now |
| `GRIEVANCE_OFFICER_NAME`, `_EMAIL`, `_PHONE`, `_ADDRESS` | real details (legally required on `/grievance`) |
| `RECON_GATE` | `on` |
| `PLATFORM_CAPITAL_PAISE` | optional; balance sheet available for financing, in paise |
| `BLOB_READ_WRITE_TOKEN` | added by the Blob store |

## 3. Domain
Add your domain in Vercel, then set `BETTER_AUTH_URL` to it and redeploy. Password-reset and notification links use it.

## 4. Check it works
- Open the site, sign up as a seller, finish two-factor setup and the company wizard.
- Upload a small PDF invoice and open it again from Agreements or the document link. This proves Blob works.
- Log in as the admin: **Admin > System and policy** shows worker status, notifications and payouts.

## 5. The background worker (required)
Vercel cannot run `npm run worker`, and without it these never happen: daily interest accrual, payouts, collections
sweeps, notification retries, offer expiry, support timers, reconciliation, underwriting and agreement preparation.
Since Phase 2 and 3 it also runs: fraud scoring (`fraud.scan`), outbound webhook delivery (`webhooks.deliver`), auto-debit notices
and presentation (`collections.nach-*`), expiry of marketplace bids and early-payment proposals (`bids.expire`, `earlypay.expire`)
and scheduled report building (`reports.run`).

Run it on any always-on host (Railway, Render, Fly, a small VM) as a **worker service**:
- Build: `npm install`  Start: `npm run worker`
- Environment: the same as above, plus `NODE_ENV=production`. It needs `DATABASE_URL`, `DATABASE_URL_DIRECT`,
  `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `INTEGRATIONS_MODE`, `BLOB_READ_WRITE_TOKEN` (it generates agreements) and the
  webhook secrets.
- Run exactly **one** instance (pg-boss de-duplicates jobs, but one is simplest).
- It needs `tsx`, which is a dev dependency, so install dev dependencies on that host.

## 6. Before you go live: migrations
Run `npm run db:migrate` against the production database before the first deploy and after every update that adds a file under
`drizzle/` (the latest are `0010_marketplace` to `0020_staff_invitations`; 0015 converts the old manager/member roles to approver/maker and creates a membership for every existing user). Then create the first admin with `scripts/seed-staff.ts`; every other staff member is invited by email from **Admin > Users and roles** (they choose their own password and set up two-step verification).

### One deployment per country
Set `NEXT_PUBLIC_MARKET` (IN or ZM; India if unset) in **both** the web project and the worker, at build time. It picks the country pack: currency, identifiers asked for, tax on fees, registry, rails, law and complaint route. Each country should be its own deployment with its own database in that country's region; do not point two markets at one database. The worker also runs `registry.file`, which files each financed invoice's assignment at the registry (mock until CERSAI or PACRA credentials exist). Check the result under **Admin > Market and registry**.

### Financiers must apply
Since `0017`, a financier company cannot hold funds or bid until staff approve its licence application (**Admin > Financiers**), even if it was verified before. Existing financier accounts must send an application. The platform's own balance sheet can be switched off per country with the Policy setting **Platform balance sheet makes offers** (`offer.platformFunds`); set it to 0 wherever we are not licensed to lend, and invoices then wait for financiers' bids.

## 7. What is real and what is simulated
Everything below runs end to end in the product, but the outside world is stood in for until you sign the provider:
- **Payments rails, virtual accounts, bank statements, bureau, KYC/AML, e-invoice registry, e-sign, e-NACH**: mock adapters
  behind `src/server/integrations/gateway.ts`. Each is one adapter file to replace; nothing else changes.
- **FX rates** (cross-border): fixed sandbox rates. A treasury or bank rate feed goes in `fx.rate`.
- **SMS**: simulated until a provider and DLT template registration exist.
- **Invoice reading**: real and free. Digital PDFs are read from their text (pdf.js); scans and photos with Tesseract; fields by rules; an optional local or free model gives a second opinion on the extracted text only. The English reading data ships in `node_modules`, so nothing is downloaded at run time. On a serverless host the first scan after idle takes a few seconds; reading is capped at four pages.
- **Email**: real once `RESEND_API_KEY` and `MAIL_FROM` are set.
- **Model-assisted underwriting**: the scoring model is an expert-weighted prior, not trained on your data. It starts in shadow mode.
- **Overseas buyers** have no Indian bureau record, so every export invoice goes to an analyst; there is no overseas credit-report feed yet.
- **Financier funds** are one pooled escrow account with per-financier ledger accounts; the bank-side segregation, and the
  partner/licensing arrangement for lending other people's money, are for you and your counsel.

## 8. Known limits
- Provider metrics and the circuit breaker are per server instance, so **Admin > System** shows one instance's view.
- The 4 MB document cap comes from Vercel's 4.5 MB request limit.
- Webhook endpoints (`/api/webhooks/*`) are public and HMAC-signed. Real providers need their URLs and secrets configured
  when you move off mock mode.
