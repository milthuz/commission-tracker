// ============================================================================
// Clover / Fiserv — bilingual, one parser (§4).
//
// Both languages ride the same "commercecontrol.com" platform, so one parser covers them;
// the layout differences are per-row, not per-document.
//
// Verified against a real French statement (05/01/26 – 05/31/26), which reconciles:
//   Frais de service   -1,601.71
//   Autres frais         -172.55
//   total fees         -1,774.26
// split by this parser into markup 161.87 + pass-through 1,474.43 + equipment 137.96.
// ============================================================================

const { parseNum, foldPunct, headerKey, squash, trailingNumbers } = require('./util');
const { classifyInterchangeLine, classifyBrandLine, classifyInteracLine, buildLineAudit, STATUS } = require('../classify');
const N = require('../notes');

const NAME = 'Clover / Fiserv';

const SECTIONS = {
  grossSales:  ['VENTES BRUTES', 'GROSS SALES'],
  serviceChg:  ['FRAIS DE SERVICE', 'SERVICE CHARGES'],
  otherFees:   ['AUTRES FRAIS', 'FEES', 'OTHER FEES'],
  disclosure:  ['DIVULGATION DES TAUX DU RÉSEAU DE PAIEMENT ET DU PROCESSEUR', 'PAYMENT NETWORK & PROCESSOR RATE DISCLOSURE', 'PAYMENT NETWORK AND PROCESSOR RATE DISCLOSURE'],
  feeSummary:  ['SOMMAIRE DES FRAIS', 'FEE DETAIL SUMMARY'],
  chargebacks: ['RÉTROFACTURATIONS/CONTREPASSATIONS', 'CHARGEBACKS/REVERSALS'],
  batchSubmit: ['MONTANTS SOUMIS PAR LOT', 'AMOUNTS SUBMITTED BY BATCH'],
  batchFunded: ['MONTANTS FINANCÉS PAR LOT', 'AMOUNTS FUNDED BY BATCH'],
};

// ⚠️ Section headers render in small caps with a stray space injected after every capital
// ("D IVULGATION D ES T AUX"), and the spacing varies by layout. Comparing with ALL
// whitespace stripped is far more robust than trying to model where the spaces land.
const SECTION_KEYS = Object.entries(SECTIONS).map(([name, headers]) => ({
  name, keys: headers.map(squash),
}));

const NOISE = [
  /^2630 Skymark/i, /^ÉTAT DE TRAITEMENT/i, /^CARD PROCESSING/i,
  /^Numéro de commercant/i, /^Merchant Number/i,
  /^Service à la clientèle/i, /^Customer Service/i,
  /^Date Facture Description/i, /^Date Invoice Description/i,
  /^Type de carte Ventes/i, /^Card Type Sales/i,
  /^Total articles/i, /^Produit\/?Description/i, /^Détail de Frais/i, /^Fee Detail/i,
  /^vendus |^payés|^paiement$|^au réseau/i,
  /^QST:/i, /^TPS:/i, /^GST:/i,   // tax continuation lines wrapped from the row above
];

