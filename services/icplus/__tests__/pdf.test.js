// The two PDF exports (§6).
//
// A PDF is hard to eyeball, so these tests check the two things that matter most and that a
// human reviewer would not reliably catch:
//   1. the CLIENT document never leaks tax, margin or audit detail
//   2. the savings hero appears only when Cluster is genuinely cheaper
// Both are verified by reading the text back OUT of the generated PDF, not by trusting the
// code that wrote it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const G = require('../parsers/global');
const K = require('../calc');
const P = require('../pdf');
const N = require('../notes');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

// ---------------------------------------------------------------------------
// Reading text back out of a pdfkit document.
//
// ⚠️ Two things make the naive version silently return nothing:
//   1. content streams are flate-COMPRESSED, so the text is not in the raw bytes
//   2. pdfkit emits text as HEX strings inside TJ arrays — <436f6d...> — not as (literal)
// Either miss yields an empty string, and then every negative assertion below ("shows NO
// tax") passes for the wrong reason. That is the worst possible outcome for exactly the
// checks that matter most, so the suite aborts if extraction comes back empty.
// ---------------------------------------------------------------------------
// Each text RUN pdfkit emitted, kept separate. Needed for label-level assertions: a joined
// string cannot tell the standalone row label "Taxes" apart from the tail of "Total avant
// taxes", and a substring test would false-positive on exactly the check that matters most.
function runsOf(buf) {
  const raw = buf.toString('latin1');
  let body = '';
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streams.exec(raw)) !== null) {
    try { body += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); }
    catch { body += m[1]; }
  }

  // ⚠️ A TJ array splits one string at every kerning pair: [<54> -20 <6f74616c> ...]. The
  // chunks inside ONE array are a single text run and must be concatenated with NOTHING
  // between them — joining them with spaces turns "Total avant taxes" into
  // "T otal a v ant tax es", which then fails every text assertion for a cosmetic reason.
  // Separate TJ operators are separate runs, so those get the space.
  const runs = [];
  const arrays = /\[([^\]]*)\]\s*TJ/g;
  let a;
  while ((a = arrays.exec(body)) !== null) {
    const chunks = [];
    const hex = /<([0-9a-fA-F\s]+)>/g;
    let h;
    while ((h = hex.exec(a[1])) !== null) {
      const clean = h[1].replace(/\s+/g, '');
      if (clean.length >= 2 && clean.length % 2 === 0) chunks.push(Buffer.from(clean, 'hex').toString('latin1'));
    }
    const lit = /\((?:\\.|[^\\()])*\)/g;
    let l;
    while ((l = lit.exec(a[1])) !== null) {
      chunks.push(l[0].slice(1, -1).replace(/\\([()\\])/g, '$1'));
    }
    if (chunks.length) runs.push(chunks.join(''));
  }
  // Single-string form: (…) Tj or <…> Tj
  const single = /(?:<([0-9a-fA-F\s]+)>|\((?:\\.|[^\\()])*\))\s*Tj/g;
  let s;
  while ((s = single.exec(body)) !== null) {
    if (s[1]) {
      const clean = s[1].replace(/\s+/g, '');
      if (clean.length >= 2 && clean.length % 2 === 0) runs.push(Buffer.from(clean, 'hex').toString('latin1'));
    } else {
      runs.push(s[0].slice(1, s[0].lastIndexOf(')')).replace(/\\([()\\])/g, '$1'));
    }
  }
  return runs;
}

// The joined page text, for ordinary "does it say X" assertions.
const textOf = (buf) => runsOf(buf).join(' ');

// Accent- and case-insensitive containment: the extracted bytes depend on the font's
// encoding, not on how the source string was typed.
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const has = (hay, needle) => norm(hay).includes(norm(needle));

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'global-fr.lines.txt'), 'utf8').split('\n');
const parsed = G.parse(lines);

