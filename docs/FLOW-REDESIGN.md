# Marichi flow redesign: research and proposal

Status: proposal for review. Nothing in the code has been changed. Research was done on 2026-10-24 from public pages; where a source was blocked or only a search snippet was seen, it is marked.

## 1. What the research found

### Companies, teams and logins (Razorpay, Stripe, Ramp, Zoho Books, Odoo, Resolve, Invoicemart, RXIL)
- Every product adds teammates by **email invitation**. The invited person sets their **own** password and, for money products, their own second factor. Invites expire (Stripe: 10 days) and can be resent or cancelled.
- Nobody has the admin type another person's password. Odoo can reset a password, but only after the person has accepted their invitation.
- There is **one owner**. Only the owner transfers ownership or closes the account, and the transfer is offered by the owner and accepted by the recipient.
- A few fixed roles beat a long permission list. Stripe separates **managing people** from **moving money**: its "IAM Administrator" can invite people but cannot see or move funds.
- **Maker-checker** on anything that moves money. Razorpay tiers it by amount (none, one approver, two approvers). Ramp says: do not let one person both create and approve a payment. The Indian exchanges (Invoicemart, RXIL) are explicit: Entity Administrator, Maker, Checker, and the maker cannot be the checker.
- Accountants and auditors get a **scoped role by invitation** (Xero, Zoho, Mercury), never the owner's login.
- **Verification gates money, not exploring.** Razorpay lets you into test mode straight away and holds live money and settlements until KYC clears.
- One person can belong to **several companies** and switches between them (Stripe orgs, Odoo, Razorpay "Switch Merchant", which is unverified).

### The transaction itself (RBI TReDS directions of 23 June 2026, Invoicemart, M1xchange, RXIL, KredX, C2FO, Taulia, PrimeRevenue)
- **The buyer's acceptance is the gate.** Financiers only see invoices the buyer has accepted. Under the RBI directions an accepted invoice becomes an unconditional obligation to pay on the due date, with no set-off.
- **Competing financiers bid; the party bearing the cost picks the winner** (usually the seller). Invoicemart also offers single bid, bulk upload and auto-bid against a benchmark. RXIL makes each financier set a **credit limit on the buyer** before it can bid.
- **Money moves T+1** to the seller after the bid is accepted, from the financier's account under a debit mandate. On the due date the buyer is debited (NACH) and the financier is paid.
- **Buyer-led products invert the entry.** C2FO, Taulia and PrimeRevenue have the buyer enrol suppliers in bulk. The supplier gets an emailed link, sets a password, accepts terms, and does not apply for credit. Early payment is optional per invoice. Price is shown as a discount or daily rate with the net amount, not as an APR.
- **Seller-led products** (Fundbox, Resolve, Kriya) start with the seller connecting accounting software, and the buyer gets a credit check and limit.
- Onboarding on the Indian exchanges is heavy and one-time: KYC, master agreement, board resolution, named signatories, bank mandate. M1xchange claims about 3 days for financiers; RXIL 7 to 14 business days (weak source).
- Funds sit in ring-fenced escrow or mandated accounts, never the platform's own account. KredX says plainly that it takes no credit risk.
- On default: TReDS is without recourse to the seller; the buyer and financier settle bilaterally, with extensions requested through the portal. KredX is the opposite: the vendor remains liable.

### What the research could not tell us
- Screens and navigation of any platform (nothing public beyond calculators).
- Whether deemed acceptance exists on TReDS (no source found; treat as not allowed until counsel says otherwise).
- Pricing for almost every product; funder-side workflows at C2FO, Taulia and Cashinvoice; RXIL detail (site blocked); India security expectations from primary RBI and CERT-In text (secondary sources only).

## 2. What is wrong with our current flow

1. **One signup form with a role dropdown.** Real platforms have different front doors for the three sides, because the sides arrive differently (a seller finds you, a buyer is pulled in by a seller, a financier is onboarded by your team).
2. **The owner creates everyone's login and password.** This is the part you rejected, and the research agrees. It removes accountability (the admin knows the credential) and it is not how any product above works.
3. **A setup wizard about "apps" before the person has done anything useful.** Companies should start with a checklist toward first money, not a catalogue.
4. **Buyers must sign up and verify with GSTIN and PAN before they can confirm an invoice.** The research says the buyer step should be as close to one click as possible, because buyer participation is the bottleneck for every platform.
5. **Verification blocks the whole product** (the seller cannot get past the dashboard). Better: explore freely, gate offers and money.
6. **Anyone with the owner/manager role can commit the company's money alone.** There is no maker-checker on accepting an offer, signing, bidding or paying early.
7. **One user belongs to exactly one company.** Accountants, group finance teams and advisers need several.

## 3. Proposed principles

1. Three front doors: **seller**, **buyer** and **financier**, each with its own entry and language. Staff are created internally.
2. **Invite, never issue.** People join by emailed link and set their own password and MFA.
3. **One owner; a small fixed set of roles; people-management separate from money.**
4. **Maker-checker on every action that commits money**, with thresholds set in Policy.
5. **Verification gates money, not exploring.**
6. **The buyer's acceptance is the gate to financing**, and acceptance wording reflects an unconditional payment obligation (legal review needed).
7. **Show price as a discount and the net amount**, with the all-in rate secondary.
8. **A user can belong to several companies** and switch.