// ---------------------------------------------------------------------------
// Rows that are Fiserv's OWN markup and must NOT be counted again.
//
// ⚠️ The double-count trap from §4, confirmed on this statement to the cent:
//   FRAIS DE TRANSACTION            -143.55  = 95,699.68 credit volume x 0.1500 %
//   INTERAC FRAIS PAR TRAN-FLASH     -16.16 ┐
//   INTERAC FRAIS PAR TRAN-CONTACT    -2.20 ┘= 458 Interac items x $0.0400
// Those are the same dollars the comparison already computes from the Card Type table's
// own rate and per-item fee. Counting the rows as well as the rates inflates the current
// processor's side by its entire markup.
// ---------------------------------------------------------------------------
const FISERV_MARKUP_RE = new RegExp([
  'FRAIS DE TRANSACTION',
  'FRAIS PAR TRAN',                       // INTERAC FRAIS PAR TRAN-FLASH / -CONTACT
  // ⚠️ L'ESCOMPTE EST LA MARGE, PAS DU TRANSFERT. Constaté sur un vrai relevé Clover
  // (2026-09-22) : la section des frais de service distingue trois lignes Interac par
  // produit, et elles n'ont pas la même nature —
  //     INTERAC FRAIS D'INTERCH-FLASH   -7,23   l'interchange du réseau
  //     INTERAC FRAIS DE COMM-FLASH     -3,20   la commutation, réseau aussi
  //     INTERAC FRAIS D'ESCOMPTE-FLASH -20,54   l'escompte = la marge de Fiserv
  // Sans cette entrée, l'escompte était compté comme transfert Interac ET refacturé une
  // seconde fois par le taux du tableau des types de carte.
  'FRAIS D.?ESCOMPTE',
  'DISCOUNT FEE',
  'FRAIS (MAST|VISA|VDBT) DE TRANSACTION',
  'FRAIS-(DEBIT|FLASH|VDBT) TRANSACTION',
  'TRANSACTION FEE',
  'PER TRANSACTION FEE',
  // ⚠️ LA MISE EN PAGE ANGLAISE ABRÈGE : « INTERAC PER TRAN FEE - FLASH », pas « PER
  // TRANSACTION FEE ». Le français « FRAIS PAR TRAN » est couvert depuis le début et
  // l'anglais ne l'était pas — le même angle mort que « MC / MASTERCARD CYBER SECURE ».
  //
  // Ce que ça coûtait, constaté en confrontant notre sortie à celle du calculateur de
  // Christine sur PATISSERIE AFRODITI (2026-09-24) : 17,35 $ + 121,05 $ = 138,40 $ par
  // mois comptés en transfert Interac au lieu de la majoration Fiserv. Or c'est
  // exactement la ligne « Débit 138,40 $ » de son tableau de majoration. Un dollar rangé
  // en pass-through est un dollar que Cluster ne remplace PAS : l'économie annoncée au
  // marchand en était sous-estimée d'autant, soit 1 660,80 $ par année.
  'PER TRAN FEE',
].join('|'), 'i');

// Interac pass-through. The English layout glues the words together
// ("INTERACSWITCHFEE-CONTACT") where French space-separates them, so every gap is \s*
// (zero or more), never \s+.
const INTERAC_RE = /(INTERAC\s*(FRAIS|SWITCH|INTERCHANGE)|FRAIS\s*-?\s*(DEBIT|FLASH)\s*(COMMUTATION|INTERCHANGE)|SWITCH\s*FEE|IDP\s*FLASH)/i;

// Rows in the fee sections that are network brand fees rather than interchange or fixed.
const BRAND_RE = /(VALUATION|ÉVALUATION|EVALUATION|ASSESSMENT|CROSS BORDER|IASF|ACQ CLEAR|CLEARING|CONNEC|CONNECTIVITY|VOLUME PERMIS|LICEN|NATL SETTLED|CARD BRAND|REDEV)/i;

// Generic fixed charges.
const FIXED_RE = /(EQUIPEMENT|EQUIPMENT|MENS\.|MONTHLY|LOCATION|RENTAL|RELEVÉ|STATEMENT)/i;

function detect(lines) {
  // §4 is explicit that this is a text-presence test, not a header match: the string turns
  // up reliably regardless of which language layout the statement uses.
  return lines.some((l) => /commercecontrol\.com/i.test(l));
}

