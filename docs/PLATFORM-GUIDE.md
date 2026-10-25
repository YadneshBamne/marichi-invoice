# Marichi Labs invoice financing: the platform guide

How the whole app works, who does what, where the money goes, which agreements bind whom, and what changes by country (India, Zambia and other African markets).

**Read this first**
- This is a product and research document, **not legal advice**. Every legal point is tagged: **[LAW]** statute text someone read, **[DIRECTION]** regulator direction, **[COMMENT]** law-firm or press commentary, **[UNVERIFIED]** could not be confirmed. Anything not tagged LAW needs a local lawyer before you rely on it.
- Research date: 24 October 2026. Several of the laws below changed in 2026 (Zambia's two core financial statutes, RBI's TReDS directions, Kenya's credit-provider rules, Nigeria's factoring bill). Treat dates as things to re-check at launch.
- Sources for the main claims are in the appendix. The research could not open some primary texts; those items are marked.

---

## 1. The app in one page

**What it is.** A marketplace and workflow engine that lets a small supplier (seller) turn an unpaid invoice into cash now, instead of waiting 30 to 120 days for the buyer to pay. It connects three parties and runs the whole chain: verify, confirm with the buyer, underwrite, offer, sign, pay out, collect, settle.

| Party | Who they are | What they want | What they do in the app |
|---|---|---|---|
| **Seller** | Small business owner or finance manager raising invoices | Cash now, low friction | Verify company, add buyers, upload invoices, compare offers, sign, receive money |
| **Buyer** | The corporate that owes the invoice | To confirm quickly, keep its payment terms, maybe offer early payment or run a supplier programme | Confirms or disputes invoices, pays at maturity, can pay early or sponsor suppliers |
| **Financier** | Bank, NBFC, MFI, fund (institutions) | Short, yield-bearing, pre-screened assets | Gets approved, sets a mandate and credit limits per buyer, bids, monitors portfolio |
| **Platform staff** | Ops, risk, compliance, admin | Safe, auditable operations | Review KYB, underwriting exceptions, payouts, collections, fraud, policy |

**Four financing models** (from the PRD), all on the same engine:
1. **Invoice factoring / discounting**: the seller sells or borrows against an invoice. **With recourse by default** (the seller repays if the buyer does not).
2. **Marketplace**: several financiers bid on the same invoice; the seller chooses.
3. **Reverse factoring / supply chain finance**: the buyer sponsors a programme; its suppliers are financed at a price based on the buyer's credit. This is the **non-recourse** model, because the buyer's credit carries the risk.
4. **Dynamic discounting**: the buyer pays early from its own cash for a discount that grows with how early.

