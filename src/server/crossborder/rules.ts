// Cross-border settings, kept apart from the service so pricing and policy can read them without loading the whole payments graph.
export const CROSS = {
  currencies: ["USD", "EUR", "GBP", "AED", "SGD"],
  blockedCountries: ["IR", "KP", "SY", "CU", "MM", "RU", "BY"], // no business with these, whatever the screening says
  fxBufferBps: 200, // the locked rate sits this far below mid, so a small fall in the currency cannot eat into the advance
  settleSpreadBps: 50, // what the bank takes when it converts the buyer's payment
  advanceCutBps: 1000, // exports are advanced this much less than a comparable domestic invoice
  riskPremiumBps: 150, // added to the yearly discount
};

