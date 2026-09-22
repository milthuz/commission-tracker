// ============================================================================
// Moneris — TWO fully separate parsers behind one dispatch entry point (§4).
//
// ⚠️ WHY TWO FUNCTIONS AND NOT ONE WITH A LANGUAGE FLAG.
// The French and English layouts use different number formats (French: space thousands,
// comma decimal — English: comma thousands, period decimal) and different row wording. §4
// is explicit that they are kept apart "so a fix to one layout can never accidentally
// change the other", and that they must NOT be consolidated behind a language flag.
//
// Where the line is drawn here: everything that touches the PAPER — section headers, row
// regexes, number parsing, the Amex stitch — is duplicated per layout, on purpose. Only
// `assemble()` is shared, and it runs after both layouts have produced identical
// normalized rows, so it has nothing language-specific left to get wrong.
//
// ⚠️ NOT YET VERIFIED AGAINST A REAL STATEMENT. Global and Clover were each reconciled to
// the cent against real paper; no Moneris statement was available. The logic below follows
// §4 clause by clause and is covered by synthetic fixtures that exercise every documented
// quirk, but SECTION_FR / SECTION_EN in particular are the most likely thing to need
// correction — they are grouped at the top for exactly that reason. Reconcile against a
// real statement's section-6 rollup before trusting a number from this parser in front of
// a client.
// ============================================================================

const { parseNum, foldPunct, headerKey } = require('./util');
const {
  classifyInterchangeLine, classifyMonerisBrandLine, classifyInteracLine,
  buildLineAudit, STATUS,
} = require('../classify');
const N = require('../notes');

const NAME = 'Moneris';

// ---------------------------------------------------------------------------
// Section headers — the six fixed sections, in both layouts.
//
// Matched as "<number> <keyword>" after the whitespace collapse, which is what makes an
// anchored pattern like /^2\s+Interchange/ work at all: PDF extraction injects stray spaces
// into these headers and only the collapse in pdfLines.js makes them line up.
//
// ⚠️ Correct these first if a real statement misparses.
// ---------------------------------------------------------------------------
const SECTION_FR = [
  { n: 1, key: 'sales',      re: /^1\s+.*(SOMMAIRE DES VENTES|VENTES PAR TYPE)/i },
  { n: 2, key: 'interchange',re: /^2\s+.*(INTERCHANGE|ESCOMPTE DE GROS)/i },
  { n: 3, key: 'brand',      re: /^3\s+.*(EVALUATION|MARQUE DE CARTE)/i },
  { n: 4, key: 'transaction',re: /^4\s+.*(FRAIS DE TRANSACTION|TRANSACTION)/i },
  { n: 5, key: 'service',    re: /^5\s+.*(FRAIS DE SERVICE|SERVICE)/i },
  { n: 6, key: 'summary',    re: /^6\s+.*(SOMMAIRE DES FRAIS|RECAPITULATIF)/i },
];

const SECTION_EN = [
  { n: 1, key: 'sales',      re: /^1\s+.*(SALES SUMMARY|SUMMARY BY CARD)/i },
  { n: 2, key: 'interchange',re: /^2\s+.*(INTERCHANGE|WHOLESALE DISCOUNT)/i },
  { n: 3, key: 'brand',      re: /^3\s+.*(ASSESSMENT|CARD BRAND)/i },
  { n: 4, key: 'transaction',re: /^4\s+.*(TRANSACTION FEE)/i },
  { n: 5, key: 'service',    re: /^5\s+.*(SERVICE FEE)/i },
  { n: 6, key: 'summary',    re: /^6\s+.*(FEE SUMMARY)/i },
];

