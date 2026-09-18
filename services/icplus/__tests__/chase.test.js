// Chase / Paymentech.
//
// ⚠️ SYNTHETIC FIXTURE. Global and Clover were each reconciled to the cent against real
// paper; no Chase statement was available. Every quirk §4 documents is covered, but the
// section wording is the most likely thing to need correcting against real paper.
const fs = require('fs');
const path = require('path');
const C = require('../parsers/chase');
const K = require('../calc');
const { STATUS } = require('../classify');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'chase.lines.txt'), 'utf8').split('\n').filter((l) => l.length);

// ---- detection: either marker on its own is enough.
ok('detects via chase.ca', C.detect(['Visit us at www.chase.ca']) === true);
ok('detects via Chase Paymentech', C.detect(['Chase Paymentech Solutions']) === true);
ok('rejects an unrelated statement', C.detect(['Moneris Solutions', 'Relevé du marchand']) === false);
ok('detects the fixture', C.detect(lines) === true);

const r = C.parse(lines);
const cp = r.current_processor;
const codes = r.notes.map((n) => n.code);
const ic = r.line_audit.interchange.map((x) => x.desc);

// ---------------------------------------------------------------------------
// Glued interchange codes.
//
// ⚠️ Chase runs the brand prefix straight into the code with no space
// ("MCCANITRACTRYCONCRCNTCLCOR"). Downstream classification keys on prefix word boundaries,
// so an un-split code matches nothing and the brand guard cannot tell which network it is.
// ---------------------------------------------------------------------------
ok('MC code un-glued', ic.includes('MC CANITRACTRYCONCRCNTCLCOR'), ic);
ok('VS code un-glued', ic.includes('VS CANELECTRONICSTD'), ic);
ok('second MC code un-glued', ic.includes('MC CANCOREMERITIII'), ic);
ok('already-spaced codes left alone', ic.includes('VS CDN INFINITE') && ic.includes('MC CDN WORLD ELITE'), ic);

// ⚠️ The un-gluing has to be narrow. A row with spaces, or an ordinary word that merely
// begins with a brand prefix, must be left intact.
ok('MASTERCARD is not split', C.ungleuCode('MASTERCARD') === 'MASTERCARD', C.ungleuCode('MASTERCARD'));
ok('a spaced description is untouched', C.ungleuCode('MC ACQUIRER LICENSE FEE') === 'MC ACQUIRER LICENSE FEE');
ok('a short token is untouched', C.ungleuCode('MCABC') === 'MCABC', C.ungleuCode('MCABC'));

// ---------------------------------------------------------------------------
// Brand-NESTED sections. A row's meaning comes from the pair of headers above it, so a
// missed boundary mislabels rows under the wrong BRAND, not merely the wrong category.
// ---------------------------------------------------------------------------
ok('six interchange rows across Visa and MC', r.line_audit.interchange.length === 6, ic);
ok('four assessment rows in the brand table', r.line_audit.brand.length === 4, r.line_audit.brand.map((x) => x.desc));
ok('Visa assessments did not land in interchange', !ic.some((d) => /ASSESSMENT/.test(d)), ic);
ok('Interac rows kept separate', r.line_audit.interac.length === 2, r.line_audit.interac.map((x) => x.desc));

// The brand guard routes each assessment to its OWN network — both publish 0.0900 %, so
// rate proximity alone cannot separate them.
const vsA = r.line_audit.brand.find((x) => /^VS ASSESSMENT/.test(x.desc));
const mcA = r.line_audit.brand.find((x) => /^MC ASSESSMENT/.test(x.desc));
ok('VS ASSESSMENT is Conforme', vsA.status === STATUS.CONFORME, vsA && vsA.status);
ok('VS ASSESSMENT matched to Visa', /^Visa/.test(vsA.cat || ''), vsA && vsA.cat);
ok('MC ASSESSMENT matched to Mastercard, not Visa', /^Mastercard/.test(mcA.cat || ''), mcA && mcA.cat);

// Interac tier in Roman numerals, same shared regex as Payfacto and Moneris EN.
ok('IDP FLASH TIER II keeps its tier',
  (r.line_audit.interac.find((x) => /TIER II/.test(x.desc)) || {}).tier === 'TIER II',
  r.line_audit.interac.map((x) => [x.desc, x.tier]));
ok('no Interac row fell to Markup processeur', !r.line_audit.interac.some((x) => x.status === STATUS.MARKUP));

// ---------------------------------------------------------------------------
// Amex's "Fees" is a wholesale DISCOUNT, not interchange.
//
// ⚠️ Per Chase's own cover-page notice. Routing it to interchange would both overstate
// Chase's pass-through and understate its markup — the comparison would be wrong twice.
// ---------------------------------------------------------------------------
ok('Amex discount row is NOT in the interchange audit', !ic.some((d) => /OPTBLUE/.test(d)), ic);
ok('Amex markup rate captured', near(cp.amex_rate, 0.023, 1e-9), cp.amex_rate);
ok('Amex per-item captured', near(cp.amex_fee, 0.10, 1e-9), cp.amex_fee);
ok('note explains why Amex is markup', codes.includes('chaseAmexIsDiscount'), codes);

// ---------------------------------------------------------------------------
// Chase is already interchange-plus, so debit/Visa/MC markup is genuinely ZERO.
//
// ⚠️ Zero here is the right answer, not a failed parse. The note exists so a rep does not
// read an empty markup column as a broken import.
// ---------------------------------------------------------------------------
ok('debit markup is 0', cp.debit_rate === 0 && cp.debit_fee === 0, [cp.debit_rate, cp.debit_fee]);
ok('Visa markup is 0', cp.visa_rate === 0 && cp.visa_fee === 0, [cp.visa_rate, cp.visa_fee]);
ok('MC markup is 0', cp.mc_rate === 0 && cp.mc_fee === 0, [cp.mc_rate, cp.mc_fee]);
ok('and the note says why', codes.includes('chaseAlreadyInterchangePlus'), codes);

// ---------------------------------------------------------------------------
// Card Type Summary
// ---------------------------------------------------------------------------
ok('Visa volume', near(r.volume.visa_amt, 96400.25) && r.volume.visa_count === 1850, r.volume);
ok('MC volume', near(r.volume.mc_amt, 81200.50) && r.volume.mc_count === 1540, r.volume);
ok('Interac volume', near(r.volume.debit_amt, 52300.75) && r.volume.debit_count === 1120, r.volume);
// Discover has no field of its own and folds into Amex (260 + 40).
ok('Discover folded into Amex', r.volume.amex_count === 300 && near(r.volume.amex_amt, 20850), r.volume);

// ---------------------------------------------------------------------------
// Arithmetic. §4 describes no statement-level fee total for Chase, so nothing is invented
// here: the assertion is that the parts add up to what the parser reports.
// ---------------------------------------------------------------------------
const rowTotal = [...r.line_audit.interchange, ...r.line_audit.brand, ...r.line_audit.interac]
  .reduce((s, x) => s + x.total, 0);
ok('interchange total = the sum of its rows', near(cp.interchange, rowTotal), [cp.interchange, rowTotal]);
ok('interchange 2,969.07', near(cp.interchange, 2969.07), cp.interchange);

const out = K.recalc(K.populate(r, {}));
ok('markup comes only from Amex', near(out.current.markup, 20850 * 0.023 + 300 * 0.10), out.current.markup);
ok('pretax = Amex markup + pass-through', near(out.current.pretax, out.current.markup + 2969.07), out.current.pretax);
ok('no fixed fees on this layout', out.current.fixed === 0, out.current.fixed);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
