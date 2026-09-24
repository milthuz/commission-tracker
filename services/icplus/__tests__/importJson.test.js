// JSON import / manual entry (§7), plus the manual row systems.
//
// The load-bearing assertion here is the LAST section: imported JSON must flow through the
// exact same populate() path as a real parse and land on the same numbers. That is what
// makes the fallback equivalent to a parse rather than a second, subtly different code path.
const fs = require('fs');
const path = require('path');
const I = require('../importJson');
const K = require('../calc');
const G = require('../parsers/global');
const D = require('../parsers');
const N = require('../notes');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

const MINIMAL = {
  current_processor: { name: 'Square', visa_rate: 0.0265, visa_fee: 0.10, interchange: 400 },
  volume: { visa_count: 500, visa_amt: 25000, mc_count: 0, mc_amt: 0, debit_count: 0, debit_amt: 0, amex_count: 0, amex_amt: 0 },
};

// ---------------------------------------------------------------------------
// ⚠️ Fence stripping. An LLM asked for JSON answers with ```json … ``` far more often than
// not, and a human pasting from a chat window brings the fence along. Failing on that makes
// the fallback look broken at exactly the moment it is needed.
// ---------------------------------------------------------------------------
ok('bare JSON parses', I.parseImport(JSON.stringify(MINIMAL)).ok === true);
ok('```json fence stripped', I.parseImport('```json\n' + JSON.stringify(MINIMAL) + '\n```').ok === true);
ok('bare ``` fence stripped', I.parseImport('```\n' + JSON.stringify(MINIMAL) + '\n```').ok === true);
ok('leading prose tolerated',
  I.parseImport('Voici le JSON demandé :\n' + JSON.stringify(MINIMAL)).ok === true);
ok('trailing prose tolerated',
  I.parseImport(JSON.stringify(MINIMAL) + '\n\nJ\'espère que ça aide !').ok === true);

// ---- failures are explicit, never a silent empty success.
const empty = I.parseImport('   ');
ok('empty input rejected', empty.ok === false && empty.errors[0].code === 'empty', empty.errors);
const bad = I.parseImport('{ not json ]');
ok('malformed JSON rejected', bad.ok === false && bad.errors[0].code === 'badJson', bad.errors);
ok('malformed JSON explains itself', N.render(bad.notes[0], 'fr').length > 20, N.render(bad.notes[0], 'fr'));
const arr = I.parseImport('[1,2,3]');
ok('an array is rejected', arr.ok === false, arr.errors);

// ---- §7 names these two keys as required.
const noVol = I.parseImport(JSON.stringify({ current_processor: {} }));
ok('missing volume rejected', noVol.ok === false && noVol.errors[0].code === 'missingKeys', noVol.errors);
ok('and it names the missing key', N.render(noVol.notes[0], 'fr').includes('volume'), N.render(noVol.notes[0], 'fr'));
const noCp = I.parseImport(JSON.stringify({ volume: {} }));
ok('missing current_processor rejected', noCp.ok === false, noCp.errors);

// ---------------------------------------------------------------------------
// ⚠️ A suspicious number is REPORTED, never corrected. Auto-dividing 1.65 by 100 is a guess
// about money: guess right and nobody notices, guess wrong and a subtly wrong figure reaches
// a client document. 165% markup is absurd on its face and gets caught on screen; a quietly
// "fixed" number never gets a second look.
// ---------------------------------------------------------------------------
const pctRate = I.parseImport(JSON.stringify({
  ...MINIMAL,
  current_processor: { ...MINIMAL.current_processor, visa_rate: 1.65 },
}));
ok('a percentage-looking rate still imports', pctRate.ok === true, pctRate.errors);
ok('but it is flagged', pctRate.warnings.some((w) => w.code === 'rateLooksLikePercent'), pctRate.warnings);
ok('and the value is NOT changed', pctRate.parsed.current_processor.visa_rate === 1.65, pctRate.parsed.current_processor.visa_rate);
ok('the warning says it was not corrected',
  /pas .{0,4}corrig/i.test(N.render(pctRate.notes.find((n) => n.code === 'jsonRateLooksLikePercent'), 'fr')),
  N.render(pctRate.notes.find((n) => n.code === 'jsonRateLooksLikePercent'), 'fr'));

