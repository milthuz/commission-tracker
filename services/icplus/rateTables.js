// ============================================================================
// IC+ fee-comparison calculator — reference rate data (§2 of the scope).
//
// This is the ground truth every parsed statement line gets checked against. It is
// deliberately a DATA layer with no logic in it: the classifier (classify.js) reads
// these tables, nothing here reads the classifier.
//
// ⚠️ SOURCING RULE — read before adding a number here.
// A rate in this file decides whether a merchant's fee is stamped "Conforme" or
// "SUSPECT" on a document a rep hands to a client. A wrong number here produces a
// confident, wrong accusation. So: every entry carries a `src` naming where the value
// came from (see SOURCES). No entry may be added from memory, from inference, or from
// a plausible-looking round number. A table with nothing sourced yet stays EMPTY —
// see the "empty tables" note below for why that is the safe failure direction.
//
// MAINTENANCE. These tables go stale, AND they can be wrong on arrival: the cross-border
// entries below shipped carrying what Moneris BILLS rather than what the networks PUBLISH,
// and blessed a 13 % overcharge until the published pages were checked (2026-09-21). This file needs an
// owner and a review whenever a network publishes a new schedule — it is not a
// one-time port. Bump DATA_VERSION on every change, so a saved analysis can say which
// rate vintage it was judged against.
// ============================================================================

const DATA_VERSION = '2026-09-21';

// Where each rate came from. Carried into the audit UI so a disputed line can be traced
// back to a document rather than to "the app says so".
const SOURCES = {
  visa_published:    'Visa published rate card (Canada)',
  mc_published:      'Mastercard published rate card (Canada)',
  amex_published:    'Amex published rate card (Canada)',
  visa_intl_irf:     'Visa "International Interchange Reimbursement Fees" table',
  adyen_report:      'Adyen "Interchange & Scheme Fee" report, Canada, June 2026 — ACTUAL OBSERVED network billing, not an official published rate card',
  adyen_mapping:     'Internal "Adyen vs Global Payments — Fee Mapping" workbook, cross-checked against the Adyen report',
  moneris_notice:    'Fee-change notice printed on a real Moneris statement',
  interac_published: 'Interac published fee schedule (Switch / Mobile Service Fee, Flash contactless tiers)',
  terminology_dict:  'Internal "Fee Terminology Dictionary" (Adyen naming vs each processor\'s own)',
  statement_obs:     'Observed on a real statement and reconciled against that statement\'s own totals',
};

// ---------------------------------------------------------------------------
// The tables.
//
// Entry shape: { cat, rate, weak?, src }
//   cat   — category label, also what matchByName() fuzzy-matches a description against
//   rate  — decimal (0.0009 === 0.0900 %)
//   weak  — see below
//   src   — a SOURCES key
//
// `weak: true` marks a rate that is only trustworthy as a match if the line's own
// description ALSO shares keywords with `cat`. Some rate values coincidentally collide
// across unrelated fee categories, and a bare numeric hit on one of those is not
// evidence of anything. matchByRate() refuses to accept a weak entry on rate proximity
// alone — see classify.js.
//
// ⚠️ ON THE EMPTY TABLES BELOW. The scope document (§2) names eight tables and pins down
// their shape, but the rate VALUES themselves live in the reference implementation
// (Cluster_IC_Calculateur.html), which was not available when this was ported. Rather
// than seed them with invented numbers, the unsourced tables ship empty and say so
// (tableStatus / tablesIncomplete). The consequence is honest and fails in the right
// direction: with an empty table nothing can match, so those lines land on "À vérifier"
// — never a false "Conforme", never a false "SUSPECT". SUSPECT still fires normally,
// because it comes from the hard-coded label lists at the bottom of this file, which the
// scope document does specify in full.
// ---------------------------------------------------------------------------

// Visa domestic interchange (Canada), by qualifying category.
const visaDomestic = [];

// Mastercard domestic interchange (Canada), by qualifying category.
const mcDomestic = [];

// Visa international / cross-border interchange.
const visaInternational = [];

// Mastercard international / cross-border interchange.
const mcInternational = [];