// ---------------------------------------------------------------------------
// Shared entry point — inspects the section-1 header and dispatches. This is the ONLY
// thing the two layouts have in common on the way in.
// ---------------------------------------------------------------------------
function detect(lines) {
  const K = headerKey(lines.map(foldPunct).join('\n'));
  if (!/MONERIS/.test(K)) return false;
  // A Moneris statement always carries at least the numbered section-1 header in one of the
  // two layouts; matching on the brand name alone would also catch their marketing PDFs.
  return SECTION_FR.some((s) => s.n === 1 && lines.some((l) => s.re.test(foldPunct(l))))
      || SECTION_EN.some((s) => s.n === 1 && lines.some((l) => s.re.test(foldPunct(l))));
}

function layoutOf(lines) {
  const s1fr = SECTION_FR.find((s) => s.n === 1);
  const s1en = SECTION_EN.find((s) => s.n === 1);
  for (const raw of lines) {
    const l = foldPunct(raw);
    if (s1fr.re.test(l)) return 'fr';
    if (s1en.re.test(l)) return 'en';
  }
  // No section-1 header found: fall back to the number format, which is the other reliable
  // discriminator between the two layouts.
  const joined = lines.join(' ');
  return /\d\s\d{3},\d{2}/.test(joined) ? 'fr' : 'en';
}

// `lines` may carry a `.cells` property (see pdfLines.js): one entry per row, holding the
// PDF's own column boundaries. When it is there, rows are rebuilt FROM the cells, so the
// line and its cells can never drift out of step.
function parseMonerisLines(lines) {
  const cells = Array.isArray(lines && lines.cells) ? lines.cells : null;
  const records = cells
    ? cells.map((c) => ({ line: foldPunct(c.join(' ')), cells: c }))
    : (lines || []).map((l) => ({ line: foldPunct(l), cells: null }));
  return layoutOf(records.map((r) => r.line)) === 'fr' ? parseFr(records) : parseEn(records);
}

// ===========================================================================
// FRENCH LAYOUT — space thousands, comma decimal. Self-contained.
// ===========================================================================
function parseFr(records) {
  const L = stitchAmexFr(records);
  const sections = splitSections(L, SECTION_FR);

  return assemble({
    layout: 'fr',
    merchantName: merchantNameFr(L),
    sales: salesFr(sections.sales),
    rows: {
      interchange: rowsFr(sections.interchange),
      brand:       rowsFr(sections.brand),
      transaction: rowsFr(sections.transaction),
      service:     rowsFr(sections.service),
    },
    summaryTotal: summaryTotal(sections.summary),
  });
}

// ⚠️ Amex's row wraps across THREE physical PDF lines — "American", the numbers, then
// "Express" — because the brand name is set on two visual lines and the row grouping puts
// each at its own Y. Re-stitch before anything else touches the rows, in BOTH layouts.
function stitchAmexFr(lines) { return stitchAmex(lines, /^American$/i, /^Express$/i); }
function stitchAmexEn(lines) { return stitchAmex(lines, /^American$/i, /^Express$/i); }

function stitchAmex(records, head, tail) {
  const out = [];
  for (let i = 0; i < records.length; i++) {
    const a = records[i], b = records[i + 1], c = records[i + 2];
    if (a && c && head.test(a.line) && tail.test(c.line)) {
      out.push({
        line: `American Express ${b ? b.line : ''}`.replace(/\s+/g, ' ').trim(),
        cells: b && b.cells ? ['American Express'].concat(b.cells) : null,
      });
      i += 2;
      continue;
    }
    out.push(a);
  }
  return out;
}

// French numbers: "56 789,01". The space is the thousands separator, so it must be removed
// BEFORE the row is split on whitespace, or one number becomes several tokens.
function deSpaceFr(line) {
  return line.replace(/(\d)[\s ](?=\d{3}(\D|$))/g, '$1');
}

function rowsFr(records) {
  const out = [];
  for (const rec of records || []) {
    if (isNoiseRow(rec.line)) continue;
    // Cells first: on this layout the collapsed line cannot be split reliably, because the
    // space is both the thousands separator and the column separator.
    const row = rec.cells ? extractRowCells(rec.cells, 'fr') : extractRow(deSpaceFr(rec.line), 'fr');
    if (row) out.push(row);
  }
  return out;
}

