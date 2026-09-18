// ============================================================================
// IC+ fee-comparison calculator — HTTP layer.
//
// Kept in its own module with a single mount line in server.js. That file is ~36k lines and
// several sessions edit it at once; adding 200 lines to it invites exactly the kind of
// merge accident this project has already had once.
//
// ⚠️ THE SERVER RECOMPUTES. Every response's money comes from calc.recalc() here, never from
// whatever the browser sent. The client may post its edited state, but the figures it gets
// back — and the figures that reach a PDF — are the server's. A rep cannot alter a savings
// number by editing a request, and the PDF cannot disagree with the screen.
//
// ⚠️ PARSING IS SPLIT ON PURPOSE. The browser extracts the PDF's text (it ships pdfjs-dist;
// the backend does not), and posts LINES. Everything downstream — rate tables, classifier,
// parsers — stays on the server, so the reference rate data is never shipped to a client
// and can be corrected without a frontend deploy.
// ============================================================================

const parsers = require('./parsers');
const calc = require('./calc');
const importJson = require('./importJson');
const pdf = require('./pdf');
const pdfLines = require('./pdfLines');
const rateTables = require('./rateTables');
const notes = require('./notes');
const ratesStore = require('./ratesStore');

const PERM_USE = 'icplus:use';
const PERM_MARGIN = 'icplus:margin';
const PERM_RATES = 'icplus:rates';

// Cap the posted payload: a statement is a few hundred lines, and anything far past that is
// either a mistake or an attempt to make the server chew on nothing useful.
const MAX_LINES = 20000;
const MAX_LINE_LEN = 2000;
const MAX_JSON_CHARS = 2_000_000;

