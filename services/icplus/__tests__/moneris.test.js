// Moneris — both layouts.
//
// ⚠️ THESE FIXTURES ARE SYNTHETIC. Global and Clover were each reconciled to the cent
// against real paper; no Moneris statement was available. The fixtures encode every quirk
// §4 documents, and the two are the SAME statement in two languages — so the strongest
// assertion here is that both layouts land on identical numbers. What they cannot prove is
// that the real section headers match SECTION_FR / SECTION_EN. Reconcile against a real
// statement's section-6 rollup before putting a number from this parser in front of a
// client.
//
// The fixtures are stored as CELLS (pipe-separated), not flat lines, because that is what
// the French layout actually needs — see the cells note in pdfLines.js.
const fs = require('fs');
const path = require('path');
const M = require('../parsers/moneris');
const K = require('../calc');
const { STATUS } = require('../classify');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

function load(name) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n').filter((l) => l.length);
  const cells = raw.map((l) => l.split('|').map((c) => c.trim()));
  const lines = cells.map((c) => c.join(' '));
  lines.cells = cells;
  return lines;
}

const fr = load('moneris-fr.cells.txt');
const en = load('moneris-en.cells.txt');

// ---- dispatch
ok('detects FR', M.detect(fr) === true);
ok('detects EN', M.detect(en) === true);
ok('routes FR to the French layout', M.layoutOf(fr) === 'fr', M.layoutOf(fr));
ok('routes EN to the English layout', M.layoutOf(en) === 'en', M.layoutOf(en));
ok('rejects a non-Moneris statement', M.detect(['Global Payments', 'Relevé du Marchand']) === false);

const R = { fr: M.parse(fr), en: M.parse(en) };
const O = { fr: K.recalc(K.populate(R.fr, {})), en: K.recalc(K.populate(R.en, {})) };

// ---- THE headline assertion: same statement, two languages, identical numbers.
// The two layouts are separate code paths on purpose, so this is what catches one of them
// drifting away from the other.
for (const field of ['debit_amt', 'visa_amt', 'mc_amt', 'amex_amt', 'debit_count', 'visa_count', 'mc_count', 'amex_count']) {
  ok(`FR and EN agree on ${field}`, R.fr.volume[field] === R.en.volume[field], [R.fr.volume[field], R.en.volume[field]]);
}
for (const side of ['markup', 'interchange', 'fixed', 'pretax']) {
  ok(`FR and EN agree on ${side}`, near(O.fr.current[side], O.en.current[side]), [O.fr.current[side], O.en.current[side]]);
}

