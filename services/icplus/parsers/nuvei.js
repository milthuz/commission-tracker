// ============================================================================
// Nuvei (§4).
//
// ⚠️ NOT YET VERIFIED AGAINST A REAL STATEMENT. Global and Clover were each reconciled to
// the cent against real paper; no Nuvei statement was available. Every clause of §4 is
// implemented and covered by synthetic fixtures, but SECTIONS and the four row-shape
// variants below are the most likely things to need correcting. Reconcile against a real
// statement before putting a number from this parser in front of a client.
//
// Three sections carry everything:
//   RATES & FEES       — interchange tiers AND network assessments in ONE table
//   OTHER CHARGES      — real fixed charges, one real Interac pass-through, and a cluster
//                        of junk labels that impersonate network terminology
//   CARD TYPE SUMMARY  — per-brand counts, volume, and a two-component markup
// ============================================================================

const { parseNum, foldPunct, headerKey, squash } = require('./util');
const {
  classifyInterchangeLine, classifyBrandLine, classifyInteracLine,
  buildLineAudit, STATUS,
} = require('../classify');
const N = require('../notes');

const NAME = 'Nuvei';

const SECTIONS = {
  deposit:  ['DEPOSIT SUMMARY', 'SOMMAIRE DES DÉPÔTS'],
  rates:    ['RATES & FEES', 'RATES AND FEES', 'TAUX ET FRAIS'],
  other:    ['OTHER CHARGES', 'AUTRES FRAIS'],
  cardType: ['CARD TYPE SUMMARY', 'SOMMAIRE PAR TYPE DE CARTE'],
};

const SECTION_KEYS = Object.entries(SECTIONS).map(([name, headers]) => ({ name, keys: headers.map(squash) }));

// ⚠️ "Total" is NOT filtered globally. The deposit summary's own bottom line is a
// "Total Fees" row, and a blanket filter swallows the one figure the reconciliation check
// needs — the same trap that blanked Global's debit volume. Each section skips its own
// total instead.
const NOISE = [
  /^Page\b/i, /^Nuvei\b/i, /^Merchant (No|Number|Name)/i,
  /^Description\b/i, /^Card Type\b/i,
  /^Items\b/i, /^Volume\b/i, /^Disc\b/i,
];

// Taxes are handled elsewhere in the comparison and are dropped from OTHER CHARGES
// entirely — leaving them in would double-count against the tax multiplier.
const TAX_ROW = /^(GST|HST|QST|PST|TPS|TVQ|TVH)\b|SALES TAX/i;

// The one genuine Interac pass-through in OTHER CHARGES.
const INTERAC_ROW = /INTERAC\s*NETWORK\s*ASSESSMENT|INTERAC\s*(SWITCH|INTERCHANGE)/i;

// Legitimate fixed / ad-hoc charges.
const FIXED_ROW = /(MONTHLY|STATEMENT|EQUIPMENT|RENTAL|TERMINAL|ACCOUNT|BATCH|GATEWAY|PORTAL|ANNUAL)/i;

// ⚠️ Real-time push-payment product names. These ARE real fee names — for a product a
// normal card-present merchant never uses, which is what makes them suspect here
// (confirmed on a real statement). They are routed into the BRAND audit table on purpose,
// so the resemblance to genuine network terminology sits side by side with the real thing
// rather than being filed away as a generic charge.
const PUSH_PAYMENT_ROW = /(MASTERCARD\s*SEND|VISA\s*DIRECT|PUSH\s*PAYMENT|ORIGINAL\s*CREDIT)/i;

// Network brand fees in OTHER CHARGES.
const BRAND_ROW = /(ASSESSMENT|NETWORK|ACQUIRER|LICEN|CLEARING|CROSS.?BORDER|BRAND|KILOBYTE|AUTHORIZATION)/i;

function detect(lines) {
  const K = headerKey(lines.map(foldPunct).join('\n'));
  // §4: "Nuvei" alone is not enough — their marketing and rate-card PDFs carry the name
  // too. One of the two statement-only section headers has to be present as well.
  if (!/NUVEI/.test(K)) return false;
  return /DEPOSIT SUMMARY/.test(K) || /RATES\s*&?\s*A?N?D?\s*FEES/.test(K);
}

