# PRD coverage: what is built and what is not

Checked on 2026-10-25 against *Marichi Labs Invoice Financing PRD v2.0 (September 2026)* and the code at commit `a1dab0e`.

**How to read the status column**
- **Built**: works in the product and is covered by tests.
- **Built, simulated**: the logic is done and tested, but the outside system it talks to is a stand-in until a provider contract exists.
- **Partial**: some of the requirement exists; the gap is named.
- **Not built**: nothing in the code yet.

Counts: automated tests pass. Real today: email (Resend, once a key is set) and invoice reading, which is free and open source (pdf.js, Tesseract, rules; an optional free model as a second opinion). Everything else outside the app is a mock.

---

## Section 6: the sixteen modules

### Module 1. Onboarding, KYC/KYB and roles
| Requirement | Status |
|---|---|
| Multi-role registration with role-based access (seller, buyer, financier, staff) | Built. Now also five company roles, invitations, and invited staff |
| MFA on every account | Built |
| KYB: legal name, entity type, company number, tax numbers, directors/UBOs | Built (India: PAN, GSTIN, CIN; Zambia: TPIN, PACRA number) |
| Bank account verification (penny drop) | Built, simulated |
| Directors/UBO sanctions and PEP screening, hit goes to a compliance case, never auto-approved | Built. Sanctions: free screening on the public OFAC, UN and EU lists (switch on with AML_PROVIDER=local). PEP lists are not free, so PEP screening is still simulated |
| Name mismatch goes to a manual queue | Built |
| Light onboarding for buyers; upgrade to full KYB to sponsor a programme | Built |
| No offer before KYB is approved | Built |
| Status lifecycle incl. Re-KYC Due | Partial. The status exists; nothing ever sets it |
| Individual KYC: PAN/Aadhaar, video KYC with liveness | Not built |
| Document upload with OCR (certificate of incorporation, GST certificate, MOA/AOA) | Not built (OCR exists for invoices only) |
| Udyam/MSME number | Not built |
| CKYC registry lookup and upload | Not built |
| Periodic re-KYC triggers (1 to 3 years, or on a risk flag) | Not built |
| Several signatories must approve before onboarding completes | Not built (company roles and maker-checker exist, but not for onboarding) |
| Foreign-ownership (FDI) checks | Not built |
| E-sign of onboarding agreements | Partial. Terms acceptance is recorded with version and time; no e-sign provider flow |

### Module 2. Buyer-seller relationships and programmes
| Requirement | Status |
|---|---|
| Buyer-seller relationship with credit terms | Built |
| Open marketplace and buyer-led supply chain finance programmes (limit, discount, advance, supplier invitations) | Built |
| Financier whitelist/blacklist of buyers; credit limit per buyer | Built |
| Per-seller cap, ticket, tenor, grade and sector limits on a financier | Built |
| Seller and buyer-pair exposure limits on the platform | Built |
| Platform-wide concentration limits by sector | Not built |
| Unverified buyer sends the seller to an "invite your buyer" flow | Changed on purpose: a seller names a buyer directly and the buyer is verified by its own link |

### Module 3. Invoice management
| Requirement | Status |
|---|---|
| Upload with OCR; API and CSV import | Built (OCR real with a key) |
| IRN validation against the government registry | Built. An adapter for India's e-invoice portal is written (switched on by keys), untried; it can only look up recent invoices |
| Duplicate detection: file hash, IRN, seller+number, same buyer/amount/date | Built |
| Eligibility rules: age, buyer status, dispute flag, min/max ticket | Built |
| Partial financing | Built |
| Credit notes with automatic clawback | Built |
| Line items and tax breakup stored | Built |
| ERP connectors: Tally agent, Zoho Books, QuickBooks, SAP, NetSuite | Tally: upload route and customer-side script written, untested against Tally. Zoho Books and QuickBooks: library code written, no connect screen yet, untested. SAP and NetSuite: not built |
| Debit notes | Built. A debit note is its own linked invoice that the buyer confirms |
| Bundling several invoices into one facility | Built. One buyer, one bid and one acceptance for the group, all or nothing; each invoice is still signed, paid out and collected on its own |
| IRN generation mode (we create the IRN for sellers without e-invoicing) | Not built |

