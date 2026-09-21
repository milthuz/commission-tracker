// ============================================================================
// IC+ fee-comparison calculator — the shared classification engine (§3 of the scope).
//
// Takes ONE extracted fee line (description + rate + basis) and decides which real rate
// category it belongs to, or flags it as unrecognized / suspect.
//
// ⚠️ This is the single shared module. Processor-specific behaviour WRAPS it — see
// classifyGlobalInterchangeLine and classifyMonerisBrandLine at the bottom for the
// established pattern: intercept one known edge case, fall through to the shared
// classifier for everything else. Never fork this file per processor, and never "fix" a
// processor's quirk by editing the shared rate tables: per standing instruction, a
// Moneris fix must not be able to silently change Global, Payfacto or anything else.
//
// Any change in here is a change to every processor at once, so per §9.4 it has to be
// regression-tested against every processor's cached statements before shipping, not
// just the one being worked on.
// ============================================================================

const {
  RATE_TABLES, SUSPECT_LABELS,
  GLOBAL_INTERCHANGE_ALIASES, GLOBAL_BRAND_ALIASES,
} = require('./rateTables');

// The six statuses a classified line can carry. Nothing outside this object may invent
// a seventh — the UI badge styling and the calc engine both switch on these exact values.
const STATUS = {
  // Matches a known published rate exactly.
  CONFORME:   'Conforme',
  // Plausible but unconfirmed — a name match without an exact rate, or the reverse.
  A_VERIFIER: 'A vérifier',
  // Charged under a name that corresponds to no real network fee.
  SUSPECT:    'SUSPECT',
  // Out of scope for this comparison.
  HORS:       'Hors périmètre',
  // The processor's own markup, not a network pass-through. Excluded from the displayed
  // network-fee audit table.
  MARKUP:     'Markup processeur',
  // No itemized data was available; a reasonable estimate was substituted. Always tagged.
  ESTIME:     'Estimé',
};

// Default tolerances, from §3. Exported so a caller can tighten them for a format known
// to print more decimals, but no caller should loosen them casually: epsilon is what
// separates 0.0900 % (real) from 0.1017 % (inflated).
const DEFAULT_EPSILON   = 0.00006;
const DEFAULT_MIN_RATIO = 0.75;
const DEFAULT_MIN_WORDS = 2;

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