function parse(lines) {
  const L = lines.map(foldPunct);
  const notes = [];

  const sections = splitSections(L);
  const cardTypes = parseCardTypes(L);
  const gross = parseGrossSales(sections.grossSales);
  const disclosure = parseDisclosure(sections.disclosure);

  const feeRows = [
    ...parseFeeRows(sections.serviceChg, 'Frais de service'),
    ...parseFeeRows(sections.otherFees, 'Autres frais'),
  ];

  // ---- volume, bucketed by HOW the card is PRICED, not by what the network calls it.
  //
  // ⚠️ debit = ONLY the flat-per-item Interac rails (Interac contact + IF contactless).
  // VisaDebit / VCDBT is billed at the credit percentage rate, so it belongs in Visa — a
  // prior version put it in debit and the comparison came out wrong.
  const vol = {
    debit_count: (gross.Interac?.count || 0) + (gross.IF?.count || 0),
    debit_amt:   (gross.Interac?.amount || 0) + (gross.IF?.amount || 0),
    visa_count:  (gross.Visa?.count || 0) + (gross.VisaDebit?.count || 0),
    visa_amt:    (gross.Visa?.amount || 0) + (gross.VisaDebit?.amount || 0),
    mc_count:    (gross.MasterCard?.count || 0) + (gross.MCDebit?.count || 0),
    mc_amt:      (gross.MasterCard?.amount || 0) + (gross.MCDebit?.amount || 0),
    amex_count:  (gross.Amex?.count || 0) + (gross.Discover?.count || 0),
    amex_amt:    (gross.Amex?.amount || 0) + (gross.Discover?.amount || 0),
  };

  // ---- markup rates.
  //
  // ⚠️ Visa's and Mastercard's rates are a computed BLEND: the Visa-rail debit volume
  // (VCDBT/MCDBT) folds into the base rate by weighted average. Kept at 6 decimals for the
  // rate and 4 for the per-item fee — §4 records normal 4/2 rounding introducing a real
  // ~$0.56 error on a live statement.
  const rates = {
    debit: blend([[cardTypes.IDEBT, vol.debit_amt, vol.debit_count]]),
    visa:  blend([
      [cardTypes.VISA,  gross.Visa?.amount || 0,      gross.Visa?.count || 0],
      [cardTypes.VCDBT, gross.VisaDebit?.amount || 0, gross.VisaDebit?.count || 0],
    ]),
    mc:    blend([
      [cardTypes.MC,    gross.MasterCard?.amount || 0, gross.MasterCard?.count || 0],
      [cardTypes.MCDBT, gross.MCDebit?.amount || 0,    gross.MCDebit?.count || 0],
    ]),
    amex:  blend([
      [cardTypes.AMEX, gross.Amex?.amount || 0,     gross.Amex?.count || 0],
      [cardTypes.DSVR, gross.Discover?.amount || 0, gross.Discover?.count || 0],
    ]),
  };

  // ---- route every fee row.
  const interchangeItems = [];
  const brandItems = [];
  const interacItems = [];
  const fixedRows = [];
  let skippedMarkup = 0;

  for (const row of feeRows) {
    const d = headerKey(row.desc);

    if (FISERV_MARKUP_RE.test(d)) { skippedMarkup += row.total; continue; }

    if (FIXED_RE.test(d) && !BRAND_RE.test(d) && !INTERAC_RE.test(d)) {
      fixedRows.push({ label: row.desc, qty: 1, unit: row.total, amount: row.total });
      continue;
    }
    if (INTERAC_RE.test(d)) { interacItems.push(row); continue; }
    if (BRAND_RE.test(d))   { brandItems.push(enrich(row, disclosure)); continue; }
    interchangeItems.push(enrich(row, disclosure));
  }

  if (skippedMarkup > 0) {
    notes.push(N.note('fiservMarkupExcluded', { amount: skippedMarkup }));
  }

  const line_audit = {
    interchange: buildLineAudit(interchangeItems, classifyInterchangeLine, { processor: 'clover' }),
    brand:       buildLineAudit(brandItems, classifyBrandLine, { processor: 'clover' }),
    interac:     buildLineAudit(interacItems, classifyInteracLine, { processor: 'clover' }),
  };

  const interchange = [...interchangeItems, ...brandItems, ...interacItems].reduce((s, r) => s + r.total, 0);

  // ---- the $0 interchange section trap.
  //
  // A merchant reads "Frais d'interchange 0.00" as good news. On this layout it usually
  // means the opposite: the real interchange is inside Frais de service under unexplained
  // codes (CANCNTLSLMWE, HNW IND3 NAT, …). Worth saying out loud, not just in a comment.
  if (declaredInterchangeZero(L) && interchange > 0) {
    notes.push(N.note('zeroInterchangeDeclared', { amount: interchange }));
  }

  // ---- inflated assessment.
  //
  // The rate-disclosure table prints the assessment actually billed on every tier. The
  // published figure is 0.0900 %; anything above it is a real, quantifiable overcharge, so
  // the note carries the monthly and annual dollars rather than just naming the rate.
  const assessment = dominantAssessment(disclosure);
  if (assessment && assessment > 0.0009 + 1e-9) {
    const cardVolume = vol.visa_amt + vol.mc_amt + vol.amex_amt;
    const excess = (assessment - 0.0009) * cardVolume;
    notes.push(N.note('assessmentInflated', {
      rate: assessment, published: 0.0009, monthly: excess, annual: excess * 12,
    }));
  }

  const suspects = [...line_audit.interchange, ...line_audit.brand, ...line_audit.interac]
    .filter((r) => r.status === STATUS.SUSPECT);
  if (suspects.length) notes.push(N.note('suspectRows', { count: suspects.length, labels: suspects.map((s) => s.desc) }));

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
  const out = {};
  for (const name of Object.keys(SECTIONS)) out[name] = [];

  let current = null;
  for (const raw of lines) {
    const sq = squash(raw);
    const hit = SECTION_KEYS.find((s) => s.keys.includes(sq));
    if (hit) { current = hit.name; continue; }
    if (!current) continue;
    if (NOISE.some((re) => re.test(raw))) continue;
    out[current].push(raw);
  }
  return out;
}