### Module 4. Buyer confirmation
| Requirement | Status |
|---|---|
| Notification, buyer portal, confirm / dispute / ask | Built, and no account needed: emailed link plus one-time code |
| Reminders at 24 h and 48 h, escalation at 72 h | Built |
| Deemed acceptance | Built |
| Audit trail: time, IP, who, exact wording, confirmation record PDF | Built |
| Disputes pause underwriting and funding | Built |
| Buyer ERP confirms invoices through an API (straight-through) | Not built (the API is read-only for buyers) |

### Module 5. Underwriting
| Requirement | Status |
|---|---|
| Rules engine, grade A to E, probability of default, buyer grade as ceiling | Built |
| Machine-learning score (shadow, then assist), drift/monitor page | Built |
| On-platform repayment history of both parties | Built |
| Bureau data with recorded consent | Built, simulated |
| Seller limit, per-buyer limit, per-invoice cap | Built |
| Manual referral queue, reasons given for a decline | Built |
| Bank-statement cash-flow analysis; Account Aggregator | Statement analysis built for uploaded CSV and text PDFs (turnover, balances, returns, payers, tampering checks). Account Aggregator not built (needs a regulated registration) |
| GST filing trend, e-way bill, utility data, financial statements | Not built |
| Buyer ratings from rating agencies | Not built |
| Periodic re-scoring of active limits | Not built |

### Module 6. Offers and marketplace
| Requirement | Status |
|---|---|
| Offer with advance, discount, fee, tenor, recourse flag, expiry | Built |
| Several financiers bid, seller picks (auction style) | Built |
| Matching to mandates, standing auto-bids, limits respected | Built |
| Fallback to the platform's balance sheet, or marked unfunded | Built (platform funds can be switched off per country) |
| Key Facts sheet with all-in yearly cost | Built (beyond the PRD) |

### Module 7. Agreements and e-signature
| Requirement | Status |
|---|---|
| Master agreement, invoice schedule, assignment notice from templates | Built, clause text is draft for counsel |
| E-signature | Built; in-app click-to-sign records who, when, from where. A Digio adapter is written from its public docs (switched on by keys), not yet tried against Digio |
| Assignment notice to the buyer before payout | Built |
| Document vault | Built (private storage once configured) |
| Payout blocked until both agreements are signed | Built, no bypass |
| Version control of documents | Partial. Template versions are recorded; the vault does not keep edit histories |
| Stamp-duty calculation and e-stamping | Not built. State e-stamping providers publish no open documentation to build from |
| Aadhaar eSign, Leegality, DocuSign | Not built (needs a provider) |

### Module 8. Disbursement
| Requirement | Status |
|---|---|
| Maker-checker above a threshold | Built |
| Escrow account in the ledger; funds in escrow before payout | Built |
| Idempotent payout; automatic retry on the alternate rail; status polling | Built; a Cashfree payouts and collection-account adapter is written, untried; rails still simulated by default |
| Payout advice to the seller | Built |
| Rail chosen by amount | Built (India: IMPS/NEFT/RTGS; Zambia: EFT/ZIPSS) |
| Funds from several financiers for one invoice, pro rata | Built. Part-bids are combined by the seller into one offer at the blended rate; money is split by share |
| UPI rail | Not built |

### Module 9. Repayment and collections
| Requirement | Status |
|---|---|
| Virtual collection account per invoice, automatic matching | Built, simulated bank |
| Waterfall: principal, discount, fees, penal charges | Built |
| Reminders, due-date notices, overdue ladder | Built for email and SMS (SMS simulated) |
| Grace period; recourse trigger; auto-debit of the seller (e-NACH) | Built. A Razorpay e-mandate adapter is written (switched on by keys), untried; mandates are simulated by default |
| Non-recourse loss and write-off review | Built |
| Part payments; delinquency buckets to 90+ | Built |
| Phone call and legal-notice steps; handoff to a recovery case system | Partial. A legal notice (PDF, dated, with a pay-by date) goes to the buyer or, with recourse, the seller, and recovery can be handed to a named agency after the notice period. The notice wording is a draft for counsel. Phone calls and a case system are not built |

