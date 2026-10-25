// The "what do I do next" list at the top of every dashboard. Pure: facts in, steps out, so the order and the wording can be tested.
// A step is done, waiting (someone else has to act), or open. The first open step is the one the page puts a button on.

export type Step = { id: string; title: string; detail: string; href: string; cta: string; done: boolean; waiting?: string };

const kybWaiting = (s: string) => (s === "submitted" || s === "under_review" ? "Our team is reviewing your details." : undefined);

export type SellerFacts = { kyb: string; buyer: boolean; invoice: boolean; funded: boolean };
export function sellerSteps(f: SellerFacts): Step[] {
  return [
    { id: "verify", title: "Verify your business", detail: "A one-time check of your company, directors and settlement account.", href: "/onboarding", cta: "Verify", done: f.kyb === "approved", waiting: kybWaiting(f.kyb) },
    { id: "buyer", title: "Add a buyer", detail: "The company that owes you money, and the person there who confirms invoices.", href: "/seller/buyers", cta: "Add buyer", done: f.buyer },
    { id: "invoice", title: "Upload your first invoice", detail: "Your buyer is asked to confirm it before anything is financed.", href: "/seller/invoices", cta: "Upload", done: f.invoice },
    { id: "paid", title: "Accept an offer and get paid", detail: "Read the key facts, e-sign, and receive the advance.", href: "/seller/invoices", cta: "View offers", done: f.funded },
  ];
}

export type BuyerFacts = { kyb: string; confirmed: boolean; autopay: boolean };
export function buyerSteps(f: BuyerFacts): Step[] {
  return [
    { id: "verify", title: "Verify your company", detail: "Optional for confirming invoices from your link; needed for your own account features.", href: "/onboarding", cta: "Verify", done: f.kyb === "approved", waiting: kybWaiting(f.kyb) },
    { id: "confirm", title: "Confirm your first invoice", detail: "Confirm it or dispute it. Your answer is recorded with the exact wording you saw.", href: "/buyer/invoices", cta: "Review invoices", done: f.confirmed },
    { id: "autopay", title: "Turn on auto-pay", detail: "Pay financed invoices on their due date from your bank, with a notice the day before.", href: "/buyer/invoices", cta: "Set up", done: f.autopay },
  ];
}

export type FinancierFacts = { kyb: string; application: string | null; limits: boolean; funded: boolean; deployed: boolean };
export function financierSteps(f: FinancierFacts): Step[] {
  const approved = f.application === "approved";
  return [
    { id: "verify", title: "Verify your company", detail: "The same company check every business passes.", href: "/onboarding", cta: "Verify", done: f.kyb === "approved", waiting: kybWaiting(f.kyb) },
    { id: "apply", title: "Apply with your licence", detail: "Your regulator, licence and settlement account. Our team checks them before you can bid or hold funds.", href: "/financier/application", cta: approved ? "View" : "Apply", done: approved, waiting: f.application === "submitted" ? "Our team is checking your licence." : undefined },
    { id: "limits", title: "Set your mandate and buyer limits", detail: "What you will fund, and how much you will lend against each buyer.", href: "/financier/mandate", cta: "Set limits", done: f.limits },
    { id: "fund", title: "Fund your account", detail: "Transfer to the escrow account and tell operations the bank reference.", href: "/financier/statement", cta: "How to fund", done: f.funded || f.deployed },
    { id: "bid", title: "Place your first bid", detail: "Bid on a confirmed invoice that fits your mandate.", href: "/financier/deals", cta: "See deals", done: f.deployed },
  ];
}

/** How far along, and which step to act on. `next` is -1 when everything is done. A waiting step is the next one but has no button. */
export function progress(steps: Step[]) {
  const done = steps.filter((s) => s.done).length;
  return { done, total: steps.length, next: steps.findIndex((s) => !s.done), complete: done === steps.length };
}