// Accents stripped, uppercased, punctuation to spaces, whitespace collapsed. Statement
// text arrives in both languages and with PDF-injected stray spaces, so every comparison
// in this file goes through here first.
function norm(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9%$./-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words too common to count as evidence of a match. "FRAIS"/"FEE" appear in essentially
// every line on every statement, so letting them satisfy minWords would make the word
// gate meaningless.
const STOPWORDS = new Set([
  'FRAIS', 'FEE', 'FEES', 'DE', 'DES', 'DU', 'LA', 'LE', 'LES', 'ET', 'AND', 'OR', 'OU',
  'PAR', 'PER', 'SUR', 'ON', 'THE', 'A', 'AU', 'AUX', 'D', 'L', 'CHARGE', 'CHARGES',
  'TOTAL', 'CARD', 'CARTE',
]);

function significantWords(s) {
  return norm(s).split(' ').filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// Sørensen–Dice coefficient over character bigrams: 0 (nothing in common) to 1 (identical).
// Chosen because it is stable against word-order differences and the French/English
// phrasing drift between layouts, which plain equality and prefix matching both fail on.
function similarity(a, b) {
  const A = norm(a).replace(/ /g, '');
  const B = norm(b).replace(/ /g, '');
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return 0;

  const bigrams = new Map();
  for (let i = 0; i < A.length - 1; i++) {
    const g = A.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < B.length - 1; i++) {
    const g = B.slice(i, i + 2);
    const n = bigrams.get(g) || 0;
    if (n > 0) { bigrams.set(g, n - 1); hits++; }
  }
  return (2 * hits) / (A.length - 1 + B.length - 1);
}

// Does the line's description corroborate this category by sharing real words with it?
// This is the gate that keeps a `weak` rate entry from matching on its number alone.
function keywordOverlap(desc, cat, minWords = DEFAULT_MIN_WORDS) {
  const d = new Set(significantWords(desc));
  if (!d.size) return 0;
  let shared = 0;
  for (const w of new Set(significantWords(cat))) if (d.has(w)) shared++;
  return shared >= minWords ? shared : 0;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Brand guard
//
// ⚠️ Visa's and Mastercard's domestic assessments carry the SAME published rate (0.0900 %).
// Rate proximity alone therefore cannot tell them apart, and whichever entry sits first in
// the table wins — which is how a real statement's "MC ASMTS" row came back labelled as a
// Visa fee. A match whose brand contradicts the line's own brand word is always wrong, so
// it is rejected outright rather than ranked lower.
//
// Deliberately conservative: only explicit brand tokens count. A code like VIBS is a Visa
// category, but inferring brands from code prefixes belongs in a processor's alias
// dictionary, not in the shared guard.
// ---------------------------------------------------------------------------
const BRAND_TOKENS = [
  ['visa',    /(^| )(VISA|VS)( |$)/],
  ['mc',      /(^| )(MC|MASTERCARD)( |$)/],
  ['amex',    /(^| )(AMEX|AMERICAN EXPRESS)( |$)/],
  ['interac', /(^| )(INTERAC|IDP)( |$)/],
];

function brandsIn(text) {
  // "/" separates brands rather than joining them — both "Visa/Mastercard — assessment
  // transfrontalier" and "VISA/MC - CARD BRAND MAINTENANCE" name two brands, and without
  // this split neither token sits at a space boundary so the row reads as brandless.
  const t = norm(text).replace(/\//g, ' ');
  const out = new Set();
  for (const [brand, re] of BRAND_TOKENS) if (re.test(t)) out.add(brand);
  return out;
}

// A line and a category conflict when both name brands and they share none. When either
// side names no brand, there is nothing to contradict and the match is allowed through.
function brandConflict(desc, cat) {
  const a = brandsIn(desc);
  const b = brandsIn(cat);
  if (!a.size || !b.size) return false;
  for (const x of a) if (b.has(x)) return false;
  return true;
}

function tableList(tables) {
  if (!tables) return [];
  if (Array.isArray(tables)) {
    // Either an array of entries, or an array of tables.
    return tables.length && Array.isArray(tables[0]) ? tables.flat() : tables;
  }
  if (typeof tables === 'object') return Object.values(tables).flat();
  return [];
}

// Scan one or more rate tables for an entry within `epsilon` of `rate`.
//
// A `weak`-flagged entry additionally requires keyword overlap with `desc` before it can
// be accepted — those rates are known to collide with unrelated fee categories, so a bare
// numeric hit on one is not evidence of anything.
function matchByRate(rate, tables, epsilon = DEFAULT_EPSILON, desc = '') {
  if (!Number.isFinite(rate)) return null;
  const rows = tableList(tables);
  let best = null;

  for (const entry of rows) {
    if (!entry || !Number.isFinite(entry.rate)) continue;
    // ⚠️ A PER-ITEM entry carries rate 0 (Interac Flash is $0.035 a transaction, not a
    // percentage of volume). Left in, every statement row whose rate is 0 — and there are
    // many — would match it exactly, and the audit would confidently label an unrelated
    // fee as "Interac Flash tier 3". Per-item entries are matched by matchByPerItem.
    if (entry.rate === 0 && Number.isFinite(entry.perItem) && entry.perItem > 0) continue;
    const delta = Math.abs(entry.rate - rate);
    if (delta > epsilon) continue;
    if (brandConflict(desc, entry.cat)) continue;
    if (entry.weak && !keywordOverlap(desc, entry.cat)) continue;
    if (!best || delta < best.delta) best = { entry, delta };
  }
  return best ? { ...best.entry, matchedBy: 'rate', distance: best.delta } : null;
}

// The same search against the $/item component.
//
// ⚠️ Kept separate from matchByRate rather than folded into it. The two are different
// units — a fraction of volume versus dollars per transaction — and one epsilon cannot
// serve both: 0.00006 is a sane tolerance on a rate and absurd on a fee where the real
// values run 0.015 to 0.055. A tenth of a cent is the right granularity here.
const DEFAULT_PER_ITEM_EPSILON = 0.0001;

function matchByPerItem(perItem, tables, epsilon = DEFAULT_PER_ITEM_EPSILON, desc = '') {
  if (!Number.isFinite(perItem) || perItem <= 0) return null;
  const rows = tableList(tables);
  let best = null;

  for (const entry of rows) {
    if (!entry || !Number.isFinite(entry.perItem) || entry.perItem <= 0) continue;
    const delta = Math.abs(entry.perItem - perItem);
    if (delta > epsilon) continue;
    if (brandConflict(desc, entry.cat)) continue;
    if (entry.weak && !keywordOverlap(desc, entry.cat)) continue;
    if (!best || delta < best.delta) best = { entry, delta };
  }
  return best ? { ...best.entry, matchedBy: 'perItem', distance: best.delta } : null;
}

// Fuzzy description match against each table entry's category label. Requires BOTH a
// similarity ratio >= minRatio AND at least minWords overlapping significant words —
// the ratio alone lets long generic labels drift into each other.
//
// `appliedRate`, when given, is used only to break ties between equally-similar
// categories: the one whose published rate is closest to what was actually billed wins.
function matchByName(desc, tables, minRatio = DEFAULT_MIN_RATIO, appliedRate = null, minWords = DEFAULT_MIN_WORDS) {
  if (!desc) return null;
  const rows = tableList(tables);
  let best = null;

  for (const entry of rows) {
    if (!entry || !entry.cat) continue;
    if (brandConflict(desc, entry.cat)) continue;
    if (!keywordOverlap(desc, entry.cat, minWords)) continue;
    const ratio = similarity(desc, entry.cat);
    if (ratio < minRatio) continue;

    const rateGap = Number.isFinite(appliedRate) && Number.isFinite(entry.rate)
      ? Math.abs(entry.rate - appliedRate) : Infinity;

    if (!best || ratio > best.ratio || (ratio === best.ratio && rateGap < best.rateGap)) {
      best = { entry, ratio, rateGap };
    }
  }
  return best ? { ...best.entry, matchedBy: 'name', ratio: best.ratio } : null;
}

// ---------------------------------------------------------------------------
// SUSPECT detection
// ---------------------------------------------------------------------------

// Hard SUSPECT: the fee NAME has no counterpart among real network fees, whatever rate or
// basis the statement discloses beside it. Checked before any rate matching, because the
// whole point of these names is that they carry a plausible-looking basis.
function suspectLabel(desc, processor) {
  const d = norm(desc);
  if (!d) return null;
  const lists = [SUSPECT_LABELS.shared, SUSPECT_LABELS[processor] || []];
  for (const list of lists) {
    for (const label of list) {
      const l = norm(label);
      // Word-boundary-ish containment: bare "PCI" must not match "PCIX" or a merchant
      // name that happens to contain the letters.
      if (d === l || new RegExp(`(^| )${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`).test(d)) {
        return label;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Interac tier recognition
//
// ⚠️ Roman numerals are NOT cosmetic. Payfacto prints "Palier II" and English Moneris
// prints "TIER I"; a tier row that fails this test falls to "Markup processeur", which the
// UI then filters out of the Interac audit table entirely — silently dropping a real
// pass-through fee from the comparison (a confirmed $6.20 case on a real statement).
// ---------------------------------------------------------------------------
// The Roman-numeral alternative has to cover palier/niveau/tier ALL THREE, not just the
// English word: Payfacto prints "Palier II". Pairing Roman numerals with `tier` only is a
// silent dropper — it passes every Arabic test and every English test, and loses the
// French Roman rows.
const INTERAC_TIER_RE = /((palier|niveau|tier)\s*(\d+|i{1,3}|iv)\b|\bt[1-4]\b)/i;

function interacTier(desc) {
  const m = String(desc || '').match(INTERAC_TIER_RE);
  return m ? m[0].trim() : null;
}

// ---------------------------------------------------------------------------
// The three category classifiers.
//
// All three follow the same order: alias identity, then name match, then rate match, then
// "not recognized". Alias and name come first on purpose — a known name beats a
// coincidental number (see the Interac-mislabeling bug noted in rateTables.js).
//
// A classifier receives one item:
//   { desc, rate, count, volume, total, basis?, kind? }
// and returns it enriched with { cat, publishedRate, theoretical, delta, status, why }.
// ---------------------------------------------------------------------------

function decide(item, match, opts = {}) {
  const rate    = Number.isFinite(item.rate) ? item.rate : null;
  const volume  = Number.isFinite(item.volume) ? item.volume : 0;
  const total   = Number.isFinite(item.total) ? item.total : 0;

  if (!match) {
    return {
      ...item,
      cat: null, publishedRate: null, theoretical: null, delta: null,
      status: opts.status || STATUS.A_VERIFIER,
      why: opts.why || 'Aucune correspondance dans les tables de taux',
    };
  }

  const count = Number.isFinite(item.count) ? item.count : 0;

  // ⚠️ A per-item entry is priced in dollars per TRANSACTION, so its expected amount is
  // fee × count, not rate × volume. Running it through the volume formula would compare a
  // $0.035 Interac fee against a percentage of tens of thousands of dollars and report an
  // enormous, meaningless delta.
  const isPerItem = Number.isFinite(match.perItem) && match.perItem > 0
    && (match.matchedBy === 'perItem' || !Number.isFinite(match.rate) || match.rate === 0);

  const publishedRate     = Number.isFinite(match.rate) && match.rate > 0 ? match.rate : null;
  const publishedPerItem  = isPerItem ? match.perItem : null;
  const theoretical = isPerItem
    ? publishedPerItem * count
    : (publishedRate != null ? publishedRate * volume : null);
  const delta = theoretical != null ? total - theoretical : null;

  // "Conforme" requires the figure itself to line up. A name match alone means we believe
  // we know WHAT the fee is, not that the amount is right — that is exactly "À vérifier".
  const rateAgrees = isPerItem
    ? (Number.isFinite(item.perItem)
      && Math.abs(publishedPerItem - item.perItem) <= (opts.perItemEpsilon || DEFAULT_PER_ITEM_EPSILON))
    : (publishedRate != null && rate != null
      && Math.abs(publishedRate - rate) <= (opts.epsilon || DEFAULT_EPSILON));

  return {
    ...item,
    cat: match.cat,
    publishedRate,
    publishedPerItem,
    theoretical,
    delta,
    status: rateAgrees ? STATUS.CONFORME : STATUS.A_VERIFIER,
    matchedBy: match.matchedBy,
    src: match.src || null,
    why: rateAgrees
      ? 'Taux publié reconnu'
      : (match.matchedBy === 'name'
        ? 'Nom reconnu, mais le taux facturé ne correspond pas au taux publié'
        : 'Taux reconnu, mais le libellé ne correspond pas'),
  };
}

function classifyInterchangeLine(item, opts = {}) {
  const sus = suspectLabel(item.desc, opts.processor);
  if (sus) return { ...item, cat: null, publishedRate: null, theoretical: null, delta: null, status: STATUS.SUSPECT, why: `Nom sans contrepartie réseau : ${sus}` };

  const tables = opts.tables || [
    RATE_TABLES.visaDomestic, RATE_TABLES.mcDomestic,
    RATE_TABLES.visaInternational, RATE_TABLES.mcInternational,
  ];
  const byName = matchByName(item.desc, tables, opts.minRatio, item.rate, opts.minWords);
  const match  = byName || matchByRate(item.rate, tables, opts.epsilon, item.desc)
    // Une ligne facturée au montant fixe par transaction (Interac Flash, débit Visa)
    // ne peut pas correspondre par taux : son taux est nul.
    || matchByPerItem(item.perItem, tables, opts.perItemEpsilon, item.desc);
  return decide(item, match, opts);
}

function classifyBrandLine(item, opts = {}) {
  const sus = suspectLabel(item.desc, opts.processor);
  if (sus) return { ...item, cat: null, publishedRate: null, theoretical: null, delta: null, status: STATUS.SUSPECT, why: `Nom sans contrepartie réseau : ${sus}` };

  const tables = opts.tables || [RATE_TABLES.networkFees, RATE_TABLES.schemeFeesCA];
  const byName = matchByName(item.desc, tables, opts.minRatio, item.rate, opts.minWords);
  const match  = byName || matchByRate(item.rate, tables, opts.epsilon, item.desc)
    // Une ligne facturée au montant fixe par transaction (Interac Flash, débit Visa)
    // ne peut pas correspondre par taux : son taux est nul.
    || matchByPerItem(item.perItem, tables, opts.perItemEpsilon, item.desc);
  return decide(item, match, opts);
}

function classifyInteracLine(item, opts = {}) {
  const sus = suspectLabel(item.desc, opts.processor);
  if (sus) return { ...item, cat: null, publishedRate: null, theoretical: null, delta: null, status: STATUS.SUSPECT, why: `Nom sans contrepartie réseau : ${sus}` };

  const tables = opts.tables || [RATE_TABLES.interacNetwork, RATE_TABLES.interacFlash];
  const tier   = interacTier(item.desc);

  const byName = matchByName(item.desc, tables, opts.minRatio, item.rate, opts.minWords);
  const match  = byName || matchByRate(item.rate, tables, opts.epsilon, item.desc)
    // Une ligne facturée au montant fixe par transaction (Interac Flash, débit Visa)
    // ne peut pas correspondre par taux : son taux est nul.
    || matchByPerItem(item.perItem, tables, opts.perItemEpsilon, item.desc);
  if (match) return { ...decide(item, match, opts), tier };

  // A recognized tier with no table hit is still a real Interac pass-through row — it must
  // NOT fall through to "Markup processeur", which the UI filters out of the audit table.
  if (tier) {
    return {
      ...item, tier, cat: `Interac Flash — ${tier}`,
      publishedRate: null, theoretical: null, delta: null,
      status: STATUS.A_VERIFIER,
      why: 'Palier Interac reconnu, taux publié absent des tables',
    };
  }
  return decide(item, null, opts);
}

// ---------------------------------------------------------------------------
// Audit building
// ---------------------------------------------------------------------------

// Run a classifier over a list of extracted items and return the rendered audit rows.
function buildLineAudit(items, classifyFn, opts = {}) {
  if (!Array.isArray(items) || !items.length) return [];
  return items.map((it) => classifyFn(it, opts));
}

// The SUSPECT convention, applied identically by every processor (§3/§5).
//
// A SUSPECT line STAYS counted in its originating section's total — the merchant really
// was charged those dollars, in that category. A duplicate, informational-only copy also
// goes into the hidden-bumps list, labelled to say it is already included above.
//
// ⚠️ The asymmetry downstream is deliberate and is the easiest thing here to get subtly
// wrong: recalc() must EXCLUDE hidden bumps from the current-processor pretax total (they
// are already inside markup/interchange/fixed — counting them again would double-count),
// while SUBTRACTING the suspect subtotal from Cluster's own interchange (so Cluster never
// inherits a fabricated charge). Excluded from one total, subtracted from another.
function splitHiddenBumps(rows) {
  const hidden = [];
  for (const r of rows || []) {
    if (r.status !== STATUS.SUSPECT) continue;
    hidden.push({
      ...r,
      label: `${r.desc} — déjà inclus ci-dessus`,
      informationalOnly: true,
    });
  }
  return { rows: rows || [], hidden };
}

// ---------------------------------------------------------------------------
// Processor-specific wrappers.
//
// The pattern, to be copied for any future processor quirk: intercept ONE known case,
// fall through to the shared classifier for everything else. Nothing here edits the shared
// tables, so a fix to one processor cannot reach another.
// ---------------------------------------------------------------------------

// Global Payments: check the alias dictionary BEFORE any rate matching. This is the fix
// for real interchange rows being reclassified as Interac because their dollar-derived
// rate happened to land near an Interac rate. Alias identity wins over rate collision.
function classifyGlobalInterchangeLine(item, opts = {}) {
  const key = norm(item.desc);
  // An alias drives the MATCHING only. `desc` keeps the statement's own wording, because
  // that is what a rep reconciles line-by-line against the paper in front of them — a row
  // silently renamed to its normalized label cannot be found on the statement.
  const viaAlias = (label, fn) => {
    const out = fn({ ...item, desc: label }, { ...opts, processor: 'global' });
    return { ...out, desc: item.desc, aliasOf: label };
  };

  for (const [code, label] of Object.entries(GLOBAL_INTERCHANGE_ALIASES)) {
    if (key === norm(code) || key.startsWith(`${norm(code)} `)) return viaAlias(label, classifyInterchangeLine);
  }
  for (const [code, label] of Object.entries(GLOBAL_BRAND_ALIASES)) {
    if (key === norm(code) || key.startsWith(`${norm(code)} `)) return viaAlias(label, classifyBrandLine);
  }
  return classifyInterchangeLine(item, { ...opts, processor: 'global' });
}

// Moneris: intercept the "VS - ASSESSMENT" / "VS - ÉVALUATION" line only.
//
// Visa publishes no distinct rate card for this domestic assessment (Mastercard does), but
// the rate actually billed (~0.1017 %) matches Mastercard's own already-verified domestic
// assessment on the same statement — so it is treated as the same generic network fee,
// Visa-branded.
//
// ⚠️ Per explicit instruction this stays Moneris-scoped. It is NOT a change to the shared
// rate tables or the shared classifier, and must never silently affect Global, Payfacto or
// any other processor.
const MONERIS_VS_ASSESSMENT_RE = /^VS\s*-\s*(ASSESSMENT|EVALUATION)/i;

function classifyMonerisBrandLine(item, opts = {}) {
  if (MONERIS_VS_ASSESSMENT_RE.test(norm(item.desc))) {
    const mcAssessment = RATE_TABLES.networkFees.find((e) => /MASTERCARD/i.test(norm(e.cat)) && /EVALUATION|ASSESSMENT/i.test(norm(e.cat)));
    if (mcAssessment) {
      return {
        ...decide(item, { ...mcAssessment, cat: 'Visa — Frais d\'évaluation (assessment, domestique)', matchedBy: 'moneris-override' }, opts),
        why: 'Visa ne publie pas de carte de taux distincte pour ce frais; le taux facturé correspond au frais d\'évaluation domestique Mastercard vérifié sur le même relevé.',
      };
    }
  }
  return classifyBrandLine(item, { ...opts, processor: 'moneris' });
}

module.exports = {
  STATUS,
  DEFAULT_EPSILON, DEFAULT_MIN_RATIO, DEFAULT_MIN_WORDS,
  norm, significantWords, similarity, keywordOverlap,
  brandsIn, brandConflict,
  matchByRate, matchByPerItem, matchByName,
  DEFAULT_PER_ITEM_EPSILON,
  suspectLabel, interacTier, INTERAC_TIER_RE,
  classifyInterchangeLine, classifyBrandLine, classifyInteracLine,
  classifyGlobalInterchangeLine, classifyMonerisBrandLine,
  buildLineAudit, splitHiddenBumps,
};
