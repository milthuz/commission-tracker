// ============================================================================
// Payfacto (§4).
//
// ⚠️ NOT YET VERIFIED AGAINST A REAL STATEMENT. Global and Clover were each reconciled to
// the cent against real paper; no Payfacto statement was available.
//
// ⚠️ AND THE SPEC ITSELF IS THIN HERE. §4 gives Payfacto two sentences: the sections are
// found by the "Sommaire des ventes" / "Sommaire des frais" headers, and Interac Flash
// tiers can be written in Roman numerals. Everything else below — row shapes, how a fee row
// is routed, where the markup lives — follows the patterns the VERIFIED parsers established
// (Global's Escompte split in particular) rather than anything §4 states about Payfacto.
// So treat the two documented facts as solid and the rest as a reasonable first draft to be
// corrected against real paper.
// ============================================================================

const { parseNum, foldPunct, headerKey, trailingNumbers } = require('./util');
const {
  classifyInterchangeLine, classifyBrandLine, classifyInteracLine,
  buildLineAudit, interacTier, STATUS,
} = require('../classify');
const N = require('../notes');

const NAME = 'Payfacto';

// The two headers §4 actually names, plus their English forms.
const SECTIONS = {
  sales: ['Sommaire des ventes', 'Sales Summary', 'Sommaire des ventes par type de carte'],
  fees:  ['Sommaire des frais', 'Fee Summary', 'Sommaire des frais de service'],
};

// Headers that CLOSE a section without opening another — §4's general boundary rule, which
// has already bitten twice on real statements (Global's equipment table ran into the
// closing notices and captured one as a $717.38 fee).
const TERMINATORS = [
  'Sommaire des dépôts', 'Deposit Summary',
  'Avis', 'Notice', 'Rappel important', 'Important Reminder',
  'Renseignements importants', 'Important Information',
  'Payfacto Payments', 'Payfacto Paiements',
].map(headerKey);

const NOISE = [
  /^Page\b/i, /^Description\b/i, /^Type de carte/i, /^Card Type/i,
  /^No de marchand/i, /^Merchant (No|Number)/i,
  /^Date\b/i, /^Relevé\b/i, /^Statement\b/i,
  /^Opérations\b/i, /^Transactions\b/i,
];

// Payfacto's own markup rather than a network pass-through.
const MARKUP_ROW = /(ESCOMPTE|DISCOUNT|MAJORATION|MARKUP|FRAIS DE SERVICE|SERVICE FEE)/i;

// Network brand fees.
const BRAND_ROW = /(EVALUATION|ASSESSMENT|ASMTS?|RESEAU|NETWORK|ACQUEREUR|ACQUIRER|LICEN|COMPENSATION|CLEARING|CROSS.?BORDER|TRANSFRONTALIER|MARQUE)/i;

// Interac. §4 identifies these by the IDP/Flash product family, not by the word "Interac",
// which the product codes do not always carry.
const INTERAC_ROW = /(\bIDP\b|INTERAC|\bFLASH\b|COMMUTATION|SWITCH)/i;

// Fixed charges.
const FIXED_ROW = /(TERMINAL|LOCATION|RENTAL|MENSUEL|MONTHLY|RELEVE|STATEMENT|PCI|COMPTE|ACCOUNT|LOT|BATCH|PORTAIL|PORTAL|EQUIPEMENT|EQUIPMENT)/i;

function detect(lines) {
  const K = headerKey(lines.map(foldPunct).join('\n'));
  if (!/PAYFACTO/.test(K)) return false;
  // The brand name alone also appears on marketing and rate-card PDFs, so one of the two
  // statement-only section headers has to be present too — same guard as Global and Nuvei.
  return /SOMMAIRE DES VENTES/.test(K) || /SOMMAIRE DES FRAIS/.test(K)
      || /SALES SUMMARY/.test(K) || /FEE SUMMARY/.test(K);
}

