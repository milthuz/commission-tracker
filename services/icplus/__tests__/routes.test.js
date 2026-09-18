// The HTTP layer.
//
// Mounted on a bare express app with stubbed auth, so this runs without a database or any
// environment. What it proves is the part that only exists at this layer: permission gating,
// the margin panel being STRIPPED rather than merely hidden, and the server recomputing
// money instead of trusting what the browser posted.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { registerIcplusRoutes, PERM_USE, PERM_MARGIN, PERM_RATES } = require('../routes');
let PGlite; try { ({ PGlite } = require('@electric-sql/pglite')); } catch { PGlite = null; }

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

// A caller's permissions come from the x-test-perms header, so one server can stand in for
// every role the real app has.
function makeApp(pool, logActivity) {
  const app = express();
  app.use(express.json({ limit: '8mb' }));

  const permsOf = (req) => new Set(String(req.headers['x-test-perms'] || '').split(',').filter(Boolean));

  registerIcplusRoutes(app, {
    authenticateToken: (req, _res, next) => { req.user = { email: 'rep@example.com', isAdmin: false }; next(); },
    requirePerm: async (req, res, perm) => {
      if (permsOf(req).has(perm)) return true;
      res.status(403).json({ error: `Permission required: ${perm}` });
      return false;
    },
    hasPerm: async (req, perm) => permsOf(req).has(perm),
    pool, logActivity,
  });
  return app;
}

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'global-fr.lines.txt'), 'utf8').split('\n').filter((l) => l.length);

