// Payfacto.
//
// ⚠️ SYNTHETIC FIXTURE, AND A THIN SPEC. §4 gives Payfacto two sentences: sections are found
// by the "Sommaire des ventes" / "Sommaire des frais" headers, and Interac Flash tiers can
// be written in Roman numerals. Those two facts are tested hard below. Everything else —
// row shapes, fee routing, where the markup sits — follows the patterns the VERIFIED parsers
// established, and is a first draft to be corrected against real paper.
const fs = require('fs');
const path = require('path');
const P = require('../parsers/payfacto');
const K = require('../calc');
const { STATUS } = require('../classify');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'payfacto.lines.txt'), 'utf8').split('\n').filter((l) => l.length);

ok('detects a Payfacto statement', P.detect(lines) === true);
ok('rejects the brand name on its own', P.detect(['Payfacto Payments Inc', 'Grille tarifaire 2026']) === false);
ok('accepts either documented section header', P.detect(['Payfacto', 'Sommaire des frais']) === true);

const r = P.parse(lines);
const cp = r.current_processor;
const codes = r.notes.map((n) => n.code);

ok('merchant name', r.merchant_name === 'COMMERCE EXEMPLE INC', r.merchant_name);

// ---------------------------------------------------------------------------
// THE documented Payfacto quirk: Interac Flash tiers in ROMAN numerals.
//
// ⚠️ Not cosmetic. A tier the shared regex fails to recognize falls through to
// "Markup processeur", which the UI filters out of the Interac audit table entirely — so a
// real pass-through fee vanishes from the comparison with no error anywhere. This was the
// first bug this whole build turned up: the Roman branch had been paired with the English
// word "tier" only, so "Palier II" passed every Arabic and every English test and lost
// exactly the French Roman rows.
// ---------------------------------------------------------------------------
const interac = r.line_audit.interac;
const tierOf = (re) => (interac.find((x) => re.test(x.desc)) || {}).tier;

ok('PALIER I recognized (Roman)',   !!tierOf(/PALIER I\b/), interac.map((x) => [x.desc, x.tier]));
ok('PALIER II recognized (Roman)',  !!tierOf(/PALIER II\b/), interac.map((x) => [x.desc, x.tier]));
ok('PALIER III recognized (Roman)', !!tierOf(/PALIER III\b/), interac.map((x) => [x.desc, x.tier]));
ok('NIVEAU 4 recognized (Arabic)',  !!tierOf(/NIVEAU 4/), interac.map((x) => [x.desc, x.tier]));

ok('no Interac row fell to Markup processeur',
  !interac.some((x) => x.status === STATUS.MARKUP), interac.map((x) => [x.desc, x.status]));
ok('no dropped-tier warning raised', !codes.includes('payfactoUnrecognizedTier'), codes);

// All five Interac rows survive, tiers and the switch fee alike.
ok('five Interac rows kept', interac.length === 5, interac.map((x) => x.desc));
ok('their dollars are all still counted',
  near(interac.reduce((s, x) => s + x.total, 0), 66.83), interac.reduce((s, x) => s + x.total, 0));

// A row whose tier genuinely cannot be read is reported, not swallowed.
const unknownTier = P.parse([
  'Payfacto', 'Sommaire des frais',
  'IDP FLASH PALIER ZETA 100 5,000.00 0.0500 2.50',
]);
ok('an unreadable tier still lands in the Interac table', unknownTier.line_audit.interac.length === 1,
  unknownTier.line_audit.interac.map((x) => x.desc));

// ---------------------------------------------------------------------------
// Section boundaries — §4's general rule.
// ---------------------------------------------------------------------------
// ⚠️ The fee summary is the last table, with a closing notice after it. Without an explicit
// terminator the scan runs on and captures "Votre compte a été débité de la somme de
// 3,311.90 $" as a fee — exactly what happened on the real Global statement.
ok('closing notice not captured as a fee',
  !cp.fixed_rows.some((f) => /débité|Renseignements/i.test(f.label)), cp.fixed_rows.map((f) => f.label));
ok('exactly three fixed charges', cp.fixed_rows.length === 3, cp.fixed_rows.map((f) => f.label));

// ⚠️ A fixed-fee row is "<label> qty amount". Skipping the two-number shape takes only the
// amount and leaves the quantity stuck on the label ("LOCATION TERMINAL 3").
const terminal = cp.fixed_rows.find((f) => /LOCATION TERMINAL/.test(f.label));
ok('quantity split off the label', terminal.label === 'LOCATION TERMINAL' && terminal.qty === 3, terminal);
ok('unit price derived from the quantity', near(terminal.unit, 29.95), terminal);

// ---------------------------------------------------------------------------
// Brand attribution — the brand is not always the first word.
// ---------------------------------------------------------------------------
// ⚠️ Markup rows read "ESCOMPTE VISA", not "VISA ESCOMPTE". A prefix-only brand test
// attributes none of them and every markup rate silently comes out zero.
ok('Visa markup 0.25%', near(cp.visa_rate, 0.0025, 1e-9), cp.visa_rate);
ok('MC markup 0.25%', near(cp.mc_rate, 0.0025, 1e-9), cp.mc_rate);
ok('Amex markup 0.30%', near(cp.amex_rate, 0.003, 1e-9), cp.amex_rate);
ok('debit carries no percentage markup', cp.debit_rate === 0, cp.debit_rate);

// Discover has no field of its own and folds into the Amex bucket.
ok('Discover folded into Amex (190 + 30)', r.volume.amex_count === 220, r.volume.amex_count);
ok('Discover volume folded in', near(r.volume.amex_amt, 14250), r.volume.amex_amt);

// ---------------------------------------------------------------------------
// Routing and classification
// ---------------------------------------------------------------------------
ok('three interchange rows', r.line_audit.interchange.length === 3, r.line_audit.interchange.map((x) => x.desc));
ok('assessments routed to the brand table', r.line_audit.brand.length === 2, r.line_audit.brand.map((x) => x.desc));
// Billed at the correct published 0.0900 %, so these come back clean rather than flagged.
ok('assessments at 0.0900% read as Conforme',
  r.line_audit.brand.every((x) => x.status === STATUS.CONFORME), r.line_audit.brand.map((x) => [x.desc, x.status]));
ok('Visa assessment matched to the Visa category', /^Visa/.test(r.line_audit.brand.find((x) => /^VISA/.test(x.desc)).cat || ''),
  r.line_audit.brand.map((x) => x.cat));
ok('MC assessment matched to the Mastercard category', /^Mastercard/.test(r.line_audit.brand.find((x) => /^MASTERCARD/.test(x.desc)).cat || ''),
  r.line_audit.brand.map((x) => x.cat));

// ---------------------------------------------------------------------------
// End to end — reconciles against the statement's own fee total.
// ---------------------------------------------------------------------------
const out = K.recalc(K.populate(r, {}));
ok('markup 381.63', near(out.current.markup, 381.63), out.current.markup);
ok('pass-through 2,386.60', near(out.current.interchange, 2386.60), out.current.interchange);
ok('fixed 112.30', near(out.current.fixed, 112.30), out.current.fixed);
ok('pretax 2,880.53 = the statement\'s own total', near(out.current.pretax, 2880.53), out.current.pretax);
ok('reconciled, no gap', codes.includes('reconciled') && !codes.includes('reconcileMismatch'), codes);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