function salesFr(records) { return salesRows(records || [], 'fr'); }

function merchantNameFr(records) {
  for (const { line: l } of records) {
    const m = l.match(/^(Nom (?:du )?(?:commer[çc]ant|marchand))\s*:?\s*(.+)$/i);
    if (m && m[2].trim()) return m[2].trim();
  }
  return null;
}

// ===========================================================================
// ENGLISH LAYOUT — comma thousands, period decimal. Self-contained.
// ===========================================================================
function parseEn(records) {
  const L = stitchAmexEn(records);
  const sections = splitSections(L, SECTION_EN);

  return assemble({
    layout: 'en',
    merchantName: merchantNameEn(L),
    sales: salesEn(sections.sales),
    rows: {
      interchange: rowsEn(sections.interchange),
      brand:       rowsEn(sections.brand),
      transaction: rowsEn(sections.transaction),
      service:     rowsEn(sections.service),
    },
    summaryTotal: summaryTotal(sections.summary),
  });
}

function rowsEn(records) {
  const out = [];
  for (const rec of records || []) {
    if (isNoiseRow(rec.line)) continue;
    const row = rec.cells ? extractRowCells(rec.cells, 'en') : extractRow(rec.line, 'en');
    if (row) out.push(row);
  }
  return out;
}

function salesEn(records) { return salesRows(records || [], 'en'); }

function merchantNameEn(records) {
  for (const { line: l } of records) {
    const m = l.match(/^(Merchant Name|Business Name)\s*:?\s*(.+)$/i);
    if (m && m[2].trim()) return m[2].trim();
  }
  return null;
}

// ===========================================================================
// Row extraction, shared in SHAPE but fed pre-normalized text by each layout.
// ===========================================================================

// ⚠️ L'EN-TÊTE DE PAGE SE RÉPÈTE, ET IL RETOMBE AU MILIEU D'UNE SECTION. Sur un vrai
// relevé Moneris de trois pages, « Numéro de commerçant: 30111158912 » et « Numéro
// d'entreprise: … » réapparaissent à chaque page — donc à l'intérieur de la section 2,
// entre deux vraies lignes de frais. Pris pour des lignes de frais, ils ajoutaient
// 181 MILLIARDS de dollars à l'interchange.
//
// Le jeu d'essai synthétique tenait sur une page et n'avait aucun en-tête répété : c'est
// typiquement ce que seul du vrai papier révèle. « No de » couvrait déjà l'abréviation,
// pas la forme longue ni « Numéro d'entreprise ».
const NOISE_ROW = /^(Description|Total|Sous-total|Subtotal|Page\b|Moneris\b|Relev|Statement|Date\b|No de|Num[ée]ro d|Merchant No|Business No|Corporation Solutions)/i;
function isNoiseRow(s) { return !s || NOISE_ROW.test(s); }

