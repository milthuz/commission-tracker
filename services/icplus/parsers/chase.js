// ============================================================================
// Chase / Paymentech (§4).
//
// ⚠️ NOT YET VERIFIED AGAINST A REAL STATEMENT. Global and Clover were each reconciled to
// the cent against real paper; no Chase statement was available. The fixture covers every
// quirk §4 documents, but the section wording is the most likely thing to need correcting.
//
// Structurally this is the odd one out. The other six processors have FLAT sections; Chase
// nests them: a BRAND header (VISA / MASTERCARD / AMERICAN EXPRESS / INTERAC), and under it
// either "Interchange Fees" or "Fees and Assessments". So a row's meaning depends on the
// pair of headers above it, not on one.
//
// ⚠️ AND CHASE IS ALREADY INTERCHANGE-PLUS. §4: "every dollar charged is either real
// interchange or a real network assessment, both already itemized." So debit/Visa/MC markup
// is genuinely $0 — that is the correct answer, not a parsing failure, and the parser says
// so in a note rather than leaving a rep to wonder. Only Amex carries a markup figure.
// ============================================================================

const { parseNum, foldPunct, headerKey, trailingNumbers } = require('./util');
const {
  classifyInterchangeLine, classifyBrandLine, classifyInteracLine,
  buildLineAudit, STATUS,
} = require('../classify');
const N = require('../notes');

const NAME = 'Chase / Paymentech';

// The brand headers that open a block.
const BRAND_HEADERS = [
  { key: 'visa',    re: /^(VISA)$/i },
  { key: 'mc',      re: /^(MASTERCARD|MASTER ?CARD)$/i },
  { key: 'amex',    re: /^(AMERICAN EXPRESS|AMEX)$/i },
  { key: 'interac', re: /^(INTERAC)$/i },
  { key: 'discover',re: /^(DISCOVER)$/i },
];

// The sub-headers that can follow a brand header.
//
// ⚠️ Amex's section is labelled just "Fees", NOT "Interchange Fees", and the difference is
// not cosmetic: per Chase's own cover-page notice this is Amex's WHOLESALE DISCOUNT RATE,
// not interchange. It therefore routes to the Amex markup fields rather than into the
// pass-through interchange audit — putting it in interchange would both overstate Chase's
// pass-through and understate its markup.
const SUB_HEADERS = [
  { kind: 'interchange', re: /^INTERCHANGE FEES?$/i },
  { kind: 'assessment',  re: /^FEES AND ASSESSMENTS$/i },
  { kind: 'discount',    re: /^FEES$/i },
];

const CARD_SUMMARY = /^CARD TYPE SUMMARY$/i;

const NOISE = [
  /^Page\b/i, /^Chase\b/i, /^Merchant (No|Number|Name)/i,
  /^Description\b/i, /^Total\b/i, /^Item\b/i, /^Rate\b/i, /^Amount\b/i,
  /^Sales\b/i, /^Count\b/i, /^Volume\b/i,
];

function detect(lines) {
  const text = lines.map(foldPunct).join('\n');
  return /chase\.ca/i.test(text) || /Chase\s*Paymentech/i.test(text);
}

// ---------------------------------------------------------------------------
// ⚠️ Chase glues the brand prefix straight onto the interchange code with no space on some
// rows ("MCCANITRACTRYCONCRCNTCLCOR"). Downstream classification keys on prefix word
// boundaries, so without a space inserted the row matches nothing and the brand guard
// cannot tell which network it belongs to.
//
// Deliberately narrow: only a run with NO spaces at all, long enough to be a code rather
// than a word, and starting with a known prefix. "MASTERCARD" must not become "MA STERCARD",
// and an ordinary description with spaces is left alone.
// ---------------------------------------------------------------------------
const GLUED_CODE = /^(MC|VS|VI|AX|DS)([A-Z0-9]{6,})$/;

function ungleuCode(label) {
  const t = foldPunct(label);
  if (/\s/.test(t)) return t;
  const m = t.match(GLUED_CODE);
  return m ? `${m[1]} ${m[2]}` : t;
}

function parse(lines) {
  const L = lines.map(foldPunct);
  const notes = [];

  const { blocks, cardSummary } = split(L);
  const vol = parseCardSummary(cardSummary);

  const interchangeItems = [];
  const brandItems = [];
  const interacItems = [];
  const amexDiscountRows = [];

  for (const b of blocks) {
    for (const row of b.rows) {
      const item = { ...row, desc: ungleuCode(row.desc), label: ungleuCode(row.desc), brand: b.brand };

      // Amex's "Fees" block is a wholesale discount, i.e. markup — never interchange.
      if (b.kind === 'discount' && b.brand === 'amex') { amexDiscountRows.push(item); continue; }

      if (b.brand === 'interac') { interacItems.push(item); continue; }
      if (b.kind === 'assessment') { brandItems.push(item); continue; }
      interchangeItems.push(item);
    }
  }

  // ---- markup.
  //
  // ⚠️ debit / Visa / MC are genuinely ZERO on this processor, not missing. Chase itemizes
  // every dollar as either real interchange or a real network assessment, so there is no
  // markup left to find. Reported as a note so a zero does not read as a failed parse.
  const amexRates = weighted(amexDiscountRows);
  const rates = {
    debit: { pct: 0, perItem: 0 },
    visa:  { pct: 0, perItem: 0 },
    mc:    { pct: 0, perItem: 0 },
    amex:  amexRates,
  };

  const line_audit = {
    interchange: buildLineAudit(interchangeItems, classifyInterchangeLine, { processor: 'chase' }),
    brand:       buildLineAudit(brandItems, classifyBrandLine, { processor: 'chase' }),
    interac:     buildLineAudit(interacItems, classifyInteracLine, { processor: 'chase' }),
  };

  const interchange = [...interchangeItems, ...brandItems, ...interacItems].reduce((s, r) => s + r.total, 0);

  notes.push(N.note('chaseAlreadyInterchangePlus'));
  if (amexDiscountRows.length) notes.push(N.note('chaseAmexIsDiscount', { rate: amexRates.pct }));

  const suspects = [...line_audit.interchange, ...line_audit.brand, ...line_audit.interac]
    .filter((r) => r.status === STATUS.SUSPECT);
  if (suspects.length) notes.push(N.note('suspectRows', { count: suspects.length, labels: suspects.map((s) => s.desc) }));

  const allNotes = [N.note('formatDetected', { processor: NAME, layoutSuffix: '' }), ...notes];

  return {
    current_processor: {
      name: NAME,
      debit_rate: 0, debit_fee: 0,
      visa_rate: 0,  visa_fee: 0,
      mc_rate: 0,    mc_fee: 0,
      amex_rate: rates.amex.pct, amex_fee: rates.amex.perItem,
      interchange: round2(interchange),
      fixed_rows: [],
    },
    volume: vol,
    merchant_name: findMerchantName(L),
    line_audit,
    notes: allNotes,
    _note: N.renderAll(allNotes, 'en'),
  };
}