const bigFee = I.parseImport(JSON.stringify({ ...MINIMAL, current_processor: { ...MINIMAL.current_processor, visa_fee: 12 } }));
ok('an implausible per-item fee is flagged', bigFee.warnings.some((w) => w.code === 'feeLooksWrong'), bigFee.warnings);
ok('and also left alone', bigFee.parsed.current_processor.visa_fee === 12);

const zeroVol = I.parseImport(JSON.stringify({ current_processor: {}, volume: {} }));
ok('a volume-less import warns', zeroVol.ok === true && zeroVol.warnings.some((w) => w.code === 'noVolume'), zeroVol.warnings);

const nan = I.parseImport(JSON.stringify({ current_processor: {}, volume: { visa_amt: 'beaucoup' } }));
ok('a non-numeric volume is a hard error', nan.ok === false && nan.errors.some((e) => e.code === 'notANumber'), nan.errors);

// ---- the import announces itself, so a saved analysis always says where its numbers came from.
const imported = I.parseImport(JSON.stringify(MINIMAL));
ok('import is labelled as manual', imported.notes.some((n) => n.code === 'jsonImported'), imported.notes.map((n) => n.code));
ok('label renders in both languages',
  N.render({ code: 'jsonImported' }, 'fr').length > 20 && N.render({ code: 'jsonImported' }, 'en').length > 20);

// ---- defaults fill in everything a parser would have set.
const norm = imported.parsed;
ok('every volume field present', I.VOLUME_FIELDS.every((f) => Number.isFinite(norm.volume[f])), norm.volume);
ok('every rate field present', I.RATE_FIELDS.every((f) => Number.isFinite(norm.current_processor[f])), norm.current_processor);
ok('line_audit defaulted to three empty buckets',
  Array.isArray(norm.line_audit.interchange) && Array.isArray(norm.line_audit.brand) && Array.isArray(norm.line_audit.interac));

// ---------------------------------------------------------------------------
// ⚠️ THE CONTRACT. §7 requires imported JSON to satisfy the same shape every parser returns.
// So the validator is pointed at the REAL parsers too — if the two ever drift apart, the
// fallback silently stops being equivalent to a parse, which is the whole thing this path
// exists to guarantee.
// ---------------------------------------------------------------------------
const globalParsed = G.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'global-fr.lines.txt'), 'utf8').split('\n'));
ok('a real parser output satisfies the import contract', I.validateShape(globalParsed).ok === true,
  I.validateShape(globalParsed).errors);

const FIXTURES = [
  ['global-fr.lines.txt', 'global'], ['clover-fr.lines.txt', 'clover'],
  ['nuvei.lines.txt', 'nuvei'], ['payfacto.lines.txt', 'payfacto'], ['chase.lines.txt', 'chase'],
];
for (const [file] of FIXTURES) {
  const lines = fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8').split('\n').filter((l) => l.length);
  const out = D.parse(lines, 'auto');
  const v = I.validateShape(out);
  ok(`${file}: parser output satisfies the contract`, v.ok === true, v.errors);
}

// ---------------------------------------------------------------------------
// And the round trip: imported JSON must reach the SAME numbers as the parse it came from.
// ---------------------------------------------------------------------------
const fromParse = K.recalc(K.populate(globalParsed, {}));
const roundTrip = I.parseImport(JSON.stringify(globalParsed));
ok('a real parse survives being serialized and re-imported', roundTrip.ok === true, roundTrip.errors);
const fromImport = K.recalc(K.populate(roundTrip.parsed, {}));
for (const field of ['markup', 'interchange', 'fixed', 'pretax', 'hiddenBumps', 'suspectBumps']) {
  ok(`round trip preserves ${field}`, near(fromParse.current[field], fromImport.current[field]),
    [fromParse.current[field], fromImport.current[field]]);
}
ok('round trip preserves the Cluster subtraction', near(fromParse.cluster.interchange, fromImport.cluster.interchange),
  [fromParse.cluster.interchange, fromImport.cluster.interchange]);

