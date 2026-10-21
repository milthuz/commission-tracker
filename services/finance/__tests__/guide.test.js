// Lot H du module Finance (guide des gestionnaires, pistes d'économies, règle des 40, repères),
// de bout en bout : vraie base Postgres en mémoire (PGlite), vrai serveur HTTP. Les réels du grand
// livre sont SYNTHÉTIQUES (écrits ici) ; l'effectif réel de la CFO est lu dans design/finance pour le
// test de NON-FUITE (aucune réponse du serveur ne contient un nom ni un salaire).
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/guide.test.js [dossier design/finance]
//
// ⚠️ Échoue (plutôt que de se déclarer vert) si le dossier de passation manque.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerFinanceRoutes } = require('../routes');
const { importHandoff } = require('../import');
const { extractHandoff, PROTO } = require('../handoff');
const G = require('../guideCore');
const guideMod = require('../guide');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
if (!fs.existsSync(path.join(DIR, PROTO))) { console.error(`ÉCHEC : paquet de passation introuvable dans ${DIR}`); process.exit(1); }

let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const near = (a, b, m, eps = 1e-6) => { assert(a != null && b != null && Math.abs(a - b) <= eps, `${m} : ${a} ≠ ${b}`); n++; };

(async () => {
  // ================================================================ calculs purs
  near(G.growthPct(120, 100), 20, 'croissance +20 %');
  near(G.growthPct(80, 100), -20, 'croissance négative');
  ok(G.growthPct(100, 0) === null && G.growthPct(100, -5) === null && G.growthPct(NaN, 100) === null, 'croissance : base nulle, négative ou non numérique = inconnue (jamais de division par zéro)');
  near(G.marginPct(30, 100), 30, 'marge 30 %');
  near(G.marginPct(-10, 100), -10, 'marge négative');
  ok(G.marginPct(10, 0) === null, 'marge : revenu nul = inconnue');
  let r = G.rule40(20, 30);
  ok(r.score === 50 && r.gap === 10 && r.passes === true, 'règle des 40 : 20 + 30 = 50, écart +10');
  r = G.rule40(-10, 15);
  ok(r.score === 5 && r.gap === -35 && r.passes === false, 'règle des 40 : croissance négative');
  r = G.rule40(10, -30);
  ok(r.score === -20 && r.passes === false, 'règle des 40 : marge négative');
  ok(G.rule40(null, 30).score === null && G.rule40(10, null).passes === null, 'règle des 40 : une donnée manque = pas de score');
  let L = G.levers({ revenue: 1200, priorRevenue: 1000, profit: 120, opex: 700 });
  near(L.growth, 20, 'leviers : croissance'); near(L.margin, 10, 'leviers : marge'); near(L.score, 30, 'leviers : score'); near(L.gap, -10, 'leviers : écart');
  near(L.onePtGrowthRevenue, 10, '+1 pt de croissance = 1 % du revenu de l\'an dernier');
  near(L.onePtMarginOpex, 12, '1 pt de marge = 1 % du revenu en OPEX');
  near(L.shortfall, 10, 'manque de 10 pts'); near(L.extraRevenueNeeded, 100, 'revenu additionnel requis'); near(L.costCutNeeded, 120, 'baisse de coûts requise');
  near(L.costCutPctOfOpex, (120 / 700) * 100, 'baisse en % de l\'OPEX');
  near(G.marginPtsFromCut(24, 1200), 2, '24 $ d\'OPEX en moins sur 1 200 $ de revenu = +2 pts');
  L = G.levers({ revenue: 1500, priorRevenue: 1000, profit: 450, opex: 500 });
  ok(L.shortfall === 0 && L.extraRevenueNeeded === 0 && L.costCutNeeded === 0 && L.passes === true, 'au-dessus de 40 : aucun effort requis');
  L = G.levers({ revenue: 0, priorRevenue: 0, profit: 0, opex: 0 });
  ok(L.score === null && L.onePtGrowthRevenue === null && L.onePtMarginOpex === null && L.extraRevenueNeeded === null && L.costCutNeeded === null, 'leviers : tout à zéro = rien d\'inventé');
  L = G.levers({ revenue: 900, priorRevenue: 1000, profit: -90, opex: 800 });
  near(L.growth, -10, 'leviers : croissance négative'); near(L.margin, -10, 'leviers : marge négative'); near(L.shortfall, 60, 'leviers : manque de 60 pts');
  near(L.costCutNeeded, 540, 'leviers : baisse de coûts requise (60 pts × 9 $)');

  // ---------------------------------------------------------------- comparaison aux repères
  const bm = [
    { id: 'a', metric: 'gross_margin', value: 25, direction: 'higher_better', use_for_flags: true },
    { id: 'b', metric: 'gross_margin', value: 25, direction: 'higher_better', use_for_flags: true },
    { id: 'c', metric: 'gross_margin', value: 25, direction: 'higher_better', use_for_flags: true },
    { id: 'd', metric: 'rd_pct', value: 27, direction: 'lower_better', use_for_flags: true },
    { id: 'e', metric: 'rd_pct', value: 27, direction: 'lower_better', use_for_flags: true },
    { id: 'f', metric: 'nrr', value: 102, direction: 'higher_better', use_for_flags: true },
    { id: 'g', metric: 'ltv_cac', value: null, direction: 'higher_better', use_for_flags: true },
    { id: 'h', metric: 'gross_margin', value: 80, direction: 'higher_better', use_for_flags: false },
  ];
  const cmp = (m, id) => G.compareBenchmarks(m, bm).find((x) => x.id === id);
  ok(cmp({ gross_margin: 30, rd_pct: 20 }, 'a').status === 'better', 'repère : au-dessus (hausse favorable) = mieux');
  ok(cmp({ gross_margin: 24 }, 'b').status === 'on_par', 'repère : à 1 pt sur 25 (±5 % relatif) = dans la moyenne');
  ok(cmp({ gross_margin: 20 }, 'c').status === 'worse' && cmp({ gross_margin: 20 }, 'c').flag === true, 'repère : sous le repère = à améliorer, signalé');
  ok(cmp({ rd_pct: 30 }, 'd').status === 'worse', 'repère de coût : au-dessus = à regarder');
  ok(cmp({ rd_pct: 20 }, 'e').status === 'better', 'repère de coût : en dessous = mieux');
  ok(cmp({ gross_margin: 30 }, 'f').status === 'no_metric', 'mesure que le modèle ne calcule pas = « pas de mesure »');
  ok(cmp({ ltv_cac: 9 }, 'g').status === 'to_validate' && cmp({ ltv_cac: 9 }, 'g').current === null, 'repère SANS valeur : jamais comparé (à valider)');
  ok(cmp({ gross_margin: 10 }, 'h').status === 'worse' && cmp({ gross_margin: 10 }, 'h').flag === false, 'repère informatif : écart montré mais pas signalé');

  // ---------------------------------------------------------------- validation des repères
  const bmBase = { id: 'x.test_one', metric: 'gross_margin', labelEn: 'A', labelFr: 'B', unit: 'pct', direction: 'higher_better', kind: 'public', value: 50, sourceOrg: 'Org', sourceUrl: 'https://example.org/p', sourceYear: 2026 };
  ok(G.validateBenchmark(bmBase, 2026).row, 'repère sourcé accepté');
  ok(G.validateBenchmark({ ...bmBase, sourceOrg: null }, 2026).error === 'source_org_required', 'valeur sans organisme refusée');
  ok(G.validateBenchmark({ ...bmBase, sourceUrl: null }, 2026).error === 'source_url_required', 'valeur publique sans URL refusée');
  ok(G.validateBenchmark({ ...bmBase, sourceYear: null }, 2026).error === 'source_year_required', 'valeur sans année refusée');
  ok(G.validateBenchmark({ ...bmBase, sourceUrl: 'javascript:alert(1)' }, 2026).error === 'bad_source_url', 'URL non http(s) refusée');
  ok(G.validateBenchmark({ ...bmBase, sourceYear: 2099 }, 2026).error === 'bad_source_year', 'année absurde refusée');
  ok(G.validateBenchmark({ ...bmBase, kind: 'internal', sourceUrl: null }, 2026).row, 'cible INTERNE de la CFO : URL facultative');
  ok(G.validateBenchmark({ ...bmBase, value: null, sourceOrg: null, sourceUrl: null, sourceYear: null }, 2026).row.value === null, 'repère sans valeur = « à valider », sans source exigée');
  ok(G.validateBenchmark({ ...bmBase, metric: 'nope' }, 2026).error === 'bad_metric' && G.validateBenchmark({ ...bmBase, value: 'abc' }, 2026).error === 'bad_value', 'mesure et valeur inconnues refusées');

  // ---------------------------------------------------------------- repères livrés
  const shipped = guideMod.loadShipped();
  ok(shipped.rows.length >= 15, 'repères livrés présents');
  ok(new Set(shipped.rows.map((x) => x.id)).size === shipped.rows.length, 'identifiants uniques');
  for (const b of shipped.rows) {
    ok(!!G.METRICS[b.metric], `repère ${b.id} : mesure connue`);
    if (b.value != null) {
      ok(!!b.source_org && /^https:\/\//.test(b.source_url || '') && Number.isInteger(b.source_year), `repère livré ${b.id} : organisme + URL + année non vides`);
    } else {
      ok(!b.source_org && !b.source_url, `repère ${b.id} sans valeur : aucune source inventée`);
    }
  }
  ok(shipped.rows.every((b) => b.value != null), 'aucun repère livré sans valeur');

  // ================================================================ analyse des réels (synthétique)
  const NOW = new Date(Date.UTC(2026, 9, 15)); // octobre 2026 : le mois en cours est exclu
  const mlist = (from, to) => { const o = []; for (let m = from; m <= to; m = G.addMonths(m, 1)) o.push(m); return o; };
  const ALL = mlist('2024-01', '2026-09');
  const LATEST = '2026-09';
  const rowsFor = (months) => {
    const rows = [];
    for (const m of months) {
      rows.push({ m, key: 'acc:R1', name: 'Zq Subscription Revenue', section: 'Gross Profit > Operating Income', amount: m >= '2025-10' ? 10000.37 : 8000.37 });
      rows.push({ m, key: 'acc:C1', name: 'Zq Hosting Cost', section: 'Gross Profit > Cost of Goods Sold', amount: 2000.11 });
      rows.push({ m, key: 'acc:O1', name: 'Zq Software Subscriptions', section: 'Operating Profit > Operating Expense > Selling Expense', amount: m === LATEST ? 5000.13 : 3000.13 });
      rows.push({ m, key: 'acc:O2', name: 'Zq Office Rent', section: 'Operating Profit > Operating Expense > Admin', amount: 1000.29 });
      rows.push({ m, key: 'acc:O3', name: 'Zq Advertising', section: 'Operating Profit > Operating Expense > Selling Expense', amount: m === LATEST ? 700.41 : 100.41 });
      rows.push({ m, key: 'acc:O4', name: 'Zq Small Tools', section: 'Operating Profit > Operating Expense > Admin', amount: m === LATEST ? 300.17 : 100.17 });
      rows.push({ m, key: 'acc:N1', name: 'Zq Interest Paid', section: 'Net Profit > Non Operating Expense', amount: 999.01 });
      rows.push({ m, key: 'acc:U1', name: 'Zq Mystery', section: '', amount: 5.55 });
    }
    return rows;
  };
  ok(G.classifySection('Gross Profit > Operating Income') === 'revenue' && G.classifySection('Operating Profit > Operating Expense > Selling Expense') === 'opex'
    && G.classifySection('Gross Profit > Cost of Goods Sold') === 'cogs' && G.classifySection('Non Operating Income') === 'nonop' && G.classifySection('') === 'unknown', 'classement des sections du P&L');

  let A = G.analyzeActuals({ rows: rowsFor(ALL).concat([{ m: '2026-10', key: 'acc:O2', name: 'x', section: 'Operating Expense', amount: 9e6 }]), syncedMonths: ALL.concat(['2026-10']), owners: {}, now: NOW });
  ok(A.hasActuals && A.latestMonth === LATEST && A.monthsAvailable === ALL.length, 'mois en cours exclu (incomplet)');
  const M = A.metrics;
  near(M.revenue, 120004.44, '12 mois : revenus'); near(M.cogs, 24001.32, '12 mois : coût des ventes');
  near(M.opex, 11 * 3000.13 + 5000.13 + 12 * 1000.29 + 11 * 100.41 + 700.41 + 11 * 100.17 + 300.17, '12 mois : OPEX (hors hors-exploitation)', 0.011);
  near(M.priorRevenue, 96004.44, '12 mois précédents : revenus');
  near(M.growthPct, ((120004.44 - 96004.44) / 96004.44) * 100, 'croissance réelle', 0.01);
  near(M.ebitdaMarginPct, ((M.revenue - M.cogs - M.opex) / M.revenue) * 100, 'marge réelle', 0.01);
  near(M.rule40, M.growthPct + M.ebitdaMarginPct, 'règle des 40 réelle', 0.02);
  ok(A.classification.unknown === 1 && A.classification.nonop === 1 && A.classification.revenue === 1 && A.classification.cogs === 1 && A.classification.opex === 4, 'classement : un compte inconnu signalé, hors-exploitation exclu');
  ok(JSON.stringify(A.leads.map((l) => `${l.type}:${l.accountKey}`)) === JSON.stringify(['vs_avg:acc:O1', 'vs_last_year:acc:O1', 'vs_avg:acc:O3', 'vs_last_year:acc:O3']), 'pistes : hausses détectées (O1 +2 000 $, O3 +600 $), O4 (+200 $) sous le seuil, O2 stable');
  const o1 = A.leads.find((l) => l.accountKey === 'acc:O1' && l.type === 'vs_avg');
  near(o1.deltaAbs, 2000, 'hausse O1'); near(o1.deltaPct, (2000 / 3000.13) * 100, 'hausse O1 en %', 0.01); ok(o1.assigned === false && o1.owner === null, 'sans responsable : marqué non assigné');
  ok(A.unassigned.map((u) => u.accountKey).sort().join() === 'acc:C1,acc:O1,acc:O2,acc:O3,acc:O4', 'comptes à assigner : tous les comptes de dépense (aucun revenu, hors-exploitation ni inconnu)');
  ok(A.topAccounts[0].accountKey === 'acc:O1' && A.topAccounts[1].accountKey === 'acc:C1', 'plus gros comptes triés par dépense sur 12 mois');
  near(A.topAccounts[0].sharePct, (A.topAccounts[0].windowTotal / (A.accounts.reduce((s, a) => s + a.windowTotal, 0))) * 100, 'part du plus gros compte', 0.01);
  // responsables et lignes de budget
  A = G.analyzeActuals({ rows: rowsFor(ALL), syncedMonths: ALL, owners: { 'acc:O1': { owner: 'Resp A', department: 'sales', budgetLine: 'opx:fakeLine' }, 'acc:O3': { owner: 'Resp A', department: 'sales', budgetLine: 'opx:fakeLine' } }, now: NOW });
  ok(A.leads[0].owner === 'Resp A' && A.leads[0].department === 'sales' && A.leads[0].assigned, 'piste : responsable et département affichés');
  ok(!A.unassigned.some((u) => u.accountKey === 'acc:O1') && A.unassigned.length === 3, 'un compte assigné quitte la liste « à assigner »');
  near(A.budgetLines['opx:fakeLine'][LATEST], 5000.13 + 700.41, 'ligne de budget : somme des comptes rattachés, mois le plus récent');
  near(A.budgetLines['opx:fakeLine']['2026-08'], 3000.13 + 100.41, 'ligne de budget : un mois ordinaire');
  // historique court
  A = G.analyzeActuals({ rows: rowsFor(mlist('2026-04', '2026-09')), syncedMonths: mlist('2026-04', '2026-09'), owners: {}, now: NOW });
  ok(A.metrics === null && A.metricsReason === 'needs_12_months' && A.leads.some((l) => l.type === 'vs_avg') && !A.leads.some((l) => l.type === 'vs_last_year'), 'historique court : pas d\'indicateur 12 mois, pas de comparaison à l\'an dernier, pistes sur 3 mois quand même');
  A = G.analyzeActuals({ rows: rowsFor(mlist('2025-04', '2026-09')), syncedMonths: mlist('2025-04', '2026-09'), owners: {}, now: NOW });
  ok(A.metrics && A.metrics.growthPct === null && A.metrics.rule40 === null && A.metricsReason === 'growth_needs_24_months' && A.metrics.ebitdaMarginPct != null, '18 mois : marge connue, croissance et règle des 40 INCONNUES (rien d\'extrapolé)');
  ok(G.analyzeActuals({ rows: [], syncedMonths: [], now: NOW }).hasActuals === false, 'aucun réel : état vide propre');
  // trou dans l'historique
  A = G.analyzeActuals({ rows: rowsFor(ALL.filter((m) => m !== '2026-02')), syncedMonths: ALL.filter((m) => m !== '2026-02'), owners: {}, now: NOW });
  ok(A.metrics === null && A.metricsReason === 'needs_12_months', 'un mois non lu dans la fenêtre : aucun indicateur 12 mois');
  // compte nouveau (absent avant) = dépense nouvelle
  A = G.analyzeActuals({ rows: rowsFor(mlist('2026-05', '2026-09')).concat([{ m: LATEST, key: 'acc:NEW', name: 'Zq New Spend', section: 'Operating Expense', amount: 1500 }]), syncedMonths: mlist('2026-05', '2026-09'), owners: {}, now: NOW });
  const nl = A.leads.find((l) => l.accountKey === 'acc:NEW');
  ok(nl && nl.deltaPct === null && nl.baseline === 0 && nl.deltaAbs === 1500, 'compte sans historique : dépense nouvelle (pourcentage inconnu, jamais infini)');

  // ================================================================ HTTP (PGlite)
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p).then((r) => ({ ...r, rowCount: r.affectedRows != null ? r.affectedRows : (r.rows || []).length })) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
  `);
  const P = {
    'cfo@x.com': ['finance:view', 'finance:edit', 'finance:guide', 'finance:payroll'],
    'lecteur@x.com': ['finance:view', 'finance:guide'],
    'budget@x.com': ['finance:view', 'finance:edit'],
    'vue@x.com': ['finance:view'],
  };
  const has = (req, p) => (P[req.user.email] || []).includes(p);
  const logs = [];
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const authenticateToken = (req, res, next) => {
    const e = req.headers['x-test-user']; if (!e) return res.status(401).json({ error: 'auth' });
    req.user = { email: e, isAdmin: false, isDemo: req.headers['x-test-demo'] === '1' }; next();
  };
  registerFinanceRoutes(app, {
    authenticateToken, pool,
    hasPerm: async (req, p) => has(req, p),
    requirePerm: async (req, res, p) => { if (has(req, p)) return true; res.status(403).json({ error: 'perm' }); return false; },
    logActivity: async (t, id, ev, d, actor, extra = {}) => { logs.push({ t, id, ev, d, actor, extra }); },
    late: () => ({}),
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const seen = []; // toutes les réponses JSON, pour le test de non-fuite
  const api = async (method, p, user, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    seen.push(JSON.stringify(j));
    return { status: r.status, body: j };
  };

  // --- permissions et démo
  ok((await api('GET', '/api/finance/guide/benchmarks', 'vue@x.com')).status === 403, 'finance:view seul : 403');
  ok((await api('GET', '/api/finance/guide/benchmarks', 'budget@x.com')).status === 403, 'finance:edit sans finance:guide : 403');
  ok((await api('GET', '/api/finance/guide/notes', 'budget@x.com')).status === 403 && (await api('GET', '/api/finance/guide/savings', 'budget@x.com')).status === 403, 'notes et pistes : même permission');
  ok((await api('GET', '/api/finance/guide/benchmarks')).status === 401, 'sans connexion : 401');
  const demo = await api('GET', '/api/finance/guide/benchmarks', 'cfo@x.com', null, { 'x-test-demo': '1' });
  ok(demo.status === 403 && demo.body.demo === true, 'mode démo : bloqué');
  ok((await api('PUT', '/api/finance/guide/notes/q1', 'cfo@x.com', { note: 'x' }, { 'x-test-demo': '1' })).status === 403, 'mode démo : note bloquée');

  // --- repères : semis, lecture, écriture
  let r2 = await api('GET', '/api/finance/guide/benchmarks', 'lecteur@x.com');
  ok(r2.status === 200 && r2.body.benchmarks.length === shipped.rows.length && r2.body.caps.canEdit === false, 'repères : lecture, semés depuis le fichier versionné, lecteur sans droit d\'écriture');
  const bRule = r2.body.benchmarks.find((b) => b.id === 'rule_of_40.aleph2026_median');
  ok(bRule.value === 25 && bRule.origin === 'shipped' && bRule.edited === false && bRule.sourceUrl.startsWith('https://'), 'repère livré : valeur et source');
  ok((await api('PUT', `/api/finance/guide/benchmarks/${bRule.id}`, 'lecteur@x.com', { ...bRule, value: 30 })).status === 403, 'repères : écriture refusée sans finance:edit');
  let e1 = await api('PUT', `/api/finance/guide/benchmarks/${bRule.id}`, 'cfo@x.com', { ...bRule, value: 30, sourceUrl: null });
  ok(e1.status === 400 && e1.body.error === 'source_url_required', 'repères : valeur sans URL refusée');
  e1 = await api('PUT', `/api/finance/guide/benchmarks/${bRule.id}`, 'cfo@x.com', { ...bRule, value: 30 });
  ok(e1.status === 200 && e1.body.benchmark.value === 30 && e1.body.benchmark.edited === true && e1.body.benchmark.version === bRule.version + 1, 'repères : modification enregistrée, version + 1');
  ok((await api('PUT', `/api/finance/guide/benchmarks/${bRule.id}`, 'cfo@x.com', { ...bRule, value: 31 })).status === 409, 'repères : version périmée = 409');
  ok((await api('PUT', '/api/finance/guide/benchmarks/inexistant.xx', 'cfo@x.com', { ...bRule, id: 'inexistant.xx', version: 1 })).status === 404, 'repères : inconnu = 404');
  ok(r2.body.benchmarks.every((b) => b.value != null), 'plus aucun repère vide livré');
  ok(!r2.body.benchmarks.some((b) => /\.to_validate$/.test(b.id)), 'les cinq repères vides ont disparu');
  e1 = await api('POST', '/api/finance/guide/benchmarks', 'cfo@x.com', { metric: 'ebitda_margin', labelEn: 'Peer EBITDA', labelFr: 'BAIIA pairs', unit: 'pct', direction: 'higher_better', kind: 'public', value: 12 });
  ok(e1.status === 400 && e1.body.error === 'source_org_required', 'on ne peut pas remplir un repère sans le sourcer');
  e1 = await api('POST', '/api/finance/guide/benchmarks', 'cfo@x.com', { metric: 'ebitda_margin', labelEn: 'Peer EBITDA', labelFr: 'BAIIA pairs', unit: 'pct', direction: 'higher_better', kind: 'public', value: 12, sourceOrg: 'Org Test', sourceUrl: 'https://example.org/x', sourceYear: 2026 });
  ok(e1.status === 200 && e1.body.benchmark.value === 12, 'repère rempli avec une source complète');
  const keepId = e1.body.benchmark.id;
  let cr = await api('POST', '/api/finance/guide/benchmarks', 'cfo@x.com', { metric: 'sm_pct', labelEn: 'Own target', labelFr: 'Cible interne', unit: 'pct', direction: 'lower_better', kind: 'internal', value: 30, sourceOrg: 'CFO target', sourceYear: 2026 });
  ok(cr.status === 200 && cr.body.benchmark.origin === 'cfo' && cr.body.benchmark.kind === 'internal', 'cible interne de la CFO créée');
  ok((await api('POST', '/api/finance/guide/benchmarks', 'lecteur@x.com', { metric: 'sm_pct' })).status === 403, 'création refusée sans finance:edit');
  ok((await api('DELETE', `/api/finance/guide/benchmarks/${cr.body.benchmark.id}`, 'cfo@x.com')).status === 200, 'repère de la CFO supprimé');
  ok((await api('DELETE', `/api/finance/guide/benchmarks/${bRule.id}`, 'cfo@x.com')).body.error === 'shipped_not_deletable', 'repère livré : non supprimable');
  const rs = await api('POST', `/api/finance/guide/benchmarks/${bRule.id}/reset`, 'cfo@x.com');
  ok(rs.status === 200 && rs.body.benchmark.value === 25 && rs.body.benchmark.edited === false, 'rétablir un repère livré');
  ok((await api('POST', '/api/finance/guide/benchmarks/cfo.xx/reset', 'cfo@x.com')).body.error === 'not_shipped', 'rétablir : seulement les repères livrés');
  // la ré-initialisation du schéma (redémarrage) n'écrase pas la modification de la CFO
  await guideMod.ensureSchema(pool);
  ok(Number((await db.query(`SELECT value FROM finance_benchmarks WHERE id = '${keepId}'`)).rows[0].value) === 12, 'le semis ne touche jamais une ligne de la CFO');
  // ménage : un repère livré jamais modifié qui a quitté le fichier disparaît ; un repère modifié reste
  await db.query("INSERT INTO finance_benchmarks (id, metric, label_en, label_fr, unit, direction, origin) VALUES ('old.stale','ebitda_margin','x','x','pct','higher_better','shipped')");
  await db.query("INSERT INTO finance_benchmarks (id, metric, label_en, label_fr, unit, direction, origin, edited, value) VALUES ('old.edited','ebitda_margin','x','x','pct','higher_better','shipped',TRUE,9)");
  await guideMod.ensureSchema(pool);
  ok((await db.query("SELECT 1 FROM finance_benchmarks WHERE id = 'old.stale'")).rows.length === 0, 'ménage : repère livré périmé retiré');
  ok((await db.query("SELECT 1 FROM finance_benchmarks WHERE id = 'old.edited'")).rows.length === 1, 'ménage : repère périmé mais modifié conservé');

  // --- notes
  let nt = await api('PUT', '/api/finance/guide/notes/opexChange:gaRent', 'cfo@x.com', { note: 'Réponse du gestionnaire', state: 'asked', version: 0 });
  ok(nt.status === 200 && nt.body.version === 1, 'note : créée');
  nt = await api('PUT', '/api/finance/guide/notes/opexChange:gaRent', 'cfo@x.com', { note: 'Réponse 2', state: 'answered', version: 1 });
  ok(nt.status === 200 && nt.body.version === 2, 'note : mise à jour versionnée');
  nt = await api('PUT', '/api/finance/guide/notes/opexChange:gaRent', 'cfo@x.com', { note: 'périmée', state: 'answered', version: 1 });
  ok(nt.status === 409 && nt.body.current.version === 2 && nt.body.current.note === 'Réponse 2', 'note : version périmée = 409 avec la version courante');
  ok((await api('PUT', '/api/finance/guide/notes/opexChange:gaRent', 'cfo@x.com', { note: 'doublon', version: 0 })).status === 409, 'note : recréer une note existante = 409');
  ok((await api('PUT', '/api/finance/guide/notes/q1', 'lecteur@x.com', { note: 'lecteur', state: 'new', version: 0 })).status === 200, 'note PERSONNELLE : le lecteur (guide seul) peut en écrire');
  ok((await api('PUT', '/api/finance/guide/notes/bad id!', 'cfo@x.com', { note: 'x' })).status === 400, 'identifiant de question invalide refusé');
  ok((await api('PUT', '/api/finance/guide/notes/q2', 'cfo@x.com', { note: 'x', state: 'wat' })).body.error === 'bad_state', 'note : état inconnu refusé');
  ok((await api('PUT', '/api/finance/guide/notes/q2', 'cfo@x.com', { note: 'x'.repeat(4001) })).body.error === 'bad_note', 'note : trop longue refusée');
  const mine = await api('GET', '/api/finance/guide/notes', 'cfo@x.com');
  ok(mine.body.notes.length === 1 && mine.body.notes[0].note === 'Réponse 2' && mine.body.notes[0].state === 'answered', 'notes : chacun voit les siennes');
  ok((await api('GET', '/api/finance/guide/notes', 'lecteur@x.com')).body.notes.length === 1 && (await api('GET', '/api/finance/guide/notes', 'lecteur@x.com')).body.notes[0].note === 'lecteur', 'notes : jamais celles d\'un autre usager');
  ok(!logs.some((l) => JSON.stringify(l).includes('Réponse')), 'le journal ne contient jamais le texte d\'une note');

  // --- pistes : aucun réel (tables absentes), puis réels synthétiques
  // Le lot KPI crée ses tables au démarrage : on les retire pour simuler « module pas initialisé ».
  for (let i = 0; i < 100; i++) { if ((await db.query("SELECT to_regclass('finance_gl_raw') AS t")).rows[0].t) break; await new Promise((x) => setTimeout(x, 50)); }
  await db.exec('DROP TABLE finance_gl_raw; DROP TABLE finance_gl_raw_months; DROP TABLE finance_kpi_sync_status;');
  let sv = await api('GET', '/api/finance/guide/savings', 'cfo@x.com');
  ok(sv.status === 200 && sv.body.hasActuals === false && sv.body.books.state === 'never' && sv.body.leads.length === 0 && sv.body.metrics === null, 'sans réels (Zoho Books jamais lu) : état vide honnête');
  await db.exec(`
    CREATE TABLE finance_gl_raw (month DATE NOT NULL, account_key TEXT NOT NULL, account_name TEXT NOT NULL, section TEXT NOT NULL DEFAULT '', is_group BOOLEAN NOT NULL DEFAULT FALSE, amount NUMERIC NOT NULL, PRIMARY KEY (month, account_key));
    CREATE TABLE finance_gl_raw_months (month DATE PRIMARY KEY, synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), accounts INT NOT NULL DEFAULT 0);
    CREATE TABLE finance_kpi_sync_status (source TEXT PRIMARY KEY, state TEXT NOT NULL, last_try_at TIMESTAMPTZ, last_ok_at TIMESTAMPTZ, last_error TEXT, detail JSONB);
  `);
  await db.query("INSERT INTO finance_kpi_sync_status (source, state, last_error) VALUES ('books', 'reconnect', 'HTTP 401 code 57')");
  sv = await api('GET', '/api/finance/guide/savings', 'cfo@x.com');
  ok(sv.body.hasActuals === false && sv.body.books.state === 'reconnect', 'Books à reconnecter : signalé, aucun réel inventé');
  ok(!JSON.stringify(sv.body).includes('code 57'), 'le message d\'erreur brut de Zoho n\'est pas renvoyé');
  // mois relatifs à la vraie date du serveur (le dernier mois clos varie)
  const today = new Date();
  const cur = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
  const last = G.addMonths(cur, -1);
  const HM = mlist(G.addMonths(last, -26), last);
  // mêmes motifs que plus haut, mais le « pic » doit tomber sur le dernier mois clos réel
  const mk = (m) => rowsFor([m]).map((x) => ({
    ...x,
    amount: x.key === 'acc:O1' ? (m === last ? 5000.13 : 3000.13) : x.key === 'acc:O3' ? (m === last ? 700.41 : 100.41) : x.key === 'acc:O4' ? (m === last ? 300.17 : 100.17)
      : x.key === 'acc:R1' ? (m >= G.addMonths(last, -11) ? 10000.37 : 8000.37) : x.amount,
  }));
  for (const m of HM) {
    for (const x of mk(m)) await db.query('INSERT INTO finance_gl_raw (month, account_key, account_name, section, amount) VALUES ($1::date,$2,$3,$4,$5)', [`${m}-01`, x.key, x.name, x.section, x.amount]);
    await db.query('INSERT INTO finance_gl_raw_months (month, accounts) VALUES ($1::date, 8)', [`${m}-01`]);
  }
  await db.query("INSERT INTO finance_gl_raw (month, account_key, account_name, section, is_group, amount) VALUES ($1::date, 'grp:total', 'Zq Group Total', 'Operating Expense', TRUE, 123456)", [`${last}-01`]);
  sv = await api('GET', '/api/finance/guide/savings', 'cfo@x.com');
  ok(sv.body.hasActuals && sv.body.latestMonth === last && sv.body.metrics && sv.body.metrics.rule40 != null, 'avec des réels : indicateurs 12 mois et règle des 40');
  ok(sv.body.leads.length === 4 && sv.body.leads[0].accountKey === 'acc:O1' && !JSON.stringify(sv.body).includes('Zq Group Total'), 'pistes détectées ; comptes de GROUPE (totaux) jamais comptés');
  ok(sv.body.unassigned.length === 5 && sv.body.caps.canEdit === true && sv.body.departments.includes('rnd'), 'comptes à assigner listés (aucune devinette)');
  ok((await api('GET', '/api/finance/guide/savings', 'lecteur@x.com')).body.caps.canEdit === false, 'lecteur : lecture seule');

  // --- assignation en lot (la ligne de budget doit exister dans le budget consolidé importé)
  const imp = await importHandoff(pool, DIR, { apply: true, actor: 'test' });
  ok(imp.action === 'create', 'budget consolidé importé pour les tests');
  const ref = (await db.query("SELECT reference FROM finance_budgets WHERE entity = 'consolidated'")).rows[0].reference;
  const editKey = ref.opex.find((it) => it.t === 'line' && !it.pay && !['smTravel', 'rdTravel', 'gaTravel'].includes(it.key)).key;
  const payKey = ref.opex.find((it) => it.t === 'line' && it.pay).key;
  const asg = (o) => api('PUT', '/api/finance/guide/accounts/owners', 'cfo@x.com', o);
  ok((await api('PUT', '/api/finance/guide/accounts/owners', 'lecteur@x.com', { assignments: [{ accountKey: 'acc:O1', owner: 'Resp A', department: 'sales' }] })).status === 403, 'assigner : finance:edit requis');
  ok((await asg({})).body.error === 'nothing_to_do', 'assigner : rien à faire');
  ok((await asg({ assignments: [{ accountKey: 'acc:INCONNU', owner: 'Resp A', department: 'sales' }] })).body.error === 'unknown_account', 'assigner : compte inconnu refusé');
  ok((await asg({ assignments: [{ accountKey: 'acc:O1', owner: '', department: 'sales' }] })).body.error === 'bad_owner', 'assigner : responsable vide refusé');
  ok((await asg({ assignments: [{ accountKey: 'acc:O1', owner: 'x'.repeat(81), department: 'sales' }] })).body.error === 'bad_owner', 'assigner : responsable de plus de 80 caractères refusé');
  ok((await asg({ assignments: [{ accountKey: 'acc:O1', owner: 'Resp A', department: 'marketing' }] })).body.error === 'bad_department', 'assigner : département inconnu refusé');
  ok((await asg({ assignments: [{ accountKey: 'acc:O1', owner: 'Resp A', department: 'sales', budgetLine: 'opx:inexistant' }] })).body.error === 'bad_budget_line', 'assigner : ligne de budget inconnue refusée');
  ok((await asg({ assignments: [{ accountKey: 'acc:O1', owner: 'Resp A', department: 'sales', budgetLine: `opx:${payKey}` }] })).body.error === 'bad_budget_line', 'assigner : ligne de paie non rattachable');
  let as1 = await asg({ assignments: [
    { accountKey: 'acc:O1', owner: 'Resp A', department: 'sales', budgetLine: `opx:${editKey}` },
    { accountKey: 'acc:O2', owner: 'Resp B', department: 'accounting' },
    { accountKey: 'acc:C1', owner: 'Resp C', department: 'support_ops' },
  ] });
  ok(as1.status === 200 && as1.body.assigned === 3, 'assignation en lot');
  sv = await api('GET', '/api/finance/guide/savings', 'cfo@x.com');
  ok(sv.body.unassigned.map((u) => u.accountKey).sort().join() === 'acc:O3,acc:O4', 'les comptes assignés quittent « à assigner »');
  ok(sv.body.leads[0].owner === 'Resp A' && sv.body.leads[0].department === 'sales', 'la piste affiche responsable et département');
  near(sv.body.budgetLines[`opx:${editKey}`][last], 5000.13, 'série mensuelle de la ligne de budget rattachée');
  ok(sv.body.knownOwners.join() === 'Resp A,Resp B,Resp C', 'responsables connus proposés');
  as1 = await asg({ clear: ['acc:O2'] });
  ok(as1.body.cleared === 1 && (await api('GET', '/api/finance/guide/savings', 'cfo@x.com')).body.unassigned.some((u) => u.accountKey === 'acc:O2'), 'retirer un responsable');
  ok(logs.some((l) => l.ev === 'owners_assigned' && l.t === 'finance_guide') && logs.some((l) => l.ev === 'benchmark_edited'), 'journal d\'activité (finance_guide)');
  ok(!logs.some((l) => /Zq |Resp A/.test(JSON.stringify(l))), 'le journal ne contient ni compte ni responsable : seulement des compteurs');

  // ================================================================ non-fuite : effectif réel de la CFO
  const { roster } = extractHandoff(DIR);
  const names = [...new Set([...roster.employees.map((e) => e.name), ...roster.contractors.map((c) => c.name), ...roster.contractors.map((c) => c.co)].filter((s) => s && s.trim().length >= 4).map((s) => s.trim().toLowerCase()))];
  const salaries = [...new Set([...roster.employees.map((e) => Math.round(e.salary)), ...roster.contractors.map((c) => Math.round(c.amt))].filter((v) => v >= 10000).map(String))];
  ok(names.length > 30 && salaries.length > 10, 'effectif réel lu pour le test de non-fuite');
  // une dernière série d'appels, y compris pour un détenteur de finance:payroll
  await api('GET', '/api/finance/guide/benchmarks', 'cfo@x.com'); await api('GET', '/api/finance/guide/savings', 'cfo@x.com'); await api('GET', '/api/finance/guide/notes', 'cfo@x.com');
  const blob = seen.join('\n').toLowerCase();
  ok(blob.length > 10000, 'réponses du serveur rassemblées');
  for (const nm of names) assert(!blob.includes(nm), `FUITE : un nom de l'effectif apparaît dans une réponse du serveur (${nm.length} car.)`);
  n++;
  for (const s of salaries) assert(!new RegExp(`(^|[^0-9.])${s}([^0-9]|\\.0*[^0-9]|$)`).test(blob), `FUITE : un salaire de l'effectif apparaît dans une réponse (${s.length} chiffres)`);
  n++;

  server.close();
  console.log(`✅ finance guide : ${n} vérifications`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
