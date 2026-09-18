// ============================================================================
// Global Payments — bilingual French/English, ONE parser (§4).
//
// Verified against globalpay.pdf (French layout, statement date 31/05/26, merchant
// DINER SAINT SAUVEUR), which reconciles to the cent:
//   Escompte      20 rows → 164.11   (statement: MONTANT DE L'ESCOMPTE 164.11)
//   FTNQ          23 rows → 449.79   (statement: Frais de trans non qualifiée 449.79)
//   Equipment            →  90.00
//   markup 84.87 + interchange 529.03 + fixed 90.00 = 703.90, and the statement's own
//   billing summary is 613.90 + 90.00 = 703.90.
// ============================================================================

const {
  parseNum, foldPunct, headerKey, trailingNumbers, trailingAmount,
} = require('./util');
const {
  classifyGlobalInterchangeLine, classifyBrandLine, classifyInteracLine,
  buildLineAudit, STATUS,
} = require('../classify');
const N = require('../notes');

const NAME = 'Global Payments';

// Section headers, both languages. Continuations ("… - suite") are handled by the scanner.
const SECTIONS = {
  cardSummary: ['Sommaire par carte', 'Card Summary', 'Summary by Card'],
  deposits:    ['Dépôts', 'Deposits', 'Sommaire des dépôts', 'Deposit Summary'],
  escompte:    ['Escompte', 'Discount'],
  // IDF and FTNQ are the same concept under two names, but a statement can carry BOTH, so
  // they are scanned as SEPARATE sections and their rows concatenated — never aliased.
  idf:         ['IDF', 'Interchange Downgrade Fees', "Frais de déclassement d'interchange"],
  ftnq:        ['Frais de transaction non qualifiée (FTNQ)', 'Non-Qualified Transaction Fees', 'FTNQ'],
  effective:   ['Taux en vigueur', 'Effective Rate'],
  billing:     ['Sommaire de facturation', 'Billing Summary'],
  // ⚠️ the apostrophe here is folded by headerKey(), so both the curly and the straight
  // spelling match. A literal match on one of them missed the section entirely on a
  // French-only statement.
  equipment:   ["Frais d'équipement", 'Equipment Fees'],
  other:       ['Autres Frais', 'Other Fees', 'Autres frais'],
};

// Page furniture that repeats on every page.
//
// ⚠️ "Total" is deliberately NOT filtered here. The card summary's per-brand volumes live
// ON its Total row, so dropping it globally blanks the volume table — debit in particular,
// whose Escompte row carries a $0 volume because debit is billed per item. Each section
// parser skips its own Total instead.
const NOISE = [
  /^Relevé du Marchand$/i, /^Merchant Statement$/i,
  /^Date du relevé/i, /^Statement Date/i,
  /^No de marchand/i, /^Merchant (No|Number)/i,
  /^Description\b/i,           // repeated column headers
  /^Achat$/i, /^Montant$/i, /^Taux/i, /^Numéro/i, /^Date /i,
];

// ⚠️ Headers that CLOSE whatever section is open without opening a new one.
//
// §4's boundary rule, hit here for real: the equipment section is the last table on the
// page and no section header follows it, so without these the scan ran on through the
// closing notices and captured "Votre compte a été débité de la somme de 717.38 $" as a
// $717.38 equipment fee. A section must close on every plausible next header the format
// can produce — including the ones that are not sections at all.
const TERMINATORS = [
  'Avis', 'Notice',
  'Rappel important', 'Important Reminder',
  "Frais d'interchange du réseau de paiement", 'Payment Network Interchange Fees',
  'Paiements Globaux Canada SENC', 'Global Payments Canada',
  'FRAIS PLUS TAXES', 'FEES PLUS TAXES',
  'Pour obtenir de l\'aide', 'For assistance',
].map((h) => headerKey(h));