// ---------------------------------------------------------------------------
// Manual rows — three independently mirrored systems (§7).
// ---------------------------------------------------------------------------
let st = K.populate(MINIMAL, {});
const base = K.recalc(st).current.fixed;
// ⚠️ Le côté Cluster ne part plus de ZÉRO : depuis le 2026-09-24 il est amorcé avec
// l'offre standard (clusterOffer.js), sans quoi le calculateur présentait Cluster comme
// ne facturant rien et l'économie annoncée au marchand était fausse. Ce que ces
// assertions mesurent n'est pas la valeur absolue mais l'INDÉPENDANCE des deux côtés :
// elles se comparent donc à leur propre base.
const baseCluster = K.recalc(st).cluster.fixed;

st = K.addFixedRow(st, 'current', { label: 'Frais de portail', qty: 1, unit: 25 });
ok('a current-side row adds to the current total', near(K.recalc(st).current.fixed, base + 25), K.recalc(st).current.fixed);
ok('and leaves the Cluster side alone', K.recalc(st).cluster.fixed === baseCluster, K.recalc(st).cluster.fixed);

st = K.addFixedRow(st, 'cluster', { label: 'Terminal', qty: 2, unit: 29.99 });
ok('the Cluster side is mirrored but independent', near(K.recalc(st).cluster.fixed, baseCluster + 59.98), K.recalc(st).cluster.fixed);
ok('adding to Cluster did not touch the current side', near(K.recalc(st).current.fixed, base + 25));

st = K.updateFixedRow(st, 'current', 0, { unit: 40 });
ok('a row can be edited in place', near(K.recalc(st).current.fixed, base + 40), K.recalc(st).current.fixed);

// ⚠️ §7's requirement: adding or removing a row must not disturb the others. State-based
// operations make that structural rather than something to remember.
st = K.addFixedRow(st, 'current', { label: 'Autre', qty: 1, unit: 10 });
st = K.removeFixedRow(st, 'current', 1);
ok('removing one row keeps the other intact', near(K.recalc(st).current.fixed, base + 40), K.recalc(st).current.fixed);
ok('operations are immutable', st.current.extraFixed !== undefined && Array.isArray(st.current.extraFixed));

// ---- manual hidden bumps follow the same SUSPECT asymmetry as parsed ones.
//
// ⚠️ The base object needs at least one itemized audit row. With none, populate() takes
// priority 3 (the flat 1.65 % fallback) and puts Cluster's interchange into OVERRIDE mode,
// where the suspect subtraction deliberately does not apply — so a bump test built on a
// bare object would be testing the wrong branch entirely.
const WITH_AUDIT = {
  ...MINIMAL,
  line_audit: { interchange: [{ desc: 'VS CPS RETAIL', count: 500, volume: 25000, total: 400, status: 'A vérifier' }], brand: [], interac: [] },
};
let bs = K.populate(WITH_AUDIT, {});
ok('base is in pass-through mode, not override', K.recalc(bs).cluster.interchangeMode === 'passthrough',
  K.recalc(bs).cluster.interchangeMode);
const beforeCluster = K.recalc(bs).cluster.interchange;
bs = K.addHiddenBump(bs, { label: 'FRAIS MYSTERE', total: 30 });
const after = K.recalc(bs);
ok('a manual bump defaults to suspect', bs.current.hiddenBumps[0].suspect === true, bs.current.hiddenBumps[0]);
ok('it shows on the current side', near(after.current.hiddenBumps, 30), after.current.hiddenBumps);
ok('but is EXCLUDED from the current pretax', near(after.current.pretax, K.recalc(K.populate(WITH_AUDIT, {})).current.pretax),
  after.current.pretax);
ok('and SUBTRACTED from Cluster interchange', near(after.cluster.interchange, beforeCluster - 30), after.cluster.interchange);

bs = K.updateHiddenBump(bs, 0, { suspect: false });
ok('un-flagging it stops the Cluster subtraction', near(K.recalc(bs).cluster.interchange, beforeCluster), K.recalc(bs).cluster.interchange);
ok('while it still shows on the current side', near(K.recalc(bs).current.hiddenBumps, 30));

bs = K.removeHiddenBump(bs, 0);
ok('removing it clears both', K.recalc(bs).current.hiddenBumps === 0 && near(K.recalc(bs).cluster.interchange, beforeCluster));

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
