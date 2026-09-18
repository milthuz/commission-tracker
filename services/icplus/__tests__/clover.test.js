// Clover / Fiserv parser, against a cached REAL statement (§9.4).
//
// Fixture: fixtures/clover-fr.lines.txt — a real French Clover statement for the period
// 05/01/26 – 05/31/26, merchant identity and account numbers redacted, every fee table
// kept byte-for-byte.
//
// The statement's own figures these assertions are pinned to:
//   Montant total soumis     115,595.37
//   Frais d'interchange            0.00   ← the trap: the real interchange is elsewhere
//   Frais de service          -1,601.71
//   Autres frais                -172.55
//   total fees                -1,774.26
const fs = require('fs');
const path = require('path');
const C = require('../parsers/clover');
const K = require('../calc');
const N = require('../notes');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'clover-fr.lines.txt'), 'utf8').split('\n');

// Detection is a text-presence test, not a header match — the string survives both layouts.
ok('detects via commercecontrol.com', C.detect(lines) === true);
ok('rejects an unrelated statement', C.detect(['Relevé du Marchand', 'Global Payments']) === false);

const r = C.parse(lines);
const codes = () => (r.notes || []).map((n) => n.code);
const note = (code) => (r.notes || []).find((n) => n.code === code);
const hasNote = (code) => !!note(code);

ok('merchant name', r.merchant_name === 'LE COMMERCE EXEMPLE', r.merchant_name);

// ---- card-type table, found by row SHAPE because it sits above every section header.
// Note the backtick apostrophe in its own header ("Taux d`escompte%") — another reason
// header text is not trustworthy here.
const ct = C.parseCardTypes(lines);
ok('VISA 0.15% / $0', near(ct.VISA.pct, 0.0015) && ct.VISA.perItem === 0, ct.VISA);
ok('IDEBT 0% / $0.04', ct.IDEBT.pct === 0 && near(ct.IDEBT.perItem, 0.04), ct.IDEBT);

// ---- bucketing by HOW the card is priced, not by what the network calls it.
//
// ⚠️ VisaDebit (VCDBT) is billed at the credit percentage, so it belongs in Visa. Interac
// and IF (Interac Flash) are the only flat-per-item rails, so they are the only debit.
// A prior version put VisaDebit in debit and the whole comparison came out wrong.
ok('debit = Interac + IF only, 459 items', r.volume.debit_count === 459, r.volume.debit_count);
ok('debit volume 19,895.69', near(r.volume.debit_amt, 19895.69), r.volume.debit_amt);
ok('VisaDebit folded into Visa (864 items)', r.volume.visa_count === 864, r.volume.visa_count);
ok('visa volume 47,203.38', near(r.volume.visa_amt, 47203.38), r.volume.visa_amt);
ok('mc volume 48,496.30', near(r.volume.mc_amt, 48496.30), r.volume.mc_amt);
// Cross-check against the figures a human validated by hand: credit = 1728 / 95,699.68.
ok('credit totals match the manual (1728 / 95,699.68)',
  r.volume.visa_count + r.volume.mc_count === 1728 && near(r.volume.visa_amt + r.volume.mc_amt, 95699.68),
  [r.volume.visa_count + r.volume.mc_count, r.volume.visa_amt + r.volume.mc_amt]);

// ⚠️ The per-item fee is billed on returns too: the IF row carries 1 credit, so the debit
// basis is 459 items, not 458. Counting sales only left a 4c gap against the statement.
ok('return items counted in the per-item basis', r.volume.debit_count === 459);

const cp = r.current_processor;
ok('visa blended rate 0.15%', near(cp.visa_rate, 0.0015, 1e-9), cp.visa_rate);
ok('debit per-item $0.04', near(cp.debit_fee, 0.04), cp.debit_fee);

// ---- the double-count trap.
// FRAIS DE TRANSACTION (-143.55) and the two INTERAC FRAIS PAR TRAN rows (-18.36) are
// Fiserv's OWN markup, already computed from the card-type rates. They must not also be
// counted as network fees.
ok('Fiserv markup rows excluded from network fees', hasNote('fiservMarkupExcluded'), codes());
const allRows = [...r.line_audit.interchange, ...r.line_audit.brand, ...r.line_audit.interac];
ok('no FRAIS DE TRANSACTION row in the audit', !allRows.some((x) => /FRAIS DE TRANSACTION/i.test(x.desc)), allRows.filter((x) => /TRANSACTION/i.test(x.desc)).map((x) => x.desc));
ok('no FRAIS PAR TRAN row in the audit', !allRows.some((x) => /FRAIS PAR TRAN/i.test(x.desc)));

// ---- the $0.00 interchange trap: the statement declares no interchange while 1,474.39
// of it sits in Frais de service under unexplained codes.
ok('flags the $0 interchange section', hasNote('zeroInterchangeDeclared'), codes());
ok('real interchange found anyway', near(cp.interchange, 1474.39), cp.interchange);
ok('the hidden codes are captured', ['CANCNTLSLMWE', 'HNW IND3 NAT'].every((code) => allRows.some((x) => x.desc.includes(code))),
  allRows.map((x) => x.desc).filter((d) => /CANCNTL|HNW/.test(d)));

// ---- inflated assessment, quantified.
// The rate-disclosure table bills 0.1017 % where the published rate is 0.0900 %.
// ⚠️ asserted on the note's CODE and raw params, never on rendered French text: the same
// note has to come out in English on an English statement, and a substring test would pass
// or fail on wording rather than on the finding.
const infl = note('assessmentInflated');
ok('flags the inflated assessment', !!infl, codes());
ok('billed rate 0.1017%', near(infl.params.rate, 0.001017, 1e-9), infl && infl.params);
ok('published rate 0.0900%', near(infl.params.published, 0.0009, 1e-9), infl && infl.params);
ok('overcharge ~11.20/month', near(infl.params.monthly, 11.20, 0.01), infl && infl.params);
ok('overcharge ~134.36/year', near(infl.params.annual, 134.36, 0.05), infl && infl.params);
// Both languages must render, or a client document goes out half-translated.
ok('renders in French', /0,1017/.test(N.render(infl, 'fr')), N.render(infl, 'fr'));
ok('renders in English', /0\.1017%/.test(N.render(infl, 'en')), N.render(infl, 'en'));

// ---- Interac rows survive, tagged -CONTACT / -FLASH.
ok('three Interac pass-through rows', r.line_audit.interac.length === 3, r.line_audit.interac.map((i) => i.desc));

// ---- equipment.
ok('one equipment row, 137.96', cp.fixed_rows.length === 1 && near(cp.fixed_rows[0].amount, 137.96), cp.fixed_rows);

// ---- end to end: the whole statement reconciles to the cent.
const out = K.recalc(K.populate(r, {}));
ok('markup 161.91', near(out.current.markup, 161.91), out.current.markup);
ok('interchange 1,474.39', near(out.current.interchange, 1474.39), out.current.interchange);
ok('fixed 137.96', near(out.current.fixed, 137.96), out.current.fixed);
ok('pretax 1,774.26 — exact match to the statement', near(out.current.pretax, 1774.26), out.current.pretax);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