### Module 10. Ledger and reconciliation
| Requirement | Status |
|---|---|
| Double-entry ledger, immutable (database triggers), corrections by reversal | Built |
| Financier payout engine; fee and revenue tracking; daily discount accrual; XIRR | Built |
| Bank reconciliation with an end-of-day gate | Built, simulated statement feed |
| Trial balance and general ledger export | Built |
| Tax on platform fees (GST, VAT) | Built |
| TDS on interest | Built. Staff set each financier's rate; it is withheld from their return into a tax-payable account, reported and remitted |
| Multi-currency ledger | By design not built: one currency per deployment (see the guide, 8.5). Export invoices keep a foreign face value |

### Module 11. Integrations
| Requirement | Status |
|---|---|
| Central gateway with retries, backoff, circuit breaker, caching, call log | Built |
| Webhooks to customers' systems; secure inbound webhooks | Built |
| Sandbox for every provider | Built (mock adapters) |
| Version pinning per provider, vendor-risk register | Not built |

### Module 12. Fraud and compliance
| Requirement | Status |
|---|---|
| Duplicate, circular-trade, related-party, shared-bank, velocity, outlier, round-amount signals | Built |
| Case queue; frozen invoices; financier notified; blacklist | Built |
| Sanctions/PEP screening on onboarding | Built, simulated provider |
| STR tracking (record that it was filed) | Built |
| Ongoing sanctions re-screening of all parties | Built (nightly), now on the real public lists when AML_PROVIDER=local |
| Re-check of financed invoices' IRN for later cancellation | **Not built.** The nightly job exists but is empty |
| Forgery detection on PDFs (metadata, template mismatch) | Not built |
| Adverse-media screening | Not built |
| Editable rules engine for monitoring | Partial. Thresholds are editable on the Policy page; the rules themselves are fixed in code |

### Module 13. Notifications
| Requirement | Status |
|---|---|
| Email | Built (real once Resend is configured) |
| SMS | Built; an MSG91 adapter is written (switched on by keys), not yet tried. India still needs DLT registration |
| WhatsApp Business, push notifications | Built. Browser push works with no provider (free); WhatsApp adapter written for Meta's Cloud API, untried and needs approved message templates |
| Event templates; preferences; delivery status; retry; critical notices on two channels | Built |
| KYC document expiry reminders | Not built |

### Module 14. Reporting and analytics
| Requirement | Status |
|---|---|
| Seller, buyer, financier and operations dashboards | Built |
| Funnel, turnaround, delinquency, fraud, capital use, vintage, concentration, cash-flow forecast | Built (concentration is bars, not a heat map) |
| Scheduled reports by email; CSV export | Built |
| PDF and Excel export | Built. Every report and export can be downloaded as CSV, Excel or PDF |
| Warehouse / BI connection | Not built |
| Regulatory returns (portfolio at risk, capital adequacy inputs, credit-bureau monthly file) | Drafts built (and suspicious-transaction report drafts). They use the usual layout, not a regulator's own form; counsel confirms the form before filing |

### Module 15. Admin console
| Requirement | Status |
|---|---|
| Staff users and roles (now by invitation) | Built |
| Pricing, grade, fee and programme configuration, with history and reasons | Built |
| Overrides: underwriting, payout holds, collections | Built |
| System health, job queue, failed items, integration metrics | Built |
| Audit log viewer | Built |
| Support ticketing | Built (inside the product) |
| Feature-flag management | Not built |

### Module 16. Support and disputes
All built: tickets with context, dispute workflow that pauses financing and collections, SLA timers, escalation levels, grievance page with officer details and the Ombudsman route.

---

## Section 7: non-functional requirements
| Requirement | Status |
|---|---|
| Encryption of PAN and bank numbers at rest (AES-256-GCM); TLS in transit | Built (TLS comes from the host) |
| Role-based access, least privilege | Built |
| MFA for every role | Built |
| Masking of PAN and account numbers in the interface and logs | Built |
| Idempotent payment calls | Built |
| Immutable audit trail and ledger | Built |
| Interest-rate disclosure | Built (Key Facts sheet) |
| VAPT; PCI-style controls | Not done (a task for an outside tester) |
| 99.9% uptime; RPO 15 min, RTO 4 h; backups | Not verified: depends on how the database and hosting are configured |
| Decision under 5 minutes, API under 500 ms | Not measured: no load test yet |
| Record retention of 7 to 10 years, enforced | Built for housekeeping data: a nightly sweep deletes expired sign-ins, old messages, report files, webhook records and logs. Regulated records are never swept and are kept for the country's retention years, which counsel confirms |
| Data localisation | Designed (one deployment per country), not yet deployed in a country region |
| DPDP / Data Protection Act rights: access, correction, breach clocks | Built: a person can ask for a copy (ready at once), correction, deletion or to stop optional uses; each has a due date and a staff queue; deletion is guarded and keeps the records the law requires. Breach clocks are stated, not automated |

