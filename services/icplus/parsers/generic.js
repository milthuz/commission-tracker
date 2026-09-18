// ============================================================================
// Generic keyword fallback (§4) — for any statement that matches no known format.
//
// ⚠️ This parser deliberately produces NO line_audit. Classifying an unknown layout's rows
// against the rate tables would mean guessing which column is a rate and which is a
// volume, and a wrong guess here surfaces as a confident "SUSPECT" or "Conforme" on a
// document a rep hands to a client. Admitting that nothing could be classified is the
// better failure: the UI falls back to manual entry, with these totals as a starting point.
// ============================================================================

const { foldPunct, trailingAmount } = require('./util');
const N = require('../notes');

const NAME = 'Format non reconnu';

const BUCKETS = [
  ['markup',      /discount|escompte|markup|majoration/i],
  ['interchange', /interchange|assessment|évaluation|evaluation|network|réseau|reseau|asmts?\b|acquirer|switch|commutation|interac/i],
  ['fixed',       /terminal|pci|batch|lot|statement|relevé|releve|account|compte|monthly|mensuel|rental|location|portal|portail|gateway/i],
];

function parse(lines) {
  const totals = { markup: 0, interchange: 0, fixed: 0, unclassified: 0 };
  const unclassified = [];
  let matched = 0;

  for (const raw of lines || []) {
    const line = foldPunct(raw);
    const amount = trailingAmount(line);
    if (!Number.isFinite(amount) || amount === 0) continue;

    const bucket = BUCKETS.find(([, re]) => re.test(line));
    if (bucket) {
      totals[bucket[0]] += Math.abs(amount);
      matched++;
      continue;
    }
    // Carries money or a percentage but matched no keyword — surfaced for review rather
    // than silently dropped or silently bucketed.
    if (/%|\$/.test(line)) {
      totals.unclassified += Math.abs(amount);
      unclassified.push({ label: line.replace(/\s*-?\(?\$?[\d,. ]+\)?\s*\$?$/, '').trim(), total: Math.abs(amount) });
      matched++;
    }
  }

  // Nothing at all matched: say so with a null rather than returning a shape full of zeros
  // that reads like a successful parse of an empty statement.
  if (!matched) return null;

  const genericNotes = [
    N.note('genericFormat'),
    N.note('genericTotals', { markup: totals.markup, interchange: totals.interchange, fixed: totals.fixed }),
    ...(unclassified.length ? [N.note('genericUnclassified', { count: unclassified.length, amount: totals.unclassified })] : []),
    N.note('genericNoAudit'),
  ];

  return {
    current_processor: {
      name: NAME,
      debit_rate: 0, debit_fee: 0, visa_rate: 0, visa_fee: 0,
      mc_rate: 0, mc_fee: 0, amex_rate: 0, amex_fee: 0,
      interchange: round2(totals.interchange),
      markup_total: round2(totals.markup),
      fixed_rows: [],
      unclassified,
    },
    volume: {
      debit_count: 0, debit_amt: 0, visa_count: 0, visa_amt: 0,
      mc_count: 0, mc_amt: 0, amex_count: 0, amex_amt: 0,
    },
    merchant_name: null,
    // No per-line classification is attempted — see the header.
    line_audit: { interchange: [], brand: [], interac: [] },
    notes: genericNotes,
    _note: N.renderAll(genericNotes, 'fr'),
  };
}

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const fmt = (v) => round2(v).toFixed(2).replace('.', ',');

module.exports = { NAME, parse };
