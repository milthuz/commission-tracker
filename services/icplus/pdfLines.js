// ============================================================================
// IC+ fee-comparison calculator — PDF text extraction (§1 of the scope).
//
// ⚠️ §9.1: get this wrong and every downstream regex silently misfires. That is why the
// row-building and normalization live HERE, in one shared function, rather than being
// reimplemented in the browser: the frontend owns loading the PDF (it ships pdfjs-dist),
// but it hands the raw text items to this file so the parsers and the tests are reading
// text produced by exactly the same code path.
//
// pdf-parse, which the backend already depends on for other features, cannot stand in
// here: it returns flattened text with no per-item transforms, and the row grouping below
// needs each item's Y coordinate.
//
// The algorithm, which must be replicated exactly:
//   1. group text items into rows by Math.round(item.transform[5])  — the Y coordinate
//   2. sort each row left-to-right by X (item.transform[4])
//   3. join with a single space
//   4. collapse whitespace: .replace(/\s+/g, ' ').trim()
//
// Step 4 is not cosmetic tidying. Several parser regexes anchor on line-start patterns
// (e.g. /^2\s+Interchange/) that only match AFTER this collapse, because PDF extraction
// injects stray spaces from bold/kerning artifacts — "S ERVICE C HARGES" for a header
// that visually reads "SERVICE CHARGES". Without the collapse, section-header detection
// breaks and a parser silently scans the wrong region of the statement.
// ============================================================================

// Build normalized lines from one page's pdf.js textContent items.
//
// `items` is the array from page.getTextContent(): each item carries `str` and a
// `transform` matrix whose [4] and [5] are the X and Y translation.
function linesFromItems(items) {
  const rows = new Map();

  for (const item of items || []) {
    if (!item || typeof item.str !== 'string') continue;
    if (!item.str.length) continue;
    const t = item.transform || item.tx || [];
    const y = Math.round(Number(t[5]) || 0);
    const x = Number(t[4]) || 0;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x, str: item.str });
  }

  // Rows top-to-bottom. PDF Y grows upward, so descending Y is reading order.
  const ys = [...rows.keys()].sort((a, b) => b - a);

  return ys.map((y) => rows.get(y)
    .sort((a, b) => a.x - b.x)
    .map((i) => i.str)
    .join(' ')
    // ⚠️ the whitespace collapse — see the header.
    .replace(/\s+/g, ' ')
    .trim())
    .filter((l) => l.length > 0);
}

// Flatten a whole document's pages into one line array, which is what every parser takes.
// `pages` is an array of textContent item arrays, in page order.
function linesFromPages(pages) {
  const out = [];
  for (const items of pages || []) out.push(...linesFromItems(items));
  return out;
}

// ---------------------------------------------------------------------------
// CELLS — the same rows, but with the PDF's own column boundaries kept.
//
// ⚠️ Why this exists alongside linesFromItems, which §1 mandates.
//
// The whitespace collapse is required for header matching and works for every layout that
// separates thousands with a comma. It is LOSSY for a layout that separates thousands with
// a SPACE (French Moneris): there, the space is simultaneously the thousands separator and
// the column separator, so once collapsed "Visa 2 400 128 900,50" cannot be told apart from
// a single number 2 400 128 900,50 — count 2400 + amount 128900.50 and 2400128900.50 are
// both valid readings, and no digit-grouping rule settles it.
//
// The PDF itself knows: those are two separate text items at two different X positions.
// So cells keep one entry per text item, and a parser that needs unambiguous columns reads
// these instead of the collapsed string. Each cell is still individually whitespace-
// collapsed, so a value never carries stray kerning spaces.
//
// Parsers should keep using lines unless they have this specific problem.
// ---------------------------------------------------------------------------
function cellsFromItems(items) {
  const rows = new Map();

  for (const item of items || []) {
    if (!item || typeof item.str !== 'string') continue;
    if (!item.str.trim()) continue;
    const t = item.transform || item.tx || [];
    const y = Math.round(Number(t[5]) || 0);
    const x = Number(t[4]) || 0;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x, str: item.str.replace(/\s+/g, ' ').trim() });
  }

  return [...rows.keys()].sort((a, b) => b - a)
    .map((y) => rows.get(y).sort((a, b) => a.x - b.x).map((i) => i.str))
    .filter((cells) => cells.length > 0);
}

function cellsFromPages(pages) {
  const out = [];
  for (const items of pages || []) out.push(...cellsFromItems(items));
  return out;
}

// Build the normalized lines FROM already-grouped cells.
//
// ⚠️ This is what lets the browser do the part only it can do — loading the PDF and grouping
// text items by coordinate — while the whitespace collapse that §9.1 warns about stays here,
// in ONE place. If the browser produced finished lines of its own, the collapse would exist
// twice, and the copy the tests exercise would not be the copy production runs: they could
// drift apart silently, with every fixture still green.
function linesFromCells(cellRows) {
  return (cellRows || [])
    .map((cells) => (Array.isArray(cells) ? cells.join(' ') : String(cells || ''))
      // ⚠️ the same collapse as linesFromItems — see the header.
      .replace(/\s+/g, ' ')
      .trim())
    .filter((l) => l.length > 0);
}

// Node-side convenience for tests and for any server path that has the bytes: loads a PDF
// with pdfjs-dist and returns the same normalized lines the browser would produce.
// Resolved lazily so the backend does not take a hard dependency on pdfjs-dist — the
// browser is the normal caller.
async function linesFromBuffer(buffer, opts = {}) {
  let pdfjsPath = opts.pdfjsPath || 'pdfjs-dist/legacy/build/pdf.mjs';
  // On Windows the ESM loader rejects a bare absolute path ("protocol 'c:'"), so an
  // absolute specifier has to be handed over as a file:// URL.
  if (/^[a-zA-Z]:[\\/]/.test(pdfjsPath) || pdfjsPath.startsWith('/')) {
    pdfjsPath = require('url').pathToFileURL(pdfjsPath).href;
  }
  const pdfjs = await import(pdfjsPath);
  const getDocument = pdfjs.getDocument || (pdfjs.default && pdfjs.default.getDocument);

  const params = {
    data: new Uint8Array(buffer),
    // Statements are text PDFs; nothing here needs fonts rendered or external resources
    // fetched, and disabling them keeps extraction offline and fast.
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
  };
  // Without this pdf.js logs an UnknownErrorException per standard font it meets. It does
  // not affect the extracted text, but it buries real warnings in noise.
  if (opts.standardFontDataUrl) params.standardFontDataUrl = opts.standardFontDataUrl;

  const loadingTask = getDocument(params);
  const doc = await loadingTask.promise;

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(content.items);
  }
  // v6 puts destroy() on the loading task, not the document.
  await loadingTask.destroy();
  // Both views of the same document: the collapsed lines every parser uses, and the cell
  // boundaries the space-thousands layouts need. Callers that only want lines can keep
  // treating the result as an array — `cells` rides along as a property.
  const lines = linesFromPages(pages);
  lines.cells = cellsFromPages(pages);
  return lines;
}

module.exports = { linesFromItems, linesFromPages, cellsFromItems, cellsFromPages, linesFromCells, linesFromBuffer };