// A row can disclose a % rate, a $/item rate, or BOTH:
//   "VISA - FRAIS DE TRANSACTION 1234 56789.01 0.20000% 0.015000$/item 132.09"
//
// ⚠️ The two components are captured SEPARATELY and never collapsed into one effective
// rate. §4 records the exact bug: dividing the row total by volume reproduces the right
// dollars while matching NEITHER number printed on the statement, which is what produced
// the "you are showing 0.23 % that does not match the statement" report.
function extractRow(line, layout) {
  const s = String(line).trim();

  const pctM     = s.match(/(-?[\d.,]+)\s*%/);
  const perItemM = s.match(/(-?[\d.,]+)\s*\$?\s*\/\s*(?:item|unit[ée]|trans)/i);

  // Strip the rate tokens, then read the remaining numeric columns.
  let rest = s;
  if (pctM) rest = rest.replace(pctM[0], ' ');
  if (perItemM) rest = rest.replace(perItemM[0], ' ');
  rest = rest.replace(/\s+/g, ' ').trim();

  const tokens = rest.split(' ');
  const nums = [];
  let i = tokens.length - 1;
  while (i >= 0 && /^[-(]?[\d.,]+\)?\$?$/.test(tokens[i]) && /\d/.test(tokens[i])) {
    nums.unshift(parseNum(tokens[i]));
    i--;
  }
  const label = tokens.slice(0, i + 1).join(' ').trim();
  if (!label || !nums.length) return null;

  // Trailing column is always the dollar total; a count and a volume may precede it.
  const total = nums[nums.length - 1];
  const count = nums.length >= 3 ? nums[0] : (nums.length === 2 ? nums[0] : 0);
  const volume = nums.length >= 3 ? nums[1] : (nums.length === 2 ? 0 : 0);

  return {
    desc: label,
    label,
    count: Number.isFinite(count) ? count : 0,
    volume: Number.isFinite(volume) ? volume : 0,
    pct: pctM ? parseNum(pctM[1]) / 100 : null,
    perItem: perItemM ? parseNum(perItemM[1]) : null,
    total: Number.isFinite(total) ? Math.abs(total) : 0,
    layout,
  };
}

// Cell-based extraction. Each cell is exactly one column as the PDF laid it out, so the
// label, the count, the volume and the two rate components cannot bleed into each other —
// which is the entire reason cells exist for this layout.
// \u26a0\ufe0f MONTANT ET NOMBRE D'ARTICLES NE SONT PAS DANS LE M\u00caME ORDRE SELON LA SECTION.
//
// Mesur\u00e9 sur un vrai relev\u00e9 Moneris (2026-09-22), et c'est l'inverse de ce que le jeu
// d'essai synth\u00e9tique supposait :
//
//   section 1, ventes    \u00ab Interac | 661 | 29 751,46 | \u2026 \u00bb      -> ARTICLES puis MONTANT
//   sections 2 \u00e0 4, frais \u00ab CAN-CE01 \u2026 | 27 381,66 | 522 | \u2026 \u00bb  -> MONTANT puis ARTICLES
//
// Les deux rang\u00e9es portent huit cellules, donc leur nombre ne les distingue pas. Ce qui
// les distingue sans ambigu\u00eft\u00e9, c'est le S\u00c9PARATEUR D\u00c9CIMAL : un montant s'imprime
// toujours avec ses deux d\u00e9cimales (\u00ab 27 381,66 \u00bb, \u00ab 1 000,00 \u00bb), un compte d'articles
// jamais. On tranche donc sur le TEXTE BRUT de la cellule, pas sur le nombre une fois
// converti \u2014 \u00ab 1 000,00 \u00bb converti vaut 1000, un entier, et la distinction serait perdue.
//
// Ce que l'inversion co\u00fbtait : le compte d'articles \u00e9tait pris pour le volume, le taux
// imprim\u00e9 ignor\u00e9, et un taux faux recalcul\u00e9 \u00e0 partir du total. Sur CAN-CE01, 1,25 % devenait
// 0,6556 %.
const HAS_DECIMALS = /[.,]\d{2}\s*\)?\$?$/;