// Network fees that are neither interchange nor a scheme fee — assessments, access and
// licence fees the acquirer passes straight through.
const networkFees = [
  // Visa's and Mastercard's domestic assessment. The scope document is explicit that the
  // correct figure is 0.0900 %, and that this line is a known inflation target: 0.1017 %,
  // 0.1250 % and 0.1500 % have all been observed billed under this same name. Those
  // inflated values are deliberately NOT entered as categories of their own — they are
  // not real rates, and adding them would let an inflated charge match as "Conforme".
  // They belong in the help text instead (HELP.assessmentInflation).
  { cat: 'Visa — Frais d\'évaluation (assessment, domestique)',       rate: 0.0009,  src: 'visa_published' },
  { cat: 'Mastercard — Frais d\'évaluation (assessment, domestique)', rate: 0.0009,  src: 'mc_published'   },

  // ⚠️ CORRIGÉ le 2026-09-21 à partir des pages publiées de Visa et de Mastercard, fournies
  // par Christine. Ces entrées portaient 0,678 % et 1,13 %, valeurs tirées d'un avis de
  // changement de tarif imprimé sur un relevé MONERIS — donc ce que Moneris FACTURE, jamais
  // ce que les réseaux PUBLIENT.
  //
  // Le rapport le dit sans ambiguïté : 0,678 / 0,60 = 1,1300 et 1,13 / 1,00 = 1,1300. Les
  // deux sont le taux publié multiplié par exactement 1,13. Tant que les mauvaises valeurs
  // étaient ici, un relevé facturant 0,678 % ressortait « Conforme » et l'outil bénissait
  // une surfacturation de 13 % au lieu de la dénoncer — l'inverse exact de son travail.
  //
  // Visa nomme ça l'IASF, Mastercard l'Acquirer Cross-Border Assessment; les libellés
  // diffèrent, les chiffres non. Ils sont donc portés par réseau, avec le libellé de chacun.
  { cat: 'Visa — IASF, achat multidevise (international)',                       rate: 0.0060, src: 'visa_published' },
  { cat: 'Visa — IASF, achat en devise unique (international)',                  rate: 0.0100, src: 'visa_published' },
  { cat: 'Mastercard — Évaluation transfrontalière, transaction en CAD',         rate: 0.0060, src: 'mc_published' },
  { cat: 'Mastercard — Évaluation transfrontalière, devise autre que CAD (DCC)', rate: 0.0100, src: 'mc_published' },

  // Visa's authorization-estimate fee. The scope document notes this one "seems to hide"
  // inside Global's TAX REIMBURSEMENT CH row without being isolated separately — so a
  // match here is informative even when the row is named something else entirely.
  { cat: 'Visa — ARQ (estimation d\'autorisation)',                   rate: 0.0002,  src: 'visa_published' },

  // Amex's assessment column as disclosed on Clover/Fiserv statements. Approximate by
  // nature (the column prints rounded), hence `weak`.
  { cat: 'Amex — Assessment',                                         rate: 0.0012,  weak: true, src: 'statement_obs' },
];

// Scheme fees (Canada) — what the networks charge the acquirer for running the
// transaction, distinct from both interchange and assessments.
const schemeFeesCA = [];

// Interac Switch / Mobile Service Fee.
const interacNetwork = [];

// Interac Flash contactless interchange, by tier.
const interacFlash = [];

const RATE_TABLES = {
  visaDomestic, mcDomestic, visaInternational, mcInternational,
  networkFees, schemeFeesCA, interacNetwork, interacFlash,
};

// Which tables actually carry sourced data. The UI reads this so an audit run against
// incomplete data SAYS so, instead of quietly returning "À vérifier" on every line and
// looking like a parsing failure.
function tableStatus() {
  const status = {};
  for (const [name, rows] of Object.entries(RATE_TABLES)) {
    status[name] = { entries: rows.length, sourced: rows.length > 0 };
  }
  return status;
}

function tablesIncomplete() {
  return Object.values(RATE_TABLES).some((rows) => rows.length === 0);
}

