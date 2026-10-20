// Module Finance, phase 2 lot A — budgets d'entité (Cluster, Xperio) et départementaux, de bout en
// bout contre une vraie base Postgres en mémoire (PGlite) et un vrai serveur HTTP :
//   - les références tirées du paquet de passation (budget_data.js) et celles relues du VRAI
//     classeur de la CFO (source_excel/Cluster_Budget_Sep2026_Dec2027.xlsx) sont identiques
//     (mêmes identifiants de drivers, mêmes chiffres — 4 cellules d'écart connues, listées) ;
//   - totaux de référence de SPEC-phase2 §A.1 / §B au cent près ;
//   - import initial / refus / --reference-only ; permissions, mode démo, verrou d'approbation,
//     concurrence, réinitialisation au journal ; import Excel avec aperçu puis confirmation,
//     ajustements gardés / retirés ; modèles Excel relus à l'identique.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/entityBudgets.test.js [dossier design/finance]
// ⚠️ Échoue si le dossier de passation ou le classeur manque, plutôt que de se déclarer vert.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const { isDeepStrictEqual: same } = require('util'); // JSONB réordonne les clés : comparer le contenu, pas le texte
const xlsx = require('xlsx');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerFinanceRoutes } = require('../routes');
const { importHandoff } = require('../import');
const { extractEntityBudgets, PROTO } = require('../handoff');
const E = require('../entityBudgets');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
const XLSX_FILE = path.join(DIR, 'source_excel', 'Cluster_Budget_Sep2026_Dec2027.xlsx');
if (!fs.existsSync(path.join(DIR, PROTO))) { console.error(`ÉCHEC : paquet de passation introuvable dans ${DIR}`); process.exit(1); }
if (!fs.existsSync(XLSX_FILE)) { console.error(`ÉCHEC : classeur introuvable (${XLSX_FILE})`); process.exit(1); }

const book = (buf) => {
  const wb = xlsx.read(buf, { type: 'buffer', cellDates: true });
  return { sheetNames: wb.SheetNames, rows: (n) => (wb.Sheets[n] ? xlsx.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true, defval: null }) : []) };
};