function extractRowCells(cells, layout) {
  const labelParts = [];
  const nums = [];       // valeurs converties, dans l'ordre des colonnes
  const rawNums = [];    // leur texte d'origine, pour trancher montant / compte
  let pct = null;
  let perItem = null;

  for (const raw of cells) {
    const c = foldPunct(raw);
    if (!c) continue;
    if (/\d/.test(c) && /%\s*$/.test(c)) { pct = parseNum(c.replace(/%\s*$/, '')) / 100; continue; }
    if (/\/\s*(item|unite|unitee|unit\u00e9|trans)/i.test(c)) {
      perItem = parseNum(c.replace(/\$?\s*\/\s*\w+.*$/i, ''));
      continue;
    }
    if (/\d/.test(c) && /^[-(]?[\d][\d\s.,\u00a0]*\)?\$?$/.test(c)) { nums.push(parseNum(c)); rawNums.push(c); continue; }
    if (!nums.length) labelParts.push(c);
  }

  const label = labelParts.join(' ').trim();
  if (!label || !nums.length) return null;

  let count = 0;
  let volume = 0;
  if (nums.length >= 2) {
    const premierEstMontant = HAS_DECIMALS.test(rawNums[0]);
    const secondEstMontant = HAS_DECIMALS.test(rawNums[1]);
    if (premierEstMontant && !secondEstMontant) { volume = nums[0]; count = nums[1]; }
    else { count = nums[0]; volume = nums[1]; }
  }

  // \u26a0\ufe0f LES COLONNES DE TAUX N'ONT NI \u00ab % \u00bb NI \u00ab /article \u00bb SUR LE VRAI RELEV\u00c9 : elles
  // s'impriment nues (\u00ab 1.25000 \u00bb, \u00ab 0,035000 \u00bb). Sans \u00e7a le taux imprim\u00e9 \u00e9tait perdu, et
  // le classificateur en recalculait un depuis le total \u2014 c'est-\u00e0-dire qu'il v\u00e9rifiait le
  // relev\u00e9 contre lui-m\u00eame au lieu de le v\u00e9rifier contre la carte de taux publi\u00e9e.
  //
  // Sur la grille de huit colonnes des sections de frais, le taux suit imm\u00e9diatement le
  // couple montant/articles, et le montant par article le suit.
  if (pct === null && perItem === null && nums.length >= 4) {
    const tauxPct = nums[2];
    const tauxArticle = nums[3];
    // Un taux d'interchange s'exprime en pourcentage sur un relev\u00e9 : 1.25 vaut 1,25 %.
    if (Number.isFinite(tauxPct) && tauxPct > 0 && tauxPct < 100) pct = tauxPct / 100;
    if (Number.isFinite(tauxArticle) && tauxArticle > 0 && tauxArticle < 10) perItem = tauxArticle;
  }

  const total = nums[nums.length - 1];
  return {
    desc: label, label,
    count, volume, pct, perItem,
    total: Number.isFinite(total) ? Math.abs(total) : 0,
    layout,
  };
}

// Section 1 — sales by card type.
function salesRows(records, layout) {
  const out = { debit: z(), visa: z(), mc: z(), amex: z(), discover: z() };
  for (const rec of records) {
    if (isNoiseRow(rec.line)) continue;
    const row = rec.cells
      ? extractRowCells(rec.cells, layout)
      : extractRow(layout === 'fr' ? deSpaceFr(rec.line) : rec.line, layout);
    if (!row) continue;
    const b = brandOf(row.label);
    if (!b) continue;
    // A sales row is "<brand> <count> <amount>": count first, amount last.
    out[b] = { count: row.count || 0, amt: row.volume || row.total || 0 };
  }
  return out;
}

function z() { return { count: 0, amt: 0 }; }

function splitSections(records, map) {
  const out = {};
  for (const s of map) out[s.key] = [];
  let current = null;
  for (const rec of records) {
    const hit = map.find((s) => s.re.test(rec.line));
    if (hit) { current = hit.key; continue; }
    if (!current) continue;
    out[current].push(rec);
  }
  return out;
}

// Section 6 is the authoritative rollup and is used only to cross-check the rest.
function summaryTotal(records) {
  let total = null;
  for (const rec of records || []) {
    const m = foldPunct(rec.line).match(/^(Total|TOTAL|Grand total)\s+(.+)$/i);
    if (!m) continue;
    const v = parseNum(m[2].replace(/(\d)[\s ](?=\d{3}(\D|$))/g, '$1'));
    if (Number.isFinite(v)) total = Math.abs(v);
  }
  return total;
}