// Names of the tables still waiting on sourced data — surfaced verbatim in the UI banner
// so whoever fills them knows exactly what is outstanding.
function unsourcedTables() {
  return Object.entries(RATE_TABLES).filter(([, rows]) => rows.length === 0).map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Alias dictionaries — a processor's own cryptic codes → a normalized description.
//
// ⚠️ Alias identity is checked BEFORE rate-proximity matching (see classify.js). That
// ordering is not cosmetic: it fixes a real bug where Global Payments interchange rows
// that had a perfectly good alias match were being reclassified as Interac purely
// because their dollar-derived rate happened to land near an Interac rate. A known name
// beats a coincidental number, always.
// ---------------------------------------------------------------------------

// Global Payments interchange row codes. The VIBS/VINF families are Visa qualifying
// categories; note the hyphenated forms ("HI-NET") — the row-label regex in the Global
// parser must stay permissive of hyphens or these rows vanish silently (a reproducible
// ~$72.50 total mismatch against a real statement).
const GLOBAL_INTERCHANGE_ALIASES = {
  'VIBS CDN HI-NET STD': 'Visa — Business Standard, réseau haut',
  'VINF CDN HI-NET EMV': 'Visa — Infinite EMV, réseau haut',
};

// Global Payments brand / assessment row codes.
const GLOBAL_BRAND_ALIASES = {
  'ASMTS': 'Visa/Mastercard — Frais d\'évaluation (assessment)',
};

// Moneris section-4 rows that look like Moneris's own markup but are genuine network
// pass-through. Established by reconciling section 6's rollup, which equals section 2 +
// section 3 exactly and therefore leaves zero room for a section-4 network row: anything
// here that IS a network fee has to move out of the markup total and into interchange,
// or the two sides stop adding up.
const MONERIS_SECTION4_NETWORK_ROWS = [
  'VISA - FRAIS D\'ACCÈS AU SYSTÈME',
  'VISA - SYSTEM ACCESS FEE',
  'MC - FRAIS COMPENSATION',
  'MC - CLEARING FEE - SMALL TICKET',
  'MC - CLEARING FEE - LARGE TICKET',
  'MC - FRAIS D\'ÉVALUATION (ACQUÉREUR)',
  'MC - ACQUIRER LICENSE FEE',
  'MC - FRAIS DE SAFETY NET (ACQUÉREUR)',
  'MC - SAFETY NET ACQUIRER FEE',
  'FRAIS DE CONNEXION AU RÉSEAU',
  'NETWORK CONNECTIVITY FEE',
  'VISA/MC - CARD BRAND MAINTENANCE',
];

// ---------------------------------------------------------------------------
// SUSPECT labels — fee names with no corresponding real network fee, regardless of what
// rate or basis the statement discloses next to them.
//
// Centralized and extensible on purpose: every processor invents new junk-fee names, and
// the next one to be added should land here rather than inside a parser.
// ---------------------------------------------------------------------------

const GLOBAL_SUSPECT_LABELS = [
  'DATASECFEE', 'PCI NONCOM', 'PNCOMPFEE', 'PCI ADMIN',
  'NETWKACCES', 'RISK ASMT', 'PCI', 'DÉCLASSEMENT',
  // Flagged not because the dollars are fake but because the NAME hides what the row is.
  // Confirmed on a real Global statement (May 2026): the row bills 0.0200 % — Visa's ARQ
  // authorization-estimate fee — under a tax-sounding label, with no separate ARQ line
  // anywhere on the statement. Without this entry the row matches ARQ cleanly and reports
  // "Conforme", which is the opposite of the warning it deserves. See HELP.hiddenArq.
  'TAX REIMBURSEMENT CH',
];

// No card network publishes a "PCI non-compliance" fee — it is a processor penalty
// deliberately named to resemble a network charge.
const NUVEI_SUSPECT_LABELS = [
  'PCI',
  'PCI NON-COMPLIANCE ASSESSMENT FEE',
];

// Real-time push-payment product names. These ARE real fees — for a product a normal
// card-present merchant would never legitimately be charged for. Routed into the BRAND
// audit table specifically so the resemblance to real network terminology is visible
// side by side.
const PUSH_PAYMENT_SUSPECT_LABELS = [
  'MASTERCARD SEND',
  'VISA DIRECT',
];

const SUSPECT_LABELS = {
  global: GLOBAL_SUSPECT_LABELS,
  nuvei:  [...NUVEI_SUSPECT_LABELS, ...PUSH_PAYMENT_SUSPECT_LABELS],
  shared: ['PCI NONCOM', 'PNCOMPFEE'],
};

// ---------------------------------------------------------------------------
// Review help — which hints apply to which processor. Wording lives in notes.js so every
// piece of rep-facing text in this feature renders through one bilingual catalogue.
// ---------------------------------------------------------------------------
const HELP = [
  { code: 'helpCrossBorderUplift',      processors: ['moneris', 'global', 'clover', 'nuvei', 'payfacto', 'chase'] },
  { code: 'helpAssessmentInflation',    processors: ['global', 'moneris', 'clover', 'nuvei', 'payfacto', 'chase'] },
  { code: 'helpDuplicateSecurityFee',   processors: ['global'] },
  { code: 'helpZeroBasisFee',           processors: ['global'] },
  { code: 'helpHiddenArq',              processors: ['global'] },
  { code: 'helpMonerisServiceSection',  processors: ['moneris'] },
  { code: 'helpCloverHiddenInterchange',processors: ['clover'] },
  { code: 'helpNuveiValueAdded',        processors: ['nuvei'] },
  { code: 'helpDiscoverFoldedIntoVisa', processors: ['moneris'] },
];

// The review hints that apply to one processor, as note records the caller renders in the
// rep's own language. The wording itself lives in notes.js, with the parser notes.
function helpFor(processor) {
  return HELP.filter((h) => h.processors.includes(processor)).map((h) => ({ code: h.code, params: {} }));
}

module.exports = {
  DATA_VERSION,
  SOURCES,
  RATE_TABLES,
  visaDomestic, mcDomestic, visaInternational, mcInternational,
  networkFees, schemeFeesCA, interacNetwork, interacFlash,
  tableStatus, tablesIncomplete, unsourcedTables,
  GLOBAL_INTERCHANGE_ALIASES, GLOBAL_BRAND_ALIASES,
  MONERIS_SECTION4_NETWORK_ROWS,
  SUSPECT_LABELS, GLOBAL_SUSPECT_LABELS, NUVEI_SUSPECT_LABELS, PUSH_PAYMENT_SUSPECT_LABELS,
  HELP, helpFor,
};
