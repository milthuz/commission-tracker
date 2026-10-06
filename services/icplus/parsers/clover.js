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
// ⚠️ « DIGITAL COMM » est un frais de RÉSEAU, pas une charge fixe de Fiserv. Les deux
// lignes Visa Digital Commerce (CP et XBRD, 1,27 $ en juillet) tombaient faute de mot-clé
// dans les frais fixes — et la distinction n'est pas cosmétique : une charge fixe est un
// frais que Cluster REMPLACE par le sien, un frais de réseau est un transfert que Cluster
// paie aussi. Mal rangé, l'avantage annoncé au marchand est surévalué d'autant.
const BRAND_RE = /(VALUATION|ÉVALUATION|EVALUATION|ASSESSMENT|CROSS BORDER|IASF|ACQ CLEAR|CLEARING|CONNEC|CONNECTIVITY|VOLUME PERMIS|LICEN|NATL SETTLED|CARD BRAND|REDEV|DIGITAL COMM)/i;

// Generic fixed charges.
const FIXED_RE = /(EQUIPEMENT|EQUIPMENT|MENS\.|MONTHLY|LOCATION|RENTAL|RELEVÉ|STATEMENT)/i;

function detect(lines) {
  // §4 is explicit that this is a text-presence test, not a header match: the string turns
  // up reliably regardless of which language layout the statement uses.
  return lines.some((l) => /commercecontrol\.com/i.test(l));
}