// ===========================================================================
// Brand routing
// ===========================================================================

// ⚠️ Discover has NO dedicated field in this data model: its volume and markup fold into
// Visa throughout. That has to be stated in the parser note, not just here, because a rep
// reading a Visa figure is also reading Discover.
function brandOf(label) {
  const k = headerKey(label);
  if (/^(IDP|INTERAC|DEBIT|DEBIT INTERAC)\b/.test(k) || /\bINTERAC\b/.test(k)) return 'debit';
  if (/^(VS|VISA)\b/.test(k)) return 'visa';
  if (/^(MC|MASTERCARD)\b/.test(k)) return 'mc';
  if (/^(AX|AMEX|AMERICAN EXPRESS)\b/.test(k)) return 'amex';
  if (/^(DS|DISCOVER)\b/.test(k)) return 'discover';
  return null;
}

// ⚠️ Interac product codes in section 4 never literally contain the word "Interac"
// ("CAN-ZTI3 FLASH STAND NIVEAU 3"). They must be prefixed before classification, or the
// shared classifier's word gate never fires and a real pass-through row is lost.
const INTERAC_CODE_RE = /^(CAN-?Z[A-Z0-9]+|IDP\b|.*\bFLASH\b.*(STAND|NIVEAU|PALIER|TIER))/i;

function isInteracCode(label) {
  return INTERAC_CODE_RE.test(headerKey(label));
}

// ⚠️ Section 4 is NOT purely Moneris's own markup. Reconciling section 6's rollup — which
// equals section 2 + section 3 exactly — leaves zero room for a section-4 network row, so
// any genuine network fee sitting here has to be moved OUT of the markup total and INTO
// interchange. The discriminator §4 gives is the presence of the word "TRANSACTION" in the
// label: rows carrying it are Moneris's per-transaction markup, rows without it are network
// pass-through wearing a markup-section disguise.
function isSection4Markup(label) {
  return /\bTRANSACTION\b/i.test(headerKey(label));
}