function parse(lines) {
  const L = lines.map(foldPunct);
  // Les cellules du document voyagent avec les lignes normalisées : sans elles,
  // splitSections ne peut pas les transmettre au sommaire par type de carte.
  if (Array.isArray(lines && lines.cells)) L.cells = lines.cells;
  const notes = [];
  const sections = splitSections(L);

  const declaredFees = parseDepositSummary(sections.deposit);
  const cardTypes = parseCardTypeSummary(sections.cardType);
  const rateRows  = parseRatesAndFees(sections.rates);
  const other     = parseOtherCharges(sections.other);

  // ---- volume, by how the card is priced.
  const vol = {
    debit_count: sum(cardTypes, 'interac', 'count'),
    debit_amt:   sum(cardTypes, 'interac', 'volume'),
    visa_count:  sum(cardTypes, 'visa', 'count'),
    visa_amt:    sum(cardTypes, 'visa', 'volume'),
    mc_count:    sum(cardTypes, 'mc', 'count'),
    mc_amt:      sum(cardTypes, 'mc', 'volume'),
    amex_count:  sum(cardTypes, 'amex', 'count') + sum(cardTypes, 'discover', 'count'),
    amex_amt:    sum(cardTypes, 'amex', 'volume') + sum(cardTypes, 'discover', 'volume'),
  };

  // ---- markup: the Disc % and the Disc Per Item $ are two components, averaged
  // independently across each brand's sub-brand rows (Business / Debit / Prepaid).
  const rates = {
    debit: blend(cardTypes, ['interac']),
    visa:  blend(cardTypes, ['visa']),
    mc:    blend(cardTypes, ['mc']),
    amex:  blend(cardTypes, ['amex', 'discover']),
  };

  // ⚠️ Debit's markup comes from the DISCLOSED "$X/txn" per-item rate, never back-solved
  // from the row total. §4 records back-solving making the Debit markup vanish or multiply.
  const debitRows = cardTypes.filter((c) => c.brand === 'interac');
  if (debitRows.length) {
    const disclosed = debitRows.find((c) => Number.isFinite(c.perItem) && c.perItem > 0);
    rates.debit = { pct: rates.debit.pct, perItem: disclosed ? disclosed.perItem : 0 };
  }

  // ---- route the RATES & FEES rows. One table, two kinds of row.
  const interchangeItems = [];
  const brandItems = [];
  const interacItems = [];

  for (const row of rateRows) {
    const d = headerKey(row.desc);
    // ⚠️ "PCI" anywhere in a RATES & FEES row is hard SUSPECT even when it carries a
    // plausible % + volume basis: no card network publishes a PCI non-compliance fee. The
    // plausible basis is the point — it is what makes the charge look like a pass-through.
    if (/\bPCI\b/.test(d)) { brandItems.push(row); continue; }
    if (INTERAC_ROW.test(d) || /\bINTERAC\b/.test(d)) { interacItems.push(row); continue; }
    if (BRAND_ROW.test(d)) { brandItems.push(row); continue; }
    interchangeItems.push(row);
  }

  // ---- route OTHER CHARGES.
  const fixedRows = [];
  for (const row of other) {
    const d = headerKey(row.desc);
    if (TAX_ROW.test(d)) continue;
    if (PUSH_PAYMENT_ROW.test(d)) { brandItems.push(row); continue; }
    if (INTERAC_ROW.test(d)) { interacItems.push(row); continue; }
    if (/\bPCI\b/.test(d) || BRAND_ROW.test(d)) { brandItems.push(row); continue; }
    if (FIXED_ROW.test(d)) { fixedRows.push({ label: row.desc, qty: 1, unit: row.total, amount: row.total }); continue; }
    // Anything left carries money but matches nothing known — kept as a fixed charge so the
    // total still reconciles, rather than being dropped.
    fixedRows.push({ label: row.desc, qty: 1, unit: row.total, amount: row.total });
  }

  const line_audit = {
    interchange: buildLineAudit(interchangeItems, classifyInterchangeLine, { processor: 'nuvei' }),
    brand:       buildLineAudit(brandItems, classifyBrandLine, { processor: 'nuvei' }),
    interac:     buildLineAudit(interacItems, classifyInteracLine, { processor: 'nuvei' }),
  };

  const interchange = [...interchangeItems, ...brandItems, ...interacItems].reduce((s, r) => s + r.total, 0);

  const suspects = [...line_audit.interchange, ...line_audit.brand, ...line_audit.interac]
    .filter((r) => r.status === STATUS.SUSPECT);
  if (suspects.length) notes.push(N.note('suspectRows', { count: suspects.length, labels: suspects.map((s) => s.desc) }));

  const pushRows = brandItems.filter((r) => PUSH_PAYMENT_ROW.test(headerKey(r.desc)));
  if (pushRows.length) {
    notes.push(N.note('nuveiPushPayment', {
      count: pushRows.length,
      amount: pushRows.reduce((s, r) => s + r.total, 0),
      labels: pushRows.map((r) => r.desc),
    }));
  }

  // ---- reconcile against the deposit summary's own "Total Fees", the one figure on the
  // statement that covers everything this parser splits apart. Same cross-check Global,
  // Clover and Moneris each get.
  if (Number.isFinite(declaredFees)) {
    const markup = ['debit', 'visa', 'mc', 'amex'].reduce((t, b) => {
      const amt = b === 'debit' ? vol.debit_amt : vol[`${b}_amt`];
      const cnt = b === 'debit' ? vol.debit_count : vol[`${b}_count`];
      return t + amt * rates[b].pct + cnt * rates[b].perItem;
    }, 0);
    const parsedTotal = markup + interchange + fixedRows.reduce((t, f) => t + f.amount, 0);
    if (Math.abs(parsedTotal - declaredFees) > 0.02) {
      notes.push(N.note('reconcileMismatch', { parsed: parsedTotal, statement: declaredFees }));
    } else {
      notes.push(N.note('reconciled', { total: declaredFees }));
    }
  }

  notes.push(N.note('helpNuveiValueAdded'));

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

// The deposit summary's "Total Fees" line — the statement's own bottom line for everything
// this parser takes apart.
function parseDepositSummary(lines) {
  for (const raw of lines || []) {
    const m = foldPunct(raw).match(/^(?:Total Fees|Frais totaux|Total des frais)\s+(-?\$?[\d,]+\.\d{2})$/i);
    if (m) return Math.abs(parseNum(m[1]));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Les CELLULES suivent la section : le sommaire par type de carte ne se lit pas autrement
// (voir parseCardTypeSummary).
function splitSections(lines) {
  const out = {};
  const cells = {};
  for (const n of Object.keys(SECTIONS)) { out[n] = []; cells[n] = []; }
  const srcCells = Array.isArray(lines && lines.cells) ? lines.cells : null;
  let current = null;
  lines.forEach((raw, i) => {
    const hit = SECTION_KEYS.find((s) => s.keys.includes(squash(raw)));
    if (hit) { current = hit.name; return; }
    if (!current) return;
    if (NOISE.some((re) => re.test(raw))) return;
    out[current].push(raw);
    if (srcCells && srcCells[i]) cells[current].push(srcCells[i]);
    // ⚠️ UNE SECTION SE FERME SUR SON PROPRE TOTAL. Sans ça « OTHER CHARGES » restait
    // ouverte après « Total Other Charges » et avalait le « FEE SUMMARY » qui suit —
    // un récapitulatif des mêmes montants, d'où des frais fixes à 1 290,36 $ au lieu des
    // 263,69 $ imprimés. La ligne de total est conservée (la réconciliation en a besoin),
    // c'est ce qui vient APRÈS qui ne fait plus partie de la section.
    if (/^Total\s+(Rates|Other|Amount|Fees)/i.test(raw)) current = null;
  });
  if (srcCells) for (const n of Object.keys(SECTIONS)) out[n].cells = cells[n];
  return out;
}

// ---------------------------------------------------------------------------
// RATES & FEES — one table mixing interchange tiers and network assessments.
//
// ⚠️ FOUR row shapes, because pdf.js emits the description and the numeric columns on
// different physical lines when the columns are visually offset. All four turn up on real
// statements, so all four have to be handled or rows go missing silently:
//
//   A  description and numbers on ONE line      "VS CPS RETAIL 120 6,000.00 1.65% 99.00"
//   B  description ABOVE a numbers-only line    "VS CPS RETAIL" / "120 6,000.00 1.65% 99.00"
//   C  description BELOW a numbers-only line    "120 6,000.00 1.65% 99.00" / "VS CPS RETAIL"
//   D  numbers only, no description at all      → kept as "(sans description)" rather than
//      dropped, because the dollars are real and must still reconcile
// ---------------------------------------------------------------------------
// The rate column may or may not carry a literal '%' depending on the layout, so the sign
// is OPTIONAL. Requiring it matched nothing at all and silently emptied the whole section.
const NUMS_ONLY = /^(\d[\d,]*)\s+([\d,]+\.\d{2})\s+([\d.]+)\s*%?\s+(-?[\d,]+\.\d{2})$/;
const FULL_ROW  = /^(.+?)\s+(\d[\d,]*)\s+([\d,]+\.\d{2})\s+([\d.]+)\s*%?\s+(-?[\d,]+\.\d{2})$/;

// Lecture par CELLULES de la section RATES & FEES.
//
// ⚠️ LA DESCRIPTION EST COUPÉE AUTOUR DES NOMBRES, comme dans le sommaire par type de
// carte. Sur un vrai relevé Nuvei (2026-09-22) :
//
//     VS CA SMALL MERCHANT ELECTRONIC          <- début du libellé
//     0.77 % | $.00 | 284 | $5,564.23 | $43.03 <- les nombres
//     CGP NNSS                                 <- suite du libellé
//
// ⚠️ ET DEUX LARGEURS DE RANGÉE. Les lignes d'interchange portent une colonne « articles »,
// les évaluations n'en ont pas :
//
//     0.77 % | $.00 | 284 | $5,564.23 | $43.03   taux, par-article, articles, montant, total
//     0.09 % | $.00 | $7,781.50 | $7.00          taux, par-article, montant, total
//
// Compter les colonnes depuis la fin marcherait, mais on préfère VÉRIFIER : le total doit
// retomber sur montant × taux. C'est ce qui a validé chaque ligne ailleurs dans ce module,
// et ici ça confirme jusqu'aux évaluations — 7 781,50 × 0,09 % = 7,00, le total imprimé.
function parseRatesAndFeesCells(cellRows) {
  const out = [];
  let enAttente = null;
  const estMotSeul = (c) => c.length === 1 && /[A-Za-z]/.test(c[0]) && !/\d/.test(c[0]);

  for (const cells of cellRows || []) {
    const c = (cells || []).map(foldPunct).filter(Boolean);
    if (!c.length) continue;
    if (/^Total/i.test(c[0])) { enAttente = null; continue; }

    if (estMotSeul(c)) {
      const derniere = out[out.length - 1];
      if (!enAttente && derniere && derniere.attendSuite) {
        derniere.desc = (derniere.desc + ' ' + c[0]).trim();
        derniere.label = derniere.desc;
        derniere.attendSuite = false;
      } else {
        enAttente = c[0];
      }
      continue;
    }

    // La rangée numérique commence par le taux, qui porte le signe %.
    const iTaux = c.findIndex((x) => /%/.test(x));
    if (iTaux < 0) { continue; }

    // Le libellé est ce qui précède le taux sur la même rangée, sinon celui mis de côté.
    const enTete = c.slice(0, iTaux).join(' ').trim();
    const desc = enTete || enAttente;
    if (!desc) { enAttente = null; continue; }
    const venaitDAttente = !enTete;
    enAttente = null;

    const rate = parseNum(String(c[iTaux]).replace(/[%\s]/g, '')) / 100;
    const reste = c.slice(iTaux + 1)
      .filter((x) => NUM_CELL.test(x))
      .map((x) => parseNum(String(x).replace(/[$%]/g, '')));
    if (reste.length < 2) continue;

    // reste = [par-article, articles?, montant, total]
    const perItem = reste[0];
    const total = Math.abs(reste[reste.length - 1]);
    const volume = reste[reste.length - 2];
    const count = reste.length >= 4 ? reste[reste.length - 3] : 0;

    out.push({
      desc, label: desc, count, volume, rate, perItem, total,
      attendSuite: venaitDAttente,
      section: 'RATES & FEES',
    });
  }
  return out;
}

function parseRatesAndFees(lines) {
  // Les cellules d'abord : elles seules situent une description coupée autour des nombres.
  const cellRows = Array.isArray(lines && lines.cells) ? lines.cells : null;
  if (cellRows) {
    const viaCells = parseRatesAndFeesCells(cellRows);
    if (viaCells.length) return viaCells;
  }
  const rows = [];
  const L = lines || [];
  const used = new Set();

  for (let i = 0; i < L.length; i++) {
    if (used.has(i)) continue;
    const s = L[i];

    // Shape A — everything on one line.
    const full = s.match(FULL_ROW);
    if (full) {
      rows.push(makeRateRow(full[1], full[2], full[3], full[4], full[5]));
      used.add(i);
      continue;
    }

    const nums = s.match(NUMS_ONLY);
    if (!nums) continue;

    // Shapes B / C / D — a numbers-only line; the description is on a neighbouring line.
    const above = i > 0 && !used.has(i - 1) ? L[i - 1] : null;
    const below = i + 1 < L.length ? L[i + 1] : null;
    let desc = null;

    if (above && isDescriptionLine(above)) { desc = above; used.add(i - 1); }
    else if (below && isDescriptionLine(below)) { desc = below; used.add(i + 1); }

    rows.push(makeRateRow(desc || '(sans description)', nums[1], nums[2], nums[3], nums[4]));
    used.add(i);
  }
  return rows;
}

// A description line carries letters and no trailing numeric column of its own.
function isDescriptionLine(s) {
  const t = foldPunct(s);
  if (!t || !/[A-Za-z]/.test(t)) return false;
  if (NUMS_ONLY.test(t) || FULL_ROW.test(t)) return false;
  return !/\d[\d,]*\.\d{2}\s*$/.test(t);
}

function makeRateRow(desc, count, volume, pct, total) {
  const v = parseNum(volume);
  return {
    desc: foldPunct(desc),
    label: foldPunct(desc),
    count: parseNum(count),
    volume: v,
    rate: parseNum(pct) / 100,
    total: Math.abs(parseNum(total)),
    section: 'RATES & FEES',
  };
}

// ---------------------------------------------------------------------------
// OTHER CHARGES — "DESCRIPTION ... amount", with no rate or volume column.
// ---------------------------------------------------------------------------
function parseOtherCharges(lines) {
  const rows = [];
  for (const raw of lines || []) {
    const s = foldPunct(raw);
    // The section's own total is a rollup of the rows above it, not another charge.
    if (/^Total/i.test(s)) continue;
    const m = s.match(/^(.+?)\s+(-?\$?[\d,]+\.\d{2})$/);
    if (!m) continue;
    const total = Math.abs(parseNum(m[2]));
    if (!Number.isFinite(total)) continue;
    rows.push({ desc: m[1].trim(), label: m[1].trim(), count: 0, volume: 0, rate: null, total, section: 'OTHER CHARGES' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// CARD TYPE SUMMARY — per-brand count, volume, Disc %, Disc Per Item $.
//
// ⚠️ Sub-brand labels (Business / Debit / Prepaid) sometimes wrap the continuation word
// onto the NEXT physical line rather than the previous one, so the section is joined into
// ONE string and matched globally. Parsing it line by line loses whichever half of the
// label landed on the wrong side of the break.
// ---------------------------------------------------------------------------
const BRAND_WORD = '(?:Visa|VS|MasterCard|Mastercard|MC|Amex|American\\s+Express|AX|Discover|DSVR|Interac|IDP|Debit)';
const SUB_WORD = '(?:\\s+(?:Business|Debit|Prepaid|Corporate|Commercial|Infinite|World|Elite|Credit|Flash|Standard))*';
const CARD_ROW = new RegExp(
  `(${BRAND_WORD}${SUB_WORD})\\s+(\\d[\\d,]*)\\s+([\\d,]+\\.\\d{2})\\s+([\\d.]+)\\s*%?\\s+([\\d.]+)`, 'g');

// ⚠️ NUVEI IMPRIME « $.08 », PAS « $0.08 ». Un motif qui exige un chiffre juste après le
// signe de dollar écarte cette cellule — et c'est exactement celle de la majoration par
// article. Le reste de la rangée passait, la vérification arithmétique échouait faute de
// cette colonne, et la majoration ressortait NULLE : un relevé où le processeur ne gagne
// rien, ce qui n'arrive jamais.
const NUM_CELL = /^\$?-?(\d[\d,. ]*|\.\d+)%?$/;
const estMot = (x) => /[A-Za-z]/.test(x) && !/\d/.test(x);

function parseCardTypeSummaryCells(cellRows) {
  const out = [];
  // ⚠️ LE LIBELLÉ D'UNE MARQUE PEUT ÊTRE COUPÉ SUR TROIS RANGÉES :
  //     « Visa »   puis   « 9|$187.55|… »   puis   « Business »
  // Le PDF place le qualificatif SOUS la marque et les nombres entre les deux. Exiger la
  // marque dans la première cellule de la rangée numérique perdait Visa Business, Visa
  // Prepaid, MasterCard Debit, MasterCard Business et MasterCard Prepaid — cinq lignes de
  // volume absentes du total.
  let enAttente = null;
  for (const cells of cellRows || []) {
    const c = (cells || []).map(foldPunct).filter(Boolean);
    if (!c.length) continue;
    if (/^Total/i.test(c[0])) { enAttente = null; continue; }

    // Une rangée d'un seul mot est soit une marque qui attend ses nombres, soit le
    // qualificatif de la ligne qu'on vient d'émettre.
    if (c.length === 1 && estMot(c[0])) {
      const derniere = out[out.length - 1];
      if (!enAttente && derniere && derniere.attendQualificatif) {
        derniere.label = (derniere.label + ' ' + c[0]).trim();
        derniere.attendQualificatif = false;
      } else {
        enAttente = c[0];
      }
      continue;
    }

    const marqueEnTete = brandOf(c[0]);
    const label = marqueEnTete ? c[0] : enAttente;
    const brand = marqueEnTete || (enAttente ? brandOf(enAttente) : null);
    if (!brand) { enAttente = null; continue; }

    const corps = marqueEnTete ? c.slice(1) : c;
    const nums = corps.filter((x) => NUM_CELL.test(x))
      .map((x) => parseNum(String(x).replace(/[$%]/g, '')));
    const venaitDAttente = !marqueEnTete;
    enAttente = null;
    if (nums.length < 2) continue;

    let pct = 0;
    let perItem = 0;
    if (nums.length >= 5) {
      const parArticle = nums[nums.length - 3];
      const pourcent = nums[nums.length - 2] / 100;
      const escompte = nums[nums.length - 1];
      // L'arithmétique de la ligne valide la lecture : 7 158,50 × 0,15 % + 374 × 0,08 $
      // = 40,66, soit l'escompte imprimé juste à côté.
      const calcule = nums[1] * pourcent + nums[0] * parArticle;
      if (escompte > 0 && Math.abs(calcule - escompte) <= Math.max(0.05, escompte * 0.01)) {
        perItem = parArticle;
        pct = pourcent;
      }
    }
    out.push({
      label, brand, count: nums[0], volume: nums[1], pct, perItem,
      attendQualificatif: venaitDAttente,
    });
  }
  return out;
}

function parseCardTypeSummary(lines) {
  const cellRows = Array.isArray(lines && lines.cells) ? lines.cells : null;
  if (cellRows) {
    const viaCells = parseCardTypeSummaryCells(cellRows);
    if (viaCells.length) return viaCells;
  }
  const joined = (lines || []).map(foldPunct).join(' ').replace(/\s+/g, ' ');
  const out = [];
  let m;
  CARD_ROW.lastIndex = 0;
  while ((m = CARD_ROW.exec(joined)) !== null) {
    const label = m[1].trim();
    const brand = brandOf(label);
    if (!brand) continue;
    out.push({
      label, brand,
      count: parseNum(m[2]),
      volume: parseNum(m[3]),
      pct: parseNum(m[4]) / 100,
      perItem: parseNum(m[5]),
    });
  }
  return out;
}

function brandOf(label) {
  const k = headerKey(label);
  if (/^(INTERAC|IDP|DEBIT)\b/.test(k)) return 'interac';
  if (/^(VISA|VS)\b/.test(k)) return 'visa';
  if (/^(MASTERCARD|MC)\b/.test(k)) return 'mc';
  if (/^(AMEX|AMERICAN EXPRESS|AX)\b/.test(k)) return 'amex';
  if (/^(DISCOVER|DSVR)\b/.test(k)) return 'discover';
  return null;
}

function sum(cardTypes, brand, field) {
  return cardTypes.filter((c) => c.brand === brand).reduce((s, c) => s + (c[field] || 0), 0);
}

// % weighted by volume, $/item weighted by count — never merged into one effective rate.
function blend(cardTypes, brands) {
  let vr = 0, v = 0, cf = 0, c = 0;
  for (const row of cardTypes.filter((x) => brands.includes(x.brand))) {
    vr += (row.volume || 0) * (row.pct || 0);
    v  += (row.volume || 0);
    cf += (row.count || 0) * (row.perItem || 0);
    c  += (row.count || 0);
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

module.exports = {
  NAME, detect, parse, SECTIONS,
  parseRatesAndFees, parseOtherCharges, parseCardTypeSummary, parseDepositSummary, brandOf, blend,
};
