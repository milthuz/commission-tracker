// Module Finance — lot C (prévisions, trésorerie, investissement), de bout en bout contre une
// vraie base Postgres en mémoire (PGlite) et un vrai serveur HTTP : permissions (dont les lignes
// nominatives réservées à finance:payroll), réels lus dans les tables de Sales Hub, concurrence
// optimiste, import Excel (aperçu → confirmation) — y compris le VRAI classeur de la CFO, dont les
// chiffres de référence de SPEC-phase2 §C.4 doivent ressortir au cent près.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/forecasts.test.js [dossier design/finance]
//
// ⚠️ Échoue si le dossier de passation (classeur de la CFO) manque, plutôt que de se déclarer vert.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const xlsx = require('xlsx');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerFinanceRoutes } = require('../routes');
const forecasts = require('../forecasts');
const C = require('../forecastsCompute');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
const WORKBOOK = path.join(DIR, 'source_excel', 'Cluster_Budget_Sep2026_Dec2027.xlsx');
if (!fs.existsSync(WORKBOOK)) { console.error(`ÉCHEC : classeur de la CFO introuvable (${WORKBOOK})`); process.exit(1); }

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  for (const q of [
    'CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW())',
    'CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN)',
    'CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)',
    "CREATE TABLE crm_sold_deals (deal_id VARCHAR(255) PRIMARY KEY, deal_name VARCHAR(500) DEFAULT '', owner_name VARCHAR(255), points INT DEFAULT 1, sold_date DATE NOT NULL, is_manual BOOLEAN DEFAULT FALSE)",
    'CREATE TABLE excluded_deals (deal_id VARCHAR(255) PRIMARY KEY, reason TEXT)',
    'CREATE TABLE teams (id SERIAL PRIMARY KEY, name VARCHAR(255) UNIQUE NOT NULL, include_deals BOOLEAN DEFAULT true, include_payments BOOLEAN DEFAULT true)',
    'CREATE TABLE salespeople (id SERIAL PRIMARY KEY, name VARCHAR(255), is_active BOOLEAN DEFAULT true, team_id INT)',
    "CREATE TABLE zentact_merchants (id SERIAL PRIMARY KEY, merchant_account_id VARCHAR(255) UNIQUE NOT NULL, business_name VARCHAR(500) DEFAULT '', status VARCHAR(50) DEFAULT '', sales_rep_name VARCHAR(255), activated_at DATE, is_manual BOOLEAN DEFAULT FALSE)",
    'CREATE TABLE zentact_merchant_revenue (id SERIAL PRIMARY KEY, merchant_account_id VARCHAR(255) NOT NULL, year INT NOT NULL, month INT NOT NULL, payments_count INT DEFAULT 0, collected_fees_cents BIGINT DEFAULT 0, transaction_profit_cents BIGINT DEFAULT 0, other_revenue_cents BIGINT, UNIQUE (merchant_account_id, year, month))',
  ]) await db.query(q);

  const perms = {
    'cfo@x.com': ['finance:view', 'finance:edit', 'finance:payroll', 'finance:forecasts', 'finance:cash', 'finance:investment'],
    'analyste@x.com': ['finance:view', 'finance:edit', 'finance:forecasts', 'finance:cash', 'finance:investment'],
    'lecteur@x.com': ['finance:view', 'finance:forecasts', 'finance:cash', 'finance:investment'],
    'budget@x.com': ['finance:view', 'finance:edit'],
    'rh@x.com': ['finance:view', 'finance:payroll', 'finance:investment'],
    'nobody@x.com': [],
  };
  const has = (req, p) => (perms[req.user.email] || []).includes(p);
  const logs = [];
  let late = {};
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const authenticateToken = (req, res, next) => {
    const e = req.headers['x-test-user']; if (!e) return res.status(401).json({ error: 'auth' });
    req.user = { email: e, isAdmin: false, isDemo: req.headers['x-test-demo'] === '1' }; next();
  };
  registerFinanceRoutes(app, {
    authenticateToken, pool,
    hasPerm: async (req, p) => has(req, p),
    requirePerm: async (req, res, p) => { if (has(req, p)) return true; res.status(403).json({ error: 'perm', perm: p }); return false; },
    logActivity: async (t, id, ev, d, actor, extra = {}) => { logs.push({ t, id, ev, d, actor, extra }); },
    late: () => late,
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, user, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  const upload = async (p, user, buf, name = 'f.xlsx') => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    const r = await fetch(base + p, { method: 'POST', headers: { 'x-test-user': user }, body: fd });
    return { status: r.status, body: await r.json() };
  };
  let n = 0; const ok = (c, m) => { assert(c, m); n++; };
  const near = (a, b, m, tol = 0.005) => ok(Math.abs(a - b) <= tol, `${m} : ${a} ≠ ${b}`);
  const readBook = (buf) => { const wb = xlsx.read(buf, { type: 'buffer', cellDates: true }); return { sheetNames: wb.SheetNames, rows: (s) => xlsx.utils.sheet_to_json(wb.Sheets[s], { header: 1, raw: true, defval: null }) }; };
  const aoaBook = (sheets) => { const wb = xlsx.utils.book_new(); for (const [nm, aoa] of sheets) xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), nm); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }); };

  // ---------------------------------------------------------------- permissions
  for (const p of ['/api/finance/forecasts/sales', '/api/finance/forecasts/payments', '/api/finance/forecasts/cash', '/api/finance/forecasts/investment']) {
    ok((await api('GET', p, 'nobody@x.com')).status === 403, `${p} : sans permission → 403`);
    ok((await api('GET', p, 'budget@x.com')).status === 403, `${p} : finance:view seul → 403 (permission du module exigée)`);
    ok((await api('GET', p, 'cfo@x.com', null, { 'x-test-demo': '1' })).status === 403, `${p} : mode démo bloqué`);
  }
  ok((await api('GET', '/api/finance/forecasts/sales', 'rh@x.com')).status === 403, 'investissement seul : pas les prévisions de ventes');

  // ---------------------------------------------------------------- ventes : réels
  let r = await api('GET', '/api/finance/forecasts/sales?year=2026', 'lecteur@x.com');
  ok(r.status === 200 && r.body.actual.mrr.source === 'pending', 'MRR : sans finance_billing_subs → « source en attente »');
  ok(!r.body.caps.canEdit, 'lecteur : pas d\'écriture');
  await db.query("INSERT INTO crm_sold_deals (deal_id, sold_date) VALUES ('d1','2026-03-04'),('d2','2026-03-20'),('d3','2026-03-28'),('d4','2026-04-02'),('d5','2025-11-11')");
  await db.query("INSERT INTO excluded_deals (deal_id) VALUES ('d3')");
  await db.query("INSERT INTO teams (name, include_deals, include_payments) VALUES ('Payment conversion', false, true), ('Inside', true, true)");
  await db.query("INSERT INTO salespeople (name, team_id) VALUES ('Conv Rep', 1), ('Inside Rep', 2)");
  await db.query(`INSERT INTO zentact_merchants (merchant_account_id, sales_rep_name, activated_at, status) VALUES
    ('m1','Inside Rep','2026-07-03','ACTIVE'),('m2','Conv Rep','2026-07-09','ACTIVE'),('m3','conv rep','2026-08-01','ACTIVE'),('m4',NULL,'2026-08-15','CLOSED')`);
  // Revenus Zentact en CENTS. m1, m2 traitent en août ; m1 seul en septembre (m2 a « churné »).
  await db.query(`INSERT INTO zentact_merchant_revenue (merchant_account_id, year, month, payments_count, collected_fees_cents, transaction_profit_cents, other_revenue_cents) VALUES
    ('m1',2026,8,10,100000,35000,NULL),('m2',2026,8,5,50000,20000,1000),('m1',2026,9,12,120000,42000,500),('m3',2026,9,3,30000,9000,NULL),('m4',2026,9,0,0,0,NULL)`);
  if (!(await db.query("SELECT to_regclass('finance_billing_subs') AS t")).rows[0].t) {
    await db.query("CREATE TABLE finance_billing_subs (org_id TEXT NOT NULL, subscription_number TEXT NOT NULL, customer_id TEXT, customer_name TEXT NOT NULL DEFAULT '', plan_name TEXT, status TEXT NOT NULL DEFAULT '', activated_at DATE, activated_src TEXT, cancelled_at DATE, cancel_reason TEXT, monthly_amount NUMERIC NOT NULL DEFAULT 0, PRIMARY KEY (org_id, subscription_number))");
  }
  r = await api('GET', '/api/finance/forecasts/sales?year=2026', 'lecteur@x.com');
  ok(r.body.actual.mrr.source === 'pending', 'MRR : table vide → toujours « en attente »');
  ok(r.body.actual.merchants.values[2] === 2 && r.body.actual.merchants.values[3] === 1, 'nouveaux marchands : crm_sold_deals par mois, deal exclu retiré');
  ok(r.body.prior.merchants.values[10] === 1, 'année précédente lue aussi (colonne FY-1)');
  ok(r.body.actual.payActivations.values[6] === 2 && r.body.actual.payActivations.values[7] === 2, 'activations Zentact par mois');
  ok(r.body.actual.installs.source === 'none', 'installations : aucune source dans Sales Hub (saisie)');
  // Organisation Canada du module KPI (697704869) ; l'organisation É.-U. n'entre pas dans le MRR ajouté.
  await db.query(`INSERT INTO finance_billing_subs (org_id, subscription_number, customer_id, customer_name, status, activated_at, activated_src, cancelled_at, cancel_reason, monthly_amount) VALUES
    ('697704869','S1','c1','Resto Un','live','2026-05-03','activated_at',NULL,NULL,300),
    ('697704869','S2','c2','Resto Deux','live','2026-05-20','activated_at',NULL,NULL,200),
    ('697704869','S3','c3','Resto Trois','cancelled','2025-01-01','activated_at','2026-05-09','Too expensive',120),
    ('697704869','S4','c4','Resto Quatre','cancelled','2025-02-01','activated_at','2026-05-10','Change of Ownership – new sub created',99),
    ('697704869','S5','c4','Resto Quatre','live','2026-05-12','activated_at',NULL,NULL,110),
    ('802470810','U1','u1','US Diner','live','2026-05-01','activated_at',NULL,NULL,999)`);

  r = await api('GET', '/api/finance/forecasts/sales?year=2026', 'lecteur@x.com');
  const mrr = r.body.actual.mrr;
  ok(mrr.source === 'billing' && mrr.newMrr[4] === 500 && mrr.newSubs[4] === 2, 'MRR nouveau = activations Canada − nouvel abonnement issu d\'un changement de propriétaire (500 $, 2) ; É.-U. ignorés');
  ok(mrr.churnMrr[4] === 120 && mrr.values[4] === 380, 'MRR perdu : changement de propriétaire EXCLU (120 $, pas 219 $) ; net 380 $');

  // ---------------------------------------------------------------- ventes : saisie, concurrence
  const put = (user, key, data, version) => api('PUT', `/api/finance/forecasts/docs/${encodeURIComponent(key)}`, user, { data, version });
  const sales1 = { cells: { budget: { '2026-03': { mrr: 4000, merchants: 3 } }, forecast: { '2026-11': { mrr: 5200 } } } };
  ok((await put('lecteur@x.com', 'sales', sales1, 0)).status === 403, 'lecteur : saisie refusée (finance:edit)');
  ok((await put('budget@x.com', 'sales', sales1, 0)).status === 403, 'finance:edit sans finance:forecasts : refusé');
  r = await put('analyste@x.com', 'sales', sales1, 0);
  ok(r.status === 200 && r.body.version === 1, 'ventes : saisie enregistrée (v1)');
  ok((await put('cfo@x.com', 'sales', sales1, 0)).status === 409, 'concurrence : v0 alors que v1 existe → 409');
  r = await put('cfo@x.com', 'sales', { cells: { budget: { '2026-03': { mrr: 4100 } } } }, 1);
  ok(r.status === 200 && r.body.version === 2, 'ventes v2');
  r = await put('analyste@x.com', 'sales', sales1, 1);
  ok(r.status === 409 && r.body.current.version === 2 && r.body.current.data.cells.budget['2026-03'].mrr === 4100, 'version périmée → 409 + version courante');
  ok((await put('cfo@x.com', 'sales', { cells: { pirate: {} } }, 2)).body.error === 'unknown_series:pirate', 'série inconnue refusée');
  ok((await put('cfo@x.com', 'sales', { cells: { budget: { '2026-13': { mrr: 1 } } } }, 2)).body.error === 'bad_month', 'mois invalide refusé');
  ok((await put('cfo@x.com', 'sales', { cells: { budget: { '2026-01': { merchants: -1 } } } }, 2)).body.error === 'negative:merchants', 'nombre de marchands négatif refusé');
  ok((await put('cfo@x.com', 'nope', {}, 0)).body.error === 'unknown_doc', 'document inconnu refusé');

  // Import des ventes : modèle → rempli → aperçu → confirmation.
  r = await api('GET', '/api/finance/forecasts/template/sales?year=2026', 'lecteur@x.com');
  const tpl = readBook(r.body);
  const trows = tpl.rows('Sales');
  ok(trows.findIndex((x) => x[0] === 'Month (YYYY-MM)') === 3 && trows.length === 4 + 36, 'modèle des ventes : 36 lignes (3 séries × 12 mois)');
  ok(trows.find((x) => x[0] === '2026-03' && x[1] === 'budget')[2] === 4100, 'modèle prérempli avec la saisie courante');
  const salesBook = aoaBook([['Sales', [['x'], [], [], ['Month (YYYY-MM)', 'Series', 'MRR added', 'New merchants', 'Installs'],
    ['2026-01', 'budget', 3000, 2, 1], ['2026-02', 'Prévision', 3500, null, null], ['2026-02', 'bogus', 1], ['2026-02', 'actual', 'abc']]]]);
  ok((await upload('/api/finance/forecasts/import/sales/preview', 'lecteur@x.com', salesBook)).status === 403, 'import : finance:edit exigée');
  r = await upload('/api/finance/forecasts/import/sales/preview', 'analyste@x.com', salesBook);
  ok(r.status === 200 && r.body.summary.cells === 4 && r.body.summary.errors.length === 2, 'aperçu : 4 cellules, 2 erreurs signalées (série, nombre)');
  const salesImp = r.body.importId;
  ok((await api('GET', '/api/finance/forecasts/sales', 'cfo@x.com')).body.doc.data.cells.budget['2026-01'] === undefined, 'l\'aperçu n\'a rien écrit');
  ok((await api('POST', `/api/finance/forecasts/import/${salesImp}/confirm`, 'cfo@x.com', { versions: { sales: 2 } })).body.error === 'not_yours', 'confirmer l\'aperçu d\'un autre : refusé');
  ok((await api('POST', `/api/finance/forecasts/import/${salesImp}/confirm`, 'analyste@x.com', { versions: { sales: 1 } })).status === 409, 'confirmer avec une version périmée : 409');
  r = await api('POST', `/api/finance/forecasts/import/${salesImp}/confirm`, 'analyste@x.com', { versions: { sales: 2 } });
  ok(r.status === 200 && r.body.versions.sales === 3, 'import confirmé (v3)');
  ok((await api('POST', `/api/finance/forecasts/import/${salesImp}/confirm`, 'analyste@x.com', { versions: { sales: 3 } })).body.error === 'already_applied', 'un aperçu ne s\'applique qu\'une fois');
  const sd = (await api('GET', '/api/finance/forecasts/sales', 'cfo@x.com')).body.doc.data.cells;
  ok(sd.budget['2026-01'].mrr === 3000 && sd.budget['2026-03'].mrr === 4100 && sd.forecast['2026-02'].mrr === 3500, 'fusion : les cellules importées s\'ajoutent, les autres restent');

  // ---------------------------------------------------------------- paiements
  r = await api('GET', '/api/finance/forecasts/payments?year=2026', 'lecteur@x.com');
  const pa = r.body.actual;
  ok(pa.source === 'zentact' && pa.lastActual === '2026-09', 'paiements : dernier mois réel = septembre 2026');
  const aug = pa.months.find((m) => m.ym === '2026-08'), sep = pa.months.find((m) => m.ym === '2026-09');
  ok(aug.active === 2 && sep.active === 2, 'actifs = marchands ayant traité (m4 sans transaction ignoré)');
  near(aug.grossFees, 1510, 'frais bruts août (cents → dollars, autres revenus inclus)');
  near(aug.residual, 560, 'résiduel août = profit + autres revenus');
  near(sep.residual, 515, 'résiduel septembre');
  ok(sep.churned === 1, 'churn septembre : m2 actif en août, plus en septembre');
  const jul = pa.months.find((m) => m.ym === '2026-07');
  ok(jul.installs === 1 && jul.conv === 1, 'juillet : 1 installation, 1 ajout de l\'équipe de conversion (équipe « paiements seulement »)');
  ok(aug.conv === 1 && aug.installs === 1, 'nom du représentant comparé sans la casse');
  ok(!pa.months.some((m) => m.ym > '2026-09'), 'aucun « réel » après le dernier mois importé');
  ok(r.body.teams.find((t) => t.name === 'Payment conversion').auto, 'équipe de conversion reconnue');
  r = await put('analyste@x.com', 'payments', { assumptions: { inst: 3, conv: 2, churn: 1.5, arpuG: 0.5, margin: 35 }, overrides: { '2026-09': { residual: 600 } }, convTeamIds: [2] }, 0);
  ok(r.status === 200, 'hypothèses et dérogations enregistrées');
  ok((await put('analyste@x.com', 'payments', { assumptions: { churn: 140 } }, 1)).body.error === 'bad_assumption:churn', 'churn > 100 % refusé');
  r = await api('GET', '/api/finance/forecasts/payments?year=2026', 'lecteur@x.com');
  const aug2 = r.body.actual.months.find((m) => m.ym === '2026-08');
  ok(aug2.conv === 0 && aug2.installs === 2, 'équipes de conversion choisies par la CFO : prises en compte');
  ok((await api('POST', '/api/finance/forecasts/payments/versions', 'lecteur@x.com', { label: 'v', series: {} })).status === 403, 'version : finance:edit exigée');
  r = await api('POST', '/api/finance/forecasts/payments/versions', 'analyste@x.com', { label: 'v2026-Q4', series: { '2026-10': { active: 3, residual: 700 } }, assumptions: { inst: 3 } });
  ok(r.status === 200 && r.body.version.id, 'version de prévision enregistrée');
  const vid = r.body.version.id;
  ok((await api('POST', '/api/finance/forecasts/payments/versions', 'analyste@x.com', { label: 'x', series: { '2026-10': { pirate: 1 } } })).status === 400, 'version : champ inconnu refusé');
  r = await put('analyste@x.com', 'payments', { assumptions: { inst: 3 }, overrides: {}, compareVersionId: vid }, 1);
  r = await api('GET', '/api/finance/forecasts/payments?year=2026', 'lecteur@x.com');
  ok(r.body.versions.length === 1 && r.body.versions[0].data.series['2026-10'].residual === 700 && r.body.doc.data.compareVersionId === vid, 'versions renvoyées avec leurs séries, choix de comparaison gardé');
  // Modèle + import des paiements.
  r = await api('GET', '/api/finance/forecasts/template/payments?year=2026', 'lecteur@x.com');
  ok(readBook(r.body).sheetNames.join() === 'Assumptions,Actuals', 'modèle des paiements : Assumptions + Actuals');
  r = await upload('/api/finance/forecasts/import/payments/preview', 'analyste@x.com', aoaBook([['Assumptions', [['Key', 'Value'], ['margin', 36], ['pirate', 1]]], ['Actuals', [['Month (YYYY-MM)', 'Active merchants', 'Installs', 'Conversion adds', 'Churned', 'Gross fees', 'Residual'], ['2026-06', 900, 20, 10, 5, 190000, 65000]]]]));
  ok(r.status === 200 && r.body.summary.assumptions.margin === 36 && r.body.summary.overrideMonths[0] === '2026-06' && r.body.summary.errors.length === 1, 'aperçu des paiements');
  r = await api('POST', `/api/finance/forecasts/import/${r.body.importId}/confirm`, 'analyste@x.com', { versions: { payments: 2 } });
  ok(r.status === 200, 'import des paiements confirmé');
  const pd = (await api('GET', '/api/finance/forecasts/payments?year=2026', 'lecteur@x.com')).body.doc.data;
  ok(pd.assumptions.margin === 36 && pd.assumptions.inst === 3 && pd.overrides['2026-06'].active === 900 && pd.compareVersionId === vid, 'import fusionné, le reste conservé');

  // ---------------------------------------------------------------- trésorerie
  r = await api('GET', '/api/finance/forecasts/cash', 'lecteur@x.com');
  ok(r.body.doc.version === 0 && r.body.doc.data.reserve === 1500000 && new Date(`${r.body.doc.data.startDate}T12:00:00Z`).getUTCDay() === 1, 'trésorerie : défauts = réserve 1,5 M$, semaine commençant un lundi');
  const cash = { startDate: '2026-10-19', opening: { mode: 'manual', amount: 2000000 }, reserve: 1500000, lines: { saas: Array(13).fill(100000), payroll: [0, 380000, 0, 380000, 0, 380000, 0, 380000, 0, 380000, 0, 380000, 0] }, scenarios: { down: [{ id: 'a1', label: 'Residuals −6 %', category: 'residual', mode: 'pct', value: -6, from: 1, to: 13 }], up: [] } };
  ok((await put('analyste@x.com', 'cash', { ...cash, startDate: '2026-10-20' }, 0)).body.error === 'not_monday', 'début de semaine : un lundi exigé');
  ok((await put('analyste@x.com', 'cash', { ...cash, lines: { payroll: Array(13).fill(-1) } }, 0)).body.error === 'negative:payroll', 'décaissement négatif refusé (signe porté par la catégorie)');
  ok((await put('analyste@x.com', 'cash', { ...cash, scenarios: { down: [{ id: 'a', label: '', category: 'saas', mode: 'pct', value: 1, from: 1, to: 2 }], up: [] } }, 0)).body.error === 'bad_adjustment', 'ajustement de scénario SANS libellé refusé');
  ok((await put('analyste@x.com', 'cash', cash, 0)).status === 200, 'trésorerie enregistrée');
  ok((await put('budget@x.com', 'cash', cash, 1)).status === 403, 'trésorerie : finance:cash exigée');
  r = await api('GET', '/api/finance/forecasts/cash/bank-accounts', 'lecteur@x.com');
  ok(r.body.status === 'unavailable', 'Zoho Books absent (banc) : « indisponible »');
  late = { getAdminBooksAuth: async () => ({ accessToken: 't', apiDomain: 'https://books.test' }) };
  forecasts.register._http = { get: async () => ({ status: 401, data: { code: 57, message: 'You are not authorized to perform this operation' } }) };
  ok((await api('GET', '/api/finance/forecasts/cash/bank-accounts', 'lecteur@x.com')).body.status === 'reconnect', 'portée banking.READ manquante → « reconnecter Zoho Books »');
  let calls = 0;
  forecasts.register._http = { get: async (url, o) => { calls++; assert(url === 'https://books.test/books/v3/bankaccounts' && o.headers.Authorization === 'Zoho-oauthtoken t'); return calls === 1 ? { status: 401, data: { code: 14 } } : { status: 200, data: { code: 0, bankaccounts: [{ account_id: 11, account_name: 'BNC', balance: 1200.5, currency_code: 'CAD' }] } }; } };
  r = await api('GET', '/api/finance/forecasts/cash/bank-accounts', 'lecteur@x.com');
  ok(r.body.status === 'ok' && calls === 2 && r.body.accounts[0].id === '11' && r.body.accounts[0].balance === 1200.5, '401 passager : une reprise, puis les comptes');
  r = await api('GET', '/api/finance/forecasts/template/cash', 'lecteur@x.com');
  const crow = readBook(r.body).rows('Cash');
  ok(crow.find((x) => x[0] === 'Category')[2] === 'W1 2026-10-19' && crow.find((x) => x[0] === 'Category')[3] === 'W2 2026-10-26', 'modèle de trésorerie : vraies dates des semaines');
  ok(crow.find((x) => x[0] === 'payroll')[3] === 380000, 'modèle prérempli');
  const cashBook = aoaBook([['Cash', [['x'], ['Start date (Monday, YYYY-MM-DD)', '2026-10-26'], ['Opening balance', 2500000], ['Reserve', ''], [], ['Category', 'Label', 'W1', 'W2'], ['vendors', 'V', 90000, 95000], ['interco', 'I', -250000], ['taxes', 'T', -5], ['pirate', 'P', 1]]]]);
  r = await upload('/api/finance/forecasts/import/cash/preview', 'analyste@x.com', cashBook);
  ok(r.status === 200 && r.body.summary.startDate === '2026-10-26' && r.body.summary.opening === 2500000 && r.body.summary.categories.join() === 'vendors,interco' && r.body.summary.errors.length === 2, 'aperçu de trésorerie (négatif et catégorie inconnue signalés)');
  r = await api('POST', `/api/finance/forecasts/import/${r.body.importId}/confirm`, 'analyste@x.com', { versions: { cash: 1 } });
  const cd = (await api('GET', '/api/finance/forecasts/cash', 'lecteur@x.com')).body.doc.data;
  ok(r.status === 200 && cd.lines.vendors[1] === 95000 && cd.lines.vendors[2] === null && cd.lines.saas[0] === 100000 && cd.reserve === 1500000 && cd.opening.amount === 2500000, 'import de trésorerie fusionné');

  // ---------------------------------------------------------------- investissement : le VRAI classeur
  const wbBuf = fs.readFileSync(WORKBOOK);
  ok((await upload('/api/finance/forecasts/import/investment/preview', 'analyste@x.com', wbBuf, 'Cluster_Budget.xlsx')).status === 403, 'import de l\'effectif : finance:payroll exigée');
  r = await upload('/api/finance/forecasts/import/investment/preview', 'cfo@x.com', wbBuf, 'Cluster_Budget.xlsx');
  ok(r.status === 200, 'aperçu du classeur de la CFO');
  const sv2 = r.body.summary.programs.v2, spc = r.body.summary.programs.payments;
  ok(sv2.sheet === 'V2' && sv2.employees === 7 && sv2.contractors === 5 && sv2.from === '2026-08' && sv2.to === '2027-12', 'V2 : 7 employés, 5 contractuels, août 2026 → décembre 2027');
  near(sv2.costByYear['2027'], 1223883.22, 'V2 FY2027 (SPEC §C.4)');
  ok(!sv2.warnings.length && !spc.warnings.length, 'Σ des personnes = ligne TOTAL du classeur, chaque mois');
  ok(spc.employees === 4 && spc.contractors === 0, 'Payments Conversion : 4 employés');
  // SPEC §C.4 écrit 334 634,12 ; la somme exacte des 12 mois est 334 634,125, et la cellule FY2027
  // de la ligne TOTAL du classeur affiche 334 634,13 — on reproduit le CLASSEUR (écart d'un
  // demi-cent dans la spec, noté dans ecarts/forecasts.md).
  const pcTotalRow = readBook(wbBuf).rows('Payments Conversion').find((x) => x && x[0] === 'TOTAL');
  const pcFy = pcTotalRow.filter((v) => typeof v === 'number').pop();
  near(spc.costByYear['2027'], Math.round(pcFy * 100) / 100, 'Payments Conversion : dépenses FY2027 = cellule FY2027 du classeur');
  near(spc.costByYear['2027'], 334634.12, 'Payments Conversion : dépenses FY2027 (SPEC §C.4, à un demi-cent près)', 0.0101);
  near(spc.returnByYear['2027'], 449588.34, 'Payments Conversion : revenus FY2027 (SPEC §C.4)');
  near(spc.returnByYear['2027'] - spc.costByYear['2027'], 114954.21, 'Payments Conversion : BAIIA FY2027 (SPEC §C.4)', 0.006);
  const sepDec = ['2026-09', '2026-10', '2026-11', '2026-12'];
  const impId = r.body.importId;
  r = await api('POST', `/api/finance/forecasts/import/${impId}/confirm`, 'cfo@x.com', { versions: {} });
  ok(r.status === 200 && r.body.versions['inv:v2'] === 1 && r.body.versions['people:payments'] === 1, 'import du classeur confirmé (4 documents)');

  // Lecture SANS finance:payroll : totaux seulement, aucun nom, aucun montant individuel.
  const rd = (await api('GET', '/api/finance/forecasts/investment?program=v2', 'lecteur@x.com')).body;
  ok(!rd.people && !rd.caps.canPayroll, 'lecteur : aucune ligne nominative');
  const raw = JSON.stringify(rd);
  const cfoV2 = (await api('GET', '/api/finance/forecasts/investment?program=v2', 'cfo@x.com')).body;
  ok(cfoV2.people && cfoV2.people.data.people.length === 12, 'CFO : les 12 personnes');
  ok(cfoV2.people.data.people.every((pp) => !raw.includes(pp.name)), 'lecteur : aucun NOM dans la réponse');
  ok(!raw.includes('"base"') && !raw.includes('"monthly"'), 'lecteur : aucun salaire de base ni horaire individuel');
  near(C.sumMonths(rd.computed.total, C.yearMonths(2027)), 1223883.22, 'lecteur : total FY2027 calculé par le serveur');
  near(C.sumMonths(rd.computed.total, sepDec), 396078.71, 'V2 sep.–déc. 2026 (SPEC §C.4)');
  ok(rd.computed.headcount.employees === 7 && rd.computed.headcount.contractors === 5 && rd.computed.initiatives[0].name === 'Kaizen V2', 'effectif agrégé, initiative par défaut');
  const pcRd = (await api('GET', '/api/finance/forecasts/investment?program=payments', 'lecteur@x.com')).body;
  near(C.sumMonths(pcRd.doc.data.returns, C.yearMonths(2027)), 449588.34, 'rendement Payments Conversion stocké');
  near(C.sumMonths(pcRd.doc.data.returns, sepDec), 98229.24, 'rendement sep.–déc. 2026 (SPEC §C.4)');
  ok(pcRd.doc.data.source.sheet === 'Payments Conversion' && pcRd.doc.data.source.file === 'Cluster_Budget.xlsx', 'origine de l\'import gardée');

  // Initiatives : modifiables sans la paie ; l'effectif, seulement avec.
  const inv = rd.doc.data;
  const inv2 = { ...inv, initiatives: [...inv.initiatives.map((it) => ({ ...it, capPct: 60 })), { id: 'kds', name: 'KDS v2', capPct: 75, other: { '2027-01': 5000 } }] };
  r = await put('analyste@x.com', 'inv:v2', inv2, rd.doc.version);
  ok(r.status === 200 && r.body.data.source.sheet === 'V2', 'initiatives modifiées (finance:edit, sans la paie) — origine conservée');
  ok((await put('analyste@x.com', 'inv:v2', { ...inv2, initiatives: [{ id: 'x', name: 'X', capPct: 120, other: {} }] }, r.body.version)).body.error === 'bad_cap', 'capitalisation > 100 % refusée');
  const people = cfoV2.people.data.people.map((pp, i) => (i < 3 ? { ...pp, initiativeId: 'kds', alloc: 50 } : pp));
  ok((await put('analyste@x.com', 'people:v2', { people }, 1)).status === 403, 'effectif : finance:payroll exigée');
  ok((await put('rh@x.com', 'people:v2', { people }, 1)).status === 403, 'effectif : finance:edit exigée aussi');
  ok((await put('cfo@x.com', 'people:v2', { people: people.map((pp) => ({ ...pp, alloc: 101 })) }, 1)).body.error === 'bad_alloc', 'allocation > 100 % refusée');
  ok((await put('cfo@x.com', 'people:v2', { people: [{ ...people[0], monthly: { '2030-01': 1 } }] }, 1)).body.error === 'bad_monthly', 'mois hors horizon refusé');
  ok((await put('cfo@x.com', 'people:v2', { people }, 1)).status === 200, 'effectif réaffecté');
  const after = (await api('GET', '/api/finance/forecasts/investment?program=v2', 'lecteur@x.com')).body.computed;
  const kds = after.initiatives.find((x) => x.id === 'kds');
  const half = people.slice(0, 3).reduce((s, pp) => s + pp.monthly['2027-01'] / 2, 0);
  near(kds.cost['2027-01'], half + 5000, 'initiative = Σ personnes × allocation + autres coûts');
  ok(kds.employees === 3 && Math.abs(kds.fte - 1.5) < 1e-9, 'ETP = Σ allocations');
  // Réimporter le même classeur : réaffectations et allocations conservées.
  r = await upload('/api/finance/forecasts/import/investment/preview', 'cfo@x.com', wbBuf, 'Cluster_Budget.xlsx');
  const cur = (await api('GET', '/api/finance/forecasts/investment?program=v2', 'cfo@x.com')).body;
  const cur2 = (await api('GET', '/api/finance/forecasts/investment?program=payments', 'cfo@x.com')).body;
  ok((await api('POST', `/api/finance/forecasts/import/${r.body.importId}/confirm`, 'cfo@x.com', { versions: { 'inv:v2': 1, 'people:v2': cur.people.version, 'inv:payments': cur2.doc.version, 'people:payments': cur2.people.version } })).body.error === 'conflict', 'réimport avec une version périmée : 409');
  r = await api('POST', `/api/finance/forecasts/import/${r.body.importId}/confirm`, 'cfo@x.com', { versions: { 'inv:v2': cur.doc.version, 'people:v2': cur.people.version, 'inv:payments': cur2.doc.version, 'people:payments': cur2.people.version } });
  ok(r.status === 200, 'réimport confirmé');
  const re = (await api('GET', '/api/finance/forecasts/investment?program=v2', 'cfo@x.com')).body;
  ok(re.people.data.people.filter((pp) => pp.initiativeId === 'kds' && pp.alloc === 50).length === 3 && re.doc.data.initiatives.length === 2, 'réimport : initiatives, affectations et allocations conservées');
  r = await api('GET', '/api/finance/forecasts/template/investment', 'lecteur@x.com');
  const tb = readBook(r.body);
  const trs = tb.rows('V2');
  const emp = trs.find((x) => x[0] === 'Employee'); emp[1] = 'Embauche prévue'; emp[4] = 1000;
  const tp = C.parseProgramSheet(trs);
  ok(tb.sheetNames.join() === 'V2,Payments Conversion' && tp.people.length === 1 && tp.months.length === 17 && tp.people[0].monthly[tp.months[0]] === 1000, 'modèle d\'investissement relu par le même lecteur');

  // ---------------------------------------------------------------- journal
  // (les autres lots écrivent aussi au journal dans ce banc : on ne lit que les nôtres)
  const mine = logs.filter((l) => l.t === 'finance_forecasts');
  ok(mine.some((l) => l.ev === 'imported') && mine.some((l) => l.ev === 'version_saved') && mine.some((l) => l.ev === 'edited'), 'journal finance_forecasts : saisies, imports, versions');
  ok(mine.every((l) => /^(sales|payments|cash|inv:|people:)/.test(l.id)), 'journal : identifiant = document');
  const names = cfoV2.people.data.people.map((pp) => pp.name);
  ok(!mine.some((l) => names.some((nm) => l.d.includes(nm)) || /\d{5}/.test(l.d)), 'journal : ni nom ni montant');

  server.close();
  console.log(`✅ finance forecasts : ${n} vérifications`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
