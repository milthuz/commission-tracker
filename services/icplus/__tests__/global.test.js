// Global Payments parser, against a cached REAL statement (§9.4).
//
// Fixture: fixtures/global-fr.lines.txt — the extracted lines of a real Global Payments
// French statement (31/05/26), with the merchant's name, account numbers and address
// redacted. Every fee table is kept byte-for-byte, because that is where the regression
// value is.
//
// The statement's own figures, which these assertions are pinned to:
//   MONTANT DE L'ESCOMPTE            164.11
//   Frais de trans non qualifiée     449.79
//   Total (sommaire de facturation)  613.90
//   Frais d'équipement                90.00
//   Compte débité                    717.38   (613.90 + 90.00 + 13.48 de taxes)
const fs = require('fs');
const path = require('path');
const G = require('../parsers/global');
const K = require('../calc');
const N = require('../notes');
const { STATUS } = require('../classify');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'global-fr.lines.txt'), 'utf8').split('\n');

ok('detects a Global statement', G.detect(lines) === true);
// A rate card carries the vocabulary but none of the merchant furniture.
ok('rejects a rate card (no merchant number)',
  G.detect(['Global Payments', 'Taux d\'interchange', 'VISA CDN ELC SME 1.65%']) === false);

const r = G.parse(lines);
const codes = () => (r.notes || []).map((n) => n.code);
const note = (code) => (r.notes || []).find((n) => n.code === code);

// ---- volumes, straight off the card summary's Total row.
ok('debit volume', near(r.volume.debit_amt, 17002.81), r.volume.debit_amt);
ok('visa volume',  near(r.volume.visa_amt, 23477.14), r.volume.visa_amt);
ok('mc volume',    near(r.volume.mc_amt, 17014.83), r.volume.mc_amt);
ok('amex volume 0', r.volume.amex_amt === 0, r.volume.amex_amt);

// ⚠️ Debit's own Escompte row carries a $0 volume (debit is billed per item), so the card
// summary's Total row is the ONLY source for debit volume. Filtering "Total" as page noise
// silently blanks it — which it did, until the noise list stopped swallowing that row.
ok('debit volume did not fall back to the $0 Escompte row', r.volume.debit_amt > 0);

// ---- counts, summed per brand across every Escompte sub-brand row. Cross-checked by the
// statement itself: the ASMTS rows bill 372 Visa and 305 MC operations.
ok('visa count 372', r.volume.visa_count === 372, r.volume.visa_count);
ok('mc count 305',   r.volume.mc_count === 305, r.volume.mc_count);
ok('debit count 300', r.volume.debit_count === 300, r.volume.debit_count);

// ---- markup rates: 0.18 % on credit, $0.04/txn on debit.
const cp = r.current_processor;
ok('visa markup 0.18%', near(cp.visa_rate, 0.0018, 1e-9), cp.visa_rate);
ok('mc markup 0.18%',   near(cp.mc_rate, 0.0018, 1e-9), cp.mc_rate);
ok('debit is per-item only', cp.debit_rate === 0 && near(cp.debit_fee, 0.04), [cp.debit_rate, cp.debit_fee]);

// ---- interchange = FTNQ + the network rows that sit inside the Escompte section.
ok('interchange 529.03', near(cp.interchange, 529.03), cp.interchange);

// ---- equipment.
// ⚠️ The equipment table is the last one on the page with no section header after it, so
// without explicit terminators the scan ran into the closing notices and captured
// "Votre compte a été débité de la somme de 717.38 $" as a $717.38 fee.
ok('exactly one equipment row', cp.fixed_rows.length === 1, cp.fixed_rows);
ok('equipment is the terminal rental', /LOCATION TERMINAL/.test(cp.fixed_rows[0].label), cp.fixed_rows[0]);
ok('equipment 2 x 45.00 = 90.00', cp.fixed_rows[0].qty === 2 && near(cp.fixed_rows[0].unit, 45) && near(cp.fixed_rows[0].amount, 90), cp.fixed_rows[0]);
ok('no notice text captured as a fee', !cp.fixed_rows.some((f) => /débité|Pour obtenir|composez/i.test(f.label)), cp.fixed_rows);

// ---- the parse reconciles against the statement's own billing summary.
// Asserted on note CODES and raw params, not on rendered French — the same statement in
// English has to produce the same findings.
const rec = note('reconciled');
ok('reconciled with the billing summary', !!rec, codes());
ok('reconciled against 613.90', Math.abs(rec.params.total - 613.90) < 0.005, rec && rec.params);
ok('no reconciliation gap reported', !note('reconcileMismatch'), codes());
const fmt = note('formatDetected');
ok('French layout detected', / \(français\)/.test(fmt.params.layoutSuffix), fmt && fmt.params);
ok('note renders in both languages',
  N.render(rec, 'fr').length > 0 && N.render(rec, 'en').length > 0 && N.render(rec, 'fr') !== N.render(rec, 'en'),
  [N.render(rec, 'fr'), N.render(rec, 'en')]);

// ---- hyphenated FTNQ rows survive the label regex (the ~$72.50 mismatch bug).
const allRows = [...r.line_audit.interchange, ...r.line_audit.brand, ...r.line_audit.interac];
const hyphenated = allRows.filter((x) => /HI-NET/.test(x.desc));
ok('HI-NET hyphenated rows captured', hyphenated.length === 3, hyphenated.map((h) => h.desc));

// ---- Interac rows are found by the IDP FLASH prefix, and the tier suffix survives.
ok('two Interac rows', r.line_audit.interac.length === 2, r.line_audit.interac.map((i) => i.desc));
ok('IDP FLASH T4 keeps its tier', r.line_audit.interac.some((i) => i.tier === 'T4'), r.line_audit.interac.map((i) => i.tier));
ok('no Interac row fell to Markup processeur', !r.line_audit.interac.some((i) => i.status === STATUS.MARKUP));

// ---- SUSPECT.
const suspects = allRows.filter((x) => x.status === STATUS.SUSPECT);
ok('TAX REIMBURSEMENT CH flagged SUSPECT', suspects.length === 1 && /TAX REIMBURSEMENT/.test(suspects[0].desc), suspects.map((s) => s.desc));

// ---- end to end through the calc engine.
const out = K.recalc(K.populate(r, {}));
ok('fixed total 90.00', near(out.current.fixed, 90), out.current.fixed);
// Rate x volume, not the sum of Global's already-rounded per-row fees: the statement's own
// rows sum to 84.87 and re-applying the rate gives 84.89. The 2c is Global rounding each
// row to the cent, and is inherent to comparing a rate against a volume.
ok('markup ~84.87 (2c of per-row rounding)', near(out.current.markup, 84.87, 0.03), out.current.markup);
ok('pretax ~703.90 (613.90 + 90.00)', near(out.current.pretax, 703.90, 0.03), out.current.pretax);

// ---- the SUSPECT asymmetry, on real dollars.
ok('suspect shown but not added to current pretax', near(out.current.hiddenBumps, 8.10) && near(out.current.suspectBumps, 8.10), [out.current.hiddenBumps, out.current.suspectBumps]);
ok('suspect subtracted from Cluster interchange', near(out.cluster.interchange, 529.03 - 8.10), out.cluster.interchange);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
