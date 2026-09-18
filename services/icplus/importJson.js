// ============================================================================
// JSON import / manual-entry fallback (§7).
//
// For scanned or image-only PDFs that no parser can read: a human — or Claude, asked to
// read the statement — hands over a JSON object instead.
//
// ⚠️ THE POINT OF THIS FILE IS THE CONTRACT, NOT THE PARSING. §7 requires that imported
// JSON flow through the EXACT SAME populate() path as a successful automated parse. That
// only works if it satisfies the same shape every parser returns (§1/§4) — so validateShape()
// below is deliberately written to police BOTH, and the parser suite runs every real parser
// through it. If the two ever drift apart, the fallback silently stops being equivalent to
// a real parse, which is the whole thing this path exists to guarantee.
//
// ⚠️ NOTHING HERE SILENTLY FIXES A NUMBER. An LLM or a tired human will sometimes send a
// rate as a percentage (1.65) where the shape wants a decimal (0.0165). Auto-correcting
// that is a guess about money: guess right and nobody notices, guess wrong and a subtly
// wrong figure reaches a client document. So a suspicious value is REPORTED and passed
// through unchanged — 165 % markup is absurd on its face and will be caught on screen,
// whereas a quietly "corrected" number never gets a second look.
// ============================================================================

const N = require('./notes');

// The fields every parser fills in, used both to validate and to fill defaults.
const VOLUME_FIELDS = [
  'debit_count', 'debit_amt', 'visa_count', 'visa_amt',
  'mc_count', 'mc_amt', 'amex_count', 'amex_amt',
];

const RATE_FIELDS = ['debit_rate', 'visa_rate', 'mc_rate', 'amex_rate'];
const FEE_FIELDS = ['debit_fee', 'visa_fee', 'mc_fee', 'amex_fee'];

// A markup rate above this is far likelier to be a percentage that was never divided by
// 100 than a real rate: 0.5 would be a 50 % markup, which no processor charges.
const IMPLAUSIBLE_RATE = 0.5;
// Likewise a per-item fee: $5.00 per transaction is not a markup, it is a typo or a total.
const IMPLAUSIBLE_FEE = 5;

// ---------------------------------------------------------------------------
// ⚠️ Strip a markdown code fence before parsing. An LLM asked for JSON answers with
// ```json … ``` far more often than not, and a human pasting from a chat window brings the
// fence with them. Failing on that would make the fallback look broken at the exact moment
// it is needed.
// ---------------------------------------------------------------------------
function stripFences(text) {
  let s = String(text == null ? '' : text).trim();
  const fence = s.match(/^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();
  // Prose around the object is also common — "Here is the JSON:" before it, and just as
  // often a friendly sign-off AFTER it. Slicing only when the object does not start at
  // index 0 handles the leading case and misses the trailing one entirely, so the test is
  // "is there anything outside the braces", on either side.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first && (first > 0 || last < s.length - 1)) s = s.slice(first, last + 1);
  return s;
}

// ---------------------------------------------------------------------------
// The shared shape contract (§1/§4).
//
// Returns { ok, errors, warnings } — errors block the import, warnings do not.
// ---------------------------------------------------------------------------
function validateShape(obj, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [{ code: 'notAnObject' }], warnings };
  }

  // §7 names these two as required. Everything else has a sensible empty default.
  const missing = ['current_processor', 'volume'].filter((k) => !obj[k] || typeof obj[k] !== 'object');
  if (missing.length) errors.push({ code: 'missingKeys', keys: missing });
  if (errors.length) return { ok: false, errors, warnings };

  const cp = obj.current_processor;
  const vol = obj.volume;

  for (const f of VOLUME_FIELDS) {
    if (vol[f] === undefined || vol[f] === null) { warnings.push({ code: 'volumeFieldMissing', field: f }); continue; }
    if (!Number.isFinite(Number(vol[f]))) errors.push({ code: 'notANumber', field: `volume.${f}`, value: vol[f] });
    else if (Number(vol[f]) < 0) warnings.push({ code: 'negativeValue', field: `volume.${f}`, value: Number(vol[f]) });
  }

  for (const f of [...RATE_FIELDS, ...FEE_FIELDS, 'interchange']) {
    const v = cp[f];
    if (v === undefined || v === null) continue;
    if (!Number.isFinite(Number(v))) { errors.push({ code: 'notANumber', field: `current_processor.${f}`, value: v }); continue; }
  }

  // ⚠️ Reported, never corrected — see the file header.
  for (const f of RATE_FIELDS) {
    const v = Number(cp[f]);
    if (Number.isFinite(v) && v > IMPLAUSIBLE_RATE) warnings.push({ code: 'rateLooksLikePercent', field: f, value: v });
  }
  for (const f of FEE_FIELDS) {
    const v = Number(cp[f]);
    if (Number.isFinite(v) && v > IMPLAUSIBLE_FEE) warnings.push({ code: 'feeLooksWrong', field: f, value: v });
  }

  // line_audit is optional, but if present it has to be the three-bucket shape, or the
  // audit tables and the SUSPECT flow silently see nothing.
  if (obj.line_audit !== undefined) {
    if (typeof obj.line_audit !== 'object' || Array.isArray(obj.line_audit)) {
      errors.push({ code: 'badLineAudit' });
    } else {
      for (const bucket of ['interchange', 'brand', 'interac']) {
        const rows = obj.line_audit[bucket];
        if (rows === undefined) continue;
        if (!Array.isArray(rows)) errors.push({ code: 'badLineAuditBucket', field: bucket });
      }
    }
  }

  if (obj.merchant_name !== undefined && obj.merchant_name !== null && typeof obj.merchant_name !== 'string') {
    warnings.push({ code: 'badMerchantName' });
  }

  // A statement with no volume at all is not an error, but it is almost always a mistake
  // and produces a comparison of nothing against nothing.
  const totalVolume = VOLUME_FIELDS.filter((f) => f.endsWith('_amt')).reduce((s, f) => s + (Number(vol[f]) || 0), 0);
  if (!totalVolume) warnings.push({ code: 'noVolume' });

  if (opts.strict && warnings.length) return { ok: false, errors, warnings };
  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Fill in every field a parser would have set, so the object entering populate() is