function registerIcplusRoutes(app, deps) {
  const { authenticateToken, requirePerm, hasPerm, pool, logActivity } = deps;

  // Charge les taux depuis la base au démarrage; sans base, les valeurs du code tiennent lieu
  // de repli et le serveur démarre quand même.
  if (pool) ratesStore.init(pool);

  // Did this caller earn the internal margin panel?
  async function canSeeMargin(req) {
    if (req.user && req.user.isAdmin === true) return true;
    try { return await hasPerm(req, PERM_MARGIN); } catch { return false; }
  }

  // ⚠️ The margin panel exposes Cluster's OWN costs. It is a separate permission from using
  // the calculator, and it is stripped from the response rather than merely hidden in the
  // UI — a hidden field in a JSON payload is not a permission check.
  function shape(result, showMargin) {
    if (showMargin) return result;
    const { margin, ...rest } = result;
    return rest;
  }

  const lang = (req) => (String(req.query.lang || (req.body && req.body.lang) || 'fr').toLowerCase() === 'en' ? 'en' : 'fr');

  // Turn a parse result into everything the page needs, in one round trip: the seeded state,
  // the computed comparison, and the notes already rendered in the caller's language.
  async function respondWithParse(req, res, parsed, extra = {}) {
    const state = calc.populate(parsed, {
      salesperson: (req.body && req.body.salesperson) || '',
      clusterRates: req.body && req.body.clusterRates,
      clusterFixed: req.body && req.body.clusterFixed,
      taxMultiplier: req.body && req.body.taxMultiplier,
    });
    const result = calc.recalc(state);
    res.json({
      ok: true,
      state,
      result: shape(result, await canSeeMargin(req)),
      notes: notes.toRecords(parsed.notes || [], lang(req)),
      ...extra,
    });
  }

  // ---------------------------------------------------------------------------
  // GET /api/icplus/config — what the page needs before it can do anything.
  // ---------------------------------------------------------------------------
  app.get('/api/icplus/config', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    const L = lang(req);
    res.json({
      processors: parsers.available(),
      // ⚠️ Surfaced so the UI can SAY the audit is running against incomplete reference
      // data. Without this the page looks broken: every interchange line reads "À vérifier"
      // and nothing explains why.
      rateData: {
        version: rateTables.DATA_VERSION,
        incomplete: rateTables.tablesIncomplete(),
        unsourced: rateTables.unsourcedTables(),
        status: rateTables.tableStatus(),
      },
      defaults: {
        taxMultiplier: calc.DEFAULT_TAX_MULTIPLIER,
        flatInterchangeFallback: calc.FLAT_INTERCHANGE_FALLBACK,
        fixedKeys: calc.FIXED_KEYS,
        brands: calc.BRANDS,
      },
      canSeeMargin: await canSeeMargin(req),
      statuses: require('./classify').STATUS,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/icplus/parse — extracted statement text in, comparison out.
  //
  // Body: { lines: string[], cells?: string[][], processor?: 'auto'|<key> }
  // `cells` carries the PDF's column boundaries and is required by the French Moneris
  // layout, where a space is both the thousands and the column separator.
  // ---------------------------------------------------------------------------
  app.post('/api/icplus/parse', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;

    const body = req.body || {};
    const hasCells = Array.isArray(body.cells);
    const hasLines = Array.isArray(body.lines);
    if (!hasCells && !hasLines) return res.status(400).json({ ok: false, error: 'cells[][] or lines[] required' });
    if ((body.cells || body.lines).length > MAX_LINES) return res.status(413).json({ ok: false, error: 'too many rows' });

    const cells = hasCells
      ? body.cells.slice(0, MAX_LINES)
          .map((row) => (Array.isArray(row) ? row.slice(0, 128).map((c) => String(c == null ? '' : c).slice(0, MAX_LINE_LEN)) : []))
      : null;

    // ⚠️ When cells are supplied, the LINES are derived here rather than trusted from the
    // browser. That keeps the §1 whitespace collapse in one place: if the client built its
    // own lines, the copy under test and the copy in production could drift apart silently.
    const lines = cells
      ? pdfLines.linesFromCells(cells)
      : body.lines.slice(0, MAX_LINES).map((l) => String(l == null ? '' : l).slice(0, MAX_LINE_LEN));
    if (cells) lines.cells = cells;

    let out;
    try {
      out = parsers.parse(lines, body.processor || 'auto');
    } catch (e) {
      console.error('[icplus] parse failed:', e.message);
      return res.status(500).json({ ok: false, error: 'parse failed', detail: e.message });
    }

    if (!out.ok) {
      return res.json({
        ok: false,
        reason: out.reason,
        processor: out.processor || null,
        notes: notes.toRecords(out.notes || [], lang(req)),
      });
    }

    return respondWithParse(req, res, out, { processor: out.processor, detected: out.detected });
  });

  // ---------------------------------------------------------------------------
  // POST /api/icplus/import — the scanned-statement fallback (§7).
  //
  // ⚠️ Feeds the SAME populate() path as a real parse. That equivalence is the whole point
  // of the fallback, and importJson.validateShape() is what keeps it true.
  // ---------------------------------------------------------------------------
  app.post('/api/icplus/import', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;

    const text = (req.body && req.body.text) || '';
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
    if (text.length > MAX_JSON_CHARS) return res.status(413).json({ ok: false, error: 'payload too large' });

    const parsed = importJson.parseImport(text, { lang: lang(req) });
    if (!parsed.ok) {
      return res.json({
        ok: false,
        reason: 'invalid_json',
        errors: parsed.errors,
        notes: notes.toRecords(parsed.notes || [], lang(req)),
      });
    }
    return respondWithParse(req, res, parsed.parsed, { processor: 'manual', warnings: parsed.warnings });
  });

  // ---------------------------------------------------------------------------
  // POST /api/icplus/calculate — recompute after the rep edits anything.
  // ---------------------------------------------------------------------------
  app.post('/api/icplus/calculate', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;
    const state = req.body && req.body.state;
    if (!state || typeof state !== 'object') return res.status(400).json({ ok: false, error: 'state required' });

    try {
      const result = calc.recalc(state);
      res.json({ ok: true, result: shape(result, await canSeeMargin(req)) });
    } catch (e) {
      console.error('[icplus] calculate failed:', e.message);
      res.status(400).json({ ok: false, error: 'could not compute', detail: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /api/icplus/rates — les huit tables, pour l'écran Admin.
  // ---------------------------------------------------------------------------
  app.get('/api/icplus/rates', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_RATES))) return;
    if (!pool) return res.status(503).json({ error: 'base indisponible' });
    try {
      const entries = await ratesStore.listAll(pool);
      const byTable = Object.fromEntries(ratesStore.TABLE_NAMES.map((n) => [n, []]));
      for (const e of entries) if (byTable[e.table_name]) byTable[e.table_name].push(e);
      res.json({
        ok: true,
        tables: byTable,
        tableNames: ratesStore.TABLE_NAMES,
        // Les sources autorisées : une entrée sans provenance traçable est refusée, donc
        // l'écran doit proposer la liste plutôt que laisser saisir du texte libre.
        sources: rateTables.SOURCES,
        version: rateTables.DATA_VERSION,
        limits: { maxRate: ratesStore.MAX_RATE, minRate: ratesStore.MIN_RATE },
      });
    } catch (e) {
      console.error('[icplus] lecture des taux impossible:', e.message);
      res.status(500).json({ error: 'lecture impossible' });
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /api/icplus/rates/:table — remplace le contenu d'UNE table.
  //
  // ⚠️ Tout ou rien. Une entrée invalide et rien n'est écrit : une table de taux à moitié
  // remplacée produirait des verdicts « Conforme » sur une moitié et « À vérifier » sur
  // l'autre, sans que personne ne sache laquelle est à jour.
  // ---------------------------------------------------------------------------
  app.put('/api/icplus/rates/:table', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_RATES))) return;
    if (!pool) return res.status(503).json({ error: 'base indisponible' });

    const table = String(req.params.table || '');
    if (!ratesStore.TABLE_NAMES.includes(table)) return res.status(400).json({ error: 'table inconnue' });

    const entries = (req.body && req.body.entries) || [];
    if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries[] requis' });
    if (entries.length > 2000) return res.status(413).json({ error: 'trop d’entrées' });

    try {
      const out = await ratesStore.replaceTable(pool, table, entries, req.user && req.user.email, logActivity);
      if (!out.ok) return res.status(400).json({ ok: false, problems: out.problems });
      res.json({ ok: true, count: out.count, incomplete: rateTables.tablesIncomplete(), unsourced: rateTables.unsourcedTables() });
    } catch (e) {
      console.error('[icplus] écriture des taux impossible:', e.message);
      res.status(500).json({ error: 'écriture impossible', detail: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/icplus/pdf — the two exports (§6).
  //
  // ⚠️ The server recomputes from the posted state before rendering, so the document can
  // never carry a figure the engine did not produce.
  // ---------------------------------------------------------------------------
  app.post('/api/icplus/pdf', authenticateToken, async (req, res) => {
    if (!(await requirePerm(req, res, PERM_USE))) return;

    const body = req.body || {};
    const state = body.state;
    if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state required' });

    const detailed = body.kind === 'detailed';
    // ⚠️ The detailed document contains the internal margin panel, so it needs that
    // permission — not merely the right to use the calculator.
    if (detailed && !(await canSeeMargin(req))) {
      return res.status(403).json({ error: `Permission required: ${PERM_MARGIN}` });
    }

    try {
      const result = calc.recalc(state);
      const L = lang(req);
      const opts = {
        lang: L,
        salesperson: body.salesperson || '',
        notes: body.notes || '',
        validDays: body.validDays,
        date: body.date,
      };
      const buf = detailed
        ? await pdf.buildDetailedPdf({ state, result, options: opts })
        : await pdf.buildClientPdf({ state, result, options: opts });

      const filename = pdf.pdfFilename({
        merchantName: state.merchantName,
        date: body.date,
        salesperson: body.salesperson,
        detailed,
        lang: L,
      });

      res.setHeader('Content-Type', 'application/pdf');
      // RFC 5987 so accented merchant names survive the trip.
      res.setHeader('Content-Disposition',
        `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(buf);
    } catch (e) {
      console.error('[icplus] pdf failed:', e.message);
      res.status(500).json({ error: 'could not build the PDF', detail: e.message });
    }
  });
}

module.exports = { registerIcplusRoutes, PERM_USE, PERM_MARGIN, PERM_RATES };