## Section 12: third-party integrations
The gateway and the mock adapter for each port are built. **No real provider is connected** except email and invoice reading.

| Area | Status |
|---|---|
| 12.2 Identity, video KYC, CKYC, MCA | Simulated PAN/TPIN and bank checks only |
| 12.3 GSTN, Udyam, MCA charges search | Not built |
| 12.4 IRN validation | Adapter for the e-invoice portal written, untried; post-financing re-check built; generation mode not built |
| 12.5 Credit bureaus | Simulated; consent recorded |
| 12.6 Rating agencies | Not built |
| 12.7 Payment rails and BaaS | Cashfree adapter written, untried (needs a business account); Account Aggregator not built |
| 12.8 ERP/accounting | CSV, API keys and webhooks only |
| 12.9 E-signature and e-stamping | Digio and Zoho Sign adapters written, untried; e-stamping not built |
| 12.10 AML screening | Sanctions on free public lists (opt in); PEP and adverse media simulated; ongoing re-screening built |
| 12.11 Communication | Email real; MSG91 SMS adapter, WhatsApp adapter and free browser push written, untried |
| 12.12 Regulatory reporting | Drafts built; filing itself stays with the compliance officer (registry filing at CERSAI/PACRA is built, simulated) |
| 12.13 Governance | Metrics in System health; version pinning and vendor-risk register not built |

## Section 11: phases
| Phase | Status |
|---|---|
| 1. MVP: onboarding, upload, confirmation, rules underwriting, agreements, disbursement, collections, ledger, notifications | Built |
| 2. Marketplace, ML underwriting, ERP integrations, full fraud engine | Built, except real ERP connectors and the two empty fraud jobs |
| 3. Supply chain finance, dynamic discounting, analytics, cross-border | Built (cross-border for India only) |

## Section 15: the open questions
Decided with the project owner: recourse for seller-led and non-recourse for buyer-led programmes; marketplace with licensed financiers, own balance sheet only where licensed; launch in India and Zambia with partner-led entry; ERP priority and ticket sizes are still open.

---

## What was built beyond the PRD
Invitations, five company roles and maker-checker approvals; one-click buyer acceptance by link; financier application, licence review, mandate and limits; Key Facts sheet; country packs (India, Zambia) with registry filings; front doors, checklist dashboards, dark mode; staff invitations; a platform guide, diagrams and a legal-documents page.

## Remaining work, grouped

**A. Can be built now, no outside contract needed**
1. Ongoing sanctions re-screening job and post-financing IRN re-check job (both exist as empty jobs).
2. Re-KYC triggers and document-expiry reminders.
3. KYB document upload with reading of the certificates; Udyam number.
4. Buyer confirmation through the API.
5. Platform sector concentration limits; periodic re-scoring of limits.
6. Feature flags.
7. (done) Debit notes; invoice bundling; pooled funding from several financiers.
8. (done) TDS on interest.
9. (done) PDF and Excel exports; regulatory-return drafts.
10. (done) Data-subject request workflow and retention policy.
11. Forgery heuristics on uploaded PDFs; a rules editor for fraud signals.
12. (done, except phone calls and a case system) Recovery handoff and legal-notice step in collections.

**B. Needs a provider, licence or partner**
Every real adapter in Section 12 (KYC, video KYC, CKYC, GSTN, IRP, bureau, rating, Account Aggregator, BaaS and escrow bank, e-sign and e-stamp, AML data, SMS, WhatsApp), ERP connectors, and regulator filings.

**C. Needs counsel or a business decision**
All clause text and country settings, the licence route per country, hosting region per country, stamp duty position, and the open questions on ERP priority and ticket sizes.

**D. Needs a specialist**
VAPT, load testing, disaster-recovery set-up.
