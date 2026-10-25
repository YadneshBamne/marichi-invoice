import { describe, expect, it } from "vitest";
import { tallyRequest } from "../../../../scripts/tally-agent.mjs";
import { parseTallyVouchers, tallyExportRequest } from "./tally";

// A reply shaped like Tally's: the party ledger is debited (negative amount), sales and GST ledgers are credited.
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><BODY><DATA><COLLECTION>
<VOUCHER REMOTEID="a1" VCHTYPE="Sales" ACTION="Create">
  <DATE>20260925</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-001</VOUCHERNUMBER>
  <PARTYLEDGERNAME>Bharat Retail Pvt Ltd</PARTYLEDGERNAME><PARTYGSTIN>29bbbbb2222b1z5</PARTYGSTIN><REFERENCE>PO-77</REFERENCE>
  <ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales 18%</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><AMOUNT>9000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>Bharat Retail Pvt Ltd</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-118000.00</AMOUNT>
    <BILLALLOCATIONS.LIST><NAME>S-001</NAME><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD><AMOUNT>-118000.00</AMOUNT></BILLALLOCATIONS.LIST>
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><AMOUNT>9000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Sales" ACTION="Create">
  <DATE>20260926</DATE><VOUCHERNUMBER>S-002</VOUCHERNUMBER><PARTYLEDGERNAME>Cancelled Buyer</PARTYLEDGERNAME><ISCANCELLED>Yes</ISCANCELLED>
  <LEDGERENTRIES.LIST><LEDGERNAME>Cancelled Buyer</LEDGERNAME><AMOUNT>-5000.00</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Sales" ACTION="Create">
  <DATE>20261001</DATE><VOUCHERNUMBER>S-003</VOUCHERNUMBER>
  <PARTYLEDGERNAME>Sharma &amp; Sons &lt;India&gt;&#4;</PARTYLEDGERNAME><PARTYGSTIN>27AAAAA1111A1Z5</PARTYGSTIN>
  <REFERENCE>&#4; PO &amp;#9 &quot;urgent&quot;</REFERENCE><BASICDUEDATEOFPYMT>20261120</BASICDUEDATEOFPYMT>
  <LEDGERENTRIES.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>5000.25</AMOUNT></LEDGERENTRIES.LIST>
  <LEDGERENTRIES.LIST><LEDGERNAME>Sharma &amp; Sons &lt;India&gt;</LEDGERNAME><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-5,900.50</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Sales" ACTION="Create">
  <DATE>20261002</DATE><VOUCHERNUMBER>S-004</VOUCHERNUMBER><PARTYLEDGERNAME>Draft Buyer</PARTYLEDGERNAME><ISOPTIONAL>Yes</ISOPTIONAL>
  <LEDGERENTRIES.LIST><LEDGERNAME>Draft Buyer</LEDGERNAME><AMOUNT>-700.00</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Sales" ACTION="Create">
  <DATE>20261003</DATE><VOUCHERNUMBER>S-005</VOUCHERNUMBER><PARTYLEDGERNAME>Returns Buyer</PARTYLEDGERNAME>
  <LEDGERENTRIES.LIST><LEDGERNAME>Returns Buyer</LEDGERNAME><AMOUNT>1200.00</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER>