(async () => {
  let n = 0; const ok = (c, m) => { assert(c, m); n++; };
  const near = (a, b, m) => ok(Number.isFinite(a) && Math.abs(a - b) < 0.005, `${m} : ${a} ≠ ${b}`);
  // Somme de deux totaux déjà arrondis au cent : un cent d'écart possible.
  const near2 = (a, b, m) => ok(Number.isFinite(a) && Math.abs(a - b) < 0.0105, `${m} : ${a} ≠ ${b}`);
  const sum = (a, f = 0, t = a.length) => a.slice(f, t).reduce((x, y) => x + (y || 0), 0);

  // ---------------------------------------------------------------- 1. références
  const H = extractEntityBudgets(DIR);
  ok(H.cluster.drivers.length === 141 && H.xperio.drivers.length === 82, 'paquet : 141 drivers Cluster, 82 Xperio (données bien chargées)');
  ok(H.cluster.pl.length === 23 && H.cluster.pl.every((r) => r.v.length === 21), 'paquet : 23 lignes de P&L, 21 colonnes');
  ok(new Set([...H.cluster.drivers, ...H.xperio.drivers].map((d) => d.id)).size === 223, 'identifiants de drivers : 223, tous distincts');
  ok(H.cluster.drivers.every((d) => /^d[0-9a-f]{12}$/.test(d.id)), 'identifiant : « d » + 12 hex');
  ok(extractEntityBudgets(DIR).cluster.drivers.every((d, i) => d.id === H.cluster.drivers[i].id), 'identifiants déterministes');

  const XB = fs.readFileSync(XLSX_FILE);
  const real = book(XB);
  const PX = { cluster: E.parseEntityWorkbook(real, 'cluster'), xperio: E.parseEntityWorkbook(real, 'xperio') };
  for (const k of ['cluster', 'xperio']) {
    const p = PX[k];
    ok(p.errors.length === 0 && p.ref, `classeur ${k} : lu sans erreur (${JSON.stringify(p.errors.slice(0, 3))})`);
    ok(p.warnings.length === 0, `classeur ${k} : tous les contrôles d'addition passent (${JSON.stringify(p.warnings.slice(0, 3))})`);
    ok(p.checks && p.checks.length === 8 && p.checks.every((c) => c.status === 'PASS'), `classeur ${k} : feuille Checks lue, 8 PASS`);
    ok(p.ref.drivers.length === H[k].drivers.length, `classeur ${k} : même nombre de drivers`);
    ok(p.ref.drivers.every((d, i) => d.id === H[k].drivers[i].id), `classeur ${k} : MÊMES identifiants que le paquet (stables entre sources)`);
    p.ref.pl.forEach((r, i) => ok(JSON.stringify(r.v) === JSON.stringify(H[k].pl[i].v) || r.v.every((x, j) => (x == null && H[k].pl[i].v[j] == null) || Math.abs(x - H[k].pl[i].v[j]) < 1e-6), `classeur ${k} : ligne ${r.name} identique`));
  }
  // Écarts connus entre budget_data.js et le classeur : Merchant Fees (déc. 2027) et l'Event Expense
  // placé en novembre au lieu d'octobre par l'extraction (le P&L du classeur la met en octobre).
  const diffs = [];
  for (const k of ['cluster', 'xperio']) {
    PX[k].ref.drivers.forEach((d, i) => {
      const h = H[k].drivers[i];
      for (const f of ['ent', 'sec', 'cat', 'parent', 'gl', 'type', 'basis', 'janAug', 'aug', 'base', 'input', 'esc', 'note']) {
        if (typeof d[f] === 'number' ? Math.abs(d[f] - h[f]) > 1e-6 : d[f] !== h[f]) diffs.push(`${k}:${d.gl}:${f}`);
      }
      d.m.forEach((v, j) => { if (Math.abs(v - h.m[j]) > 1e-6) diffs.push(`${k}:${d.gl}:m${j}`); });
    });
  }
  ok(JSON.stringify(diffs.sort()) === JSON.stringify(['cluster:Event Expense:m1', 'cluster:Event Expense:m2', 'cluster:Merchant Fees:m15', 'xperio:Merchant Fees:m15']),
    `classeur vs paquet : seulement les 4 cellules connues (${diffs.join(', ')})`);

  // Totaux de référence (SPEC-phase2 §A.1), au cent.
  const T = { cluster: E.plTotals(H.cluster), xperio: E.plTotals(H.xperio) };
  near(T.cluster.fy.revenue, 10141175.20, 'Cluster FY27 revenus');
  near(T.cluster.fy.ebitda, 1344784.18, 'Cluster FY27 BAIIA');
  near(T.cluster.fy.netIncome, 1093670.62, 'Cluster FY27 bénéfice net');
  near(T.cluster.t16.revenue, 12975616.28, 'Cluster 16 mois revenus');
  near(T.cluster.t16.ebitda, 1318594.90, 'Cluster 16 mois BAIIA');
  near(T.xperio.fy.revenue, 1180808.76, 'Xperio FY27 revenus');
  near(T.xperio.fy.ebitda, -438913.82, 'Xperio FY27 BAIIA');
  near(T.xperio.fy.netIncome, -561776.78, 'Xperio FY27 bénéfice net');
  near2(T.cluster.fy.revenue + T.xperio.fy.revenue, 11321983.96, 'consolidé FY27 revenus');
  near2(T.cluster.fy.opex + T.xperio.fy.opex, 6053687.51, 'consolidé FY27 OPEX');
  near2(T.cluster.t16.ebitda + T.xperio.t16.ebitda, 724516.58, 'consolidé 16 mois BAIIA (= feuille Checks)');
  near2(T.cluster.t16.netIncome + T.xperio.t16.netIncome, 225881.22, 'consolidé 16 mois bénéfice net');
  const gaps = (r) => E.driverGaps(r).map((g) => g.line).sort().join(',');
  ok(gaps(H.cluster) === 'Hardware COGS,Recurring COGS,Service COGS' && gaps(H.xperio) === 'Recurring COGS,Service COGS', 'paquet : écarts lignes ≠ Σ drivers, les 5 lignes connues');
  // Dans le classeur, Merchant Fees de déc. 2027 est juste : Recurring COGS (Cluster) tombe pile.
  ok(gaps(PX.cluster.ref) === 'Hardware COGS,Service COGS', `classeur : Recurring COGS Cluster ne montre plus d'écart (${gaps(PX.cluster.ref)} / ${gaps(PX.xperio.ref)})`);

  // Départements.
  const PD = E.parseDeptWorkbook(real);
  ok(PD.errors.length === 0 && PD.warnings.length === 0, `classeur départements : lu, contrôles OK (${JSON.stringify(PD.errors.concat(PD.warnings).slice(0, 3))})`);
  const HD = H.departments;
  ok(HD.depts.map((d) => d.rows.length).join(',') === '45,9,41,10', 'paquet départements : 45 / 9 / 41 / 10 lignes');
  HD.depts.forEach((d, i) => {
    const x = PD.ref.depts[i];
    ok(x.key === d.key && x.title === d.title && x.rows.length === d.rows.length, `départements ${d.key} : mêmes lignes`);
    ok(d.rows.every((r, j) => r.name === x.rows[j].name && r.v.every((v, c) => (v == null && x.rows[j].v[c] == null) || Math.abs(v - x.rows[j].v[c]) < 1e-6)), `départements ${d.key} : mêmes chiffres`);
  });
  const LEAD = { sales: [2701967.28, 9772940.42, 12474907.70], rd: [675693.74, 2087177.48, 2762871.21], ops: [1591178.82, 4898057.30, 6489236.12], acct: [142251.80, 438319.08, 580570.88] };
  for (const L of HD.leaders) LEAD[L.key].forEach((v, i) => { near(L.v[i], v, `leader ${L.key}[${i}] (paquet)`); near(PD.ref.leaders.find((x) => x.key === L.key).v[i], v, `leader ${L.key}[${i}] (classeur)`); });
  ok(HD.depts[0].contribution === true && HD.depts.slice(1).every((d) => !d.contribution), 'Ventes = contribution, les autres = dépenses');
  ok(HD.summary.length === 15 && HD.summary[0].name === 'Recurring Revenue', 'sommaire : 15 lignes de mesures');

  // ---------------------------------------------------------------- 2. serveur
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
  `);
  const perms = {
    'cfo@x.com': ['finance:view', 'finance:edit', 'finance:approve', 'finance:entity_budgets', 'finance:dept_budgets'],
    'analyste@x.com': ['finance:view', 'finance:edit', 'finance:entity_budgets'],
    'lecteur@x.com': ['finance:view', 'finance:entity_budgets', 'finance:dept_budgets'],
    'consolide@x.com': ['finance:view', 'finance:edit'],
    'sansvue@x.com': ['finance:entity_budgets'],
  };
  const has = (req, p) => (perms[req.user.email] || []).includes(p);
  const logs = [];
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const authenticateToken = (req, res, next) => {
    const e = req.headers['x-test-user']; if (!e) return res.status(401).json({ error: 'auth' });
    req.user = { email: e, isAdmin: false, isDemo: req.headers['x-test-demo'] === '1' }; next();
  };
  registerFinanceRoutes(app, {
    authenticateToken, pool,
    hasPerm: async (req, p) => has(req, p),
    requirePerm: async (req, res, p) => { if (has(req, p)) return true; res.status(403).json({ error: 'perm' }); return false; },
    logActivity: async (t, id, ev, d, actor, extra = {}) => { logs.push({ t, id, ev, d, actor, extra }); },
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, user, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const upload = async (p, user, buf, fields = {}) => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), 'budget.xlsx');
    for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
    const r = await fetch(base + p, { method: 'POST', headers: { 'x-test-user': user }, body: fd });
    return { status: r.status, body: await r.json() };
  };

  ok((await api('GET', '/api/finance/entity/cluster', 'cfo@x.com')).body.empty === true, 'avant import : empty');
  ok((await api('GET', '/api/finance/dept', 'cfo@x.com')).body.empty === true, 'départements avant import : empty');

  // Import initial (paquet) : crée consolidé + cluster + xperio + departments.
  const dry = await importHandoff(pool, DIR, { apply: false });
  ok(dry.dryRun && dry.entityBudgets.cluster.action === 'create' && dry.entityBudgets.cluster.drivers === 141 && dry.entityBudgets.departments.depts === 4, 'simulation : 3 lignes de plus seraient créées');
  ok((await api('GET', '/api/finance/entity/cluster', 'cfo@x.com')).body.empty === true, 'la simulation n\'a rien écrit');
  const imp = await importHandoff(pool, DIR, { apply: true, actor: 'test' });
  ok(imp.action === 'create' && ['cluster', 'xperio', 'departments'].every((e) => imp.entityBudgets[e].action === 'create' && imp.entityBudgets[e].budgetId), 'import : 4 lignes créées');
  ok((await importHandoff(pool, DIR, { apply: true })).action === 'refused_exists', '2e import refusé (inchangé)');
  const rows = (await db.query('SELECT entity, fiscal_year FROM finance_budgets ORDER BY id')).rows;
  ok(rows.map((r) => `${r.entity}:${r.fiscal_year}`).join(',') === 'consolidated:2027,cluster:2027,xperio:2027,departments:2027', 'lignes finance_budgets : consolidated, cluster, xperio, departments (FY2027)');
  // Le Budget maître (phase 1) ne voit que sa ligne.
  ok((await api('GET', '/api/finance/budget', 'cfo@x.com')).body.budget.entity === 'consolidated', 'GET /api/finance/budget : toujours le consolidé');

  // Lecture et permissions.
  ok((await api('GET', '/api/finance/entity/cluster', 'consolide@x.com')).status === 403, 'sans finance:entity_budgets : 403');
  ok((await api('GET', '/api/finance/entity/cluster', 'sansvue@x.com')).status === 403, 'sans finance:view : 403');
  ok((await api('GET', '/api/finance/entity/cluster', 'cfo@x.com', null, { 'x-test-demo': '1' })).status === 403, 'mode démo : bloqué');
  ok((await api('GET', '/api/finance/entity/holdco', 'cfo@x.com')).status === 404, 'entité inconnue : 404');
  ok((await api('GET', '/api/finance/dept', 'analyste@x.com')).status === 403, 'départements sans finance:dept_budgets : 403');
  let cl = (await api('GET', '/api/finance/entity/cluster', 'cfo@x.com')).body;
  ok(cl.reference.drivers.length === 141 && cl.reference.entity === 'Cluster' && !JSON.stringify(cl.reference).includes('"Xperio"'), 'Cluster : sa référence seulement');
  ok(cl.caps.canEdit && cl.caps.canApprove && cl.caps.canImport && cl.state.drivers === null, 'CFO : capacités, aucun ajustement');
  const lec = (await api('GET', '/api/finance/entity/cluster', 'lecteur@x.com')).body;
  ok(!lec.caps.canEdit && !lec.caps.canImport && !lec.caps.canApprove, 'lecteur : lecture seule');
  ok((await api('GET', '/api/finance/entity/cluster', 'analyste@x.com')).body.caps.canEdit, 'analyste (edit + entity) : peut modifier');
  const id = cl.budget.id;
  const drv = (name, line) => cl.reference.drivers.find((d) => d.gl === name && (!line || E.lineOfCat(d.cat) === line));
  const pay = drv('Payments Revenue').id, disc = drv('Service Discount').id, sub = drv('Subscription Revenue').id;
  const payroll = cl.reference.drivers.find((d) => d.type === 'Payroll allocation').id;

  // Ajustements.
  const put = (user, ov, version, bid = id) => api('PUT', `/api/finance/entity/budgets/${bid}/drivers`, user, { data: { ov }, version });
  ok((await put('lecteur@x.com', { [pay]: 4 }, 0)).status === 403, 'lecteur : ne peut pas modifier');
  ok((await put('consolide@x.com', { [pay]: 4 }, 0)).status === 403, 'finance:edit seul : ne peut pas modifier un budget d\'entité');
  ok((await put('cfo@x.com', { [payroll]: 4 }, 0)).body.error === `unknown_driver:${payroll}`, 'driver non recalculable (allocation de paie) : refusé');
  ok((await put('cfo@x.com', { pirate: 4 }, 0)).status === 400, 'driver inconnu : refusé');
  ok((await put('cfo@x.com', { [pay]: 900 }, 0)).body.error === `bad_driver:${pay}`, 'pourcentage hors plage : refusé');
  ok((await put('cfo@x.com', { [pay]: '4' }, 0)).status === 400, 'pourcentage non numérique : refusé');
  const consId = (await api('GET', '/api/finance/budget', 'cfo@x.com')).body.budget.id;
  ok((await put('cfo@x.com', { [pay]: 4 }, 0, consId)).body.error === 'not_entity_budget', 'ajustements d\'entité sur le budget consolidé : refusé');
  let r = await put('analyste@x.com', { [pay]: 4, [disc]: 10 }, 0);
  ok(r.status === 200 && r.body.version === 1, 'ajustements enregistrés (v1)');
  ok((await put('cfo@x.com', { [pay]: 5 }, 0)).status === 409, 'concurrence : v0 alors que v1 existe → 409');
  const stale = await put('cfo@x.com', { [pay]: 5 }, 7);
  ok(stale.status === 409 && stale.body.current.version === 1 && stale.body.current.data.ov[pay] === 4, 'version périmée → 409 + version courante');
  r = await put('cfo@x.com', { [pay]: 4, [disc]: 10, [sub]: 2 }, 1);
  ok(r.status === 200 && r.body.version === 2, 'v2 (dont Subscription Revenue)');
  cl = (await api('GET', '/api/finance/entity/cluster', 'lecteur@x.com')).body;
  ok(cl.state.drivers.version === 2 && cl.state.drivers.data.ov[sub] === 2, 'ajustements relus par tous');
  const xp = (await api('GET', '/api/finance/entity/xperio', 'lecteur@x.com')).body;
  ok(xp.state.drivers === null && xp.budget.id !== id, 'Xperio : budget et ajustements séparés');
  ok(logs.some((l) => l.t === 'finance_entity_budgets' && l.ev === 'edited'), 'modification au journal (finance_entity_budgets)');

  // Verrou d'approbation (routes de la phase 1, sur la ligne de l'entité).
  ok((await api('POST', `/api/finance/budgets/${id}/approve`, 'analyste@x.com')).status === 403, 'approuver : finance:approve exigée');
  ok((await api('POST', `/api/finance/budgets/${id}/approve`, 'cfo@x.com')).body.budget.status === 'approved', 'Cluster approuvé');
  ok((await put('cfo@x.com', { [pay]: 6 }, 2)).body.error === 'locked', 'approuvé : ajustements verrouillés (même pour la CFO)');
  ok((await upload('/api/finance/entity/cluster/import', 'cfo@x.com', XB)).body.error === 'locked', 'approuvé : import verrouillé');
  ok((await api('GET', '/api/finance/entity/xperio', 'cfo@x.com')).body.budget.status === 'draft', 'Xperio reste en brouillon (approbations indépendantes)');
  ok((await api('GET', '/api/finance/budget', 'cfo@x.com')).body.budget.status === 'draft', 'le Budget maître n\'est pas touché');
  ok((await api('POST', `/api/finance/budgets/${id}/unlock`, 'cfo@x.com')).body.budget.status === 'draft', 'déverrouillé');

  // --reference-only : les ajustements dont le driver existe encore sont gardés.
  const ro = await importHandoff(pool, DIR, { apply: true, referenceOnly: true, actor: 'test' });
  ok(ro.action === 'replace_reference' && ro.entityBudgets.cluster.action === 'replace' && !ro.entityBudgets.cluster.droppedOverrides, '--reference-only : références remplacées, ajustements gardés');
  cl = (await api('GET', '/api/finance/entity/cluster', 'cfo@x.com')).body;
  ok(Object.keys(cl.state.drivers.data.ov).length === 3 && cl.state.drivers.version === 2, 'ajustements intacts après --reference-only');

  // ---------------------------------------------------------------- 3. import Excel
  ok((await upload('/api/finance/entity/cluster/import', 'lecteur@x.com', XB)).status === 403, 'import : finance:edit exigée');
  let pv = await upload('/api/finance/entity/cluster/import', 'cfo@x.com', XB);
  ok(pv.status === 200 && pv.body.preview && pv.body.preview.token, 'aperçu renvoyé');
  let P = pv.body.preview;
  // Seules différences : la ligne G&A n'en a aucune (le P&L est identique) ; 1 driver changé (Event Expense) + Merchant Fees.
  ok(P.lines.length === 0 && P.drivers.added.length === 0 && P.drivers.removed.length === 0 && P.drivers.changed === 2, `aperçu : P&L identique, 2 drivers changés (${JSON.stringify(P.drivers)})`);
  near(P.totals.after.fy.revenue, 10141175.20, 'aperçu : revenus FY27 après');
  near(P.totals.before.fy.ebitda, P.totals.after.fy.ebitda, 'aperçu : BAIIA FY27 avant = après');
  ok(P.overrides.kept === 3 && P.overrides.dropped.length === 0, 'aperçu : 3 ajustements gardés');
  ok(P.gaps && P.gaps.map((g) => g.line).join(',') === 'Hardware COGS,Service COGS' && P.checks && P.checks.length === 8, `aperçu : écarts lignes/drivers et feuille Checks (${JSON.stringify([P.gaps, P.checks && P.checks.length])})`);
  const refBefore = JSON.stringify((await api('GET', '/api/finance/entity/cluster', 'cfo@x.com')).body.reference);
  ok(refBefore.includes('"handoff"'), 'l\'aperçu n\'a rien écrit');
  ok((await upload('/api/finance/entity/cluster/import', 'cfo@x.com', XB, { confirm: 'x'.repeat(64), base: P.base })).body.error === 'token_mismatch', 'confirmation avec un autre jeton : 409');
  ok((await upload('/api/finance/entity/cluster/import', 'cfo@x.com', XB, { confirm: P.token, base: '2000-01-01T00:00:00.000Z' })).body.error === 'conflict', 'confirmation sur une base périmée : 409');
  r = await upload('/api/finance/entity/cluster/import', 'cfo@x.com', XB, { confirm: P.token, base: P.base });
  ok(r.status === 200 && r.body.reference.source.kind === 'xlsx' && r.body.applied.action === 'replace' && r.body.applied.kept === 3, 'import confirmé : référence remplacée, 3 ajustements gardés');
  ok(r.body.reference.drivers.find((d) => d.gl === 'Event Expense').m[1] === 10000, 'Event Expense : octobre, comme le P&L du classeur');
  ok(logs.some((l) => l.ev === 'imported' && l.extra.metadata.sha256 === P.token), 'import au journal (empreinte du fichier)');

  // Classeur modifié : un driver retiré (Payments Revenue) et une ligne du P&L changée.
  const wb = xlsx.read(XB, { type: 'buffer' });
  const ds = wb.Sheets['Drivers →'];
  const dRows = xlsx.utils.sheet_to_json(ds, { header: 1, raw: true, defval: null });
  const ri = dRows.findIndex((x) => x[0] === 'Cluster' && x[5] === 'Payments Revenue');
  ds[xlsx.utils.encode_cell({ r: ri, c: 0 })].v = 'Retired';
  const ps = wb.Sheets['Cluster P&L'];
  const pRows = xlsx.utils.sheet_to_json(ps, { header: 1, raw: true, defval: null });
  const hi = pRows.findIndex((x) => x[0] === 'Hardware Revenue');
  ps[xlsx.utils.encode_cell({ r: hi, c: 8 })].v += 1000; // Jan-27
  const XB2 = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  pv = await upload('/api/finance/entity/cluster/import', 'cfo@x.com', XB2);
  P = pv.body.preview;
  ok(P.drivers.removed.length === 1 && P.drivers.removed[0].id === pay, 'aperçu : le driver retiré est listé');
  ok(P.overrides.dropped.length === 1 && P.overrides.dropped[0].id === pay && P.overrides.dropped[0].gl === 'Payments Revenue' && P.overrides.kept === 2, 'aperçu : son ajustement serait retiré');
  ok(P.lines.length === 1 && P.lines[0].name === 'Hardware Revenue' && Math.abs(P.lines[0].fyAfter - P.lines[0].fyBefore - 1000) < 0.01, 'aperçu : la ligne changée et son FY27 avant / après');
  ok(P.warnings.some((w) => w.code === 'tie_out' && w.row === 'Total Revenue'), 'aperçu : le total de revenus ne s\'additionne plus → avertissement');
  near(P.totals.after.fy.revenue - P.totals.before.fy.revenue, 1000, 'aperçu : FY27 +1 000 $');
  r = await upload('/api/finance/entity/cluster/import', 'cfo@x.com', XB2, { confirm: P.token, base: P.base });
  ok(r.status === 200 && r.body.state.drivers.version === 3 && !(pay in r.body.state.drivers.data.ov) && Object.keys(r.body.state.drivers.data.ov).length === 2, 'import : ajustement orphelin retiré, version + 1');
  ok(r.body.applied.dropped.length === 1, 'import : retrait signalé');

  // Classeur invalide.
  const wb3 = xlsx.read(XB, { type: 'buffer' });
  delete wb3.Sheets['Cluster P&L']; wb3.SheetNames = wb3.SheetNames.filter((x) => x !== 'Cluster P&L');
  r = await upload('/api/finance/entity/cluster/import', 'cfo@x.com', xlsx.write(wb3, { type: 'buffer', bookType: 'xlsx' }));
  ok(r.status === 400 && r.body.error === 'invalid_workbook' && r.body.errors[0].code === 'missing_sheet', 'feuille manquante : refusé avec la liste des erreurs');
  const wb4 = xlsx.read(XB, { type: 'buffer' });
  const d4 = wb4.Sheets['Drivers →'];
  d4[xlsx.utils.encode_cell({ r: ri + 1, c: 6 })].v = 'Magic';
  d4[xlsx.utils.encode_cell({ r: ri + 1, c: 15 })] = { t: 's', v: 'abc' };
  r = await upload('/api/finance/entity/cluster/import', 'cfo@x.com', xlsx.write(wb4, { type: 'buffer', bookType: 'xlsx' }));
  ok(r.status === 400 && r.body.errors.some((e) => e.code === 'bad_driver_type') && r.body.errors.some((e) => e.code === 'bad_driver_number'), 'type de driver inconnu et nombre illisible : refusés');
  ok((await upload('/api/finance/entity/cluster/import', 'cfo@x.com', Buffer.from('pas un classeur'))).status === 400, 'fichier illisible : 400');

  // Modèle Excel : relu à l'identique.
  const tpl = await api('GET', '/api/finance/entity/xperio/template', 'lecteur@x.com');
  ok(tpl.status === 200 && Buffer.isBuffer(tpl.body) && tpl.body.length > 1000, 'modèle Xperio téléchargé');
  const back = E.parseEntityWorkbook(book(tpl.body), 'xperio');
  const xpRef = (await api('GET', '/api/finance/entity/xperio', 'cfo@x.com')).body.reference;
  ok(back.errors.length === 0 && back.warnings.length === 0, 'modèle : relu sans erreur ni avertissement');
  ok(same(back.ref.pl, xpRef.pl) && same(back.ref.drivers, xpRef.drivers), 'modèle : P&L et drivers relus à l\'identique (identifiants compris)');
  ok((await api('GET', '/api/finance/entity/xperio/template', 'consolide@x.com')).status === 403, 'modèle : finance:entity_budgets exigée');

  // Réinitialiser = vider les ajustements (journal « reset »).
  cl = (await api('GET', '/api/finance/entity/cluster', 'cfo@x.com')).body;
  ok((await put('cfo@x.com', {}, cl.state.drivers.version)).status === 200 && logs.some((l) => l.t === 'finance_entity_budgets' && l.ev === 'reset'), 'réinitialiser : vidé, « reset » au journal');

  // ---------------------------------------------------------------- 4. départements
  let dp = (await api('GET', '/api/finance/dept', 'lecteur@x.com')).body;
  ok(dp.reference.depts.length === 4 && dp.reference.leaders.length === 4 && !dp.caps.canImport, 'départements : lecture, sans import pour le lecteur');
  ok((await upload('/api/finance/dept/import', 'lecteur@x.com', XB)).status === 403, 'import départements : finance:edit exigée');
  ok((await upload('/api/finance/dept/import', 'analyste@x.com', XB)).status === 403, 'import départements : finance:dept_budgets exigée');
  pv = await upload('/api/finance/dept/import', 'cfo@x.com', XB);
  P = pv.body.preview;
  ok(pv.status === 200 && P.depts.every((d) => d.changed === 0 && d.removed === 0) && P.leaders.every((L) => L.fyBefore === L.fyAfter), `aperçu départements : identique au paquet (${JSON.stringify(P)})`);
  r = await upload('/api/finance/dept/import', 'cfo@x.com', XB, { confirm: P.token, base: P.base });
  ok(r.status === 200 && r.body.reference.source.kind === 'xlsx' && r.body.applied.action === 'replace', 'import départements confirmé');
  const dtpl = await api('GET', '/api/finance/dept/template', 'lecteur@x.com');
  const dback = E.parseDeptWorkbook(book(dtpl.body));
  ok(dback.errors.length === 0 && dback.warnings.length === 0 && same(dback.ref.depts.map((d) => d.rows), r.body.reference.depts.map((d) => d.rows)) && same(dback.ref.leaders, r.body.reference.leaders), 'modèle départements : relu à l\'identique');
  dp = (await api('GET', '/api/finance/dept', 'cfo@x.com')).body;
  ok(dp.caps.canImport && dp.reference.depts[0].contribution === true, 'CFO : import permis ; Ventes marqué contribution');

  ok(!logs.some((l) => /\d{5}/.test(l.d)), 'aucun montant dans les descriptions du journal');
  server.close();
  console.log(`✅ finance entity budgets : ${n} vérifications`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