// The Card Type table sits above every section header, so it is found by row shape:
// a short code followed by exactly two decimal numbers.
function parseCardTypes(lines) {
  const out = {};
  for (const raw of lines) {
    const m = foldPunct(raw).match(/^([A-Za-z][A-Za-z0-9]{1,12})\s+(\d+\.\d{2,6})\s+(\d+\.\d{2,6})$/);
    if (!m) continue;
    const key = m[1].toUpperCase();
    // The table prints the discount as a PERCENT.
    out[key] = { pct: parseNum(m[2]) / 100, perItem: parseNum(m[3]) };
  }
  return out;
}

// VENTES BRUTES: brand salesCount salesAmt creditsCount creditsAmt netAmt
function parseGrossSales(lines) {
  const out = {};
  const alias = {
    VISA: 'Visa', MASTERCARD: 'MasterCard', INTERAC: 'Interac',
    VISADEBIT: 'VisaDebit', MCDEBIT: 'MCDebit', MASTERCARDDEBIT: 'MCDebit',
    IF: 'IF', AMEX: 'Amex', 'AMERICANEXPRESS': 'Amex', DISCOVER: 'Discover', DSVR: 'Discover',
  };
  for (const raw of lines || []) {
    const t = trailingNumbers(raw, 5);
    if (!t) continue;
    const key = squash(t.label);
    const name = alias[key];
    if (!name) continue;
    const [count, amount, creditCount, , net] = t.nums;
    // ⚠️ The per-item fee is billed on every ITEM processed, returns included — the same
    // "both legs" behaviour Global shows on its Escompte section. Counting sales only
    // understated the debit basis by one item here and left a 4c gap against the
    // statement's own total. Volume stays NET; only the item count picks up the returns.
    out[name] = {
      count: count + (Number.isFinite(creditCount) ? creditCount : 0),
      salesCount: count,
      amount: Number.isFinite(net) ? net : amount,
    };
  }
  return out;
}

// Rate disclosure: CODE itemsSold saleAmt itemsReturned returnAmt interchangeRate% assessmentRate%
//
// ⚠️ Detected by numeric row SHAPE rather than by the small-caps header, whose injected
// spacing is too fragile to match on.
function parseDisclosure(lines) {
  const out = {};
  for (const raw of lines || []) {
    const s = foldPunct(raw);
    if (/\bTOTAL\b/i.test(s)) continue;           // per-brand rollup rows
    const m = s.match(/^(.+?)\s+(\d+)\s+([\d,.]+)\s+(\d+)\s+([\d,.-]+)\s+([\d.]+)%\s+([\d.]+)%$/);
    if (!m) continue;
    out[headerKey(m[1])] = {
      code: m[1].trim(),
      count: parseNum(m[2]),
      volume: parseNum(m[3]),
      interchangeRate: parseNum(m[6]) / 100,
      assessmentRate: parseNum(m[7]) / 100,
    };
  }
  return out;
}