function parse(lines) {
  const L = lines.map(foldPunct);
  const notes = [];
  const sections = splitSections(L);

  const sales = parseSales(sections.sales);
  const feeRows = parseFees(sections.fees);

  const vol = {
    debit_count: sales.debit.count, debit_amt: sales.debit.amt,
    visa_count:  sales.visa.count,  visa_amt:  sales.visa.amt,
    mc_count:    sales.mc.count,    mc_amt:    sales.mc.amt,
    // Discover has no field of its own and folds into Amex here, matching the Clover
    // convention for the same data model.
    amex_count:  sales.amex.count + sales.discover.count,
    amex_amt:    sales.amex.amt + sales.discover.amt,
  };

  // ---- route every fee row.
  const markupRows = [];
  const interchangeItems = [];
  const brandItems = [];
  const interacItems = [];
  const fixedRows = [];

  for (const row of feeRows) {
    const d = headerKey(row.desc);

    // ⚠️ Interac is tested BEFORE markup. A Flash tier row can be worded like a service fee,
    // and losing it to the markup bucket is exactly the failure §4 warns about below.
    if (INTERAC_ROW.test(d) || interacTier(row.desc)) { interacItems.push(row); continue; }
    if (MARKUP_ROW.test(d) && row.volume > 0) { markupRows.push(row); continue; }
    if (BRAND_ROW.test(d)) { brandItems.push(row); continue; }
    if (FIXED_ROW.test(d) && !row.volume) {
      fixedRows.push({ label: row.desc, qty: row.count || 1, unit: row.count ? row.total / row.count : row.total, amount: row.total });
      continue;
    }
    interchangeItems.push(row);
  }

  // ---- markup per brand: % weighted by volume, $/item weighted by count, independently.
  const rates = weightedRates(markupRows);

  const line_audit = {
    interchange: buildLineAudit(interchangeItems, classifyInterchangeLine, { processor: 'payfacto' }),
    brand:       buildLineAudit(brandItems, classifyBrandLine, { processor: 'payfacto' }),
    interac:     buildLineAudit(interacItems, classifyInteracLine, { processor: 'payfacto' }),
  };

  // ⚠️ THE documented Payfacto quirk, and it is not cosmetic.
  //
  // Interac Flash tiers can be printed in ROMAN numerals ("Palier II") as well as Arabic.
  // A tier row the shared regex fails to recognize falls through to "Markup processeur",
  // which the UI then filters out of the Interac audit table entirely — so a real
  // pass-through fee disappears from the comparison without any error. Any Interac row that
  // lands on MARKUP here is reported rather than swallowed.
  const droppedTiers = line_audit.interac.filter((r) => r.status === STATUS.MARKUP);
  if (droppedTiers.length) {
    notes.push(N.note('payfactoUnrecognizedTier', {
      count: droppedTiers.length,
      labels: droppedTiers.map((r) => r.desc),
    }));
  }

  const interchange = [...interchangeItems, ...brandItems, ...interacItems].reduce((s, r) => s + r.total, 0);

  const suspects = [...line_audit.interchange, ...line_audit.brand, ...line_audit.interac]
    .filter((r) => r.status === STATUS.SUSPECT);
  if (suspects.length) notes.push(N.note('suspectRows', { count: suspects.length, labels: suspects.map((s) => s.desc) }));

  const declared = parseDeclaredTotal(sections.fees);
  if (Number.isFinite(declared)) {
    const markupTotal = markupRows.reduce((s, r) => s + r.total, 0);
    const parsedTotal = markupTotal + interchange + fixedRows.reduce((s, f) => s + f.amount, 0);
    if (Math.abs(parsedTotal - declared) > 0.02) notes.push(N.note('reconcileMismatch', { parsed: parsedTotal, statement: declared }));
    else notes.push(N.note('reconciled', { total: declared }));
  }

  const allNotes = [N.note('formatDetected', { processor: NAME, layoutSuffix: '' }), ...notes];

  return {
    current_processor: {
      name: NAME,
      debit_rate: rates.debit.pct, debit_fee: rates.debit.perItem,
      visa_rate:  rates.visa.pct,  visa_fee:  rates.visa.perItem,
      mc_rate:    rates.mc.pct,    mc_fee:    rates.mc.perItem,
      amex_rate:  rates.amex.pct,  amex_fee:  rates.amex.perItem,
      interchange: round2(interchange),
      fixed_rows: fixedRows,
    },
    volume: vol,
    merchant_name: findMerchantName(L),
    line_audit,
    notes: allNotes,
    _note: N.renderAll(allNotes, 'fr'),
  };
}

// ---------------------------------------------------------------------------
function splitSections(lines) {
  const openers = [];
  for (const [name, headers] of Object.entries(SECTIONS)) {
    for (const h of headers) openers.push({ name, key: headerKey(h) });
  }
  openers.sort((a, b) => b.key.length - a.key.length);

  const out = { sales: [], fees: [] };
  let current = null;
  for (const raw of lines) {
    const key = headerKey(raw).replace(/\s*-\s*(SUITE|CONTINUED)$/, '').trim();
    const hit = openers.find((o) => o.key === key);
    if (hit) { current = hit.name; continue; }
    if (TERMINATORS.includes(key)) { current = null; continue; }
    if (!current) continue;
    if (NOISE.some((re) => re.test(raw))) continue;
    out[current].push(raw);
  }
  return out;
}

// Sales summary: "<brand> <count> <amount>".
function parseSales(lines) {
  const out = { debit: z(), visa: z(), mc: z(), amex: z(), discover: z() };
  for (const raw of lines || []) {
    if (/^Total\b/i.test(foldPunct(raw))) continue;
    const t = trailingNumbers(raw, 2);
    if (!t) continue;
    const b = brandOf(t.label);
    if (!b) continue;
    out[b] = { count: t.nums[0], amt: t.nums[1] };
  }
  return out;
}