for (const lang of ['fr', 'en']) {
  const r = R[lang];
  const cp = r.current_processor;
  const tag = lang.toUpperCase();

  // ---- French number format: space thousands, comma decimal.
  ok(`${tag} reads the volume correctly`, near(r.volume.mc_amt, 96300.25), r.volume.mc_amt);

  // ⚠️ Rate columns print many decimals ("0,015000$/item"). An earlier decimal rule that
  // only accepted 1-2 trailing digits turned that into 15000.
  ok(`${tag} per-item fee is $0.015, not 15000`, near(cp.visa_fee, 0.015, 1e-9), cp.visa_fee);

  // ---- two-component markup, tracked SEPARATELY.
  // ⚠️ Never blended into one effective % via total / volume: a blend reproduces the right
  // dollar total while matching neither number printed on the statement, which is exactly
  // the "you are showing 0.23 % that does not match the statement" report in §4.
  ok(`${tag} keeps the % component`, near(cp.visa_rate, 0.002, 1e-9), cp.visa_rate);
  ok(`${tag} keeps the $/item component`, near(cp.visa_fee, 0.015, 1e-9), cp.visa_fee);
  ok(`${tag} debit is per-item only`, cp.debit_rate === 0 && near(cp.debit_fee, 0.04), [cp.debit_rate, cp.debit_fee]);

  // Each brand's markup reproduces its own statement row.
  ok(`${tag} MC markup = the statement's 219.60`,
    near(r.volume.mc_amt * cp.mc_rate + r.volume.mc_count * cp.mc_fee, 219.60), null);
  ok(`${tag} Amex markup = the statement's 120.00`,
    near(r.volume.amex_amt * cp.amex_rate + r.volume.amex_count * cp.amex_fee, 120.00), null);

  // ---- Amex's row wraps across three physical lines and must be re-stitched.
  ok(`${tag} Amex row stitched from its 3 lines`, r.volume.amex_count === 850 && near(r.volume.amex_amt, 41200), r.volume);

  // ---- Discover has no field of its own and folds into Visa, everywhere.
  ok(`${tag} Discover folded into Visa (2400 + 60)`, r.volume.visa_count === 2460, r.volume.visa_count);
  ok(`${tag} Discover volume folded in`, near(r.volume.visa_amt, 132000.50), r.volume.visa_amt);
  ok(`${tag} says so in the notes`, r.notes.some((n) => n.code === 'helpDiscoverFoldedIntoVisa'), r.notes.map((n) => n.code));

  // ---- section 4 is NOT purely markup.
  // Rows carrying the word TRANSACTION are Moneris's own markup; the rest are network
  // pass-through in disguise and belong in interchange. Section 6 (4,528.63 = section 2 +
  // section 3) leaves no room for them anywhere else.
  ok(`${tag} network rows rescued from section 4`, near(cp.interchange, 4582.63), cp.interchange);
  ok(`${tag} = s2 + s3 + the 54.00 of rescued rows`, near(cp.interchange - 4528.63, 54.00), cp.interchange - 4528.63);
  ok(`${tag} reconciles against the section-6 rollup`, r.notes.some((n) => n.code === 'reconciled'), r.notes.map((n) => n.code));
  ok(`${tag} no reconciliation gap`, !r.notes.some((n) => n.code === 'reconcileMismatch'), r.notes.map((n) => n.code));

  // ---- Interac product codes never contain the word "Interac" and must be prefixed, or
  // the shared classifier's word gate never fires and a real pass-through row is lost.
  ok(`${tag} two Interac rows found`, r.line_audit.interac.length === 2, r.line_audit.interac.map((i) => i.desc));
  ok(`${tag} Interac prefix added`, r.line_audit.interac.every((i) => /^Interac /.test(i.desc)), r.line_audit.interac.map((i) => i.desc));
  ok(`${tag} tier recognized on both rows`, r.line_audit.interac.every((i) => !!i.tier), r.line_audit.interac.map((i) => i.tier));
  ok(`${tag} no Interac row fell to Markup processeur`, !r.line_audit.interac.some((i) => i.status === STATUS.MARKUP));

  // ---- unattributed section-4 dollars are prorated by Visa/MC dollar share, not dropped
  // and not parked on one brand.
  const split = cp.unattributed_split;
  ok(`${tag} unattributed dollars prorated`, !!split, split);
  ok(`${tag} proration sums back to 7.40`, near(split.visa + split.mc, 7.40), split);
  ok(`${tag} proration follows the volume share`,
    near(split.visa / (split.visa + split.mc), r.volume.visa_amt / (r.volume.visa_amt + r.volume.mc_amt), 1e-6), split);
  ok(`${tag} reports the proration`, r.notes.some((n) => n.code === 'monerisUnattributed'), r.notes.map((n) => n.code));

  // ---- the service-section warning is always raised: §4 records real per-transaction
  // network fees turning up in a nominally fixed-fee section.
  ok(`${tag} raises the service-section warning`, r.notes.some((n) => n.code === 'monerisServiceSectionWarning'));

  ok(`${tag} three fixed-fee rows`, cp.fixed_rows.length === 3, cp.fixed_rows.map((f) => f.label));
}

// ---- the Moneris-scoped VS-ASSESSMENT override reaches the brand audit.
const vs = R.fr.line_audit.brand.find((x) => /VS - ASSESSMENT/i.test(x.desc));
ok('VS - ASSESSMENT classified by the Moneris override', !!vs && !!vs.cat, vs && { desc: vs.desc, cat: vs.cat });

// ---- French notes render in French, English notes in English.
ok('FR note text is French', /Format détecté/.test(R.fr._note), R.fr._note.slice(0, 60));
ok('EN note text is English', /Format detected/.test(R.en._note), R.en._note.slice(0, 60));

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