// Frais de service / Autres frais: DATE INVOICE DESCRIPTION [GST:x] -amount
function parseFeeRows(lines, origin) {
  const rows = [];
  for (const raw of lines || []) {
    const s = foldPunct(raw);
    if (/^Total\b/i.test(s)) continue;
    const m = s.match(/^\d{2}\/\d{2}\/\d{2}\s+\S+\s+(.+?)(?:\s+(?:GST|TPS):-?[\d.,]+)?\s+(-?[\d,]+\.\d{2})$/i);
    if (!m) continue;
    const total = Math.abs(parseNum(m[2]));
    if (!Number.isFinite(total)) continue;
    rows.push({ desc: m[1].trim(), total, section: origin, rate: null, volume: 0, count: 0 });
  }
  return rows;
}

// Attach the volume and rate the disclosure table already discloses for this code, so the
// audit can compare a real applied rate instead of only a dollar amount.
function enrich(row, disclosure) {
  const d = disclosure[headerKey(row.desc)];
  if (!d) return row;
  return {
    ...row,
    count: d.count,
    volume: d.volume,
    rate: d.volume > 0 ? row.total / d.volume : row.rate,
    disclosedInterchangeRate: d.interchangeRate,
    disclosedAssessmentRate: d.assessmentRate,
  };
}

// The assessment rate the disclosure table repeats on essentially every row.
function dominantAssessment(disclosure) {
  const counts = new Map();
  for (const d of Object.values(disclosure)) {
    if (!Number.isFinite(d.assessmentRate)) continue;
    counts.set(d.assessmentRate, (counts.get(d.assessmentRate) || 0) + 1);
  }
  let best = null;
  for (const [rate, n] of counts) if (!best || n > best.n) best = { rate, n };
  return best ? best.rate : null;
}

function declaredInterchangeZero(lines) {
  return lines.some((l) => /^(Frais d'interchange|Interchange (Charges|Fees))\s+0\.00$/i.test(foldPunct(l))
    || /There are no Interchange Charges/i.test(l));
}

// Weighted blend of several card-type rows into one brand rate. % by volume, $/item by
// count — the two components never get merged into a single effective rate.
function blend(parts) {
  let vr = 0, v = 0, cf = 0, c = 0;
  for (const [ct, volume, count] of parts) {
    if (!ct) continue;
    vr += (volume || 0) * (ct.pct || 0);
    v  += (volume || 0);
    cf += (count || 0) * (ct.perItem || 0);
    c  += (count || 0);
  }
  return {
    pct: v > 0 ? round(vr / v, 6) : 0,
    perItem: c > 0 ? round(cf / c, 4) : 0,
  };
}

function findMerchantName(lines) {
  // The merchant name sits in the address block, above the statement period line.
  const i = lines.findIndex((l) => /Période\s*couverte\s*par\s*le\s*relevé|Statement\s*Period/i.test(foldPunct(l).replace(/\s+/g, ' ')));
  if (i > 0) {
    for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
      const s = foldPunct(lines[j]);
      if (/^[A-ZÀ-Ü0-9][A-ZÀ-Ü0-9 '&.-]{3,}$/.test(s) && !/SKYMARK|ÉTAT|CARD PROCESSING/i.test(s)) return s;
    }
  }
  return null;
}

const round = (v, d) => { const f = 10 ** d; return Math.round((Number(v) + Number.EPSILON) * f) / f; };
const round2 = (v) => round(v, 2);
// French decimal comma, to match the rest of the note text.
const fmt = (v) => round2(v).toFixed(2).replace('.', ',');

module.exports = { NAME, detect, parse, SECTIONS, parseCardTypes, parseGrossSales, blend };
