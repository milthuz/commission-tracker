// ============================================================================
// Processor dispatch (§1).
//
// One entry point. A caller either names the processor (the dropdown) or asks for
// auto-detection; either way the result conforms to the single shared shape, which is also
// the contract the JSON-paste fallback (§7) has to satisfy.
//
// STATUS:
//   Global Payments, Clover/Fiserv — implemented and reconciled to the cent against cached
//     REAL statements.
//   Moneris (FR+EN), Nuvei,        — implemented and covered by synthetic fixtures for every
//   Payfacto, Chase                  quirk §4 documents, but NOT yet reconciled against a
//     real statement. `verified` below says so, so the UI can mark it, and so nobody mistakes
//     "the tests pass" for "this was checked against real paper".
//
// An unknown format still falls through to the generic keyword parser, which deliberately
// produces no line_audit at all.
// ============================================================================

const global = require('./global');
const clover = require('./clover');
const moneris = require('./moneris');
const nuvei = require('./nuvei');
const payfacto = require('./payfacto');
const chase = require('./chase');
const generic = require('./generic');
const N = require('../notes');

// Implemented parsers, in detection order. Clover's test is a single unambiguous string, so
// it runs first and costs nothing.
const PARSERS = [
  { key: 'clover',  module: clover },
  { key: 'global',  module: global },
  { key: 'moneris', module: moneris },
  { key: 'nuvei',   module: nuvei },
  { key: 'payfacto', module: payfacto },
  { key: 'chase',    module: chase },
];

// Named in the scope but not yet built. Listed explicitly so the UI can show them as
// "coming" rather than pretending they work.
// All seven formats §4 specifies are now implemented. A new processor goes here first, so
// the UI can list it as coming rather than silently falling through to the keyword parser.
const PLANNED = {};

// Reconciled against a cached real statement. Moneris and Nuvei are deliberately absent:
// both are implemented, but nothing has checked either against real paper yet.
const VERIFIED = new Set(['clover', 'global']);

function available() {
  return PARSERS.map((p) => ({ key: p.key, name: p.module.NAME, implemented: true, verified: VERIFIED.has(p.key) }))
    .concat(Object.entries(PLANNED).map(([key, name]) => ({ key, name, implemented: false, verified: false })));
}

// Identify the format without parsing it.
function detect(lines) {
  for (const p of PARSERS) {
    try {
      if (p.module.detect(lines)) return p.key;
    } catch {
      // A detector throwing on a malformed document must not stop the others from trying.
    }
  }
  return null;
}

// `processor` is a key from available(), or 'auto'.
function parse(lines, processor = 'auto') {
  if (!Array.isArray(lines) || !lines.length) {
    return { ok: false, reason: 'empty', notes: [N.note('emptyExtraction')], _note: N.render(N.note('emptyExtraction')) };
  }

  if (processor && processor !== 'auto') {
    if (PLANNED[processor]) {
      const n = N.note('notImplemented', { processor: PLANNED[processor] });
      return { ok: false, reason: 'not_implemented', processor, notes: [n], _note: N.render(n) };
    }
    const hit = PARSERS.find((p) => p.key === processor);
    if (!hit) {
      const n = N.note('unknownProcessor', { processor });
      return { ok: false, reason: 'unknown_processor', processor, notes: [n], _note: N.render(n) };
    }
    return { ok: true, processor, detected: detect(lines), ...hit.module.parse(lines) };
  }

  const key = detect(lines);
  if (key) {
    const hit = PARSERS.find((p) => p.key === key);
    return { ok: true, processor: key, detected: key, ...hit.module.parse(lines) };
  }

  const fallback = generic.parse(lines);
  if (!fallback) {
    const n = N.note('unrecognized');
    return { ok: false, reason: 'unrecognized', notes: [n], _note: N.render(n) };
  }
  return { ok: true, processor: 'generic', detected: null, ...fallback };
}

module.exports = { parse, detect, available, PARSERS, PLANNED, VERIFIED };
