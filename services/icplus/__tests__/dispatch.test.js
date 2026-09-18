// Processor dispatch (§1).
//
// The single most valuable assertion here is the cross-matching one: every detector must
// recognize its OWN statement and must NOT claim anyone else's. A detector that is too
// loose is worse than one that is too tight — a wrong parser produces a confident,
// plausible, wrong comparison under the wrong processor's name, whereas a missed detection
// falls through to the generic keyword parser, which openly says it classified nothing.
const fs = require('fs');
const path = require('path');
const D = require('../parsers');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

const load = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8').split('\n').filter((l) => l.length);
const loadCells = (f) => load(f).map((l) => l.split('|').join(' '));

const FIXTURES = [
  ['global-fr.lines.txt',     'global'],
  ['clover-fr.lines.txt',     'clover'],
  ['clover-fr-apr.lines.txt', 'clover'],
  ['clover-fr-may.lines.txt', 'clover'],
  ['nuvei.lines.txt',         'nuvei'],
  ['payfacto.lines.txt',      'payfacto'],
  ['chase.lines.txt',         'chase'],
];

for (const [file, expected] of FIXTURES) {
  ok(`${file} -> ${expected}`, D.detect(load(file)) === expected, D.detect(load(file)));
}
for (const f of ['moneris-fr.cells.txt', 'moneris-en.cells.txt']) {
  ok(`${f} -> moneris`, D.detect(loadCells(f)) === 'moneris', D.detect(loadCells(f)));
}

// ---- every implemented parser actually parses its own fixture through the dispatch.
for (const [file, expected] of FIXTURES) {
  const out = D.parse(load(file), 'auto');
  ok(`${file} parses via auto`, out.ok === true && out.processor === expected, { ok: out.ok, processor: out.processor });
  ok(`${file} returns the shared shape`,
    !!out.current_processor && !!out.volume && !!out.line_audit, Object.keys(out));
}

// ---- all seven §4 formats are implemented; none is still a stub.
// §4 counts "seven processor formats" across SIX vendors — Moneris contributes two, because
// its French and English layouts are two fully separate parsers behind one entry point.
// available() lists what a user picks from, so it is the six vendors.
const avail = D.available();
ok('six vendors available', avail.length === 6, avail.map((p) => p.key));
ok('all implemented', avail.every((p) => p.implemented), avail.filter((p) => !p.implemented).map((p) => p.key));
ok('nothing left planned', Object.keys(D.PLANNED).length === 0, D.PLANNED);
// The seventh format is Moneris's second layout, reachable through its own entry point.
const M = require('../parsers/moneris');
ok('Moneris carries two layouts',
  M.layoutOf(loadCells('moneris-fr.cells.txt')) === 'fr' && M.layoutOf(loadCells('moneris-en.cells.txt')) === 'en');

// ⚠️ `verified` means "reconciled to the cent against a cached REAL statement", NOT "the
// tests pass". Only Global and Clover have been. If this list ever grows, it should be
// because a real statement was checked — not because a synthetic fixture was added.
const verified = avail.filter((p) => p.verified).map((p) => p.key).sort();
ok('only Global and Clover are marked verified', JSON.stringify(verified) === JSON.stringify(['clover', 'global']), verified);

// ---- an unknown format falls through to the keyword parser, which classifies nothing.
const generic = D.parse(['Discount fee 12.50', 'Interchange assessment 100.00', 'Terminal rental 30.00'], 'auto');
ok('unknown format -> generic', generic.ok && generic.processor === 'generic', generic.processor);
ok('generic produces NO line audit', generic.line_audit.interchange.length === 0
  && generic.line_audit.brand.length === 0 && generic.line_audit.interac.length === 0, generic.line_audit);
ok('generic says so', (generic.notes || []).some((n) => n.code === 'genericNoAudit'), (generic.notes || []).map((n) => n.code));

// ---- nothing usable at all is an honest failure, not an empty success.
const nothing = D.parse(['hello world', 'nothing here'], 'auto');
ok('unusable input -> ok:false', nothing.ok === false && nothing.reason === 'unrecognized', nothing);

const empty = D.parse([], 'auto');
ok('empty input -> ok:false', empty.ok === false && empty.reason === 'empty', empty);

// ---- naming a processor explicitly overrides detection.
const forced = D.parse(load('global-fr.lines.txt'), 'global');
ok('explicit processor honoured', forced.ok && forced.processor === 'global', forced.processor);
const unknown = D.parse(load('global-fr.lines.txt'), 'square');
ok('unknown processor name -> ok:false', unknown.ok === false && unknown.reason === 'unknown_processor', unknown.reason);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