<VOUCHER VCHTYPE="Sales" ACTION="Create">
  <DATE>20261004</DATE><VOUCHERNUMBER>S-006</VOUCHERNUMBER><PARTYLEDGERNAME>Walk-in Cash</PARTYLEDGERNAME>
  <!-- <VOUCHER><VOUCHERNUMBER>IGNORED</VOUCHERNUMBER></VOUCHER> -->
  <LEDGERENTRIES.LIST><LEDGERNAME>Walk-in Cash</LEDGERNAME><AMOUNT>-250</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>`;

describe("parseTallyVouchers", () => {
  it("returns the exact rows: skips cancelled, optional and reversed vouchers, uses the party ledger amount", () => {
    expect(parseTallyVouchers(SAMPLE)).toEqual([
      { externalId: "S-001", invoiceNumber: "S-001", buyerName: "Bharat Retail Pvt Ltd", buyerTaxId: "29BBBBB2222B1Z5", invoiceDate: "2026-09-25", dueDate: "2026-10-25", amountMinor: 11800000n, currency: "INR", poReference: "PO-77" },
      { externalId: "S-003", invoiceNumber: "S-003", buyerName: "Sharma & Sons <India>", buyerTaxId: "27AAAAA1111A1Z5", invoiceDate: "2026-10-01", dueDate: "2026-11-20", amountMinor: 590050n, currency: "INR", poReference: 'PO &#9 "urgent"' },
      { externalId: "S-006", invoiceNumber: "S-006", buyerName: "Walk-in Cash", buyerTaxId: null, invoiceDate: "2026-10-04", dueDate: null, amountMinor: 25000n, currency: "INR", poReference: null },
    ]);
  });

  it("copes with a byte-order mark, stray control characters, CDATA and a missing XML prolog", () => {
    const xml = "﻿<VOUCHER><DATE>20260101</DATE><VOUCHERNUMBER>A\u0001-1</VOUCHERNUMBER><PARTYLEDGERNAME><![CDATA[P & Q]]></PARTYLEDGERNAME>" +
      "<LEDGERENTRIES.LIST><LEDGERNAME>p &amp; q</LEDGERNAME><AMOUNT>-1.005</AMOUNT></LEDGERENTRIES.LIST></VOUCHER>";
    expect(parseTallyVouchers(xml)).toMatchObject([{ invoiceNumber: "A -1", buyerName: "P & Q", amountMinor: 101n }]);
  });

  it("returns nothing for a reply with no vouchers", () => {
    expect(parseTallyVouchers("<ENVELOPE><BODY><DATA><COLLECTION/></DATA></BODY></ENVELOPE>")).toEqual([]);
  });
});

describe("tallyExportRequest", () => {
  const args = { company: "Acme & Sons <Ltd>", from: "2026-04-01", to: "2027-03-31" };
  it("builds the exact request body, escaping the company name and writing dates the way Tally's docs do", () => {
    expect(tallyExportRequest(args)).toBe(`<ENVELOPE>
<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>MarichiSalesVouchers</ID></HEADER>
<BODY><DESC>
<STATICVARIABLES>
<SVCURRENTCOMPANY>Acme &amp; Sons &lt;Ltd&gt;</SVCURRENTCOMPANY>
<SVFROMDATE TYPE="Date">1-Apr-2026</SVFROMDATE>
<SVTODATE TYPE="Date">31-Mar-2027</SVTODATE>
</STATICVARIABLES>
<TDL><TDLMESSAGE>
<COLLECTION NAME="MarichiSalesVouchers" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">
<TYPE>Voucher</TYPE><FETCH>Date, VoucherNumber, VoucherTypeName, PartyLedgerName, PartyGSTIN, Reference, BasicDueDateOfPymt, IsCancelled, IsOptional, AllLedgerEntries.LedgerName, AllLedgerEntries.IsPartyLedger, AllLedgerEntries.Amount, AllLedgerEntries.BillAllocations.Name, AllLedgerEntries.BillAllocations.BillCreditPeriod</FETCH><FILTERS>MarichiSalesVouchersIsSales</FILTERS>
</COLLECTION>
<SYSTEM TYPE="Formulae" NAME="MarichiSalesVouchersIsSales">$$IsSales:$VoucherTypeName</SYSTEM>
</TDLMESSAGE></TDL>
</DESC></BODY>
</ENVELOPE>`);
  });

  it("rejects a bad date, and the agent script builds the identical request", () => {
    expect(() => tallyExportRequest({ ...args, from: "01-04-2026" })).toThrow(/not a date/);
    expect(tallyRequest(args)).toBe(tallyExportRequest(args));
  });
});
