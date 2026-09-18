// ============================================================================
// IC+ fee-comparison calculator — the calculation engine (§5 of the scope).
//
// Pure functions, no I/O, no DB. The API layer seeds a parsed statement through
// populate(), then calls recalc() on every edit; the PDF exporters read the result
// rather than recomputing anything of their own.
//
// ⚠️ THE SUSPECT ASYMMETRY — the single easiest thing in this file to get subtly wrong,
// and the reason §9 calls it out separately. A SUSPECT line is counted ONCE, in its own
// section's total, because the merchant really was charged those dollars. The duplicate
// copy in `hiddenBumps` is informational only. From there the two sides treat it
// DIFFERENTLY, on purpose:
//
//   current side  — hidden bumps are EXCLUDED from the pretax total. Their dollars are
//                   already inside markup / interchange / fixed; adding them again would
//                   double-count. They are displayed, never summed into the total.
//   Cluster side  — the suspect subtotal is SUBTRACTED from Cluster's own interchange, so
//                   Cluster passes through the real network cost only and never inherits a
//                   fabricated charge that the current processor invented.
//
// Excluded from one total, subtracted from another. If someone later "simplifies" these
// into one shared treatment, the comparison silently stops being true.
// ============================================================================

const { STATUS } = require('./classify');

// Québec: GST 5 % + QST 9.975 %. Configurable because the tool is used outside QC, but
// this is the default the original model was built against.
const DEFAULT_TAX_MULTIPLIER = 1.14975;

// The flat blended interchange guess of last resort (§5, priority 3). Only ever used when
// a statement itemized NOTHING, and always surfaced tagged as an estimate — an earlier
// version applied a guess like this to a statement that did disclose a breakdown and
// produced a figure more than double the entire actual invoice.
const FLAT_INTERCHANGE_FALLBACK = 0.0165;

// The four brands the model carries. Discover has no field of its own: its volume and
// markup fold into Visa throughout, which every parser note must state explicitly.
const BRANDS = ['debit', 'visa', 'mc', 'amex'];

