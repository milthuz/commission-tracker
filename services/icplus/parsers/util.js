// ============================================================================
// Shared parser helpers (§4).
//
// Everything here is format-agnostic. A processor-specific quirk belongs in that
// processor's own parser, never in this file — the same discipline the shared classifier
// follows, for the same reason: a fix for one statement layout must not be able to reach
// another.
// ============================================================================

// ---------------------------------------------------------------------------
// Numbers
//
// Two conventions turn up, sometimes on the same statement family:
//   comma-thousands / period-decimal   1,234.56   (Global FR+EN, Clover, Chase)
//   space-thousands  / comma-decimal   1 234,56   (Moneris FR)
// The separator that appears LAST is the decimal one, which settles every mixed case
// without needing to know the layout in advance.
// ---------------------------------------------------------------------------
function parseNum(raw) {
  if (raw == null) return NaN;
  let s = String(raw).trim()
    .replace(/[$\s ]/g, '')   // currency, spaces, non-breaking spaces
    .replace(/%$/, '');
  if (!s) return NaN;

  // Accounting negatives: (12.34)
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/^-/.test(s)) { neg = true; s = s.slice(1); }

  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Whichever comes last is the decimal mark; the other is a grouping separator.
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // A lone comma is a decimal mark unless its tail is exactly 3 digits, which is the one
    // genuinely ambiguous case ("1,234" — four dollars of thousands, or 1.234?) and is
    // resolved as a thousands separator.
    //
    // ⚠️ The tail length matters and is not always 2: French rate columns print many
    // decimals ("0,015000$/item", "0,10170%"). An earlier "<= 2 digits" rule turned
    // 0,015000 into 15000 and every Moneris FR markup rate came out six orders of
    // magnitude too large.
    const parts = s.split(',');
    s = (parts.length === 2 && parts[1].length !== 3) ? `${parts[0]}.${parts[1]}` : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

const isNum = (s) => Number.isFinite(parseNum(s));

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

// ⚠️ Real statements mix apostrophe characters within a single document: globalpay.pdf
// prints "Frais d’équipement" (U+2019) on one line and "Frais d'interchange" (U+0027) on
// another. Any literal section-header match has to fold them together first, or the
// equipment section goes silently missing — a bug §4 records as having already happened
// once on a French-only statement.
function foldPunct(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Accent-insensitive, case-insensitive comparison key for header matching.
function headerKey(s) {
  return foldPunct(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
}

// Some layouts inject a stray space after every capital in a small-caps header
// ("S ERVICE C HARGES"). Comparing with all whitespace stripped is more robust than trying
// to model the spacing.
function squash(s) {
  return headerKey(s).replace(/\s+/g, '');
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

// Pull the last `n` numeric columns off a row, returning them plus everything before them
// as the label.
//
// ⚠️ The label is captured as "whatever is left", never by a hand-enumerated character
// class. §4 records a restrictive class silently dropping real hyphenated interchange rows
// ("VIBS CDN HI-NET STD", "VINF CDN HI-NET EMV") and producing a reproducible ~$72.50
// mismatch against a real statement. Anchor on the trailing numbers; let the label be
// anything.
function trailingNumbers(line, n) {
  const tokens = foldPunct(line).split(' ');
  if (tokens.length <= n) return null;

  const nums = [];
  let i = tokens.length - 1;
  while (i >= 0 && nums.length < n) {
    const t = tokens[i];
    if (!/\d/.test(t) || !isNum(t)) return null;
    nums.unshift(parseNum(t));
    i--;
  }
  if (nums.length < n) return null;

  const label = tokens.slice(0, i + 1).join(' ').trim();
  if (!label) return null;
  return { label, nums };
}

// The trailing dollar amount on a line, used by the generic fallback and by fixed-fee rows.
function trailingAmount(line) {
  const m = foldPunct(line).match(/(-?\(?\$?[\d][\d,. ]*\)?)\s*\$?$/);
  if (!m) return NaN;
  return parseNum(m[1]);
}

// ---------------------------------------------------------------------------
// Section scanning
//
// ⚠️ §4's general rule, hit as a real bug more than once: a loop tracking "am I inside
// section X" must close that state on EVERY plausible next-section header the format can
// produce, not just on its own expected "Total" line. Otherwise the scan bleeds past its
// section and mislabels rows belonging to the next one.
//
// So a scanner is always given the full set of section headers and closes on any of them
// but its own. Headers are matched anchored and literal (after folding), never with a
// loose "contains" test.
//
// A second trap §4 names: a trailing \b placed straight after a literal ")" can never
// match, because ")" is a non-word character and \b needs a word character on at least one
// side. Building the header patterns from literal strings here rather than from
// hand-written regexes avoids the whole class of problem.
// ---------------------------------------------------------------------------

// Continuation headers ("Escompte - suite", "... - continued") re-open the SAME section
// rather than closing it. Treating one as a boundary truncates a section at its first page
// break, which on a multi-page statement loses most of its rows.
const CONTINUATION = /\s*-\s*(SUITE|CONTINUED|CONT\.?)$/;

function stripContinuation(key) {
  return key.replace(CONTINUATION, '').trim();
}

// Page furniture that repeats on every page and belongs to no section.
function makeNoiseTest(patterns) {
  const res = (patterns || []).map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
  return (line) => {
    const l = foldPunct(line);
    if (!l) return true;
    if (/^\d+\s*\/\s*\d+$/.test(l)) return true;  // "5/9" page markers
    return res.some((re) => re.test(l));
  };
}

// Walk `lines`, handing each row to `onRow(line, sectionName)` while inside a known
// section. `sections` maps a section name to the header strings that open it.
function scanSections(lines, sections, opts = {}) {
  const isNoise = opts.isNoise || (() => false);
  const openers = [];
  for (const [name, headers] of Object.entries(sections)) {
    for (const h of headers) openers.push({ name, key: headerKey(h) });
  }

  let current = null;
  for (const raw of lines) {
    const line = foldPunct(raw);
    const key = stripContinuation(headerKey(line));

    const hit = openers.find((o) => o.key === key);
    if (hit) {
      // A continuation of the section already open simply keeps it open.
      current = hit.name;
      continue;
    }
    // Any OTHER section's header closes the current one — see the boundary rule above.
    if (current && isNoise(line)) continue;
    if (!current) continue;
    opts.onRow(line, current);
  }
}

module.exports = {
  parseNum, isNum,
  foldPunct, headerKey, squash,
  trailingNumbers, trailingAmount,
  scanSections, makeNoiseTest, stripContinuation, CONTINUATION,
};