// Fee summary rows. The shape varies, so the widest form is tried first and narrower ones
// after: "<label> count volume rate amount", then "<label> count volume amount", then
// "<label> amount".
//
// ⚠️ The label is whatever is left once the trailing numbers are taken, never a
// hand-enumerated character class — §4 records a restrictive class silently dropping real
// hyphenated row names and producing a reproducible dollar mismatch.
function parseFees(lines) {
  const rows = [];
  for (const raw of lines || []) {
    const s = foldPunct(raw);
    if (/^Total\b/i.test(s)) continue;

    let label = null, count = 0, volume = 0, rate = null, total = null;

    const four = trailingNumbers(s, 4);
    if (four) {
      [count, volume, rate, total] = four.nums;
      label = four.label;
      // The rate column prints as a percentage.
      rate = rate / 100;
    } else {
      const three = trailingNumbers(s, 3);
      if (three) {
        [count, volume, total] = three.nums;
        label = three.label;
        rate = volume > 0 ? total / volume : null;
      } else {
        // ⚠️ The two-number form has to be tried before the one-number form. A fixed-fee row
        // is "<label> qty amount" ("LOCATION TERMINAL 3 89.85"); skipping straight to one
        // number takes only the amount and leaves the quantity stuck on the end of the
        // label, so the row renders as "LOCATION TERMINAL 3".
        const two = trailingNumbers(s, 2);
        if (two) {
          [count, total] = two.nums;
          label = two.label;
        } else {
          const one = trailingNumbers(s, 1);
          if (!one) continue;
          label = one.label;
          total = one.nums[0];
        }
      }
    }

    if (!label || !Number.isFinite(total)) continue;
    rows.push({ desc: label, label, count, volume, rate, total: Math.abs(total), section: 'Sommaire des frais' });
  }
  return rows;
}

function parseDeclaredTotal(lines) {
  for (const raw of lines || []) {
    const m = foldPunct(raw).match(/^Total\s+(?:des frais\s+)?(-?\$?[\d,. ]+)$/i);
    if (m) {
      const v = parseNum(m[1]);
      if (Number.isFinite(v)) return Math.abs(v);
    }
  }
  return null;
}

// ⚠️ The brand is not always the FIRST word. A markup row reads "ESCOMPTE VISA", not
// "VISA ESCOMPTE", so a prefix-only test attributes none of the markup to any brand and
// every markup rate silently comes out as zero.
//
// Prefix is still tried first — it is the stronger signal, and it keeps a row like
// "VISA - FRAIS D'EVALUATION" attributed to Visa rather than to whatever else the label
// mentions. The anywhere-search is the fallback.
function brandOf(label) {
  const k = headerKey(label);

  const prefix = [
    [/^(IDP|INTERAC|DEBIT)\b/, 'debit'],
    [/^(VS|VISA|VI)/, 'visa'],
    [/^(MC|MASTERCARD)/, 'mc'],
    [/^(AX|AMEX|AMERICAN EXPRESS)\b/, 'amex'],
    [/^(DS|DISCOVER)\b/, 'discover'],
  ];
  for (const [re, brand] of prefix) if (re.test(k)) return brand;

  const anywhere = [
    [/\b(AMERICAN EXPRESS|AMEX|AX)\b/, 'amex'],
    [/\b(DISCOVER|DSVR)\b/, 'discover'],
    [/\b(MASTERCARD|MC)\b/, 'mc'],
    [/\b(VISA|VS)\b/, 'visa'],
    [/\b(INTERAC|IDP|DEBIT)\b/, 'debit'],
  ];
  for (const [re, brand] of anywhere) if (re.test(k)) return brand;

  return null;
}

function weightedRates(rows) {
  const acc = {};
  for (const b of ['debit', 'visa', 'mc', 'amex']) acc[b] = { vr: 0, v: 0, cf: 0, c: 0 };
  for (const r of rows) {
    let b = brandOf(r.label);
    if (b === 'discover') b = 'amex';
    if (!b) continue;
    acc[b].vr += (r.volume || 0) * (r.rate || 0);
    acc[b].v  += (r.volume || 0);
    acc[b].cf += (r.count || 0) * (r.perItem || 0);
    acc[b].c  += (r.count || 0);
  }
  const out = {};
  for (const b of Object.keys(acc)) {
    out[b] = { pct: acc[b].v > 0 ? acc[b].vr / acc[b].v : 0, perItem: acc[b].c > 0 ? acc[b].cf / acc[b].c : 0 };
  }
  return out;
}

function findMerchantName(lines) {
  for (const l of lines) {
    const m = foldPunct(l).match(/^(Nom (?:du )?(?:marchand|commer[çc]ant)|Merchant Name)\s*:?\s*(.+)$/i);
    if (m && m[2].trim()) return m[2].trim();
  }
  return null;
}

function z() { return { count: 0, amt: 0 }; }
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

module.exports = { NAME, detect, parse, SECTIONS, parseSales, parseFees, brandOf, weightedRates };