// The six standard fixed-fee rows.
const FIXED_KEYS = ['terminalWireless', 'terminalWired', 'pci', 'account', 'batch', 'statement'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

// One brand's fee: volume × rate% + count × per-item fee. The two components never get
// blended into a single "effective %" — see the weighted-average note in the Moneris
// parser for why that reproduces the right dollar total while matching neither number
// actually printed on the statement.
function part(volume, count, rate) {
  return num(volume) * num(rate && rate.pct) + num(count) * num(rate && rate.perItem);
}

function emptyRates() {
  const o = {};
  for (const b of BRANDS) o[b] = { pct: 0, perItem: 0 };
  return o;
}

function emptyFixed() {
  const o = {};
  for (const k of FIXED_KEYS) o[k] = { qty: 0, unit: 0 };
  return o;
}

// ---------------------------------------------------------------------------
// populate — seed a parsed statement into the comparison (§5.1)
// ---------------------------------------------------------------------------

// `parsed` is whatever a processor parser (or the JSON-paste fallback) returned: the
// shared shape from §1. Everything it does not carry is written as an explicit zero, NOT
// left alone — a fresh import with no activity in some brand must actively clear whatever
// a previous import left behind, or the rep silently compares a mix of two statements.
function populate(parsed, opts = {}) {
  const p = parsed || {};
  const cp = p.current_processor || {};
  const v = p.volume || {};
  const audit = p.line_audit || {};

  const state = {
    // Always overwritten, blank when nothing was detected — never left stale.
    merchantName: p.merchant_name || '',
    processor: cp.name || p.processor || null,
    salesperson: opts.salesperson || '',

    volume: {
      debit_count: num(v.debit_count), debit_amt: num(v.debit_amt),
      visa_count:  num(v.visa_count),  visa_amt:  num(v.visa_amt),
      mc_count:    num(v.mc_count),    mc_amt:    num(v.mc_amt),
      amex_count:  num(v.amex_count),  amex_amt:  num(v.amex_amt),
    },

    current: {
      rates: {
        debit: { pct: num(cp.debit_rate), perItem: num(cp.debit_fee) },
        visa:  { pct: num(cp.visa_rate),  perItem: num(cp.visa_fee)  },
        mc:    { pct: num(cp.mc_rate),    perItem: num(cp.mc_fee)    },
        amex:  { pct: num(cp.amex_rate),  perItem: num(cp.amex_fee)  },
      },
      interchange: num(cp.interchange),
      fixed: seedFixed(cp),
      // Equipment and other-fee rows keep their own labels rather than being bucketed into
      // the six standard rows: a rep comparing against the statement needs to see
      // "LOCATION TERMINAL MOVE5000", not an anonymous "terminal" line.
      extraFixed: (cp.fixed_rows || []).map((r) => ({
        label: r.label,
        qty: num(r.qty) || 1,
        unit: num(r.unit != null ? r.unit : r.amount),
      })),
      hiddenBumps: [],
    },

    cluster: {
      rates: opts.clusterRates ? mergeRates(opts.clusterRates) : emptyRates(),
      // Recomputed by recalc() unless an estimate mode put a manual value here.
      interchange: 0,
      interchangeOverride: false,
      interchangeNote: null,
      fixed: opts.clusterFixed ? mergeFixed(opts.clusterFixed) : emptyFixed(),
      extraFixed: [],
    },

    tax: { multiplier: num(opts.taxMultiplier) || DEFAULT_TAX_MULTIPLIER },

    lineAudit: {
      interchange: audit.interchange || [],
      brand:       audit.brand || [],
      interac:     audit.interac || [],
    },

    notes: p._note ? [p._note] : [],
    volumeNote: cp.volume_note || null,
  };

  // Terminal counts mirror to the Cluster side — the merchant keeps the same hardware
  // footprint, so the comparison is quantity-for-quantity by default.
  state.cluster.fixed.terminalWireless.qty = state.current.fixed.terminalWireless.qty;
  state.cluster.fixed.terminalWired.qty    = state.current.fixed.terminalWired.qty;

  // Rebuild the hidden-bump rows from the parsed audit: every SUSPECT row, in any of the
  // three buckets, gets its informational duplicate here.
  state.current.hiddenBumps = collectHiddenBumps(state.lineAudit);

  seedClusterInterchange(state);
  return state;
}

function seedFixed(cp) {
  const f = emptyFixed();
  f.terminalWireless = { qty: num(cp.terminal_wireless_qty), unit: num(cp.terminal_wireless_unit) };
  f.terminalWired    = { qty: num(cp.terminal_wired_qty),    unit: num(cp.terminal_wired_unit) };
  f.pci              = { qty: num(cp.pci_qty) || (cp.pci ? 1 : 0),             unit: num(cp.pci) };
  f.account          = { qty: num(cp.account_qty) || (cp.account ? 1 : 0),     unit: num(cp.account) };
  f.batch            = { qty: num(cp.batch_qty) || (cp.batch ? 1 : 0),         unit: num(cp.batch) };
  f.statement        = { qty: num(cp.statement_qty) || (cp.statement ? 1 : 0), unit: num(cp.statement) };
  return f;
}

function mergeRates(src) {
  const o = emptyRates();
  for (const b of BRANDS) if (src[b]) o[b] = { pct: num(src[b].pct), perItem: num(src[b].perItem) };
  return o;
}

function mergeFixed(src) {
  const o = emptyFixed();
  for (const k of FIXED_KEYS) if (src[k]) o[k] = { qty: num(src[k].qty), unit: num(src[k].unit) };
  return o;
}

function allAuditRows(lineAudit) {
  return [...(lineAudit.interchange || []), ...(lineAudit.brand || []), ...(lineAudit.interac || [])];
}

// The duplicate, informational-only copies. The originals stay where they are.
function collectHiddenBumps(lineAudit) {
  return allAuditRows(lineAudit)
    .filter((r) => r.status === STATUS.SUSPECT)
    .map((r) => ({
      label: `${r.desc} — déjà inclus ci-dessus`,
      desc: r.desc,
      total: num(r.total),
      suspect: true,
      informationalOnly: true,
    }));
}

// Cluster IC+ interchange seeding — the 3-tier priority from §5.4.
function seedClusterInterchange(state) {
  const rows = allAuditRows(state.lineAudit);
  const estimated = rows.filter((r) => r.status === STATUS.ESTIME);
  const itemized  = rows.filter((r) => r.status !== STATUS.ESTIME);

  // Priority 1 — estimate mode. The parser could not see an itemized interchange section
  // and derived a per-tier estimate from what the statement DID disclose. `theoretical` is
  // what Cluster would charge; the rows themselves were never billed (total: 0).
  if (estimated.length) {
    const theoretical = estimated.reduce((s, r) => s + num(r.theoretical), 0);
    const suspect = suspectBumpTotal(state.current.hiddenBumps);
    state.cluster.interchange = r2(num(state.current.interchange) + theoretical - suspect);
    state.cluster.interchangeOverride = true;
    state.cluster.interchangeNote = 'estimate';
    return;
  }

  // Priority 2 — pass-through. Left to recalc(), which recomputes it live as
  // pass-through minus the suspect subtotal on every edit.
  if (itemized.length) {
    state.cluster.interchangeOverride = false;
    state.cluster.interchangeNote = 'passthrough';
    return;
  }

  // Priority 3 — nothing was itemized at all. Flat fallback, tagged as such so nobody
  // mistakes it for a reading of the statement.
  const cardVolume = num(state.volume.visa_amt) + num(state.volume.mc_amt) + num(state.volume.amex_amt);
  state.cluster.interchange = r2(cardVolume * FLAT_INTERCHANGE_FALLBACK);
  state.cluster.interchangeOverride = true;
  state.cluster.interchangeNote = 'flat';
}

// Only the bumps whose label marks them suspect feed the Cluster-side subtraction.
function suspectBumpTotal(hiddenBumps) {
  return (hiddenBumps || []).filter((b) => b.suspect).reduce((s, b) => s + num(b.total), 0);
}

// ---------------------------------------------------------------------------
// recalc (§5.2–5.4)
// ---------------------------------------------------------------------------

function recalc(state) {
  const v = state.volume;
  const vol = {
    debit: { amt: num(v.debit_amt), count: num(v.debit_count) },
    visa:  { amt: num(v.visa_amt),  count: num(v.visa_count)  },
    mc:    { amt: num(v.mc_amt),    count: num(v.mc_count)    },
    amex:  { amt: num(v.amex_amt),  count: num(v.amex_count)  },
  };
  const cardVolume  = vol.visa.amt + vol.mc.amt + vol.amex.amt;
  const totalVolume = cardVolume + vol.debit.amt;
  const totalCount  = vol.debit.count + vol.visa.count + vol.mc.count + vol.amex.count;

  // ---- current processor
  const curMarkup = BRANDS.reduce((s, b) => s + part(vol[b].amt, vol[b].count, state.current.rates[b]), 0);
  const curInterchange = num(state.current.interchange);
  const curFixed = fixedTotal(state.current);
  const hiddenBumpTotal = (state.current.hiddenBumps || []).reduce((s, b) => s + num(b.total), 0);
  const suspectBumps = suspectBumpTotal(state.current.hiddenBumps);

  // ⚠️ hiddenBumpTotal is deliberately NOT part of this sum. See the header.
  const curPretax = curMarkup + curInterchange + curFixed;
  const curTax    = curPretax * (num(state.tax.multiplier) - 1);

  // ---- Cluster IC+
  const cluMarkup = BRANDS.reduce((s, b) => s + part(vol[b].amt, vol[b].count, state.cluster.rates[b]), 0);
  // ⚠️ and here it IS subtracted. Cluster passes through the real network cost only.
  const cluInterchange = state.cluster.interchangeOverride
    ? num(state.cluster.interchange)
    : curInterchange - suspectBumps;
  const cluFixed  = fixedTotal(state.cluster);
  const cluPretax = cluMarkup + cluInterchange + cluFixed;
  const cluTax    = cluPretax * (num(state.tax.multiplier) - 1);

  const curGrand = curPretax + curTax;
  const cluGrand = cluPretax + cluTax;

  // Negative means Cluster is cheaper — the expected normal case.
  const diff = cluGrand - curGrand;

  return {
    volume: { ...vol, cardVolume: r2(cardVolume), totalVolume: r2(totalVolume), totalCount },

    current: {
      markup: r2(curMarkup),
      interchange: r2(curInterchange),
      // Informational only. The true qualifying category cannot be derived from a
      // statement total, so this is never auto-flagged as high or low.
      effectiveBlendedRate: cardVolume > 0 ? (curInterchange / cardVolume) * 100 : null,
      fixed: r2(curFixed),
      hiddenBumps: r2(hiddenBumpTotal),
      suspectBumps: r2(suspectBumps),
      pretax: r2(curPretax),
      tax: r2(curTax),
      grand: r2(curGrand),
    },

    cluster: {
      markup: r2(cluMarkup),
      interchange: r2(cluInterchange),
      interchangeMode: state.cluster.interchangeOverride ? (state.cluster.interchangeNote || 'override') : 'passthrough',
      fixed: r2(cluFixed),
      pretax: r2(cluPretax),
      tax: r2(cluTax),
      grand: r2(cluGrand),
    },

    savings: {
      monthly: r2(diff),
      annual: r2(diff * 12),
      clusterIsCheaper: diff < 0,
      breakdown: {
        markup: r2(cluMarkup - curMarkup),
        fixed: r2(cluFixed - curFixed),
        hiddenBumps: r2(-hiddenBumpTotal),
      },
    },

    margin: recalcMargin(state, { totalVolume, totalCount }),
  };
}

function fixedTotal(side) {
  let t = 0;
  for (const k of FIXED_KEYS) t += num(side.fixed[k].qty) * num(side.fixed[k].unit);
  for (const row of side.extraFixed || []) t += num(row.qty || 1) * num(row.unit != null ? row.unit : row.amount);
  return t;
}

// ---------------------------------------------------------------------------
// recalcMargin (§5.5) — internal profitability, purely additive
//
// Does not feed back into either comparison panel. What Cluster bills the merchant, less
// what those same components cost Cluster.
//
// ⚠️ revenue % divides by TOTAL dollar volume, not by each row's own basis. That matches
// the internal Excel margin model this replaces and must be replicated exactly, not
// "corrected" — a rep comparing this screen against the Excel has to see the same numbers.
// ---------------------------------------------------------------------------
function recalcMargin(state, totals) {
  const cost = state.clusterCost || {};
  const totalVolume = num(totals.totalVolume);
  const totalCount  = num(totals.totalCount);

  const rows = [];
  const add = (key, billed, costAmt) => {
    const revenue = num(billed) - num(costAmt);
    rows.push({
      key,
      billed: r2(billed),
      cost: r2(costAmt),
      revenue: r2(revenue),
      revenuePct: totalVolume > 0 ? (revenue / totalVolume) * 100 : null,
    });
  };

  const billedPerTxn = BRANDS.reduce((s, b) => {
    const amt = num(state.volume[`${b}_count`]);
    return s + amt * num(state.cluster.rates[b].perItem);
  }, 0);
  const billedPct = BRANDS.reduce((s, b) => {
    const amt = num(state.volume[`${b}_amt`]);
    return s + amt * num(state.cluster.rates[b].pct);
  }, 0);

  add('transactionFee', billedPerTxn, totalCount * num(cost.perTxn));
  add('discountPct',    billedPct,    totalVolume * num(cost.discountPct));
  // T+1 is currently always absorbed — billed at $0, with its cost still shown, so the
  // margin panel tells the truth about what absorbing it costs.
  add('t1',             0,            totalVolume * num(cost.t1Pct));
  add('fixed',
    num(state.cluster.fixed.pci.qty) * num(state.cluster.fixed.pci.unit)
      + num(state.cluster.fixed.account.qty) * num(state.cluster.fixed.account.unit)
      + num(state.cluster.fixed.batch.qty) * num(state.cluster.fixed.batch.unit)
      + num(state.cluster.fixed.statement.qty) * num(state.cluster.fixed.statement.unit),
    num(cost.fixed));
  add('terminalWireless',
    num(state.cluster.fixed.terminalWireless.qty) * num(state.cluster.fixed.terminalWireless.unit),
    num(state.cluster.fixed.terminalWireless.qty) * num(cost.terminalWireless));
  add('terminalWired',
    num(state.cluster.fixed.terminalWired.qty) * num(state.cluster.fixed.terminalWired.unit),
    num(state.cluster.fixed.terminalWired.qty) * num(cost.terminalWired));

  const revenue = rows.reduce((s, r) => s + num(r.revenue), 0);
  return {
    rows,
    totalBilled: r2(rows.reduce((s, r) => s + num(r.billed), 0)),
    totalCost:   r2(rows.reduce((s, r) => s + num(r.cost), 0)),
    revenue:     r2(revenue),
    revenuePct:  totalVolume > 0 ? (revenue / totalVolume) * 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Audit table totals (§5, "Audit table rendering")
//
// Theoretical and delta are summed ONLY across rows that actually carry a verified rate —
// summing over unmatched rows would produce a total that looks authoritative and means
// nothing.
// ---------------------------------------------------------------------------
function auditTotals(rows) {
  const verified = (rows || []).filter((r) => Number.isFinite(r.theoretical));
  const suspects = (rows || []).filter((r) => r.status === STATUS.SUSPECT);
  const suspectTotal = suspects.reduce((s, r) => s + num(r.total), 0);
  return {
    count: (rows || []).length,
    verifiedCount: verified.length,
    total: r2((rows || []).reduce((s, r) => s + num(r.total), 0)),
    theoretical: r2(verified.reduce((s, r) => s + num(r.theoretical), 0)),
    delta: r2(verified.reduce((s, r) => s + num(r.delta), 0)),
    suspectCount: suspects.length,
    suspectTotal: r2(suspectTotal),
    suspectAnnual: r2(suspectTotal * 12),
  };
}

// ---------------------------------------------------------------------------
// Manual rows (§7) — three independently mirrored systems: extra fixed fees on the current
// side, extra fixed fees on the Cluster side, and manually added hidden bumps.
//
// §7 requires that an in-progress edit is never lost when a row is added or removed. In the
// reference tool that means re-reading every live input out of the DOM before touching the
// list, because the DOM is where the edits live. Here the edits live in `state`, so the
// failure mode does not exist: each operation returns a NEW state built from the current
// one, and nothing is read back from a view. Every operation is caller-triggers-recalc —
// they change state only, so the caller re-runs recalc() exactly once afterwards.
// ---------------------------------------------------------------------------

const SIDES = ['current', 'cluster'];

function assertSide(side) {
  if (!SIDES.includes(side)) throw new Error(`unknown side: ${side}`);
}

// Clone just deeply enough that the returned state shares nothing mutable with the old one
// along the path being changed.
function withSide(state, side, mutate) {
  assertSide(side);
  const next = { ...state, [side]: { ...state[side], extraFixed: [...(state[side].extraFixed || [])] } };
  mutate(next[side].extraFixed);
  return next;
}

function addFixedRow(state, side, row = {}) {
  return withSide(state, side, (rows) => rows.push({
    label: String(row.label || ''),
    qty: num(row.qty) || 1,
    unit: num(row.unit),
  }));
}

function updateFixedRow(state, side, index, patch = {}) {
  return withSide(state, side, (rows) => {
    if (index < 0 || index >= rows.length) return;
    rows[index] = { ...rows[index], ...patch };
  });
}

function removeFixedRow(state, side, index) {
  return withSide(state, side, (rows) => {
    if (index < 0 || index >= rows.length) return;
    rows.splice(index, 1);
  });
}

// A manually added bump follows the same convention as a parsed one: it is informational on
// the current side and subtracted from Cluster's interchange when marked suspect. `suspect`
// defaults to true — someone adding a bump by hand is flagging a charge they distrust, and
// defaulting to false would quietly drop it out of the Cluster-side subtraction.
function addHiddenBump(state, row = {}) {
  const next = { ...state, current: { ...state.current, hiddenBumps: [...(state.current.hiddenBumps || [])] } };
  next.current.hiddenBumps.push({
    label: String(row.label || ''),
    desc: String(row.desc || row.label || ''),
    total: num(row.total),
    suspect: row.suspect === undefined ? true : !!row.suspect,
    informationalOnly: true,
    manual: true,
  });
  return next;
}

function updateHiddenBump(state, index, patch = {}) {
  const next = { ...state, current: { ...state.current, hiddenBumps: [...(state.current.hiddenBumps || [])] } };
  if (index < 0 || index >= next.current.hiddenBumps.length) return next;
  next.current.hiddenBumps[index] = { ...next.current.hiddenBumps[index], ...patch };
  return next;
}

function removeHiddenBump(state, index) {
  const next = { ...state, current: { ...state.current, hiddenBumps: [...(state.current.hiddenBumps || [])] } };
  if (index < 0 || index >= next.current.hiddenBumps.length) return next;
  next.current.hiddenBumps.splice(index, 1);
  return next;
}

module.exports = {
  DEFAULT_TAX_MULTIPLIER, FLAT_INTERCHANGE_FALLBACK, BRANDS, FIXED_KEYS, SIDES,
  part, populate, recalc, recalcMargin, auditTotals,
  suspectBumpTotal, collectHiddenBumps,
  addFixedRow, updateFixedRow, removeFixedRow,
  addHiddenBump, updateHiddenBump, removeHiddenBump,
};