// ---------------------------------------------------------------------------
// Split into brand blocks.
//
// ⚠️ A brand header closes the previous block AND opens a new one, and a sub-header closes
// only the rows of the previous sub-block. §4's boundary rule applies twice over here
// because the nesting means a missed boundary mislabels rows under the WRONG brand, not
// merely the wrong category.
// ---------------------------------------------------------------------------
function split(lines) {
  const blocks = [];
  const cardSummary = [];
  let brand = null;
  let kind = null;
  let inSummary = false;

  for (const raw of lines) {
    const s = foldPunct(raw);

    if (CARD_SUMMARY.test(s)) { inSummary = true; brand = null; kind = null; continue; }

    const bh = BRAND_HEADERS.find((h) => h.re.test(s));
    if (bh) { brand = bh.key; kind = null; inSummary = false; continue; }

    const sh = SUB_HEADERS.find((h) => h.re.test(s));
    if (sh && brand) { kind = sh.kind; inSummary = false; continue; }

    if (inSummary) { if (!NOISE.some((re) => re.test(s))) cardSummary.push(s); continue; }
    if (!brand || !kind) continue;
    if (NOISE.some((re) => re.test(s))) continue;

    const row = parseRow(s);
    if (!row) continue;

    let block = blocks.find((b) => b.brand === brand && b.kind === kind);
    if (!block) { block = { brand, kind, rows: [] }; blocks.push(block); }
    block.rows.push(row);
  }
  return { blocks, cardSummary };
}

// A row carries a description then, depending on the block, either
//   count volume rate amount            (interchange)
// or
//   count volume rate perItem amount    (assessments and Amex's discount — dual columns)
function parseRow(s) {
  const five = trailingNumbers(s, 5);
  if (five) {
    const [count, volume, rate, perItem, total] = five.nums;
    return { desc: five.label, count, volume, rate: rate / 100, perItem, total: Math.abs(total) };
  }
  const four = trailingNumbers(s, 4);
  if (four) {
    const [count, volume, rate, total] = four.nums;
    return { desc: four.label, count, volume, rate: rate / 100, perItem: null, total: Math.abs(total) };
  }
  const three = trailingNumbers(s, 3);
  if (three) {
    const [count, volume, total] = three.nums;
    return { desc: three.label, count, volume, rate: volume > 0 ? Math.abs(total) / volume : null, perItem: null, total: Math.abs(total) };
  }
  return null;
}

// Card Type Summary: "<brand> <count> <volume>".
function parseCardSummary(lines) {
  const out = {
    debit_count: 0, debit_amt: 0, visa_count: 0, visa_amt: 0,
    mc_count: 0, mc_amt: 0, amex_count: 0, amex_amt: 0,
  };
  for (const raw of lines || []) {
    const t = trailingNumbers(raw, 2);
    if (!t) continue;
    const k = headerKey(t.label);
    const [count, amt] = t.nums;
    if (/^(INTERAC|DEBIT)/.test(k))            { out.debit_count += count; out.debit_amt += amt; }
    else if (/^(VISA|VS)/.test(k))             { out.visa_count += count;  out.visa_amt += amt; }
    else if (/^(MASTERCARD|MASTER CARD|MC)/.test(k)) { out.mc_count += count; out.mc_amt += amt; }
    else if (/^(AMERICAN EXPRESS|AMEX|AX)/.test(k))  { out.amex_count += count; out.amex_amt += amt; }
    // Discover has no field of its own; it folds into the Amex bucket, as on Clover.
    else if (/^(DISCOVER|DS)/.test(k))         { out.amex_count += count; out.amex_amt += amt; }
  }
  return out;
}

// % weighted by volume, $/item weighted by count — the two components never merged.
function weighted(rows) {
  let vr = 0, v = 0, cf = 0, c = 0;
  for (const r of rows) {
    vr += (r.volume || 0) * (r.rate || 0);
    v  += (r.volume || 0);
    cf += (r.count || 0) * (r.perItem || 0);
    c  += (r.count || 0);
  }
  return { pct: v > 0 ? vr / v : 0, perItem: c > 0 ? cf / c : 0 };
}

function findMerchantName(lines) {
  for (const l of lines) {
    const m = foldPunct(l).match(/^(Merchant Name|Nom du marchand|DBA)\s*:?\s*(.+)$/i);
    if (m && m[2].trim()) return m[2].trim();
  }
  return null;
}

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

module.exports = { NAME, detect, parse, ungleuCode, parseRow, parseCardSummary, split };