// Rows inside Escompte that are genuine network pass-through rather than Global's own
// markup. Same principle as the Moneris section-4 split: a network fee sitting in a markup
// section belongs in the interchange total, not the markup total, or the two sides stop
// adding up against the statement's own summary.
const ESCOMPTE_NETWORK_RE = /(ASMTS|ASSESSMENT|LICENSE FEE|INFRASTRUCTURE|NETWORK FEE|CLEARMIN|CLEARMAX|CLEARING|\bXB\b|CROSS.?BORDER|TAX REIMBURSEMENT|DATASECFEE|RISK ASMT|NETWKACCES|PNCOMPFEE|PCI)/i;

// Brand routing for a category code. Global's Visa families are VI* (VISA, VIBS, VINF,
// VIPP); Mastercard's are MC*. Interac is IDP.
function brandOf(label) {
  const k = headerKey(label);
  if (/^IDP\b/.test(k)) return 'debit';
  if (/^(VS|VI)/.test(k)) return 'visa';
  if (/^(MC|MASTERCARD)/.test(k)) return 'mc';
  if (/^(AMEX|AMERICAN EXPRESS|AX)\b/.test(k)) return 'amex';
  return null;
}

// Row kind for IDF / FTNQ rows.
//
// ⚠️ Interac is identified by the IDP FLASH label prefix, NOT by a general "contains
// Interac" text search — these rows never contain the word.
function rowKind(label) {
  const k = headerKey(label);
  if (/^IDP\b/.test(k)) return 'interac';
  if (/^(VS|VI|MC)/.test(k)) return 'interchange';
  return 'brand';
}

