// Policy numbers for privacy requests and for how long housekeeping data is kept. Editable under Policy; these are the defaults.
// Regulated records (verification, agreements, transactions, the ledger) are NOT in here: they are kept for the country's retention years
// (countries pack, privacy.retentionYears) and are never swept.
export const PRIVACY = {
  responseDays: 30, // a privacy request is answered within this
  exportDays: 30, // a copy of someone's data stays downloadable this long
  notificationDays: 365, // messages we sent
  reportRunDays: 90, // scheduled report files
  webhookDays: 90, // delivered or abandoned webhook records
  logDays: 180, // technical call logs
};