(async () => {
  // Un vrai Postgres en mémoire pour les endpoints de taux; sans lui ils répondent 503, ce qui
  // est un comportement correct mais ne prouve rien.
  const db = PGlite ? new PGlite() : null;
  const pool = db ? {
    query: (sql, params) => db.query(sql, params),
    connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }),
  } : null;
  const logged = [];
  const app = makeApp(pool, async (...a) => { logged.push(a); });
  if (pool) await require('../ratesStore').init(pool);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, url, { perms = [PERM_USE], body } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-perms': perms.join(',') },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };

  // ---------------------------------------------------------------------------
  // Permission gating — every endpoint, not just the obvious one.
  // ---------------------------------------------------------------------------
  for (const [method, url, body] of [
    ['GET', '/api/icplus/config', undefined],
    ['POST', '/api/icplus/parse', { lines }],
    ['POST', '/api/icplus/import', { text: '{}' }],
    ['POST', '/api/icplus/calculate', { state: {} }],
    ['POST', '/api/icplus/pdf', { state: {} }],
  ]) {
    const r = await call(method, url, { perms: [], body });
    ok(`${method} ${url} refuses a caller without ${PERM_USE}`, r.status === 403, r.status);
  }

  // ---------------------------------------------------------------------------
  // config
  // ---------------------------------------------------------------------------
  const cfg = await call('GET', '/api/icplus/config');
  ok('config returns the six processors', cfg.body.processors.length === 6, cfg.body.processors.length);
  ok('config marks which are verified against real paper',
    cfg.body.processors.filter((p) => p.verified).map((p) => p.key).sort().join(',') === 'clover,global',
    cfg.body.processors.filter((p) => p.verified).map((p) => p.key));
  // ⚠️ Without this the page looks broken: every interchange line reads "À vérifier" and
  // nothing on screen explains that the reference tables are still empty.
  ok('config admits the rate data is incomplete', cfg.body.rateData.incomplete === true, cfg.body.rateData);
  ok('config names the unsourced tables', cfg.body.rateData.unsourced.length > 0, cfg.body.rateData.unsourced);

  // ---------------------------------------------------------------------------
  // parse
  // ---------------------------------------------------------------------------
  const parsed = await call('POST', '/api/icplus/parse', { body: { lines } });
  ok('parse succeeds', parsed.body.ok === true, parsed.body);
  ok('parse auto-detects Global', parsed.body.processor === 'global', parsed.body.processor);
  ok('parse returns the seeded state', !!parsed.body.state && !!parsed.body.state.volume, Object.keys(parsed.body.state || {}));
  ok('parse reconciles to 703.92', near(parsed.body.result.current.pretax, 703.92), parsed.body.result.current.pretax);
  ok('parse returns rendered notes', Array.isArray(parsed.body.notes) && parsed.body.notes.every((n) => n.code && typeof n.text === 'string'),
    (parsed.body.notes || [])[0]);
  const enParse = await call('POST', '/api/icplus/parse', { body: { lines, lang: 'en' } });
  ok('notes render in the requested language',
    enParse.body.notes.some((n) => /Reconciled against/.test(n.text)), enParse.body.notes.map((n) => n.text.slice(0, 40)));

  const badLines = await call('POST', '/api/icplus/parse', { body: {} });
  ok('parse without lines is a 400', badLines.status === 400, badLines.status);
  const unknown = await call('POST', '/api/icplus/parse', { body: { lines: ['hello', 'world'] } });
  ok('an unreadable statement answers ok:false, not a crash', unknown.body.ok === false && unknown.body.reason === 'unrecognized', unknown.body);

  // ---------------------------------------------------------------------------
  // ⚠️ THE MARGIN PANEL IS STRIPPED, NOT HIDDEN. A field left in the JSON and merely not
  // rendered is not a permission check — it exposes Cluster's own costs to anyone who opens
  // the network tab.
  // ---------------------------------------------------------------------------
  ok('margin absent without icplus:margin', parsed.body.result.margin === undefined, Object.keys(parsed.body.result));
  ok('config says so too', cfg.body.canSeeMargin === false, cfg.body.canSeeMargin);

  const withMargin = await call('POST', '/api/icplus/parse', { perms: [PERM_USE, PERM_MARGIN], body: { lines } });
  ok('margin present WITH icplus:margin', !!withMargin.body.result.margin, Object.keys(withMargin.body.result));
  ok('and the margin carries rows', withMargin.body.result.margin.rows.length > 0, withMargin.body.result.margin.rows.length);

  // ---------------------------------------------------------------------------
  // calculate — the server recomputes; it does not echo what was posted.
  // ---------------------------------------------------------------------------
  const state = parsed.body.state;
  const tampered = JSON.parse(JSON.stringify(state));
  tampered.current.interchange = 99999;      // a rep "editing" the savings in flight
  const recomputed = await call('POST', '/api/icplus/calculate', { body: { state: tampered } });
  ok('calculate recomputes from the posted state',
    near(recomputed.body.result.current.interchange, 99999), recomputed.body.result.current.interchange);
  // The point: the TOTAL follows from the engine's formula, never from a posted total.
  ok('and the total follows the engine, not the payload',
    near(recomputed.body.result.current.pretax,
      recomputed.body.result.current.markup + 99999 + recomputed.body.result.current.fixed),
    recomputed.body.result.current.pretax);

  const noState = await call('POST', '/api/icplus/calculate', { body: {} });
  ok('calculate without a state is a 400', noState.status === 400, noState.status);

  // ---------------------------------------------------------------------------
  // import (§7)
  // ---------------------------------------------------------------------------
  const imported = await call('POST', '/api/icplus/import', {
    body: { text: '```json\n' + JSON.stringify({ current_processor: { visa_rate: 0.02, interchange: 100 }, volume: { visa_count: 10, visa_amt: 1000 } }) + '\n```' },
  });
  ok('import accepts fenced JSON', imported.body.ok === true, imported.body);
  ok('import returns a full comparison', !!imported.body.result && !!imported.body.state, Object.keys(imported.body));
  ok('import is labelled manual', imported.body.processor === 'manual', imported.body.processor);

  const badImport = await call('POST', '/api/icplus/import', { body: { text: '{ broken' } });
  ok('bad JSON answers ok:false with a readable note',
    badImport.body.ok === false && badImport.body.notes[0].text.length > 10, badImport.body);

  // ---------------------------------------------------------------------------
  // pdf
  // ---------------------------------------------------------------------------
  const clientPdf = await call('POST', '/api/icplus/pdf', { body: { state, kind: 'client', salesperson: 'David' } });
  ok('client PDF returns a PDF', Buffer.isBuffer(clientPdf.body) && clientPdf.body.slice(0, 5).toString() === '%PDF-',
    Buffer.isBuffer(clientPdf.body) ? clientPdf.body.slice(0, 8).toString() : clientPdf.body);

  // ⚠️ The detailed document embeds the margin panel, so it needs that permission — not
  // merely the right to use the calculator.
  const deniedDetail = await call('POST', '/api/icplus/pdf', { body: { state, kind: 'detailed' } });
  ok('detailed PDF refused without icplus:margin', deniedDetail.status === 403, deniedDetail.status);
  const allowedDetail = await call('POST', '/api/icplus/pdf', { perms: [PERM_USE, PERM_MARGIN], body: { state, kind: 'detailed' } });
  ok('detailed PDF allowed with it', Buffer.isBuffer(allowedDetail.body) && allowedDetail.body.slice(0, 5).toString() === '%PDF-',
    allowedDetail.status);
  ok('the two documents differ', clientPdf.body.length !== allowedDetail.body.length,
    [clientPdf.body.length, allowedDetail.body.length]);

  // ---------------------------------------------------------------------------
  // Tables de taux (écran Admin)
  // ---------------------------------------------------------------------------
  if (!pool) {
    ok('PGlite requis pour tester les endpoints de taux', false, 'npm install --no-save @electric-sql/pglite');
  } else {
    // ⚠️ Permission DISTINCTE de icplus:use : modifier un taux de référence n'est pas un geste
    // d'usage courant, c'est de la maintenance qui change les verdicts de TOUS les relevés.
    const r1 = await call('GET', '/api/icplus/rates', { perms: [PERM_USE] });
    ok('lire les taux refusé avec icplus:use seul', r1.status === 403, r1.status);
    const r2 = await call('PUT', '/api/icplus/rates/visaDomestic', { perms: [PERM_USE], body: { entries: [] } });
    ok('écrire les taux refusé avec icplus:use seul', r2.status === 403, r2.status);

    const got = await call('GET', '/api/icplus/rates', { perms: [PERM_RATES] });
    ok('lecture autorisée avec icplus:rates', got.status === 200 && got.body.ok, got.status);
    ok('les huit tables sont renvoyées', got.body.tableNames.length === 8, got.body.tableNames);
    ok('la liste des sources est fournie', Object.keys(got.body.sources).length > 0, Object.keys(got.body.sources).length);
    ok('networkFees est amorcée', (got.body.tables.networkFees || []).length === 6, (got.body.tables.networkFees || []).length);

    // ⚠️ Le piège de cet écran : un pourcentage non converti. Refusé, jamais divisé en douce.
    const bad = await call('PUT', '/api/icplus/rates/visaDomestic', {
      perms: [PERM_RATES], body: { entries: [{ cat: 'Visa — Test', rate: 1.42, src: 'visa_published' }] },
    });
    ok('un taux > 100 % est refusé', bad.status === 400 && !!bad.body.problems, bad.body);
    ok('et le motif est explicite', bad.body.problems[0].errors.some((e) => e.code === 'looksLikePercent'), bad.body.problems);

    const noSrc = await call('PUT', '/api/icplus/rates/visaDomestic', {
      perms: [PERM_RATES], body: { entries: [{ cat: 'Visa — Test', rate: 0.0142 }] },
    });
    ok('une entrée sans source est refusée', noSrc.status === 400, noSrc.body);

    const good = await call('PUT', '/api/icplus/rates/visaDomestic', {
      perms: [PERM_RATES], body: { entries: [{ cat: 'Visa — Electronic Standard', rate: 0.0142, src: 'visa_published' }] },
    });
    ok('une entrée valide est acceptée', good.status === 200 && good.body.ok, good.body);
    ok('la modification est journalisée', logged.length > 0, logged.length);

    // ⚠️ L'EFFET QUI COMPTE : un taux saisi dans Admin change le verdict rendu par /parse
    // IMMÉDIATEMENT, sans redéploiement. C'est toute la raison d'être de cet écran.
    const after = await call('POST', '/api/icplus/parse', { body: { lines } });
    const cats = after.body.state.lineAudit.interchange.map((r) => r.cat).filter(Boolean);
    ok('le nouveau taux est actif dans le classificateur sans redéploiement',
      cats.some((c) => /Electronic Standard/.test(c)), cats.slice(0, 5));

    const unknownTable = await call('PUT', '/api/icplus/rates/inventee', { perms: [PERM_RATES], body: { entries: [] } });
    ok('table inconnue rejetée', unknownTable.status === 400, unknownTable.status);
  }

  server.close();
  if (db) await db.close();
  console.log(fail ? `\n${fail} FAILING` : '\nall green');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