## 4. Proposed journeys

### Company model (all three sides)
| Role | Can do |
|---|---|
| Owner (exactly one) | Everything, transfers ownership, closes the company |
| Admin | Invites and removes people, edits company details; **cannot move money** |
| Maker | Prepares: uploads invoices, drafts bids, proposes early payment, requests payouts |
| Approver | Commits: accepts offers, signs agreements, approves bids and early payments (never their own) |
| Viewer / Accountant | Reads and exports; invited by email, can belong to many companies |

Invites: email + role, link expires in 10 days, resend or cancel, invitee sets own password and enrols MFA, an audit entry records who invited whom. Changing roles or approval thresholds needs a second factor. Ownership transfer is offered by the owner and accepted by the recipient.

### Seller
1. Sign up on the seller page (email, password, MFA). Land in a **sandbox-style dashboard** with a checklist.
2. **Verify the company** in steps: GSTIN and PAN pre-fill the entity, directors and UBOs are each emailed to verify themselves, bank account by penny-drop. The checklist shows status; nothing else is blocked.
3. Connect accounting or upload invoices; **add a buyer** (this sends the buyer's invitation).
4. Upload an invoice. It goes to the buyer for acceptance.
5. After acceptance: **offers and bids side by side** (platform offer plus financier bids), each shown as net cash today and the discount. Seller picks.
6. Approver signs; funds arrive T+1 in the verified account; the dashboard tracks maturity.
7. Optional: early-payment offers from the buyer, programme invitations, export invoices.

### Buyer
1. Arrives through an **emailed link from a supplier** (or a programme invite). The link opens the invoice.
2. **Accept, dispute or ask a question with one click** after a one-time email or phone verification. No password needed for this step. The acceptance records who, when and from where.
3. Prompt afterwards: "create your company account to see all invoices, pay by NACH, set approvers". The full account needs company verification (light KYB, as in the PRD) and is where Admin, Maker and Approver roles apply.
4. Later: approved-invoice feed and ERP link, auto-debit, pay-early proposals, supplier programme.

### Financier
1. **Apply**, not self-signup: institution details, agreement, KYC of named users, debit mandate and escrow details. Staff approve (target a few days, as M1xchange claims).
2. Set a **mandate**: per-buyer credit limits, ticket size, tenor, sector caps, whitelist and blacklist. A financier cannot bid on a buyer it has not given a limit.
3. **Deal flow shows only buyer-accepted invoices**, seller identity hidden until a bid is accepted.
4. Bid manually or with a standing auto-bid rule inside the mandate; bids expire.
5. Portfolio, repayment statements, delinquency; our own balance sheet obeys the same mandate engine.

### Staff
Unchanged in function (KYB, underwriting, disbursements with maker-checker, collections, fraud, policy). They get invited by an admin the same way and enrol MFA at first login.

## 5. Decisions (locked on 2026-10-24)

The six questions were resolved by taking the recommendations. Reasons and the country-by-country legal picture are in [PLATFORM-GUIDE.md](PLATFORM-GUIDE.md).

1. **Recourse:** with recourse by default for seller-led financing; non-recourse for buyer-led programmes.
2. **Regulatory position:** a factoring and discounting marketplace working with licensed financiers, not a TReDS operator; own balance sheet only where licensed.
3. **Buyer without an account:** one-click acceptance by emailed link plus one-time verification, full account offered afterwards.
4. **Winning bid:** the seller picks, with optional auto-select inside the seller's guardrails.
5. **Settlement:** T+1 target, same day where the rail allows.
6. **Financiers:** institutions only at launch.

Added by the Africa and India research: partner-led entry in each country, and a country-pack structure for everything that legally differs.

## 6. What it means in the code (so you know the size)

- **Replace** owner-created logins and passwords with an invitations table, expiry and acceptance. Remove the password fields and the owner's password reset.
- **Replace** the owner/manager/member roles with Owner, Admin, Maker, Approver, Viewer, and add a pending-approval queue for the actions listed above.
- **Change** a user's single company into a membership list with a company switcher. This touches sessions, the permission layer and most pages.
- **Add** buyer acceptance by tokenised link, and split the signup and entry pages by side.
- **Add** financier application, mandate and per-buyer limits. Marketplace bids then check the mandate.
- **Rebuild** the checklist-first dashboards and navigation after the above, then the visual redesign.

Suggested order: roles, invitations and approvals first (everything depends on them), then buyer link acceptance, then financier mandate, then the shell and visuals.

## 7. Build progress

- Done: invitations, five roles, maker-checker approvals, several companies per login (`6e20778`).
- Done: buyer one-click acceptance by emailed link with a one-time code, recorded acceptance wording, pending buyers a supplier names, and the account claim afterwards.
- Done: financier application with a licence record and staff review, mandate, per-buyer credit limits, standing bids, and a switch for the platform's own balance sheet.
- Next: the full agreement stack and key-facts sheet, then the country-pack framework (India, Zambia), then the shell and visual redesign.
