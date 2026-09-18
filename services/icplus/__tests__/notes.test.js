// The bilingual note catalogue.
//
// These notes are the rep-facing voice of the whole feature: they land on screen, in the
// client PDF and in the internal PDF. A note that renders in one language and not the other
// goes out on a client document half-translated, so that is what this suite guards.
const N = require('../notes');
const T = require('../rateTables');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

// ---- no code may ship in only one language.
const gaps = N.missingTranslations();
ok('every note has FR and EN', gaps.length === 0, gaps);

// ---- every code renders non-empty, and differently, in both languages.
const sample = {
  processor: 'Moneris', layoutSuffix: ' (français)',
  count: 2, labels: ['DATASECFEE', 'PCI ADMIN'],
  escompte: 40492, net: 40492, total: 613.90, parsed: 600, statement: 613.90,
  amount: 1474.39, rate: 0.001017, published: 0.0009, monthly: 11.2, annual: 134.36,
  markup: 84.87, interchange: 529.03, fixed: 90,
};
for (const code of Object.keys(N.TEMPLATES)) {
  const n = N.note(code, sample);
  const fr = N.render(n, 'fr');
  const en = N.render(n, 'en');
  ok(`${code} renders FR`, fr.length > 0 && !fr.startsWith('['), fr);
  ok(`${code} renders EN`, en.length > 0 && !en.startsWith('['), en);
  ok(`${code} leaves no unresolved placeholder`, !/\{\{/.test(fr) && !/\{\{/.test(en), [fr, en]);
}

// ---- an unknown code is visible, never silently blank on a client document.
ok('unknown code renders a marker', N.render({ code: 'nope' }, 'fr') === '[nope]');

// ---- locale formatting.
ok('FR money: space thousands, comma decimal, trailing $',
  N.fmtMoney(1774.26, 'fr') === '1\u00a0774,26\u00a0$', N.fmtMoney(1774.26, 'fr'));
ok('EN money: comma thousands, leading $',
  N.fmtMoney(1774.26, 'en') === '$1,774.26', N.fmtMoney(1774.26, 'en'));
ok('FR percent uses a comma', N.fmtPct(0.001017, 'fr') === '0,1017\u00a0%', N.fmtPct(0.001017, 'fr'));
ok('EN percent uses a period', N.fmtPct(0.001017, 'en') === '0.1017%', N.fmtPct(0.001017, 'en'));
ok('FR list joins with "et"', N.fmtList(['a', 'b'], 'fr') === 'a et b', N.fmtList(['a', 'b'], 'fr'));
ok('EN list joins with "and"', N.fmtList(['a', 'b'], 'en') === 'a and b', N.fmtList(['a', 'b'], 'en'));

// ⚠️ French typography keeps a space before ':' — an over-eager punctuation cleanup turned
// "Format détecté :" into "Format détecté:".
ok('FR keeps the space before a colon',
  /détecté\s:/.test(N.render(N.note('formatDetected', { processor: 'Moneris', layoutSuffix: '' }), 'fr')),
  N.render(N.note('formatDetected', { processor: 'Moneris', layoutSuffix: '' }), 'fr'));

// ---- toRecords gives the frontend the code and raw params alongside the rendered text, so
// it can override the wording without a backend change.
const recs = N.toRecords([N.note('reconciled', { total: 613.90 })], 'en');
ok('toRecords carries code, params and text',
  recs[0].code === 'reconciled' && recs[0].params.total === 613.90 && /\$613\.90/.test(recs[0].text), recs);

// ---- the review help hints resolve to real, translatable codes.
for (const proc of ['global', 'clover', 'moneris', 'nuvei']) {
  const hints = T.helpFor(proc);
  ok(`help for ${proc} is non-empty`, hints.length > 0, hints);
  ok(`help for ${proc} all translate`, hints.every((h) => !N.render(h, 'en').startsWith('[')), hints.map((h) => h.code));
}

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
