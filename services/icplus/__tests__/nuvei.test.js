// Nuvei.
//
// ⚠️ SYNTHETIC FIXTURE. Global and Clover were each reconciled to the cent against real
// paper; no Nuvei statement was available. The fixture encodes every quirk §4 documents —
// in particular all FOUR RATES & FEES row shapes and the wrapped sub-brand labels — and it
// is internally consistent, so the parse reconciles against the deposit summary's own
// "Total Fees". What it cannot prove is that the real section headers match SECTIONS.
const fs = require('fs');
const path = require('path');
const V = require('../parsers/nuvei');
const K = require('../calc');
const { STATUS } = require('../classify');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'nuvei.lines.txt'), 'utf8').split('\n').filter((l) => l.length);

// ---- detection needs BOTH the name and a statement-only section header: the name alone
// also appears on Nuvei's marketing and rate-card PDFs.
ok('detects a Nuvei statement', V.detect(lines) === true);
ok('rejects the name on its own', V.detect(['Nuvei Corporation', 'Rate card 2026']) === false);
ok('accepts RATES & FEES as the second signal', V.detect(['Nuvei', 'RATES & FEES']) === true);

const r = V.parse(lines);
const cp = r.current_processor;
const codes = r.notes.map((n) => n.code);
const allRows = [...r.line_audit.interchange, ...r.line_audit.brand, ...r.line_audit.interac];
const row = (re) => allRows.find((x) => re.test(x.desc));

ok('merchant name', r.merchant_name === 'EXAMPLE BUSINESS INC', r.merchant_name);

// ---------------------------------------------------------------------------
// The four RATES & FEES row shapes. pdf.js splits the description off the numeric columns
// when they are visually offset, and all four turn up on real statements — miss one and
// those rows vanish silently.
// ---------------------------------------------------------------------------
ok('shape A — description and numbers on one line', !!row(/VS CPS RETAIL/), allRows.map((x) => x.desc));
ok('shape B — description ABOVE the numbers', !!row(/MC CORE MERIT III/), allRows.map((x) => x.desc));
ok('shape C — description BELOW the numbers', !!row(/AX OPTBLUE RETAIL/), allRows.map((x) => x.desc));
ok('shape C again, second occurrence', !!row(/MC ASSESSMENT FEE/));
// ⚠️ A numbers-only row with no description anywhere is KEPT, not dropped: the dollars are
// real and the statement still has to reconcile.
ok('shape D — numbers with no description at all', !!row(/sans description/), allRows.map((x) => x.desc));

ok('shape B row keeps its own numbers', near(row(/MC CORE MERIT III/).total, 873.74), row(/MC CORE MERIT III/));
ok('shape C row keeps its own numbers', near(row(/AX OPTBLUE RETAIL/).total, 342.70), row(/AX OPTBLUE RETAIL/));

// ---------------------------------------------------------------------------
// CARD TYPE SUMMARY — sub-brand labels wrap the continuation word onto the NEXT physical
// line, so the section is joined into one string before matching. Line-by-line parsing
// loses whichever half of the label landed on the wrong side of the break.
// ---------------------------------------------------------------------------
ok('Visa sub-brands folded in (1200 + 80 + 40)', r.volume.visa_count === 1320, r.volume.visa_count);
ok('Visa volume folded in', near(r.volume.visa_amt, 70500), r.volume.visa_amt);
ok('MasterCard sub-brand folded in (1050 + 60)', r.volume.mc_count === 1110, r.volume.mc_count);
ok('Amex + Discover share a bucket (210 + 25)', r.volume.amex_count === 235, r.volume.amex_count);
ok('Interac is its own bucket', r.volume.debit_count === 900 && near(r.volume.debit_amt, 67400), r.volume);

// ---- two markup components, averaged independently.
ok('Visa % is volume-weighted across sub-brands', near(cp.visa_rate, 0.0178482, 1e-6), cp.visa_rate);
ok('Visa $/item is count-weighted', near(cp.visa_fee, 0.05, 1e-9), cp.visa_fee);

// ⚠️ Debit's markup comes from the DISCLOSED "$X/txn", never back-solved from a row total.
// §4 records back-solving making the Debit markup vanish or multiply.
ok('debit per-item read from the disclosed rate', near(cp.debit_fee, 0.07, 1e-9), cp.debit_fee);
ok('debit carries no percentage markup', cp.debit_rate === 0, cp.debit_rate);