// Cluster priced BELOW the current processor: this statement genuinely saves money.
const cheaper = K.populate(parsed, {
  clusterRates: { debit: { pct: 0, perItem: 0.04 }, visa: { pct: 0.001, perItem: 0 }, mc: { pct: 0.001, perItem: 0 }, amex: { pct: 0.001, perItem: 0 } },
  clusterFixed: { terminalWired: { qty: 2, unit: 29.99 }, pci: { qty: 1, unit: 9 } },
});
const cheaperOut = K.recalc(cheaper);

// And the opposite: Cluster priced far above, so there are NO savings to claim.
const dearer = K.populate(parsed, {
  clusterRates: { debit: { pct: 0, perItem: 0.20 }, visa: { pct: 0.02, perItem: 0.10 }, mc: { pct: 0.02, perItem: 0.10 }, amex: { pct: 0.02, perItem: 0.10 } },
  clusterFixed: { terminalWired: { qty: 2, unit: 99 }, pci: { qty: 1, unit: 50 } },
});
const dearerOut = K.recalc(dearer);

(async () => {
  const client = await P.buildClientPdf({ state: cheaper, result: cheaperOut, options: { salesperson: 'David', notes: 'Merci de votre confiance.' } });
  const clientText = textOf(client);

  // ⚠️ Guard the guard — see the extractor note above.
  ok('text extraction actually works', clientText.length > 200 && has(clientText, 'Total avant taxes'),
    { length: clientText.length, head: clientText.slice(0, 140) });
  if (clientText.length < 200) { console.log('\nextraction broken — aborting so nothing passes vacuously'); process.exit(1); }

  ok('sanity: the cheap scenario really is cheaper', cheaperOut.savings.clusterIsCheaper === true, cheaperOut.savings.monthly);
  ok('sanity: the dear scenario really is not', dearerOut.savings.clusterIsCheaper === false, dearerOut.savings.monthly);

  const detailed = await P.buildDetailedPdf({ state: cheaper, result: cheaperOut, options: {} });
  const detailedText = textOf(detailed);

  ok('client PDF is a valid PDF', client.slice(0, 5).toString() === '%PDF-', client.slice(0, 8).toString());
  ok('detailed PDF is a valid PDF', detailed.slice(0, 5).toString() === '%PDF-');

  // ---- the client document carries what it should.
  ok('client shows the merchant', has(clientText, 'COMMERCE EXEMPLE'), clientText.slice(0, 200));
  ok('client shows the salesperson', has(clientText, 'David'));
  ok('client shows the volume table', has(clientText, 'Visa') && has(clientText, 'Mastercard'));
  ok('client shows a pre-tax total', has(clientText, 'Total avant taxes'));
  ok('client shows the free-text note', has(clientText, 'Merci de votre confiance'));

  // ---------------------------------------------------------------------------
  // ⚠️ THE ONE THAT MATTERS. §6 records taxes-excluded-from-the-client-PDF as a deliberate
  // design decision, not an oversight. The tax IS computed and sits right there in the
  // result, so nothing but this assertion stops it appearing the next time someone edits
  // the layout.
  // ---------------------------------------------------------------------------
  const clientRuns = runsOf(client).map(norm);
  ok('client PDF has no "Taxes" row label',
    !clientRuns.includes('TAXES'), clientRuns.filter((r) => r.includes('TAX')));
  const taxFigure = cheaperOut.current.tax.toFixed(2).replace('.', ',');
  const grandFigure = cheaperOut.current.grand.toFixed(2).replace('.', ',');
  ok('client PDF shows no tax FIGURE either', !clientText.includes(taxFigure), taxFigure);
  ok('client PDF shows no grand total', !clientText.includes(grandFigure), grandFigure);

  // The client document is not an internal one either.
  ok('client PDF has no margin panel', !has(clientText, 'Rentabilite interne'));
  ok('client PDF has no audit table', !has(clientText, 'Verification ligne par ligne'));
  ok('client PDF has no internal-use warning', !has(clientText, 'USAGE INTERNE'));

  // ---------------------------------------------------------------------------
  // The savings hero appears ONLY when Cluster is genuinely cheaper — a red or zero savings
  // claim on a client document is worse than omitting the section.
  // ---------------------------------------------------------------------------
  ok('hero shown when cheaper', has(clientText, 'Economies par mois'), clientText.slice(0, 300));

  const noSave = await P.buildClientPdf({ state: dearer, result: dearerOut, options: {} });
  const noSaveText = textOf(noSave);
  ok('no-savings document still extracts', noSaveText.length > 200, noSaveText.length);
  ok('hero HIDDEN when not cheaper', !has(noSaveText, 'Economies par mois'), noSaveText.slice(0, 300));
  ok('and it says so plainly instead', has(noSaveText, 'Aucune economie'), noSaveText.slice(0, 400));

  // ---- the detailed document carries everything the client one omits.
  ok('detailed HAS the "Taxes" row label',
    runsOf(detailed).map(norm).includes('TAXES'), runsOf(detailed).map(norm).filter((r) => r.includes('TAX')));
  ok('detailed shows the audit', has(detailedText, 'Verification ligne par ligne'));
  ok('detailed shows the internal-use warning', has(detailedText, 'USAGE INTERNE'));
  ok('detailed lists a real audit row', has(detailedText, 'TAX REIMBURSEMENT CH'), detailedText.slice(0, 600));
  ok('detailed flags the SUSPECT row', has(detailedText, 'SUSPECT'));
  ok('detailed carries the parser notes', has(detailedText, 'sommaire de facturation'));
  ok('detailed shows the margin panel', has(detailedText, 'Rentabilite interne'));

  // ---- English renders too, or half the clients get a French document.
  const en = await P.buildClientPdf({ state: cheaper, result: cheaperOut, options: { lang: 'en' } });
  const enText = textOf(en);
  ok('English client PDF renders', has(enText, 'Monthly savings'), enText.slice(0, 300));
  ok('English PDF shows its pre-tax total', has(enText, 'Total before tax'));
  // Checked on the FIGURE rather than the word: "Total before tax" legitimately contains
  // "tax", so a word test would either false-positive or need a fragile carve-out.
  ok('English PDF still hides the tax figure',
    !enText.includes(N.fmtMoney(cheaperOut.current.tax, 'en')), N.fmtMoney(cheaperOut.current.tax, 'en'));
  ok('English PDF hides the grand total too',
    !enText.includes(N.fmtMoney(cheaperOut.current.grand, 'en')), N.fmtMoney(cheaperOut.current.grand, 'en'));

  // ---- filenames.
  const d = new Date('2026-09-18T12:00:00');
  const f = P.pdfFilename({ merchantName: 'LE COMMERCE EXEMPLE', date: d, salesperson: 'David' });
  ok('filename pattern', f === 'LE COMMERCE EXEMPLE - 2026-09-18 - David.pdf', f);
  const fd = P.pdfFilename({ merchantName: 'LE COMMERCE EXEMPLE', date: d, detailed: true });
  ok('detailed filename gets its own suffix', /\(d.taill.\)\.pdf$/.test(fd), fd);
  ok('the two filenames cannot collide', f !== fd);

  // ⚠️ The merchant name is typed freely and ends up on a filesystem.
  ok('illegal characters stripped', P.sanitizeName('A/B:C*D?E"F<G>H|I') === 'ABCDEFGHI', P.sanitizeName('A/B:C*D?E"F<G>H|I'));
  ok('whitespace collapsed', P.sanitizeName('  A   B  ') === 'A B', JSON.stringify(P.sanitizeName('  A   B  ')));
  ok('length capped', P.sanitizeName('x'.repeat(200)).length === 80, P.sanitizeName('x'.repeat(200)).length);
  ok('a blank name still yields a filename', /^Marchand - /.test(P.pdfFilename({ merchantName: '', date: d })),
    P.pdfFilename({ merchantName: '', date: d }));

  console.log(fail ? `\n${fail} FAILING` : '\nall green');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
