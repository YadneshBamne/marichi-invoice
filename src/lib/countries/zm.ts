import type { Pack } from "./types";

// Zambia. Entry is partner-led: financiers lend, and the platform does not use its own balance sheet until a licence says it may.
// The Banking and Financial Services Act No. 9 of 2026 had not commenced when this was researched: counsel must confirm which regime applies.
export const ZM: Pack = {
  code: "ZM", name: "Zambia", adjective: "Zambian",
  currency: { code: "ZMW", symbol: "K", major: "kwacha", minor: "ngwee", grouping: "western", compact: [[1e9, "bn"], [1e6, "m"], [1e3, "k"]] },
  ids: {
    kyb: { label: "TPIN", pattern: /^\d{10}$/, hint: "The ten-digit taxpayer number from the Zambia Revenue Authority." },
    taxReg: { label: "TPIN", pattern: /^\d{10}$/, hint: "The ten-digit taxpayer number from the Zambia Revenue Authority." },
    companyReg: { label: "PACRA registration number", pattern: /^[A-Z0-9]{6,14}$/, hint: "From the certificate of incorporation or business registration. Leave blank if you have none." },
    bankCode: { label: "Bank sort code", pattern: /^\d{6}$/, hint: "Six digits, from your bank." },
    bankAccount: { label: "Account number", pattern: /^\d{8,16}$/, hint: "Eight to sixteen digits." },
    director: "NRC or passport number",
  },
  tax: { name: "VAT", rateBps: 1600 },
  eInvoice: { short: "Smart Invoice number", long: "Smart Invoice number", authority: "the Zambia Revenue Authority" },
  registry: { text: "the Collateral Registry maintained by PACRA under the Movable Property (Security Interest) Act, 2016", short: "PACRA", when: "before_payout", withinDays: null },
  rails: { small: ["EFT", "ZIPSS"], large: ["ZIPSS", "EFT"], largeAbove: 100_000_00n },
  mandate: "direct debit",
  terms: {
    law: "the laws of the Republic of Zambia", forum: "[the courts or arbitration seat, to be completed by counsel]",
    esign: "the Electronic Communications and Transactions Act, 2021", grievance: "the Bank of Zambia, where it applies",
  },
  privacy: {
    law: "the Data Protection Act, 2021", regulator: "the Office of the Data Protection Commissioner",
    breachHours: 24, residency: "Personal data is stored in Zambia unless a transfer condition in the Act is met. Counsel must confirm how this applies to our hosting.",
  },
  ombudsman: { name: "Bank of Zambia (consumer complaints)", url: "https://www.boz.zm" },
  regulator: "Bank of Zambia",
  institutions: { bank: "Commercial bank", nbfi: "Non-bank financial institution", dfi: "Development finance institution", fund: "Fund or private lender", other: "Other licensed institution" },
  phone: "+260", timezone: "Africa/Lusaka",
  platformFunds: false,
  policyScale: [3, 10],
};