// ---------------------------------------------------------------------------
// Detection
//
// ⚠️ Must positively separate an actual billing statement from Global's own published
// rate-card PDF — a rep can upload the wrong document, and a rate card is full of the same
// vocabulary. The discriminator is the merchant-specific furniture (a merchant number, a
// statement date, a card summary), which a rate card has none of.
// ---------------------------------------------------------------------------
function detect(lines) {
  const text = lines.map(foldPunct).join('\n');
  const K = headerKey(text);

  const isGlobal = /GLOBAL ?PAYMENTS|PAIEMENTS GLOBAUX/.test(K);
  if (!isGlobal) return false;

  const hasMerchantNo = /(NO DE MARCHAND|MERCHANT (NO|NUMBER))\s*:?/.test(K);
  const hasStatement  = /(RELEVE DU MARCHAND|MERCHANT STATEMENT)/.test(K);
  const hasSummary    = /(SOMMAIRE PAR CARTE|CARD SUMMARY)/.test(K);

  return hasMerchantNo && (hasStatement || hasSummary);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parse(lines) {
  const L = lines.map(foldPunct);
  const notes = [];

  const sections = splitSections(L);

  const volume  = parseCardSummary(sections.cardSummary);
  const escompte = parseEscompte(sections.escompte);
  // IDF and FTNQ can both appear; their rows are concatenated, each keeping its origin.
  const downgrade = [
    ...parseDowngrade(sections.idf, 'IDF'),
    ...parseDowngrade(sections.ftnq, 'FTNQ'),
  ];
  const fixedRows = parseFixedRows([...(sections.equipment || []), ...(sections.other || [])]);

  // ---- markup, per brand, from the Escompte card-category rows.
  //
  // The % and $/item components are averaged SEPARATELY — volume-weighted for the %,
  // count-weighted for the $/item — never blended into one effective % via total ÷ volume.
  // A blend reproduces the right dollar total while matching neither number printed on the
  // statement.
  const rates = weightedRates(escompte.markup);

  // ---- counts come from the Escompte card-category rows, which break out every sub-brand.
  const counts = { debit: 0, visa: 0, mc: 0, amex: 0 };
  const escVolumes = { debit: 0, visa: 0, mc: 0, amex: 0 };
  for (const r of escompte.markup) {
    const b = brandOf(r.label);
    if (!b) continue;
    counts[b] += r.count;
    escVolumes[b] += r.volume;
  }

  // ---- volume.
  // The card summary is the net figure and is what the comparison uses. Escompte volume
  // covers sales AND returns, because Global bills its markup on both legs — so it can
  // legitimately exceed the net figure. That is an explanatory note, not a discrepancy.
  const vol = {
    debit_count: counts.debit, debit_amt: volume.debit != null ? volume.debit : escVolumes.debit,
    visa_count:  counts.visa,  visa_amt:  volume.visa  != null ? volume.visa  : escVolumes.visa,
    mc_count:    counts.mc,    mc_amt:    volume.mc    != null ? volume.mc    : escVolumes.mc,
    amex_count:  counts.amex,  amex_amt:  volume.amex  != null ? volume.amex  : escVolumes.amex,
  };

  let volumeNote = null;
  const escTotal = escVolumes.debit + escVolumes.visa + escVolumes.mc + escVolumes.amex;
  const sumTotal = vol.debit_amt + vol.visa_amt + vol.mc_amt + vol.amex_amt;
  if (escTotal - sumTotal > 0.01) {
    volumeNote = N.note('volumeDiscrepancy', { escompte: escTotal, net: sumTotal });
    notes.push(volumeNote);
  }

  // ---- audit rows.
  const interchangeItems = downgrade.filter((r) => r.kind === 'interchange');
  const interacItems     = downgrade.filter((r) => r.kind === 'interac');
  const brandItems       = [...downgrade.filter((r) => r.kind === 'brand'), ...escompte.network];

  const line_audit = {
    interchange: buildLineAudit(interchangeItems, classifyGlobalInterchangeLine, { processor: 'global' }),
    brand:       buildLineAudit(brandItems, classifyBrandLine, { processor: 'global' }),
    interac:     buildLineAudit(interacItems, classifyInteracLine, { processor: 'global' }),
  };

  // ---- interchange total: the downgrade sections plus the network rows that were sitting
  // inside Escompte.
  const downgradeTotal = downgrade.reduce((s, r) => s + r.total, 0);
  const escNetworkTotal = escompte.network.reduce((s, r) => s + r.total, 0);
  const interchange = downgradeTotal + escNetworkTotal;

  // ---- no-IDF-section fallback.
  //
  // Some blend-rate statements disclose no itemized downgrade section at all. An earlier
  // version guessed a flat ~1.65 % blended interchange, which on one real statement came
  // out to more than double the entire invoice. Instead, derive a per-tier estimate from
  // the Escompte section's own disclosed sub-brand volumes, tagged Estimé, total 0 (nothing
  // was billed under this line) with the theoretical figure carried separately.
  if (!downgrade.length && escompte.markup.length) {
    line_audit.interchange = buildGlobalEscompteInterchangeEstimate(escompte.markup);
    notes.push(N.note('noDowngradeSection'));
  }

  const suspects = [...line_audit.interchange, ...line_audit.brand, ...line_audit.interac]
    .filter((r) => r.status === STATUS.SUSPECT);
  if (suspects.length) {
    notes.push(N.note('suspectRows', { count: suspects.length, labels: suspects.map((s) => s.desc) }));
  }

  const billing = parseBilling(sections.billing);
  if (billing.total != null) {
    const parsedTotal = escompte.total + downgradeTotal;
    if (Math.abs(parsedTotal - billing.total) > 0.02) {
      notes.push(N.note('reconcileMismatch', { parsed: parsedTotal, statement: billing.total }));
    } else {
      notes.push(N.note('reconciled', { total: billing.total }));
    }
  }

  const allNotes = [
    N.note('formatDetected', { processor: NAME, layoutSuffix: frenchLayout(L) ? ' (français)' : ' (anglais)' }),
    ...notes,
  ];

  return {
    current_processor: {
      name: NAME,
      debit_rate: rates.debit.pct, debit_fee: rates.debit.perItem,
      visa_rate:  rates.visa.pct,  visa_fee:  rates.visa.perItem,
      mc_rate:    rates.mc.pct,    mc_fee:    rates.mc.perItem,
      amex_rate:  rates.amex.pct,  amex_fee:  rates.amex.perItem,
      interchange: round2(interchange),
      fixed_rows: fixedRows,
      volume_note: volumeNote,
    },
    volume: vol,
    merchant_name: findMerchantName(L),
    line_audit,
    notes: allNotes,
    _note: N.renderAll(allNotes, 'fr'),
  };
}

// ---------------------------------------------------------------------------
// Section splitting
//
// Rows are collected per section. Every known header closes whatever section is open — see
// the boundary rule in util.js — and a "- suite" continuation re-opens the same one.
// ---------------------------------------------------------------------------
function splitSections(lines) {
  const openers = [];
  for (const [name, headers] of Object.entries(SECTIONS)) {
    for (const h of headers) openers.push({ name, key: headerKey(h) });
  }
  // Longest header first, so "Frais de transaction non qualifiée (FTNQ)" is tested before
  // the bare "FTNQ" alias and the specific name wins.
  openers.sort((a, b) => b.key.length - a.key.length);

  const out = {};
  for (const name of Object.keys(SECTIONS)) out[name] = [];

  let current = null;
  for (const raw of lines) {
    const key = headerKey(raw).replace(/\s*-\s*(SUITE|CONTINUED|CONT\.?)$/, '').trim();
    const hit = openers.find((o) => o.key === key);
    if (hit) { current = hit.name; continue; }
    if (TERMINATORS.includes(key)) { current = null; continue; }
    if (!current) continue;
    if (NOISE.some((re) => re.test(raw))) continue;
    out[current].push(raw);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Card summary → per-brand net volume.
//
// Columns are Date | Visa | Débit | Mastercard | Amex | Discover | Autres, but the Amex
// header wraps onto its own physical line ("American" above the header row, "Express"
// below), so the header text cannot be used to locate columns. The Total row is read
// positionally instead, which is stable across both layouts.
// ---------------------------------------------------------------------------
function parseCardSummary(lines) {
  const out = { visa: null, debit: null, mc: null, amex: null, discover: null, other: null };
  for (const l of lines || []) {
    const m = foldPunct(l).match(/^(Total|TOTAL)\s+(.+)$/);
    if (!m) continue;
    const nums = m[2].split(' ').map(parseNum).filter(Number.isFinite);
    if (nums.length < 3) continue;
    [out.visa, out.debit, out.mc, out.amex, out.discover, out.other] = nums;
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Escompte → Global's own markup rows + the network rows mixed in with them.
//
// Row shape: LABEL count volume avgTicket ratePct perItem feeAmount
//   "VISA VISA 300 15,877.47 52.92 0.1800 0.0000 28.57"
//   "MC LICENSE FEE 305 17,014.83 55.79 0.0140 0.0060 4.21"
// The rate column is a PERCENT on this layout, so it is divided by 100 into a decimal.
// ---------------------------------------------------------------------------
function parseEscompte(lines) {
  const markup = [];
  const network = [];
  let total = 0;

  for (const l of lines || []) {
    const t = trailingNumbers(l, 6);
    if (!t) continue;
    const [count, volume, , ratePct, perItem, fee] = t.nums;
    const row = {
      desc: t.label, label: t.label,
      count, volume,
      rate: ratePct / 100,
      perItem,
      total: fee,
      section: 'Escompte',
    };
    total += fee;
    if (ESCOMPTE_NETWORK_RE.test(headerKey(t.label))) network.push(row);
    else markup.push(row);
  }
  return { markup, network, total: round2(total) };
}

// ---------------------------------------------------------------------------
// IDF / FTNQ → the itemized downgrade rows.
//
// Row shape: LABEL count volume feeAmount — there is NO rate column, so the applied rate is
// derived from the dollars. That derived rate is exactly why alias identity must be checked
// before rate proximity in the classifier: a dollar-derived rate can land near an unrelated
// published rate purely by coincidence.
//
// ⚠️ Each row is kind-tagged individually. These sections are NOT one category: they carry
// interchange, brand and Interac rows together.
// ---------------------------------------------------------------------------
function parseDowngrade(lines, origin) {
  const rows = [];
  for (const l of lines || []) {
    const t = trailingNumbers(l, 3);
    if (!t) continue;
    const [count, volume, fee] = t.nums;
    // A row with no volume and no fee is a header remnant, not data.
    if (!Number.isFinite(fee)) continue;
    rows.push({
      desc: t.label, label: t.label,
      count, volume, total: fee,
      rate: volume > 0 ? fee / volume : null,
      kind: rowKind(t.label),
      section: origin,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Equipment / Other fees → fixed-fee rows, kept with their own labels so the comparison
// shows what the merchant is actually renting rather than bucketing it away.
// ---------------------------------------------------------------------------
function parseFixedRows(lines) {
  const rows = [];
  for (const l of lines || []) {
    const s = foldPunct(l);
    if (/^(TOTAL|QST|GST|TPS|TVQ|HST|TVH|FRAIS PLUS TAXES)\b/i.test(s)) continue;
    const t = trailingNumbers(s, 3);
    if (t) {
      const [qty, unit, amount] = t.nums;
      rows.push({ label: t.label, qty, unit, amount });
      continue;
    }
    const amount = trailingAmount(s);
    if (Number.isFinite(amount) && /[A-Za-z]/.test(s)) {
      rows.push({ label: s.replace(/\s*[\d,. ]+$/, '').trim(), qty: 1, unit: amount, amount });
    }
  }
  return rows;
}

function parseBilling(lines) {
  let total = null;
  for (const l of lines || []) {
    const m = foldPunct(l).match(/^Total\s+([\d,.]+)$/i);
    if (m) total = parseNum(m[1]);
  }
  return { total };
}

// ---------------------------------------------------------------------------
// Weighted rates — % averaged by volume, $/item averaged by count, independently.
// ---------------------------------------------------------------------------
function weightedRates(rows) {
  const acc = {};
  for (const b of ['debit', 'visa', 'mc', 'amex']) acc[b] = { vr: 0, v: 0, cf: 0, c: 0 };

  for (const r of rows) {
    const b = brandOf(r.label);
    if (!b) continue;
    acc[b].vr += (r.volume || 0) * (r.rate || 0);
    acc[b].v  += (r.volume || 0);
    acc[b].cf += (r.count || 0) * (r.perItem || 0);
    acc[b].c  += (r.count || 0);
  }

  const out = {};
  for (const b of Object.keys(acc)) {
    out[b] = {
      pct: acc[b].v > 0 ? acc[b].vr / acc[b].v : 0,
      perItem: acc[b].c > 0 ? acc[b].cf / acc[b].c : 0,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// The no-IDF estimate. Rows are tagged Estimé with total 0 — nothing was billed under this
// line — and the theoretical figure is what Cluster's own pass-through would come to.
// ---------------------------------------------------------------------------
function buildGlobalEscompteInterchangeEstimate(markupRows) {
  return markupRows
    .filter((r) => (r.volume || 0) > 0)
    .map((r) => ({
      desc: `${r.label} (estimation)`,
      count: r.count, volume: r.volume,
      rate: null,
      total: 0,
      theoretical: null,
      status: STATUS.ESTIME,
      cat: null, publishedRate: null, delta: null,
      why: "Aucune section IDF/FTNQ divulguée; estimation dérivée de la ventilation par sous-marque de l'Escompte.",
    }));
}

function findMerchantName(lines) {
  for (const l of lines) {
    const m = foldPunct(l).match(/Nom de marchand\s*:\s*(.+)$/i) || foldPunct(l).match(/Merchant Name\s*:\s*(.+)$/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

function frenchLayout(lines) {
  return lines.some((l) => /^Relevé du Marchand$/i.test(foldPunct(l)));
}

const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

module.exports = { NAME, detect, parse, SECTIONS, brandOf, rowKind, weightedRates };