**What we are and are not.**
- We are a **technology, verification, servicing and collections platform** working with **licensed financiers**. The financier is the lender or purchaser of record.
- We are **not a TReDS operator** and must not describe ourselves as one (India's TReDS is a licensed exchange regime).
- Our own balance sheet only funds invoices **where we, or a group entity, hold the licence the country requires**. Today the app has a simulated "platform capital" pool; in production it becomes "financier zero" and is switched off in any country where we are not licensed.

---

## 2. Decisions taken

You asked me to go with my recommendations on the six open questions. They are now the working position:

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Recourse | **With recourse by default for seller-led financing. Non-recourse for buyer-led programmes.** | Protects financiers while we have no exchange-style guarantees. India's Factoring Regulation Act and Zambia's 2026 Act both allow factoring "with or without recourse". Buyer-led programmes price on the buyer's credit, so non-recourse is natural there. |
| 2 | Regulatory position | **Factoring and discounting marketplace working with licensed financiers.** Not a TReDS operator. Own balance sheet only where licensed. | Factoring needs an RBI certificate in India (Factoring Regulation Act 2011) and a Bank of Zambia licence in Zambia under the 2026 Act. Whether a pure introducer needs a licence is open in both countries. |
| 3 | Buyer without an account | **One-click acceptance from an emailed link plus one-time verification**, then offer a full account. | Every platform reviewed found buyer participation to be the bottleneck. The acceptance still records who, when and from where. |
| 4 | Who picks the winning bid | **The seller**, with optional **auto-select inside guardrails the seller sets** (maximum rate, minimum net cash, preferred financiers). | Matches how the exchanges work: the cost bearer chooses. |
| 5 | Settlement | **T+1 target; same day where the local rail allows it.** | Exchanges run T+1; the PRD says funding within 24 hours. |
| 6 | Who may finance | **Institutions only at launch.** | Retail money brings the peer-to-peer rules (India: NBFC-P2P directions, investor caps) and securities-style rules in each country. |

Two more consequences of the research that you should treat as decisions to confirm:
- **Partner-led entry in each country.** Launch each country through a licensed financier (bank, NBFC-Factor, licensed MFI) rather than a licence of our own, until counsel says otherwise.
- **Country packs.** One core product; everything that legally differs is a per-country module (Section 8).

---

## 3. People, companies and logins

This replaces the earlier "owner creates everyone's password" flow, which no product we reviewed uses.

### 3.1 Front doors
- **Seller**: self-signup page (email, password, MFA).
- **Buyer**: arrives from a **link in an email** from a supplier or from a buyer programme. First contact is the invoice itself, not a signup form.
- **Financier**: **application**, not self-signup. Staff approve after checking licence, agreement and users.
- **Staff**: created internally, invited by an admin, enrol MFA at first sign-in.

### 3.2 One company, several people
| Role | Can do |
|---|---|
| **Owner** (exactly one) | Everything; transfers ownership; closes the company |
| **Admin** | Invites and removes people, edits company details. **Cannot move money** |
| **Maker** | Prepares: uploads invoices, drafts bids, proposes early payment, requests payouts |
| **Approver** | Commits: accepts offers, signs agreements, approves bids and early payments. **Never their own** |
| **Viewer / Accountant** | Reads and exports; can belong to several companies |

How people join:
1. An Owner or Admin enters an **email and a role**. The system emails a single-use link that **expires in 10 days**, can be resent or cancelled.
2. The invitee **sets their own password** and **enrols a second factor**. Nobody else ever knows it.
3. Every invite, role change and approval is written to the audit log. Changing roles or approval limits needs a second factor.
4. **Ownership transfer**: the owner offers, the recipient accepts.
5. **One person, several companies**: one login, a company switcher, roles held per company. This is how accountants and group finance teams work.

### 3.3 What needs a second person (maker-checker)
| Action | Maker prepares | Approver commits | Notes |
|---|---|---|---|
| Accept an offer or a bid | any Maker | an Approver, not the same person | Binds the company |
| Sign an agreement | n/a | Approver with signing authority | Authorised signatories named at onboarding |
| Place a bid (financier) | Maker | Approver | Inside the financier's mandate and limits |
| Propose early payment (buyer) | Maker | Approver | Commits company cash |
| Change bank account for payouts | Admin | Approver + second factor + cooling period | A top fraud route |
| Change roles or approval limits | Admin | Owner or second Admin + second factor | |
| Large payouts (platform side) | Ops | Different ops/admin, above a threshold set in Policy | Already built |

Thresholds are Policy settings (some products tier by amount: none, one approver, two).

### 3.4 What blocks what
**Verification gates money, not exploring.** A new company can look around, set up the team and upload a draft. It cannot receive an offer, sign, bid, or be paid until verification is approved. A sanctions or PEP hit always goes to a person.

---

## 4. The invoice, end to end

The steps are the same everywhere. The bracketed parts are where a country pack plugs in.

| # | Step | Who | What happens | Country pack plugs in |
|---|---|---|---|---|
| 1 | **Verify the company** | Seller (+ staff) | Entity data, directors and beneficial owners each verify themselves, bank account is checked | [ID types, company registry, beneficial-ownership threshold, bank check method] |
| 2 | **Add the buyer** | Seller | Seller names the buyer; the buyer receives an invitation link | [Buyer identifiers: GSTIN, TPIN, KRA PIN, TIN, VAT number] |
| 3 | **Upload the invoice** | Seller or ERP | Read from PDF or synced; fields checked | [Tax e-invoice check: IRN, Smart Invoice, eTIMS, MBS, E-VAT, EFD] |
| 4 | **Fraud and eligibility checks** | System | Duplicate detection, age, ticket size, disputes, fraud signals | Rules from Policy |
| 5 | **Buyer acceptance** | Buyer | **One click** from the emailed link after one-time verification: accept, dispute or ask. Optional deemed-acceptance **off by default** | [Acceptance wording, language, statutory clocks] |
| 6 | **Underwriting** | System + analysts | Buyer risk first, then seller and invoice; grade A to E; manual review for exceptions | [Credit bureaus, alternative data] |
| 7 | **Offers and bids** | System, financiers, seller | Platform or partner offer plus competing financier bids, shown as net cash today and discount, with a standard disclosure sheet | [Disclosure format, rate caps if any] |
| 8 | **Sign** | Seller Approver | Seller signs the invoice schedule electronically; buyer receives and acknowledges the **notice of assignment** | [E-signature level, stamping, notice law] |
| 9 | **Register the assignment** | System | Registry filing where the country requires or rewards it | [CERSAI, PACRA collateral registry, NCR, BRS, BoG registry] |
| 10 | **Fund and pay out** | Financier, platform | Funds move from the financier's account to the seller's verified account | [Rail, cut-offs, currency] |
| 11 | **Maturity: buyer pays** | Buyer | Pays the invoice into the **collection account** named in the notice; auto-debit where available | [Direct-debit scheme, mobile money] |
| 12 | **Settle** | System | Payment applied to principal, discount, penal charges; financier repaid; surplus to seller | [Withholding tax, VAT on fees] |
| 13 | **Late or disputed** | All | Reminders; grace period; recourse notice; dispute pauses collections; credit notes handled | [Disputes law, interest caps] |
| 14 | **Close or write off** | Staff | Loss follows the agreed recourse and sharing rules | [Insolvency, collections conduct rules] |

**Standard timings we will publish and track:** buyer acknowledgement within 48 hours (reminders at 24h and 48h, human escalation at 72h); decision within 4 hours of acceptance for auto-approved cases; payout T+1; collections reminders from 3 days before due.

---

## 5. Money flow

### 5.1 The principle
**Client money never sits in our operating account.** Every leg goes through a ring-fenced account at a licensed bank: a trust or escrow account, or a virtual account under it. This is the safest design in every country reviewed, and in Zambia and India it also avoids the open question of whether collecting buyer payments counts as "payment aggregation" (see Section 9).

### 5.2 The legs
1. **Funding in.** The financier sends cash to its escrow or mandated account. Staff record it; the ledger credits that financier's funds.
2. **Payout.** On acceptance and signature, the financier's cash funds the advance. The seller receives advance minus the upfront fee into its **verified** bank account. Large amounts need a second approver.
3. **Collection.** The buyer pays the **per-invoice collection account** named in the notice. Every credit then matches exactly one invoice.
4. **Waterfall at maturity.** Payment is applied to principal, then discount, then penal charges; any surplus is paid to the seller; the financier's share goes back to its funds.
5. **Failure paths.** Buyer short-pays: partial settlement, the rest stays due (and with recourse falls to the seller). Payout fails: retry on the next rail with the same idempotency key. Wrong amount or unknown account: held for ops.

The existing double-entry ledger already does this in rupees (escrow, receivables, discount income, fees with tax, financier funds, surplus owed to seller). What is new is **currency per country** (Section 8.3).

### 5.3 Rails by country (research summary)
| Country | Push payments | Bulk / direct debit | Mobile money | Currency rule |
|---|---|---|---|---|
| **India** | IMPS, NEFT and RTGS (24x7), UPI | NACH/e-NACH [COMMENT: per-mandate limits; TReDS category higher] | n/a | INR |
| **Zambia** | ZIPSS (RTGS) | ZECHL clearing house direct debit/credit [UNVERIFIED current rules] | MTN, Airtel, Zamtel; wallet tiers set by BoZ | Domestic settlement in kwacha since Dec 2025; foreign-currency invoicing allowed for pricing; exports and imports exempt [COMMENT] |
| **Kenya** | KEPSS (RTGS), PesaLink | EFT via NACH (cap KES 999,999) | M-Pesa | KES [FX controls UNVERIFIED] |
| **Nigeria** | NIBSS Instant Payment | NIBSS e-mandate direct debit | n/a | NGN [FX UNVERIFIED] |
| **Ghana** | GhIPSS Instant Pay | n/a found | yes | Domestic pricing and settlement in cedi (Act 723) [COMMENT] |
| **South Africa** | RTC, PayShap [UNVERIFIED] | DebiCheck [UNVERIFIED] | n/a | ZAR; exchange control for cross-border |
| **Tanzania** | TIPS | n/a found | yes | Domestic transactions priced and settled in TZS since March 2025 |
| **Cross-border** | PAPSS (about 28 countries connected by mid-2026; counts conflict) | | | Afreximbank programmes exist |

---

## 6. The agreement stack

Ten documents. This is the minimum; each country's lawyer adapts them. Nothing here is a template to copy blindly.

| # | Document | Signed by | When | What it must do |
|---|---|---|---|---|
| 1 | **Platform terms and privacy notice** | Every user | Signup | Roles, eligibility, e-signature and e-records consent, data sharing with financiers, consent withdrawal, complaints route |
| 2 | **Seller master receivables agreement** | Seller and funder (or platform as agent) | Once, at approval | True-sale or financing characterisation, eligible and excluded invoices, seller warranties (exists, assignable, no other financing, no defences), recourse and repurchase events, reserve, pricing, authority to notify and register, audit rights, termination, governing law |
| 3 | **Invoice schedule / offer letter** | Seller and funder | Per invoice | Invoice identifiers, face value, advance, reserve, fee, discount rate, day-count basis and days, due date, payee account, recourse status, acceptance timestamp, incorporation of #2 |
| 4 | **Notice of assignment and debtor acknowledgement** | Sent by seller or funder; **buyer acknowledges** | Per invoice (or per master) | Identifies the invoice and the new owner, payment instruction, effective on receipt, buyer states known set-off or claims, no change to currency or place of payment, proof of transfer on request |
| 5 | **Buyer acceptance / confirmation** | Buyer (one click, recorded) | Per invoice | Becomes binding if it is an **unconditional payment undertaking** that waives defences and set-off in a signed writing; fraud and incapacity carved out; consent to assignment (waives any no-assignment clause); dispute procedure |
| 6 | **Buyer programme agreement** (supply chain finance) | Buyer and funder or agent | Once | Authority to pay, unconditional payment on the due date without set-off, acknowledgement of assignment and registry filing, information exchange, adverse-claims notice |
| 7 | **Financier funding agreement and mandate** | Platform and financier | Once | Eligibility criteria, per-buyer limits, funding commitments, servicing and collections, reporting, repurchase pass-through, fees, licence warranty |
| 8 | **Collection account / trust agreement** | Platform or funder, account bank, seller | Once | Account title and ring-fencing, who may pay in, sweep timing, waterfall, trust declaration, no set-off by the bank, reconciliation, seller insolvency, signatories |
| 9 | **Direct-debit or e-mandate consent** | Payer | Per mandate | Strong authentication at registration, validity period, maximum amount, pre-debit notice, opt-out |
| 10 | **Key facts / rate disclosure sheet** | Given to seller, **seller acknowledges** | Before accepting any offer | One standard format, all-in rate (APR), every charge incl. contingent ones listed separately, validity of the quote, language the seller understands |

**Five clauses not to leave to a template**
1. **True sale, recourse and perfection**: what is sold, what triggers repurchase, and which notice and registry steps are needed, because the law differs by country.
2. **Dispute, dilution and set-off allocation, with the buyer's waiver**: must be a signed writing and say exactly what the buyer undertakes.
3. **Collection account, proceeds and priority**: misdirected payments, the trust declaration, the waterfall, funder versus seller.
4. **Pricing consistency**: one formula, one day-count basis (actual/365 or actual/360 stated), one late-charge rule, the same figures in the offer and the disclosure sheet.
5. **Electronic execution and evidence**: signature level per country, audit trail, timestamps, consent record, governing law and forum.

**Document language.** English is the language of business in Zambia, Kenya, Ghana, Nigeria and Tanzania (alongside Swahili in the last two); India needs English plus the user's preferred language for the disclosure sheet and notices as practice allows. Keep a plain-language summary of every offer.

---

## 7. Standard processes and definitions (used everywhere in the app)

These come from the international practice documents (ICC/GSCFF Standard Definitions, FCI rules, UNIDROIT Model Law on Factoring) so partners and lawyers read our documents the way they expect.

- **Receivables purchase / factoring**: a sale of receivables at a discount to a funder that usually runs the ledger and collects. **Payables finance** (reverse factoring): a buyer-led programme where the seller can take early discounted payment. **Loan against receivables**: always full recourse.
- **Advance rate and reserve**: the share of the invoice paid now; the rest held back to cover dilution and paid on settlement.
- **Dilution**: anything that reduces an invoice other than non-payment (credit notes, returns, rebates, disputes). Tracked per seller and reflected in the advance rate.
- **Dispute**: the buyer rejects the goods or invoice or raises a defence, counterclaim or set-off. A dispute **pauses** funding and collections on that invoice. The FCI rule of thumb: a dispute notified within 90 days of due date stops payment under approval; within 180 days after a payment the funder may recover.
- **Concentration limits**: caps per buyer, seller and sector (also each financier's own per-buyer limit).
- **Discount charge**: advance × annual rate × days ÷ basis. The day-count basis is stated in every document; do not mix 360 and 365.
- **Penal charges** are charges, not compounding interest. Late fees must be disclosed in advance.
- **Recourse**: with recourse means the seller repays on buyer default; even non-recourse keeps recourse for fraud, breach of warranty and invalid invoices.
- **True sale vs secured loan**: the characterisation decides who bears risk and what registration is needed. Counsel sets it per country.
- **Verification vs confirmation**: verification checks the invoice exists; **confirmation** is the buyer's irrevocable payment acknowledgement and has legal consequences. We keep them as separate states.

---

## 8. Country packs

One core product; the module below changes per country. The first column is what the core stores as data ("opaque field plus status") so adding a country is configuration plus an adapter, not a rewrite.

### 8.1 India (launch country, research in depth)
| Topic | Position |
|---|---|
| **Who may factor** | **[LAW]** Factoring Regulation Act 2011 s.2(j), s.3: factoring business needs an RBI certificate of registration; banks and some government bodies are exempt (s.5). **[DIRECTION]** RBI NBFC directions (28 Nov 2025): factoring must be at least 50% of an NBFC-Factor's assets and income. A platform that only introduces financiers: no licence regime found **[UNVERIFIED]**. |
| **TReDS** | RBI TReDS Master Direction (23 Jun 2026) applies to authorised operators only: ₹25 crore net worth, financiers must be factors, units without recourse, CERSAI filing by the operator. **Risk:** a platform marketing multi-financier invoice discounting may look like an unlicensed TReDS. We avoid that language and structure; counsel to confirm. |
| **Digital lending** | RBI Digital Lending Directions (8 May 2025): lending service providers acting for regulated entities, key facts statements, 5% cap on default loss guarantees, explicit consent with audit trail, India-only storage. Applicability to B2B receivables finance is **unclear**; we build to them. |
| **Assignment and notice** | **[LAW]** FRA s.7: written assignment; s.8: assignee cannot demand payment until notice is given; s.9: payment to the assignee after notice discharges the debtor. |
| **Registry** | **[LAW]** FRA s.19 and CERSAI. Under the 2022 RBI regulations TReDS files within 10 days. The deadline for non-TReDS factors is **[UNVERIFIED]**. We build a registration step and a CERSAI search before funding. |
| **Stamp duty** | **[LAW]** Indian Stamp Act s.8D (inserted by the FRA): assignment to a registered "factor" is not liable to duty. Other agreements can attract state duty. |
| **MSME law** | **[LAW]** MSMED Act 2006 s.15 to 18: the agreed credit period cannot exceed 45 days from acceptance or deemed acceptance; compound interest at three times the bank rate on delay; Facilitation Council route. Income-tax s.43B(h) makes late payment to micro/small suppliers non-deductible until paid. A buyer's acceptance starts these clocks, so **acceptance wording needs legal review** and we do not switch on our own "deemed acceptance" in India. |
| **E-invoice** | GST e-invoicing above ₹5 crore turnover **[COMMENT]**; IRN and signed QR; IRN cancellation allowed within 24 hours. |
| **E-signature** | **[LAW]** IT Act 2000 s.3A and s.10A; Aadhaar e-sign is a recognised method. Electronic records need the Bharatiya Sakshya Adhiniyam s.63 certificate; we hash documents at signing. |
| **KYC / AML** | RBI KYC Directions (2025 text for banks; which text binds a given NBFC is **[UNVERIFIED]**): beneficial owner above 10% for companies; re-KYC 2, 8 or 10 years by risk. PMLA reporting to FIU-IND. |
| **Data protection** | **[LAW]** DPDP Act 2023 and Rules 2025: most obligations from about 13 May 2027; breach to the Board within 72 hours with a detailed report; one-year log retention. **[DIRECTION]** CERT-In: **6-hour** incident reporting, 180-day logs kept in India. Payment data stays in India. |
| **Payments** | PA Master Direction (15 Sep 2025): non-bank aggregators hold merchant funds in escrow with ₹15 crore net worth rising to ₹25 crore. Whether collecting B2B repayments needs PA authorisation is **open**; partner-bank virtual accounts are the safer design. NACH, UPI, IMPS, NEFT, RTGS as in Section 5. |
| **Tax** | Interest or discount on financing is GST-exempt; processing and CERSAI fees are generally taxable **[COMMENT]**. TDS on discount is contested (ITAT says factoring charges are not "interest" under s.194A) **[COMMENT]**. |
| **Disputes** | Section 138 cheque dishonour, mandatory pre-institution mediation in commercial suits, IBC threshold ₹1 crore, MSME Facilitation Council. |
| **Grievance** | Nominated grievance officer, 30 days before escalation under the digital lending rules; ombudsman scheme revised July 2026 **[COMMENT]**. |

### 8.2 Zambia (second country, research in depth)
| Topic | Position |
|---|---|
| **Law changed in 2026** | The **Banking and Financial Services Act No. 9 of 2026** repeals the 2017 Act **once it commences by ministerial order**. No commencement order was found. We design to the 2026 Act and treat the 2017 Act as current until commencement is confirmed. A new National Payment System Act (No. 5 of 2026) replaces the 2007 Act; its commencement and final text were not confirmed. |
| **Who may do this** | **[LAW]** 2026 Act s.2 lists "factoring, with or without recourse", "financing of commercial transactions, including forfaiting", "brokering" and "secured or unsecured advances" as financial services; s.10: a **Bank of Zambia licence** is required (heavy penalties); s.9 licence types include "financial institution" and "virtual financial service". Whether an introducer is "brokering" is **open**. Capital minimums are set by the Bank, not in the Act. A regulatory sandbox exists (2021 guidelines) **[COMMENT]**. |
| **Assignment and registry** | **[LAW]** Movable Property (Security Interest) Act No. 3 of 2016: covers an outright transfer of accounts receivable; an anti-assignment clause does not stop it binding the debtor (s.42); **until the buyer is notified, the buyer can raise contract defences and set-off against the new owner** (s.66); perfected interest beats unperfected (s.52). Registration at the **Collateral Registry (PACRA)**, electronic, first-to-file, up to 5 years renewable. Fees in S.I. 73 of 2016 are in fee units; kwacha value **[UNVERIFIED]**. |
| **Stamp duty** | **[UNVERIFIED]**. A tax guide says Zambia has no stamp tax while the Stamp Duty Act appears to remain; lawyer to confirm. |
| **E-signature** | **[LAW]** Electronic Communications and Transactions Act No. 4 of 2021: an advanced electronic signature satisfies a signature requirement (s.6); other reliable methods suffice where no type is specified (s.7); data messages are admissible (s.9). ZICTA is root certification authority; the national PKI only launched around September 2026, so **use advanced signatures with a licensed provider as it becomes available and keep strong audit trails meanwhile**. |
| **E-invoice** | **[DIRECTION]** ZRA **Smart Invoice** is mandatory for VAT taxpayers (no turnover threshold; penalties from 1 Oct 2024); each invoice has a QR code for verification. The invoice field list was not confirmed. |
| **Tax** | VAT exempts interest and "commitment and arrangement fees"; factoring discount and fees are **not named** so treatment is **[UNVERIFIED]**. Withholding tax on interest and commissions 15% for residents, 20% for non-residents, with an exemption for interest paid to BFSA-licensed institutions **[COMMENT]**. Taxpayer ID is the TPIN. |
| **KYC / AML** | **[LAW]** FIC Act 2010 (amended 2020) and General Regulations 2022: identify customers and **beneficial owners**, PEP and sanctions screening, individual ID by national ID, passport or licence; companies by certificate of incorporation, TPIN and companies register. Beneficial-owner threshold 5% under the 2025 Companies amendment **[COMMENT]**. No official national ID API found. |
| **Data protection** | **[LAW]** Data Protection Act No. 3 of 2021: consent, controller **registration**, **data protection officer**, **breach notice to the Commissioner within 24 hours**, and **personal data must be processed and stored in Zambia** with limited prescribed exceptions (sensitive data stays). This affects hosting and foreign financiers (Section 9). Credit Reporting Act 2018: one bureau licensed. |
| **Payments** | ZIPSS (RTGS), ZECHL direct debit/credit, mobile money under e-money directives (customer funds held in trust at banks, KYC tiers). **Domestic settlement is in kwacha**. Collect via a trust account at a licensed bank. |
| **Borrower protection** | **[LAW]** 2026 Act: MSMEs are "consumers"; cost of credit must be disclosed before granting (s.110); new or higher charges need Bank approval (ss.111-112); no abusive collection (s.106-107); Bank may regulate lending rates (s.184, no cap found). |
| **Existing players** | Lupiya, EFC Zambia, LOLC Zambia, CEEC, Pangaea, Access Bank and RMB supply chain finance **[COMMENT]**. |

### 8.3 Other African markets (compact)
| | Who may lend | Registry and assignment | E-invoicing | Notes |
|---|---|---|---|---|
| **Kenya** | CBK non-deposit credit provider regime, new regulations dated 29 Sep 2026; factoring not named in the draft; scope of final text **[UNVERIFIED]** | Movable Property Security Rights Act 2017; registry at the Business Registration Service | **eTIMS mandatory**; QR/control number verifiable | Data Protection Act 2019, breach 72h; e-signature Cap 411A s.83P |
| **Nigeria** | **[LAW]** BOFIA 2020 s.57 expressly lists **factoring**; CBN licence; Factoring, Assignments and Receivables Financing Bill 2026 passed the Senate; assent unconfirmed | **[LAW]** Secured Transactions in Movable Assets Act 2017: transfer of a receivable is effective against the debtor despite anti-assignment terms (s.4(2)); priority by registration at the National Collateral Registry (s.33(3)) | MBS clearance model with IRN, phased by taxpayer size to July 2027 | NDPA 2023, breach 72h; Nigeria is a party to the Ottawa factoring convention |
| **Ghana** | Non-Bank Financial Institutions Act 2008; digital credit rules cap at GHS 10,000 so larger B2B likely outside them; licence route **[UNVERIFIED]** | Borrowers and Lenders Act 2020, BoG collateral registry | E-VAT with QR, phased | Data Protection Act 2012; domestic pricing in cedi |
| **South Africa** | National Credit Act excludes many juristic-person agreements (turnover or assets of R1m+, large agreements); a 2026 appeal court treated recourse factoring as a loan outside the Act | Cession by common law, no registry, no debtor notice needed for validity | **No mandate yet**; Peppol-based reform announced | POPIA; exchange control |
| **Tanzania** | Microfinance Act 2018 (unlicensed lending is an offence); no factoring statute | New 2026 movable-property act creates a BoT registry; commencement **[UNVERIFIED]** | EFD/VFD receipts verifiable | Domestic pricing in TZS; data law needs Commission approval for transfers |

**Continental layer.** Afreximbank's 2016 Model Law on Factoring and its programmes; PAPSS for cross-border payments; the AfCFTA Digital Trade Protocol (adopted 2024; entry into force **[UNVERIFIED]**) says electronic documents and signatures cannot be denied validity only because they are electronic. UNCITRAL's secured-transactions model law is enacted in Kenya, Nigeria, Malawi and Zimbabwe. The UNIDROIT Model Law on Factoring (2023) has no African enactment yet.

### 8.4 What the core stores as data (so a country is a configuration)
- **Party**: person ID type and number, company number, tax ID, beneficial-owner list, validator type, licence number and type (for financiers).
- **Invoice**: tax-invoice reference (IRN, Smart Invoice code, eTIMS control number, MBS IRN…) with a **verified / unverified / not applicable** flag; currency and minor unit; purpose code where relevant.
- **Notice and registry**: notice sent/received timestamps; registry filing reference, date, status.
- **Signature**: level (simple, advanced), provider, certificate, hash, timestamp, IP and device.
- **Compliance clocks**: breach notice window, retention period, consent records per country.
- **Money**: currency per account, settlement currency, rail adapter, day-count basis.

### 8.5 How the code does it (built)
- **One deployment, one home market.** `NEXT_PUBLIC_MARKET` (IN or ZM; India if unset) selects a country pack from `src/lib/countries`. The pack is plain data read by the server, the browser, emails and agreements alike. To open a country, deploy another copy with its own database in that country's region and its own licence, partner bank and staff. This keeps every ledger in a single currency and solves data residency by construction. The price: there is no marketplace that spans countries, and one login does not work in two countries.
- **What a pack holds:** currency and how amounts are written; the company and tax identifiers asked for (India: PAN, GSTIN, CIN, IFSC; Zambia: TPIN, PACRA number, bank sort code); the tax charged on our fees (GST 18%, VAT 16%); the e-invoice system (IRN, Smart Invoice); the assignment registry and whether filing comes before or after payout; payout rails and the amount that switches rail; the recurring-debit scheme; governing law, forum, e-signature law and complaint route; data-protection law, regulator, breach clock and residency note; the kinds of lender the regulator licenses.
- **Policy scales with currency.** Every money value in the policy registry starts at its rupee default multiplied by the pack's scale (Zambia: 0.3, rounded to two significant figures); the platform's own balance sheet starts off wherever the pack says we cannot lend from it (Zambia). Staff change values on the Policy page as before.
- **Registry filings.** Each accepted offer gets a filing record; the worker files it through the registry adapter (mock for now) with retries, and tells ops after five failures. India: due 30 days after assignment, payout not held. Zambia: payout waits until the filing is done, because priority goes to whoever files first. Both are drafts for counsel.
- **Downloads.** Every report and export is one table model drawn three ways (`src/server/exports/table.ts`): CSV, Excel (written by hand, no library) and PDF (pdf-lib). A route takes `?format=csv|xlsx|pdf`.
- **Privacy requests.** Any signed-in person can ask for a copy of their data (answered at once, deleted after a few days), correction, deletion or to stop optional uses (`/settings/privacy`). Staff work the queue at `/admin/privacy` against a due date. Deletion is refused while a company the person alone owns has open financing, and it keeps the records the law requires without a name on the account. A nightly sweep (`retention.sweep`) deletes housekeeping data on the schedule in Policy. The retention years for regulated records are in the country pack and need counsel's confirmation.
- **Legal notices.** From a policy number of days past due, admin or compliance can issue a dated demand notice (PDF) to the buyer or, where there is recourse, the seller, with a pay-by date; after that date recovery can be handed to a named agency. The wording is a draft for counsel.
- **Regulatory drafts.** `/admin/regulatory` builds portfolio at risk, a credit information file, suspicious-transaction report drafts and capital adequacy inputs from the books. All are marked DRAFT, logged when downloaded, and never sent anywhere. They use the usual layout, not a regulator's form.
- **Not yet done:** real adapters (IRP, ZRA Smart Invoice, CERSAI, PACRA, banks); export financing outside India; pack-specific wording of the buyer acceptance text; locale-specific date formats; money limits that are constants outside the policy registry (SCF programme maximum, fraud round-number test). Kenya, Nigeria and the other markets are a new pack each plus counsel review.

---

## 9. The hard questions (decide with counsel before launch)

These are not engineering problems. They change what we can legally do.

**India**
1. Can a non-NBFC platform balance sheet buy receivables as a business without an RBI certificate, and what is the safe structure if not?
2. Does "introducer plus multiple financiers" amount to a TReDS-like payment system needing Payment and Settlement Systems Act authorisation?
3. Do the Digital Lending Directions (LSP, KFS, 5% default loss guarantee cap) apply to B2B receivables finance? Is any platform first-loss fund caught?
4. Does a collection or escrow account in our name, or virtual accounts, need payment-aggregator authorisation, or does a partner-bank structure avoid it?
5. Non-TReDS CERSAI filing deadline, who files, and priority against an earlier charge-holder.
6. Does the s.8D stamp exemption cover our documents, and which agreements stay dutiable in each state?
7. Which KYC direction binds each type of financier, and what are our duties as a non-regulated platform?
8. Does MSMED s.16 interest follow the receivable to the assignee, and how must acceptance wording limit set-off without creating admissions?
9. TDS and GST treatment of discount, platform fees and CERSAI fees.
10. DPDP readiness before May 2027; CERT-In reporting.

**Zambia**
1. Has the 2026 Banking and Financial Services Act commenced, and which Act governs a licence application today?
2. Is receivables financing with or without recourse a "financial service" needing a financial business or institution licence? Does an introducer count as "brokering"? Capital minimums?
3. Can a platform balance sheet fund invoices without a licence, and can foreign financiers lend directly to Zambian suppliers? Any loan-registration or repatriation rules?
4. Structure the assignment as an outright transfer under the 2016 Act: is registration needed as well as written notice to the buyer?
5. Stamp duty status, VAT on factoring discounts and fees, withholding tax.
6. Which e-signature standard is safe now that the national PKI has only just launched? Is Smart Invoice data enough to prove an invoice against the buyer?
7. Is collecting buyer payments at maturity "payment aggregation" under the 2026 payments Act, or is a trust account at a licensed bank enough?
8. Does the Data Protection Act's **in-Zambia storage rule** block foreign cloud hosting or foreign financiers, and what registration and consent are required?
9. Do the disclosure, charge-approval and rate rules apply to discount fees?
10. Are we a reporting entity under the FIC Act, with beneficial-owner and PEP duties for supplier onboarding?

**Cross-country**
- **Where data lives.** India keeps payment data in India and logs in India; Zambia requires personal data stored in Zambia; Kenya, Nigeria, Ghana, Tanzania have transfer rules. Our current hosting is a single region. A multi-country product will need **per-country data residency or a lawyer-approved transfer mechanism**. This is the biggest architectural consequence of the research.
- **Financier licence warranty.** The marketplace must refuse a bid from a financier without a valid licence for that country, recorded and checked at funding.
- **Regulator notification**: whether a launch needs a notice, sandbox or licence per country.

---

## 10. How the current app maps to this

The app already has the engine: invoices, fraud checks, underwriting, offers, marketplace, agreements, escrow, collections, ledger, notifications, support and an admin console, with simulated provider adapters. In India terms it was built mostly as a single-country, single-company-model app.

| Area | Status | What changes |
|---|---|---|
| Invoice, underwriting, offers, marketplace, early payment, supply chain finance, analytics, cross-border | Built | Currency per country (not only INR); country-pack hooks for tax-invoice check, registry and notice |
| Ledger and collections waterfall | Built (rupees) | Multi-currency accounts; withholding and VAT hooks per country |
| Escrow and payouts | Built (simulated rails) | Trust-account model made explicit; per-country rail adapters |
| Agreements | Built (3 documents) | Expand to the 10-document stack, with per-country text and e-signature level |
| Company users | **Wrong model** (owner creates passwords; single company per person) | Invitations, new roles, maker-checker approvals, multi-company membership |
| Buyer confirmation | Needs signup and KYB first | One-click tokenised link with one-time verification; unconditional-payment wording |
| Financier | Portal exists, no onboarding or mandate | Application, licence record, mandate, per-buyer limits |
| Entry and navigation | One signup with a role pick; apps wizard | Three front doors, checklist-first dashboards |
| Data residency | One deployment per home market (see 8.5) | Built in code; hosting region per country still to be agreed with counsel |
| Disclosure | Rate shown on offer | Standard key-facts sheet with all-in rate |

---

## 11. Build order

1. **Foundations**: invitations, new roles, approvals, multi-company membership (everything else depends on it).
2. **Buyer link acceptance** and the new acceptance wording.
3. **Financier application, licence record, mandate and per-buyer limits.**
4. **Agreement stack and key-facts sheet** in the standard formats.
5. **Country-pack framework** (built, see 8.5): currencies, IDs, tax-invoice and registry adapters; India pack, then Zambia pack. Real adapters come with each licence.
6. **The new shell, navigation and visual redesign** on top of the finished flow.
7. **Counsel review per country**, in parallel from day one, because items in Section 9 can change steps 3 to 5.

---

## 12. Glossary
- **FU (factoring unit)**: the exchange term for an accepted receivable.
- **Notice of assignment**: the written notice to the buyer that the invoice now belongs to the financier and must be paid to a named account.
- **Recourse**: the seller repays if the buyer does not.
- **Maker-checker**: one person prepares, a different person approves.
- **KYB**: know your business. **UBO**: ultimate beneficial owner. **PEP**: politically exposed person.
- **Dilution**: reductions to an invoice other than non-payment.
- **Collateral registry**: the public record where a security interest or assignment is filed (CERSAI in India, PACRA in Zambia).
- **E-mandate / NACH**: bank-side authority to debit an account on a schedule.

---

## Appendix: main sources
India: Factoring Regulation Act 2011 (financialservices.gov.in PDF); RBI NBFC Directions 28 Nov 2025 (rbi.org.in id=12931); RBI TReDS Master Direction 23 Jun 2026 (id=13526); RBI Digital Lending Directions 8 May 2025 (id=12848); RBI Registration of Assignment of Receivables Regulations 14 Jan 2022; DPDP Rules 2025 summaries; CERT-In 2022; RBI Payment Aggregator Master Direction 15 Sep 2025.
Zambia: Banking and Financial Services Act No. 9 of 2026 and Movable Property (Security Interest) Act No. 3 of 2016, S.I. 73 of 2016, ECTA No. 4 of 2021, Data Protection Act No. 3 of 2021, FIC Act 2020 amendment and S.I. 54 of 2022 (all at commons.laws.africa); PACRA collateral registry (mprs.pacra.org.zm); ZRA Smart Invoice FAQs (zra.org.zm).
Africa: CBK draft credit provider regulations; Nigeria Secured Transactions in Movable Assets Act 2017 gazette; Afreximbank on Nigeria's factoring bill; BoG digital credit FAQs; KRA eTIMS notices; AfCFTA Digital Trade Protocol text.
Standards: UNIDROIT Model Law on Factoring (2023) and Ottawa Convention 1988; UNCITRAL Model Law on Secured Transactions 2016; ICC/GSCFF Standard Definitions 2016; FCI GRIF and invoice verification guide; BAFT master participation agreement; RBI Key Facts Statement.
Platforms studied: Invoicemart, RXIL, M1xchange, KredX, C2FO, Taulia, PrimeRevenue, Resolve, Kriya, Fundbox; company-account patterns at Razorpay, Stripe, Ramp, Zoho Books, Odoo.