// ===========================================================================
// assemble — runs on normalized rows only, so nothing here is language-specific.
// ===========================================================================
function assemble(p) {
  const notes = [];
  const sales = p.sales;

  // Discover folds into Visa everywhere.
  const vol = {
    debit_count: sales.debit.count, debit_amt: sales.debit.amt,
    visa_count:  sales.visa.count + sales.discover.count,
    visa_amt:    sales.visa.amt + sales.discover.amt,
    mc_count:    sales.mc.count, mc_amt: sales.mc.amt,
    amex_count:  sales.amex.count, amex_amt: sales.amex.amt,
  };

  // ---- split section 4.
  const s4markup = [];
  const s4network = [];
  for (const row of p.rows.transaction) {
    (isSection4Markup(row.label) ? s4markup : s4network).push(row);
  }

  // ---- markup, per brand, two components tracked independently.
  const acc = {};
  for (const b of ['debit', 'visa', 'mc', 'amex']) acc[b] = { vr: 0, v: 0, cf: 0, c: 0 };
  let unattributed = 0;

  for (const row of s4markup) {
    let b = brandOf(row.label);
    if (b === 'discover') b = 'visa';        // no dedicated Discover field
    if (!b) { unattributed += row.total; continue; }
    acc[b].vr += (row.volume || 0) * (row.pct || 0);
    acc[b].v  += (row.volume || 0);
    acc[b].cf += (row.count || 0) * (row.perItem || 0);
    acc[b].c  += (row.count || 0);
  }

  const rates = {};
  for (const b of Object.keys(acc)) {
    rates[b] = {
      // Volume-weighted for the %, count-weighted for the $/item — never one blended rate.
      pct: acc[b].v > 0 ? acc[b].vr / acc[b].v : 0,
      perItem: acc[b].c > 0 ? acc[b].cf / acc[b].c : 0,
    };
  }

  // ⚠️ Section-4 rows with no clean brand prefix are prorated across Visa and Mastercard by
  // their own dollar-volume share, rather than being dropped or parked arbitrarily on one
  // brand. Kept as a dollar adjustment, not folded into a rate, so the displayed rates stay
  // the ones printed on the statement.
  let unattributedSplit = null;
  if (unattributed > 0) {
    const base = vol.visa_amt + vol.mc_amt;
    unattributedSplit = base > 0
      ? { visa: unattributed * (vol.visa_amt / base), mc: unattributed * (vol.mc_amt / base) }
      : { visa: unattributed, mc: 0 };
    notes.push(N.note('monerisUnattributed', { amount: unattributed }));
  }

  // ---- audit rows.
  // Interac codes get their prefix so the shared classifier's word gate fires.
  const interacRows = s4network.filter((r) => isInteracCode(r.label))
    .map((r) => ({ ...r, desc: `Interac ${r.desc}`, rawDesc: r.desc }));
  const networkRows = s4network.filter((r) => !isInteracCode(r.label));

  const line_audit = {
    interchange: buildLineAudit(p.rows.interchange.map(withRate), classifyInterchangeLine, { processor: 'moneris' }),
    brand:       buildLineAudit([...p.rows.brand, ...networkRows].map(withRate), classifyMonerisBrandLine, { processor: 'moneris' }),
    interac:     buildLineAudit(interacRows.map(withRate), classifyInteracLine, { processor: 'moneris' }),
  };

  // ---- interchange total: section 2 + section 3 + the network rows rescued from section 4.
  const s2 = sum(p.rows.interchange);
  const s3 = sum(p.rows.brand);
  const s4net = sum(s4network);
  const interchange = s2 + s3 + s4net;

  // ---- fixed fees from section 5.
  const fixedRows = p.rows.service.map((r) => ({ label: r.desc, qty: r.count || 1, unit: r.count ? r.total / r.count : r.total, amount: r.total }));

  // ---- reconciliation against section 6, which is the authoritative rollup.
  if (Number.isFinite(p.summaryTotal)) {
    const expected = s2 + s3;
    if (Math.abs(expected - p.summaryTotal) > 0.02) {
      notes.push(N.note('reconcileMismatch', { parsed: expected, statement: p.summaryTotal }));
    } else {
      notes.push(N.note('reconciled', { total: p.summaryTotal }));
    }
  }

  const suspects = [...line_audit.interchange, ...line_audit.brand, ...line_audit.interac]
    .filter((r) => r.status === STATUS.SUSPECT);
  if (suspects.length) notes.push(N.note('suspectRows', { count: suspects.length, labels: suspects.map((s) => s.desc) }));

  if (sales.discover.count || sales.discover.amt) notes.push(N.note('helpDiscoverFoldedIntoVisa'));
  notes.push(N.note('monerisServiceSectionWarning'));

  const allNotes = [
    N.note('formatDetected', { processor: NAME, layoutSuffix: p.layout === 'fr' ? ' (français)' : ' (anglais)' }),
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
      unattributed_split: unattributedSplit,
    },
    volume: vol,
    merchant_name: p.merchantName,
    line_audit,
    notes: allNotes,
    _note: N.renderAll(allNotes, p.layout === 'en' ? 'en' : 'fr'),
    _layout: p.layout,
  };
}

// A row's applied rate for classification: the disclosed % when there is one, otherwise
// derived from the dollars.
function withRate(r) {
  return { ...r, rate: r.pct != null ? r.pct : (r.volume > 0 ? r.total / r.volume : null) };
}

const sum = (rows) => (rows || []).reduce((s, r) => s + (r.total || 0), 0);
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

module.exports = {
  NAME, detect, parse: parseMonerisLines, parseMonerisLines,
  layoutOf, SECTION_FR, SECTION_EN,
  brandOf, isInteracCode, isSection4Markup, extractRow, extractRowCells, stitchAmex, deSpaceFr,
};