// ---------------------------------------------------------------------------
// SUSPECT routing
// ---------------------------------------------------------------------------
// ⚠️ "PCI" in a RATES & FEES line is hard SUSPECT even with a plausible % + volume basis.
// The plausible basis is exactly what makes the charge look like a pass-through.
const pci = row(/PCI NON-COMPLIANCE/);
ok('PCI row found', !!pci, allRows.map((x) => x.desc));
ok('PCI is SUSPECT despite a plausible basis', pci.status === STATUS.SUSPECT, pci && pci.status);
ok('PCI really did carry a basis', pci.volume > 0 && pci.rate > 0, pci && { volume: pci.volume, rate: pci.rate });

// ⚠️ Push-payment product names are REAL network fee names for a product a card-present
// merchant never uses. They go into the BRAND table on purpose, so the resemblance to
// genuine terminology is visible side by side.
const send = r.line_audit.brand.find((x) => /MASTERCARD SEND/i.test(x.desc));
const direct = r.line_audit.brand.find((x) => /VISA DIRECT/i.test(x.desc));
ok('Mastercard Send routed to the BRAND table', !!send, r.line_audit.brand.map((x) => x.desc));
ok('Visa Direct routed to the BRAND table', !!direct);
ok('both flagged SUSPECT', send.status === STATUS.SUSPECT && direct.status === STATUS.SUSPECT, [send.status, direct.status]);
ok('push-payment note raised', codes.includes('nuveiPushPayment'), codes);

// ---- the one genuine Interac pass-through in OTHER CHARGES.
ok('Interac assessment routed to the Interac table', r.line_audit.interac.some((x) => /INTERAC NETWORK ASSESSMENT/i.test(x.desc)), r.line_audit.interac.map((x) => x.desc));
ok('Interac row is not SUSPECT', !r.line_audit.interac.some((x) => x.status === STATUS.SUSPECT));

// ---- taxes are dropped entirely; leaving them in double-counts against the tax multiplier.
ok('GST dropped', !cp.fixed_rows.some((f) => /^GST/i.test(f.label)), cp.fixed_rows.map((f) => f.label));
ok('QST dropped', !cp.fixed_rows.some((f) => /^QST/i.test(f.label)));
ok('no tax row reached the audit', !allRows.some((x) => /^(GST|QST)\b/i.test(x.desc)));

// ---- the section's own rollup is not another charge.
ok('"Total Other Charges" not counted as a fee', !cp.fixed_rows.some((f) => /^Total/i.test(f.label)), cp.fixed_rows.map((f) => f.label));

// ---- real fixed charges survive.
ok('five real fixed charges', cp.fixed_rows.length === 5, cp.fixed_rows.map((f) => f.label));
ok('value-added charges kept for review',
  ['TAX RECOVERY FEE', 'WEB REPORTS/ALERTS BUSINESS COACH+', 'SAQ/SCAN INCOMPLETE'].every((l) => cp.fixed_rows.some((f) => f.label === l)),
  cp.fixed_rows.map((f) => f.label));
ok('value-added help note raised', codes.includes('helpNuveiValueAdded'), codes);

// ---------------------------------------------------------------------------
// End to end — reconciles against the deposit summary's own "Total Fees".
// ---------------------------------------------------------------------------
const out = K.recalc(K.populate(r, {}));
ok('markup 2,899.20', near(out.current.markup, 2899.20), out.current.markup);
ok('pass-through 2,547.34', near(out.current.interchange, 2547.34), out.current.interchange);
ok('fixed 149.05', near(out.current.fixed, 149.05), out.current.fixed);
ok('pretax 5,595.59 = the statement\'s own Total Fees', near(out.current.pretax, 5595.59), out.current.pretax);
ok('reconciled, no gap', codes.includes('reconciled') && !codes.includes('reconcileMismatch'), codes);

// ---- the SUSPECT asymmetry on this statement's dollars.
ok('suspect bumps shown', near(out.current.suspectBumps, 126.18), out.current.suspectBumps);
ok('suspect NOT added to the current pretax', near(out.current.pretax, 5595.59), out.current.pretax);
ok('suspect subtracted from Cluster interchange', near(out.cluster.interchange, 2547.34 - 126.18), out.cluster.interchange);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