// indistinguishable from a real parse.
// ---------------------------------------------------------------------------
function normalize(obj) {
  const cp = obj.current_processor || {};
  const vol = obj.volume || {};
  const audit = obj.line_audit || {};

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const out = {
    current_processor: {
      ...cp,
      name: cp.name || 'Saisie manuelle',
      interchange: num(cp.interchange),
      fixed_rows: Array.isArray(cp.fixed_rows) ? cp.fixed_rows.map((r) => ({
        label: String(r.label || r.desc || ''),
        qty: num(r.qty) || 1,
        unit: num(r.unit != null ? r.unit : r.amount),
        amount: num(r.amount != null ? r.amount : (num(r.qty) || 1) * num(r.unit)),
      })) : [],
    },
    volume: {},
    merchant_name: typeof obj.merchant_name === 'string' ? obj.merchant_name : null,
    line_audit: {
      interchange: Array.isArray(audit.interchange) ? audit.interchange : [],
      brand: Array.isArray(audit.brand) ? audit.brand : [],
      interac: Array.isArray(audit.interac) ? audit.interac : [],
    },
  };

  for (const f of [...RATE_FIELDS, ...FEE_FIELDS]) out.current_processor[f] = num(cp[f]);
  for (const f of VOLUME_FIELDS) out.volume[f] = num(vol[f]);

  // Notes: accept the structured form, a plain string, or nothing.
  if (Array.isArray(obj.notes)) out.notes = obj.notes.filter((n) => n && n.code);
  else out.notes = [];
  if (typeof obj._note === 'string' && obj._note.trim()) out._note = obj._note.trim();

  return out;
}

// ---------------------------------------------------------------------------
// The entry point. Text in, a parse-shaped object out — or a clear reason why not.
// ---------------------------------------------------------------------------
function parseImport(text, opts = {}) {
  const raw = stripFences(text);
  if (!raw) return { ok: false, errors: [{ code: 'empty' }], warnings: [], notes: [N.note('jsonEmpty')] };

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      errors: [{ code: 'badJson', message: e.message }],
      warnings: [],
      notes: [N.note('jsonBadSyntax', { message: e.message })],
    };
  }

  const check = validateShape(obj, opts);
  if (!check.ok) {
    return { ok: false, errors: check.errors, warnings: check.warnings, notes: errorNotes(check) };
  }

  const normalized = normalize(obj);
  // The import announces itself, so a saved analysis always says whether its numbers were
  // read off a statement or typed in by hand.
  normalized.notes = [N.note('jsonImported'), ...warningNotes(check), ...(normalized.notes || [])];
  normalized._note = N.renderAll(normalized.notes, opts.lang || 'fr');

  return { ok: true, errors: [], warnings: check.warnings, parsed: normalized, notes: normalized.notes };
}

function errorNotes(check) {
  const out = [];
  for (const e of check.errors) {
    if (e.code === 'missingKeys') out.push(N.note('jsonMissingKeys', { keys: e.keys }));
    else if (e.code === 'notANumber') out.push(N.note('jsonNotANumber', { field: e.field, value: String(e.value) }));
    else if (e.code === 'notAnObject') out.push(N.note('jsonNotAnObject'));
    else if (e.code === 'badLineAudit' || e.code === 'badLineAuditBucket') out.push(N.note('jsonBadLineAudit'));
  }
  return out.length ? out : [N.note('jsonBadSyntax', { message: '—' })];
}

function warningNotes(check) {
  const out = [];
  for (const w of check.warnings) {
    if (w.code === 'rateLooksLikePercent') out.push(N.note('jsonRateLooksLikePercent', { field: w.field, value: w.value }));
    else if (w.code === 'feeLooksWrong') out.push(N.note('jsonFeeLooksWrong', { field: w.field, value: w.value }));
    else if (w.code === 'noVolume') out.push(N.note('jsonNoVolume'));
  }
  return out;
}

module.exports = {
  stripFences, validateShape, normalize, parseImport,
  VOLUME_FIELDS, RATE_FIELDS, FEE_FIELDS, IMPLAUSIBLE_RATE, IMPLAUSIBLE_FEE,
};