function parse(lines) {
  const L = lines.map(foldPunct);

  // La mise en page 2026 se lit par un chemin entierement separe : voir le bloc en bas
  // de ce fichier pour pourquoi elle n'est PAS entrelacee avec l'ancienne.
  const newSummary = parseNewSummaryRows(L);
  if (newSummary.length) return parseNewLayout(L, newSummary);

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

// ============================================================================
// Mise en page 2026 — le « relevé repensé » de Fiserv.
//
// Fiserv a refondu le relevé à compter d'août 2026. Ce n'est pas un habillage : les
// données ont changé de place, de forme et de granularité. Un relevé neuf passé dans
// l'ancienne lecture ressortait détecté comme Clover avec DES ZÉROS PARTOUT — pire qu'une
// erreur, puisque la page affichait un comparatif d'apparence normale.
//
// ⚠️ Les deux lectures sont SÉPARÉES, pas entrelacées. Les anciens relevés circulent
// encore des mois après le changement, et la lecture ancienne est vérifiée au cent près
// contre de vrais documents. Un `if` de plus dans le chemin commun, c'est le risque de
// déplacer un chiffre sur un relevé qui marchait. Ici, rien de commun n'est touché :
// parse() bifurque une fois, au début, sur la présence d'une ligne du tableau §3.1.
//
// Vérifié contre Juillet-Saoko.pdf (07/2026), qui se referme ainsi :
//   majoration Fiserv      67,90 $   (0,15 % du crédit + 0,03 $/transaction Interac)
//   transfert réseau      427,39 $
//   -------------------------------
//   avant taxes           495,29 $   contre 495,23 $ imprimés (6 ¢ d'arrondi par ligne)
// ============================================================================

// §3.1 — « Résumé du traitement des cartes et des frais ».
//   AmexCredit 35 $881.70 0 $0.00 0.1500 0.0000 $18.71 2.12%
//   nom | art. vendus | montant | art. crédités | montant | escompte % | $/article |
//   frais totaux | taux effectif
//
// ⚠️ C'est AUSSI le test de mise en page. L'ancien relevé n'a jamais produit de ligne de
// cette forme : neuf champs dont trois préfixés d'un $. Un test sur la date ou sur un
// libellé se serait fait avoir par la version anglaise, que personne n'a encore vue.
const NEW_SUMMARY_RE = /^(.+?)\s+(\d+)\s+\$(-?[\d,]+\.\d{2})\s+(\d+)\s+\$(-?[\d,]+\.\d{2})\s+(-?[\d.]+)\s+(-?[\d.]+)\s+\$(-?[\d,]+\.\d{2})\s+(-?[\d.]+)%$/;

function parseNewSummaryRows(lines) {
  const out = [];
  for (const raw of lines || []) {
    const m = foldPunct(raw).match(NEW_SUMMARY_RE);
    if (!m) continue;
    const key = squash(m[1]).toUpperCase();
    // La ligne « Total » n'a que cinq colonnes et ne peut pas correspondre ; la garde
    // reste au cas où une mise en page future la remplirait.
    if (key === 'TOTAL') continue;
    out.push({
      key,
      label: m[1].trim(),
      // ⚠️ Le $/article se facture sur chaque ARTICLE TRAITÉ, remboursements compris —
      // le même comportement « deux jambes » relevé sur l'ancienne mise en page, où
      // compter les ventes seules laissait un écart de 4 ¢ contre le total imprimé. Sur
      // l'échantillon de juillet les crédits sont tous nuls, donc les deux lectures
      // donnent le même chiffre : cette règle-ci reste à confirmer sur un relevé qui a
      // des remboursements.
      count: parseNum(m[2]) + parseNum(m[4]),
      salesCount: parseNum(m[2]),
      amount: parseNum(m[3]) - parseNum(m[5]),
      pct: parseNum(m[6]) / 100,
      perItem: parseNum(m[7]),
      totalFees: Math.abs(parseNum(m[8])),
    });
  }
  return out;
}

// §3.2 — le tableau des frais facturés.
//   000075228 FRAIS DE VOLUME PERMIS DE MC Frais -$0.74
//   Interac Flash 428521123 INTERAC FRAIS DE COMM-FLASH Frais de service -$12.59
//
// Le numéro de facture à neuf chiffres ancre la ligne. L'en-tête de catégorie
// (« Interac Flash », « Visa », …) se colle parfois DEVANT, sur la même ligne.
//
// ⚠️ La colonne « Type » n'est pas décorative : « Frais » et « Frais de service » ne se
// routent pas pareil (voir routeNewFeeRow). Les mots anglais sont une CONJECTURE — aucun
// relevé anglais de la nouvelle mise en page n'a encore été vu.
const NEW_FEE_RE = /^(?:(.*?)\s+)?(\d{9})\s+(.+?)\s+(Frais de service|Service Fees?|Service Charges?|Frais|Fees?)\s+-?\$(-?[\d,]+\.\d{2})$/i;
const NEW_SERVICE_TYPE_RE = /^(Frais de service|Service Fees?|Service Charges?)$/i;

function parseNewFeeRows(lines) {
  const rows = [];
  for (const raw of lines || []) {
    const m = foldPunct(raw).match(NEW_FEE_RE);
    if (!m) continue;
    const total = Math.abs(parseNum(m[5]));
    if (!Number.isFinite(total)) continue;
    rows.push({
      group: (m[1] || '').trim(),
      invoice: m[2],
      desc: m[3].trim(),
      kind: NEW_SERVICE_TYPE_RE.test(m[4].trim()) ? 'service' : 'fee',
      total,
      rate: null, volume: 0, count: 0,
    });
  }
  return rows;
}

// §3.3 — « Frais d'interchange / frais de programme ».
//   MC-CAN ITR SM CONTACTLESS-WRLD $1,151.38 8% 41 8% 0.9300% 0.0000 %
//
// ⚠️ Le libellé est FACULTATIF. Les lignes Interac n'en portent pas — le nom de la marque
// est seul sur la ligne précédente — et une expression exigeant un libellé les perdait en
// silence. L'espace devant le dernier % est dans le document, pas une coquille.
const NEW_IC_RE = /^(?:(.+?)\s+)?\$(-?[\d,]+\.\d{2})\s+-?\d+%\s+(\d+)\s+-?\d+%\s+(-?[\d.]+)%\s+(-?[\d.]+)\s*%$/;

// Les en-têtes de marque, seuls sur leur ligne, au-dessus de leurs produits.
const NEW_IC_BRANDS = ['AMEXCREDIT', 'DISCOVERCREDIT', 'INTERAC', 'INTERACFLASH',
  'MASTERCARDCREDIT', 'MASTERCARDDEBIT', 'UPICREDIT', 'UPIDEBIT', 'VISADEBIT', 'VISACREDIT'];

function parseNewInterchange(lines) {
  const out = [];
  let brand = '';
  for (const raw of lines || []) {
    const s = foldPunct(raw);
    const sq = squash(s).toUpperCase();
    if (NEW_IC_BRANDS.includes(sq)) { brand = sq; continue; }
    // « AmexCredit Total $881.70 35 » ferme un groupe sans être un produit.
    if (/\bTOTAL\b/i.test(s) && !/-/.test(s)) continue;
    const m = s.match(NEW_IC_RE);
    if (!m) continue;
    const volume = parseNum(m[2]);
    const count = parseNum(m[3]);
    const rate = parseNum(m[4]) / 100;
    if (!Number.isFinite(volume) || !Number.isFinite(rate)) continue;
    out.push({
      desc: (m[1] || '').trim() || brand,
      brand,
      volume,
      count,
      rate,
      assessmentRate: parseNum(m[5]) / 100,
      // Le tableau publie le TAUX, pas les dollars. Le montant est reconstitué ; il se
      // vérifie contre les codes du tableau des frais (284,84 $ imprimés contre 284,90 $
      // reconstitués sur l'échantillon de juillet, soit 6 ¢ d'arrondi par ligne).
      total: round2(volume * rate),
    });
  }
  return out;
}

// Le nom du marchand suit la PREMIÈRE ligne de période, avec le numéro de magasin collé
// derrière : « SAOKO Numéro de magasin# 001 ».
//
// ⚠️ L'ancienne règle — la ligne après « Page 1 de N » — rend ici un NUMÉRO DE TÉLÉPHONE :
// la nouvelle mise en page a déplacé le bloc d'adresse.
function findNewMerchantName(lines) {
  const i = lines.findIndex((l) => /(PÉRIODE|PERIOD)\s*:/i.test(foldPunct(l))
    && /(Num[ée]ro de commer[çc]ant|Merchant Number)/i.test(foldPunct(l)));
  if (i < 0) return null;
  for (let j = i + 1; j < lines.length && j <= i + 3; j += 1) {
    const s = foldPunct(lines[j])
      .replace(/\s*(Num[ée]ro de magasin|Store Number)\s*#?.*$/i, '')
      .trim();
    if (/^[A-ZÀ-Ü0-9][A-ZÀ-Ü0-9 '&.\-]{2,}$/.test(s)) return s;
  }
  return null;
}

// Les lignes de type « Frais de service » qui sont des CODES D'INTERCHANGE (VSMELECONN,
// CANCNTLSSMCR, AC REST T1…) sont écartées À DESSEIN : ce sont les mêmes dollars que le
// tableau §3.3 reconstitue déjà à partir des taux publiés. Les compter des deux côtés
// doublerait l'interchange du marchand — et le comparatif annoncerait une économie qui
// n'existe pas. Ne survivent au filtre que les frais NOMMÉS, reconnaissables.
function routeNewFeeRow(row, buckets, summaryByKey, volumes) {
  const d = headerKey(row.desc);

  // La majoration de Fiserv, déjà reproduite par taux × volume du tableau §3.1.
  if (FISERV_MARKUP_RE.test(d)) { buckets.skippedMarkup += row.total; return; }

  if (/^INTERAC/i.test(row.desc)) {
    // -FLASH se rapporte au sans-contact, -CONTACT au débit à puce. Sans ce rattachement
    // la ligne n'a ni nombre ni volume, donc aucun $/transaction à confronter aux paliers
    // publiés : elle sortirait « À vérifier » sans catégorie.
    const src = /FLASH/i.test(row.desc) ? summaryByKey.INTERACFLASH : summaryByKey.INTERAC;
    buckets.interac.push({
      ...row,
      count: src ? src.count : 0,
      volume: src ? src.amount : 0,
      perItem: src && src.count > 0 ? row.total / src.count : null,
    });
    return;
  }

  // La redevance de marque : un pourcentage du volume de SA marque.
  if (/(REDEV.*CARTE|CARD BRAND FEE)/i.test(d)) {
    const base = /VISA|\bVI\b/i.test(row.desc) ? volumes.visa
      : /(MASTERCARD|\bMC\b)/i.test(row.desc) ? volumes.mc
        : /AMEX|AMERICAN/i.test(row.desc) ? volumes.amex : 0;
    buckets.brand.push({ ...row, volume: base, rate: base > 0 ? row.total / base : null });
    return;
  }

  if (BRAND_RE.test(d)) { buckets.brand.push(row); return; }

  // Un frais de type « Frais » qui n'est pas un frais de réseau nommé est une charge fixe
  // de Fiserv (location de terminal, relevé…). Aucune sur l'échantillon de juillet : ce
  // chemin n'est pas vérifié contre du vrai papier.
  if (row.kind === 'fee') {
    buckets.fixed.push({ label: row.desc, qty: 1, unit: row.total, amount: row.total });
    return;
  }

  // Code d'interchange : écarté, voir le commentaire au-dessus de la fonction.
  buckets.skippedInterchangeCodes += row.total;
}

function parseNewLayout(L, summary) {
  const notes = [];
  const summaryByKey = {};
  for (const r of summary) summaryByKey[r.key] = r;
  const S = (k) => summaryByKey[k] || null;
  const sum = (...keys) => keys.map(S).filter(Boolean);

  const take = (rows, field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
  const debitRows = sum('INTERAC', 'INTERACFLASH');
  const visaRows  = sum('VISACREDIT', 'VISADEBIT');
  const mcRows    = sum('MASTERCARDCREDIT', 'MASTERCARDDEBIT');
  const amexRows  = sum('AMEXCREDIT', 'DISCOVERCREDIT');

  // ⚠️ débit = UNIQUEMENT les rails Interac facturés au montant fixe par transaction.
  // Visa Debit est facturé au pourcentage du crédit et appartient donc à Visa — même
  // règle que l'ancienne mise en page, où l'avoir rangé en débit faussait le comparatif.
  const vol = {
    debit_count: take(debitRows, 'count'), debit_amt: take(debitRows, 'amount'),
    visa_count:  take(visaRows, 'count'),  visa_amt:  take(visaRows, 'amount'),
    mc_count:    take(mcRows, 'count'),    mc_amt:    take(mcRows, 'amount'),
    amex_count:  take(amexRows, 'count'),  amex_amt:  take(amexRows, 'amount'),
  };

  const asParts = (rows) => rows.map((r) => [{ pct: r.pct, perItem: r.perItem }, r.amount, r.count]);
  const rates = {
    debit: blend(asParts(debitRows)),
    visa:  blend(asParts(visaRows)),
    mc:    blend(asParts(mcRows)),
    amex:  blend(asParts(amexRows)),
  };

  const buckets = {
    interchange: [], brand: [], interac: [], fixed: [],
    skippedMarkup: 0, skippedInterchangeCodes: 0,
  };

  // L'interchange vient du tableau §3.3, jamais des codes du tableau des frais.
  for (const ic of parseNewInterchange(L)) {
    // Un taux nul ne coûte rien et n'apprend rien ; les lignes Interac sont toutes à zéro
    // ici, leur vrai coût étant dans les lignes nommées du tableau des frais.
    if (!(ic.rate > 0) || !(ic.total > 0)) continue;
    const row = { desc: ic.desc, rate: ic.rate, volume: ic.volume, count: ic.count, total: ic.total };
    // Amex n'a pas de table d'interchange publiée chez nous ; ses lignes se comparent aux
    // tables de frais de marque, comme sur l'ancienne mise en page.
    if (/^AMEX/i.test(ic.desc)) buckets.brand.push(row);
    else buckets.interchange.push(row);
  }

  const volumes = { visa: vol.visa_amt, mc: vol.mc_amt, amex: vol.amex_amt };
  for (const row of parseNewFeeRows(L)) routeNewFeeRow(row, buckets, summaryByKey, volumes);

  if (buckets.skippedMarkup > 0) {
    notes.push(N.note('fiservMarkupExcluded', { amount: buckets.skippedMarkup }));
  }

  const line_audit = {
    interchange: buildLineAudit(buckets.interchange, classifyInterchangeLine, { processor: 'clover' }),
    brand:       buildLineAudit(buckets.brand, classifyBrandLine, { processor: 'clover' }),
    interac:     buildLineAudit(buckets.interac, classifyInteracLine, { processor: 'clover' }),
  };

  const interchange = [...buckets.interchange, ...buckets.brand, ...buckets.interac]
    .reduce((s, r) => s + r.total, 0);

  const suspects = [...line_audit.interchange, ...line_audit.brand, ...line_audit.interac]
    .filter((r) => r.status === STATUS.SUSPECT);
  if (suspects.length) notes.push(N.note('suspectRows', { count: suspects.length, labels: suspects.map((s) => s.desc) }));

  const allNotes = [
    N.note('formatDetected', { processor: NAME, layoutSuffix: '' }),
    N.note('cloverNewLayout', {}),
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
      fixed_rows: buckets.fixed,
    },
    volume: vol,
    merchant_name: findNewMerchantName(L),
    line_audit,
    notes: allNotes,
    _note: N.renderAll(allNotes, 'fr'),
  };
}

const round = (v, d) => { const f = 10 ** d; return Math.round((Number(v) + Number.EPSILON) * f) / f; };
const round2 = (v) => round(v, 2);
// French decimal comma, to match the rest of the note text.
const fmt = (v) => round2(v).toFixed(2).replace('.', ',');

module.exports = {
  NAME, detect, parse, SECTIONS, parseCardTypes, parseGrossSales, blend,
  parseNewSummaryRows, parseNewFeeRows, parseNewInterchange, findNewMerchantName,
};
