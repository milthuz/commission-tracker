// Onglet KPI du module Finance, de bout en bout : vraie base Postgres en mémoire (PGlite), vrai
// serveur HTTP, et de FAUX Zoho Billing / Zoho Books / Banque du Canada (aucun appel réseau
// extérieur). Les chiffres affichés sont recalculés par le VRAI moteur du navigateur
// (frontend/src/pages/Finance/Kpi/kpiModel.ts, compilé par esbuild).
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/kpi.test.js
//
// ⚠️ Échoue (plutôt que de se déclarer vert) si le dépôt frontend voisin ou esbuild manquent.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const xlsx = require('xlsx');

const FRONT = path.resolve(path.join(__dirname, '../../../../frontend'));
const MODEL = path.join(FRONT, 'src/pages/Finance/Kpi/kpiModel.ts');
let esbuild;
try { esbuild = require(path.join(FRONT, 'node_modules/esbuild')); } catch { console.error(`ÉCHEC : esbuild introuvable dans ${FRONT}/node_modules`); process.exit(1); }
if (!fs.existsSync(MODEL)) { console.error(`ÉCHEC : moteur KPI introuvable (${MODEL})`); process.exit(1); }
const out = path.join(os.tmpdir(), `finance-kpi-model-${process.pid}.cjs`);
esbuild.buildSync({ entryPoints: [MODEL], outfile: out, format: 'cjs', bundle: true, logLevel: 'error' });
const K = require(out);

process.env.ZOHO_ORG_ID = 'BOOKS-ORG';
delete process.env.FINANCE_KPI_MANUAL_SYNC_MS;
const S = require('../kpiSync');
S._setBackoff(5);
const { KPI_KEYS } = require('../kpi');
const { registerFinanceRoutes } = require('../routes');
const C = require('../kpiCore');

const CAN = '697704869', USA = '802470810', XP = '905113716';

// ------------------------------------------------------------------------ faux Zoho Billing
const sub = (o) => ({ interval: 1, interval_unit: 'months', currency_code: 'CAD', status: 'live', plan_name: 'POS', ...o });
let billing = {
  [CAN]: [
    // Même numéro que l'abonnement des É.-U. plus bas : les deux doivent coexister.
    sub({ subscription_number: 'SUB-00001', customer_id: 'c1', customer_name: 'Resto Alpha', activated_at: '2026-09-05', sub_total: 100 }),
    sub({ subscription_number: 'SUB-00002', customer_id: 'c2', customer_name: 'SC - Pizza Roma', activated_at: '2026-09-10', sub_total: 80 }),
    sub({ subscription_number: 'SUB-00003', customer_id: 'c3', customer_name: 'SCOTTS Diner', activated_at: '2026-09-12', sub_total: 90 }),
    sub({ subscription_number: 'SUB-00004', customer_id: 'c4', customer_name: 'Café Lirette', activated_at: '2026-09-14', sub_total: 50 }),
    sub({ subscription_number: 'SUB-00005', customer_id: 'c5', customer_name: 'Chez Marie', activated_at: '2025-03-01', cancelled_at: '2026-09-15', status: 'cancelled', cf_reason_for_cancel: 'change of ownership-new  sub created', sub_total: 70 }),
    sub({ subscription_number: 'SUB-00006', customer_id: 'c5', customer_name: 'Chez Marie', activated_at: '2026-09-16', sub_total: 75 }),
    sub({ subscription_number: 'SUB-00007', customer_id: 'c7', customer_name: 'Bar Fermé', activated_at: '2024-01-01', cancelled_at: '2026-09-20', status: 'cancelled', cf_reason_for_cancel_formatted: 'Closed business', sub_total: 60 }),
    sub({ subscription_number: 'SUB-00008', customer_id: 'c8', customer_name: 'Deli Gamma', activated_at: '2024-02-01', cancelled_at: '2026-09-22', status: 'cancelled', cf_reason_for_cancel: 'Change of ownership', sub_total: 50 }),
    sub({ subscription_number: 'SUB-00009', customer_id: 'c9', customer_name: 'Annual Bistro', activated_at: '2026-09-01', sub_total: 1200, interval_unit: 'years' }),
    sub({ subscription_number: 'SUB-00010', customer_id: 'c10', customer_name: 'Crispy Chicken', activated_at: '2026-09-25', sub_total: 45 }),
    sub({ subscription_number: 'SUB-00011', customer_id: 'c11', customer_name: 'Old Act', activated_at: '2026-08-03', sub_total: 40 }),
    sub({ subscription_number: 'SUB-00012', customer_id: 'c12', customer_name: 'Old Gone', activated_at: '2023-08-03', cancelled_at: '2026-08-11', status: 'cancelled', sub_total: 35 }),
    sub({ subscription_number: 'SUB-00013', customer_id: 'c13', customer_name: 'Trial Only', status: 'trial', activated_at: '2026-09-09', sub_total: 99 }),
  ],
  [USA]: [
    sub({ subscription_number: 'SUB-00001', customer_id: 'u1', customer_name: 'NY Deli', activated_at: '2025-01-01', sub_total: 50, currency_code: 'USD' }),
    sub({ subscription_number: 'SUB-00002', customer_id: 'u2', customer_name: 'Boston Bar', activated_at: '2025-06-01', cancelled_at: '2026-09-03', status: 'cancelled', sub_total: 30, currency_code: 'USD' }),
    sub({ subscription_number: 'SUB-00003', customer_id: 'u3', customer_name: 'LA Tacos', activated_at: '2026-02-01', sub_total: 20, currency_code: 'USD' }),
  ],
  [XP]: [sub({ subscription_number: 'SUB-00001', customer_id: 'x1', customer_name: 'Xperio One', activated_at: '2026-09-02', sub_total: 300 })],
};
const failOnce = { [USA]: 'HTTP 429', [XP]: 'HTTP 401' };
let authCalls = 0;
const locks = [];
const fakeLate = (base) => ({
  ZOHO_BILLING_ORG_IDS: [CAN, USA, XP],
  ZOHO_BILLING_ORG_NAMES: { [CAN]: 'Cluster Canada', [USA]: 'Cluster USA', [XP]: 'Xperio POS' },
  MRR_STATUSES: new Set(['live', 'non_renewing', 'dunning', 'unpaid']),
  ACTIVE_STATUSES: new Set(['live', 'non_renewing', 'dunning', 'unpaid', 'paused']),
  subMonthlyAmount: C.subMonthlyAmountLocal,
  getAdminBooksAuth: async () => { authCalls++; return { accessToken: `tok${authCalls}`, apiDomain: base }; },
  fetchBillingSubs: async (apiDomain, token, orgId, filter) => {
    assert.strictEqual(filter, 'SubscriptionStatus.All');
    if (failOnce[orgId]) { const m = failOnce[orgId]; delete failOnce[orgId]; throw new Error(`org ${orgId} ${filter} ${m}: fake`); }
    return JSON.parse(JSON.stringify(billing[orgId]));
  },
  acquireSaasScanLock: async (label) => { locks.push(['take', label]); return `${label}:owner`; },
  releaseSaasScanLock: async (owner) => { locks.push(['release', owner]); },
  saasScanShouldStop: async () => false,
});

// ------------------------------------------------------------------------ faux Books + BoC
let booksMode = 'scope'; // d'abord : portées manquantes (avant la reconnexion de l'admin)
const fake = express();
const pnl = () => ({
  code: 0,
  profit_and_loss: [
    { name: 'Gross Profit', total: 1700, account_transactions: [
      { name: 'Operating Income', total: 1700, account_transactions: [
        { account_id: '1', name: 'Subscription Revenue', total: '1,000.00' },
        { account_id: '2', name: 'Adyen Income', total: 500 },
        { account_id: '3', name: 'Recurring revenue - other', total: 200 },
      ] },
    ] },
    { name: 'Operating Profit', total: -2300, account_transactions: [
      { name: 'Operating Expense', total: 4000, account_transactions: [
        { name: 'Selling Expense', total: 4000, account_transactions: [
          { account_id: '10', name: 'Advertising', total: 1000 },
          { account_id: '11', name: 'Sales wages', total: 3000 },
        ] },
      ] },
    ] },
  ],
});
const bookHits = [];
fake.get('/books/v3/reports/profitandloss', (req, res) => {
  bookHits.push(req.query);
  if (req.query.organization_id !== 'BOOKS-ORG') return res.status(400).json({ code: 1, message: 'org' });
  if (booksMode === 'scope') return res.status(401).json({ code: 57, message: 'You are not authorized to perform this operation' });
  res.json(pnl());
});
fake.get('/books/v3/creditnotes', (req, res) => {
  if (booksMode === 'scope') return res.status(401).json({ code: 57, message: 'You are not authorized to perform this operation' });
  const m = String(req.query.date_start).slice(0, 7);
  const list = m === '2026-09'
    ? [{ creditnote_id: 'a', date: '2026-09-04', status: 'open', total: 113 }, { creditnote_id: 'b', date: '2026-09-21', status: 'closed', total: '56.50' }, { creditnote_id: 'c', date: '2026-09-22', status: 'void', total: 999 }]
    : [];
  res.json({ code: 0, creditnotes: list, page_context: { has_more_page: false } });
});
fake.get('/valet/observations/FXUSDCAD/json', (req, res) => {
  res.json({ observations: [
    { d: '2026-08-28', FXUSDCAD: { v: '1.3700' } },
    { d: '2026-09-29', FXUSDCAD: { v: '1.3900' } },
    { d: '2026-09-30', FXUSDCAD: { v: '1.3912' } },
    { d: '2026-07-31', FXUSDCAD: { v: '1.3650' } },
  ] });
});

(async () => {
  const fakeSrv = http.createServer(fake).listen(0);
  const fakeBase = `http://127.0.0.1:${fakeSrv.address().port}`;
  process.env.FINANCE_BOC_BASE_URL = fakeBase;

  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p).then((r) => ({ ...r, rowCount: r.affectedRows != null ? r.affectedRows : (r.rows || []).length })) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
    CREATE TABLE resellers (id SERIAL PRIMARY KEY, name TEXT, name_aliases JSONB DEFAULT '[]'::jsonb, active BOOLEAN DEFAULT TRUE);
    INSERT INTO resellers (name, name_aliases) VALUES ('Solutions Crisp', '["crisp"]'), ('Groupe Inactif', '["alpha"]');
    UPDATE resellers SET active = FALSE WHERE name = 'Groupe Inactif';
    CREATE TABLE zentact_merchants (id SERIAL PRIMARY KEY, merchant_account_id TEXT UNIQUE, status TEXT, activated_at DATE);
    INSERT INTO zentact_merchants (merchant_account_id, status, activated_at) VALUES
      ('m1', 'ACTIVE', '2026-01-10'), ('m2', 'ACTIVE', '2026-09-02'), ('m3', 'ACTIVE', '2026-10-05'), ('m4', 'INACTIVE', '2026-03-01');
  `);
  const P = {
    'cfo@x.com': ['finance:view', 'finance:edit', 'finance:kpi'],
    'lecteur@x.com': ['finance:view', 'finance:kpi'],
    'budget@x.com': ['finance:view', 'finance:edit'],
    'vue@x.com': ['finance:view'],
  };
  const has = (req, p) => (P[req.user.email] || []).includes(p);
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
    late: () => fakeLate(fakeBase),
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, user, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
  let n = 0; const ok = (c, m) => { assert(c, m); n++; };
  const near = (a, b, m) => ok(a != null && Math.abs(a - b) < 1e-6, `${m} : ${a} ≠ ${b}`);
  const END = '2026-09';
  const load = async (user = 'cfo@x.com') => (await api('GET', `/api/finance/kpi?end=${END}`, user)).body;
  const table = (data, prefill) => K.computeKpiTable(data, prefill);
  const cell = (t, key, m = END) => t.rows.find((r) => r.def.key === key).cells.find((c) => c.m === m);
  const row = (t, key) => t.rows.find((r) => r.def.key === key);
  const syncAndWait = async (user = 'cfo@x.com') => {
    const r = await api('POST', '/api/finance/kpi/sync', user);
    for (let i = 0; i < 200; i++) {
      const s = await api('GET', '/api/finance/kpi/status', user);
      if (!s.body.syncing) break;
      await new Promise((x) => setTimeout(x, 25));
    }
    return r;
  };

  // ---------------------------------------------------------------- définitions partagées
  ok(JSON.stringify(KPI_KEYS) === JSON.stringify(K.KPI_KEYS), 'mêmes lignes, même ordre, serveur et navigateur');

  // ---------------------------------------------------------------- permissions et démo
  ok((await api('GET', `/api/finance/kpi?end=${END}`, 'vue@x.com')).status === 403, 'finance:view seul : 403');
  ok((await api('GET', `/api/finance/kpi?end=${END}`, 'budget@x.com')).status === 403, 'finance:edit sans finance:kpi : 403');
  const demo = await api('GET', `/api/finance/kpi?end=${END}`, 'cfo@x.com', null, { 'x-test-demo': '1' });
  ok(demo.status === 403 && demo.body.demo === true, 'mode démo : bloqué');
  ok((await api('PUT', '/api/finance/kpi/budget', 'cfo@x.com', { cells: [{ month: END, key: 'canNew', value: 1, version: 0 }] }, { 'x-test-demo': '1' })).status === 403, 'mode démo : écriture bloquée');
  let d0 = await load('lecteur@x.com');
  ok(d0.caps && d0.caps.canEdit === false, 'lecteur : lecture sans écriture');
  ok(d0.billingReady === false, 'avant toute synchro : Billing pas prêt');
  let t0 = table(d0);
  ok(cell(t0, 'canNew').a.v === null, 'avant synchro : comptes VIDES, pas des zéros');
  ok((await api('PUT', '/api/finance/kpi/budget', 'lecteur@x.com', { cells: [{ month: END, key: 'canNew', value: 1, version: 0 }] })).status === 403, 'lecteur : budget refusé');
  ok((await api('POST', '/api/finance/kpi/sync', 'lecteur@x.com')).status === 403, 'lecteur : synchro refusée');
  ok((await api('PUT', '/api/finance/kpi/actual', 'lecteur@x.com', { month: END, key: 'canNew', value: 1, version: 0 })).status === 403, 'lecteur : correction refusée');
  ok((await api('GET', '/api/finance/kpi?end=2099-01', 'cfo@x.com')).status === 400, 'mois futur refusé');

  // ---------------------------------------------------------------- 1re synchro (Books sans portée)
  const s1 = await syncAndWait();
  ok(s1.status === 202, 'synchro lancée (202)');
  ok(locks[0][0] === 'take' && locks[0][1] === 'finance_kpi' && locks.some((l) => l[0] === 'release'), 'verrou Zoho partagé pris (finance_kpi) puis rendu');
  ok(authCalls >= 2, '401 de Billing : ré-authentification puis reprise');
  const subs = (await db.query('SELECT org_id, COUNT(*)::int AS n FROM finance_billing_subs GROUP BY org_id ORDER BY org_id')).rows;
  ok(subs.find((r) => r.org_id === CAN).n === 13 && subs.find((r) => r.org_id === USA).n === 3 && subs.find((r) => r.org_id === XP).n === 1, 'les 3 organisations copiées (429 et 401 repris une fois)');
  const dup = (await db.query("SELECT org_id FROM finance_billing_subs WHERE subscription_number = 'SUB-00001' ORDER BY org_id")).rows;
  ok(dup.length === 3, 'même numéro d\'abonnement dans 3 organisations : 3 lignes distinctes');
  ok((await api('POST', '/api/finance/kpi/sync', 'cfo@x.com')).status === 429, 'synchro manuelle limitée (une par 5 min)');

  let d1 = await load();
  ok(d1.billingReady === true, 'Billing prêt après la synchro');
  const books = d1.sources.find((s) => s.source === 'books');
  ok(books && books.state === 'reconnect', 'Books sans portée : état « reconnect » (Zoho Books à reconnecter)');
  ok(d1.sources.find((s) => s.source === 'fx').state === 'ok', 'Banque du Canada : synchro ok');
  let t1 = table(d1);
  const f = d1.facts[END];
  ok(f.activations === 7, `activations Canada de septembre = 7 (pas l\'essai, pas les É.-U. ni Xperio) : ${f.activations}`);
  ok(f.resellerActivations === 2, `revendeurs = « SC - Pizza Roma » et « Café Lirette » seulement : ${f.resellerActivations}`);
  const det = (await api('GET', `/api/finance/kpi/detail?month=${END}`, 'cfo@x.com')).body.detail;
  const resOf = (name) => det.activations.find((a) => a.customer === name).reseller;
  ok(resOf('SCOTTS Diner') === null, '« SCOTTS » ne correspond PAS à l\'alias « SC » (mots entiers)');
  ok(resOf('Crispy Chicken') === null, '« Crispy Chicken » ne correspond pas au revendeur « Crisp »');
  ok(resOf('Resto Alpha') === null, 'un revendeur INACTIF ne compte pas');
  ok(resOf('SC - Pizza Roma') === 'SC' && resOf('Café Lirette') === 'Lirette', 'alias du document Word reconnus en mots entiers (accents ignorés)');
  ok(f.cooCancellations === 1, 'CoO : seul le motif EXACT (après normalisation tirets/espaces/casse) compte');
  ok(det.cancellations.find((c) => c.customer === 'Deli Gamma').coo === false, '« Change of ownership » tout court n\'est PAS un CoO');
  ok(f.cooNewSubs === 1 && near(f.cooNewMrr, 75, 'MRR du nouvel abonnement CoO') == null, 'nouvel abonnement CoO rapproché (même client, même mois)');
  ok(cell(t1, 'canNew').a.v === 4, `nouveaux rooftops Canada = 7 − 2 revendeurs − 1 CoO = 4 : ${cell(t1, 'canNew').a.v}`);
  ok(cell(t1, 'coo').a.v === 1 && cell(t1, 'churn').a.v === 2, 'churn = 3 résiliations − 1 CoO = 2');
  near(cell(t1, 'newMrr').a.v, 100 + 80 + 90 + 50 + 75 + 100 + 45 - 75, 'nouvelle MRR = brute − MRR CoO (annuel ramené au mois)');
  near(cell(t1, 'churnMrr').a.v, 60 + 50, 'MRR perdue = résiliations − CoO');
  ok(cell(t1, 'usaChurn').a.v === 1, 'attrition É.-U. = 1 (organisation Cluster USA seulement)');
  near(cell(t1, 'usaMrrUsd').a.v, 70, 'MRR É.-U. fin septembre (reconstituée) = 50 + 20');
  ok(cell(t1, 'usaMrrUsd').a.src === 'reconstructed', 'MRR É.-U. marquée « reconstituée » sans photo de fin de mois');
  near(cell(t1, 'fxUsdCad').a.v, 1.3912, 'taux de fin de mois = DERNIÈRE observation de septembre');
  near(cell(t1, 'usaMrrCad').a.v, 70 * 1.3912, 'MRR É.-U. × taux de fin de mois');
  near(cell(t1, 'usaMrrCad', '2026-08').a.v, 70 * 1.37 + 30 * 1.37, 'août : MRR É.-U. (avec l\'abonnement résilié en septembre) × taux d\'août');
  ok(cell(t1, 'totalMrr').a.v === null && cell(t1, 'arpu').a.v === null, 'sans Books : MRR totale et ARPU vides');
  ok(cell(t1, 'adyenRooftops').a.v === 2 && cell(t1, 'adyenRooftops').a.src === 'zentact', 'rooftops Adyen fin septembre = 2 (actifs, activés au plus tard le 30)');

  // ---------------------------------------------------------------- saisie manuelle du GL (Books absent)
  let r = await api('PUT', '/api/finance/kpi/actual', 'cfo@x.com', { month: END, key: 'sellingExpense', value: 6000, note: 'GL de septembre, saisi', version: 0 });
  ok(r.status === 200 && r.body.kind === 'gl_manual', 'frais de vente saisis à la main (Books absent)');
  d1 = await load(); t1 = table(d1);
  ok(cell(t1, 'sellingExpense').a.src === 'manual' && cell(t1, 'sellingExpense').a.v === 6000, 'saisie manuelle affichée, source « manuel »');
  near(cell(t1, 'coa').a.v, 6000 / 6, 'coût d\'acquisition = frais de vente ÷ (Canada + revendeurs)');
  ok((await api('PUT', '/api/finance/kpi/actual', 'cfo@x.com', { month: END, key: 'sellingExpense', value: 1, version: 0 })).status === 409, 'concurrence : version périmée → 409');

  // ---------------------------------------------------------------- reconnexion de Books
  booksMode = 'ok';
  process.env.FINANCE_KPI_MANUAL_SYNC_MS = '0';
  await syncAndWait();
  ok(bookHits.some((q) => q.from_date === '2026-09-01' && q.to_date === '2026-09-30'), 'P&L demandé mois par mois (du 1er au dernier jour)');
  d1 = await load();
  ok(d1.sources.find((s) => s.source === 'books').state === 'ok', 'Books reconnecté : état ok');
  t1 = table(d1);
  ok(cell(t1, 'totalMrr').a.v === null, 'rattachement des comptes VIDE par défaut : rien n\'est deviné');
  const acc = (await api('GET', '/api/finance/kpi/accounts', 'cfo@x.com')).body.accounts;
  const key = (name) => acc.find((a) => a.name === name).key;
  ok(acc.find((a) => a.name === 'Adyen Income').suggest.includes('adyenIncome'), 'suggestion d\'après le nom (proposée, pas appliquée)');
  ok(acc.find((a) => a.name === 'Selling Expense').isGroup, 'un TOTAL du rapport (groupe) peut être rattaché');
  const st = d1.settings;
  r = await api('PUT', '/api/finance/kpi/settings', 'cfo@x.com', { version: st.version, data: {
    ...st, opening: { month: '2026-07', value: 3000 },
    glMapping: {
      recurringRevenue: [{ key: key('Subscription Revenue') }, { key: key('Recurring revenue - other') }],
      subscriptionRevenue: [{ key: key('Subscription Revenue') }],
      adyenIncome: [{ key: key('Adyen Income') }],
      sellingExpense: [{ key: key('Selling Expense') }],
    },
  } });
  ok(r.status === 200, 'réglages enregistrés (rattachement + ouverture du parc)');
  ok((await api('PUT', '/api/finance/kpi/settings', 'cfo@x.com', { version: st.version, data: st })).status === 409, 'réglages : version périmée → 409');
  ok((await api('PUT', '/api/finance/kpi/settings', 'cfo@x.com', { version: r.body.version, data: { resellerAliases: ['S'] } })).body.error === 'alias_too_short', 'alias d\'une lettre refusé');
  ok((await api('PUT', '/api/finance/kpi/settings', 'cfo@x.com', { version: r.body.version, data: { canadaOrgIds: [CAN], usaOrgIds: [CAN] } })).body.error === 'orgs_overlap', 'une organisation ne peut être Canada ET É.-U.');
  ok((await api('PUT', '/api/finance/kpi/settings', 'cfo@x.com', { version: r.body.version, data: { usaOrgIds: ['999'] } })).body.error === 'bad_orgs', 'organisation inconnue refusée');
  d1 = await load(); t1 = table(d1);
  near(cell(t1, 'totalMrr').a.v, 1200, 'MRR totale = revenus récurrents rattachés (1 000 + 200)');
  ok(cell(t1, 'totalMrr').a.src === 'books', 'source : Books');
  ok(cell(t1, 'sellingExpense').a.v === 6000 && cell(t1, 'sellingExpense').a.src === 'manual', 'la saisie manuelle GAGNE sur Books');
  near(cell(t1, 'saasCreditNotes').a.v, 169.5, 'notes de crédit de septembre (hors annulées) = 113 + 56,50');
  near(cell(t1, 'paymentsArpu').a.v, 500 / 2, 'ARPU paiements = revenus Adyen ÷ rooftops Adyen');
  // Parc : ouverture 3 000 fin juillet ; août +1 −1 = 0 ; septembre (4 + 2) − (2 + 1) = +3.
  ok(cell(t1, 'totalRooftops', '2026-06').a.v === null, 'avant le mois d\'ouverture : parc vide');
  ok(cell(t1, 'totalRooftops', '2026-07').a.v === 3000 && cell(t1, 'totalRooftops', '2026-07').a.src === 'opening', 'mois d\'ouverture = solde de la CFO');
  ok(cell(t1, 'totalRooftops', '2026-08').a.v === 3000, 'août : 3 000 + 0');
  ok(cell(t1, 'rooftopIncrease').a.v === 3 && cell(t1, 'totalRooftops').a.v === 3003, 'septembre : hausse 3, parc 3 003');
  near(cell(t1, 'arpu').a.v, 1200 / 3003, 'ARPU = MRR totale ÷ parc');
  near(cell(t1, 'mrrIncrease').a.v, 0, 'hausse de la MRR = mois − mois précédent');

  // ---------------------------------------------------------------- correction d'un réel
  r = await api('PUT', '/api/finance/kpi/actual', 'cfo@x.com', { month: END, key: 'canNew', value: 10, note: 'Recompté avec les ventes', version: 0 });
  ok(r.status === 200 && r.body.kind === 'override', 'correction enregistrée');
  ok(logs.some((l) => l.t === 'finance_kpi' && l.ev === 'override_set' && /Recompté/.test(l.d)), 'correction journalisée (finance_kpi)');
  await syncAndWait(); // une resynchro n'efface pas la correction
  d1 = await load(); t1 = table(d1);
  const cn = cell(t1, 'canNew');
  ok(cn.a.v === 10 && cn.a.src === 'override' && cn.a.base === 4 && cn.a.saved.note === 'Recompté avec les ventes', 'la correction gagne sur Billing, valeur d\'origine gardée');
  ok(cell(t1, 'newRooftops').a.v === 12 && cell(t1, 'totalRooftops').a.v === 3009, 'la correction se propage aux formules (parc 3 009)');
  r = await api('PUT', '/api/finance/kpi/actual', 'cfo@x.com', { month: END, key: 'totalRooftops', value: 3100, version: 0 });
  d1 = await load(); t1 = table(d1);
  ok(cell(t1, 'totalRooftops').a.v === 3100, 'parc corrigé à la main : la correction gagne sur le cumul');
  r = await api('PUT', '/api/finance/kpi/actual', 'cfo@x.com', { month: END, key: 'fxUsdCad', value: 1.4, note: 'taux du contrat', version: 0 });
  ok(r.status === 200 && r.body.kind === 'fx_manual', 'taux manuel enregistré');
  ok((await api('PUT', '/api/finance/kpi/actual', 'cfo@x.com', { month: END, key: 'fxUsdCad', value: 14, version: 1 })).body.error === 'bad_rate', 'taux absurde refusé');
  d1 = await load(); t1 = table(d1);
  near(cell(t1, 'usaMrrCad').a.v, 70 * 1.4, 'le taux manuel remplace celui de la Banque du Canada');
  // Photo de fin de mois prise la nuit du 1er octobre : elle remplace la reconstitution.
  await db.query(`INSERT INTO finance_billing_mrr_snap (org_id, snap_date, mrr, active_count) VALUES ('${USA}', '2026-10-01', 72, 2)`);
  d1 = await load(); t1 = table(d1);
  ok(cell(t1, 'usaMrrUsd').a.v === 72 && cell(t1, 'usaMrrUsd').a.src === 'snapshot', 'photo de fin de mois préférée à la reconstitution');
  const ovCanNew = (await db.query("SELECT version FROM finance_kpi_actual_override WHERE kpi_key = 'canNew'")).rows[0].version;
  ok((await api('PUT', '/api/finance/kpi/actual', 'cfo@x.com', { month: END, key: 'canNew', value: null, version: ovCanNew })).status === 200, 'correction retirée');
  d1 = await load(); t1 = table(d1);
  ok(cell(t1, 'canNew').a.v === 4 && cell(t1, 'canNew').a.src === 'billing', 'sans correction : retour à Billing');

  // ---------------------------------------------------------------- budget
  const b = (cells) => api('PUT', '/api/finance/kpi/budget', 'cfo@x.com', { cells });
  r = await b([{ month: END, key: 'canNew', value: 5, version: 0 }, { month: END, key: 'resellerAdds', value: 1, version: 0 }, { month: END, key: 'sellingExpense', value: 5400, version: 0 }]);
  ok(r.status === 200 && r.body.saved.length === 3, 'budget enregistré');
  ok((await b([{ month: END, key: 'canNew', value: 6, version: 0 }])).status === 409, 'budget : version périmée → 409');
  ok((await b([{ month: END, key: 'pirate', value: 6, version: 0 }])).status === 400, 'budget : KPI inconnu refusé');
  ok((await b([{ month: '2026-13', key: 'canNew', value: 6, version: 0 }])).status === 400, 'budget : mois invalide refusé');
  d1 = await load(); t1 = table(d1);
  const bc = cell(t1, 'coa');
  ok(bc.b.src === 'formula' && near(bc.b.v, 5400 / 6, 'CoA budget') == null, 'ligne-formule du budget calculée à partir des lignes saisies');
  const nb = cell(t1, 'newRooftops');
  ok(nb.var === 0 && nb.varPct === 0, 'écart = réel − budget (6 − 6)');
  const sc = cell(t1, 'canNew');
  ok(sc.var === -1 && near(sc.varPct, -0.2, 'Var %') == null, 'Var % = écart ÷ budget (−1 ÷ 5)');
  // Préremplissage par le modèle FY2027 (seulement les mois 2027, seulement si rien n'est enregistré).
  const pre = (m, k) => (m === '2027-01' && k === 'canNew' ? 42 : m === END && k === 'canNew' ? 99 : null);
  const tp = table({ ...d1, end: '2027-01', months: [...d1.months, '2026-10', '2026-11', '2026-12', '2027-01'] }, pre);
  ok(cell(tp, 'canNew', '2027-01').b.v === 42 && cell(tp, 'canNew', '2027-01').b.src === 'model', 'mois 2027 vide : prérempli par le modèle');
  ok(cell(tp, 'canNew', END).b.v === 5 && cell(tp, 'canNew', END).b.src === 'stored', 'valeur enregistrée gagne sur le préremplissage');

  // ---------------------------------------------------------------- colonne 12 mois
  const rNew = row(t1, 'newRooftops');
  ok(rNew.t12.a === rNew.cells.reduce((a, c) => a + (c.a.v || 0), 0), '12 mois d\'un FLUX = somme');
  ok(row(t1, 'totalRooftops').t12.a === 3100, '12 mois d\'un SOLDE = dernier mois');
  const rArpu = row(t1, 'arpu');
  const sumMrr = rArpu.cells.reduce((a, c) => a + (c.a.v != null ? cell(t1, 'totalMrr', c.m).a.v : 0), 0);
  const sumRoof = rArpu.cells.reduce((a, c) => a + (c.a.v != null ? cell(t1, 'totalRooftops', c.m).a.v : 0), 0);
  near(rArpu.t12.a, sumMrr / sumRoof, '12 mois de l\'ARPU = Σ MRR ÷ Σ rooftops (rapport des sommes)');
  const sumArpus = rArpu.cells.reduce((a, c) => a + (c.a.v || 0), 0);
  ok(Math.abs(rArpu.t12.a - sumArpus) > 1e-6, 'jamais la SOMME des ARPU (bogue du classeur)');
  ok(row(t1, 'fxUsdCad').t12.a === null, 'taux de change : pas de colonne 12 mois');
  ok(t1.months.length === 12 && t1.months[0] === '2025-10' && t1.months[11] === END, 'fenêtre = 12 mois terminés par le mois choisi');

  // ---------------------------------------------------------------- Excel
  const tpl = await api('GET', `/api/finance/kpi/budget/template?end=${END}&lang=fr`, 'cfo@x.com');
  ok(tpl.status === 200 && Buffer.isBuffer(tpl.body), 'modèle Excel téléchargé');
  const wb = xlsx.read(tpl.body, { type: 'buffer' });
  const aoa = xlsx.utils.sheet_to_json(wb.Sheets['KPI Budget'], { header: 1, defval: null });
  const head = aoa[0];
  const colSep = head.indexOf(END);
  const rCan = aoa.findIndex((x) => x[0] === 'canNew');
  ok(colSep > 1 && aoa[rCan][colSep] === 5, 'modèle prérempli des valeurs enregistrées');
  ok(head.includes('2027-12'), 'modèle couvre aussi l\'exercice 2027');
  aoa[rCan][colSep] = 7;                                         // changement
  aoa[aoa.findIndex((x) => x[0] === 'churn')][colSep] = '2,5';    // virgule décimale
  aoa[aoa.findIndex((x) => x[0] === 'coo')][colSep] = 'abc';      // erreur
  aoa.push(['pirate', 'Inconnu', 1]);
  const ws2 = xlsx.utils.aoa_to_sheet(aoa);
  const wb2 = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb2, ws2, 'KPI Budget');
  const buf = xlsx.write(wb2, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData(); fd.append('file', new Blob([buf]), 'budget.xlsx');
  const imp = await fetch(`${base}/api/finance/kpi/budget/import`, { method: 'POST', headers: { 'x-test-user': 'cfo@x.com' }, body: fd }).then((x) => x.json());
  ok(imp.cells.length === 2 && imp.unchanged >= 2, `aperçu : seules les cellules qui CHANGENT (${imp.cells.length})`);
  ok(imp.cells.find((c) => c.key === 'canNew').old === 5 && imp.cells.find((c) => c.key === 'churn').value === 2.5, 'aperçu : ancienne valeur, virgule décimale lue');
  ok(imp.errors.some((e) => e.error === 'bad_value') && imp.errors.some((e) => e.error === 'unknown_kpi'), 'aperçu : erreurs ligne par ligne');
  ok((await db.query("SELECT value::float8 AS v FROM finance_kpi_budget WHERE kpi_key = 'canNew'")).rows[0].v === 5, 'l\'aperçu n\'écrit rien');
  r = await api('PUT', '/api/finance/kpi/budget', 'cfo@x.com', { mode: 'import', cells: imp.cells.map(({ month, key, value }) => ({ month, key, value })) });
  ok(r.status === 200 && (await db.query("SELECT value::float8 AS v FROM finance_kpi_budget WHERE kpi_key = 'canNew'")).rows[0].v === 7, 'import confirmé : écrit');
  ok(logs.some((l) => l.ev === 'imported'), 'import journalisé');
  const ex = await api('POST', '/api/finance/kpi/export', 'cfo@x.com', { filename: 'kpi.xlsx', rows: [['KPI', 'Sep-26'], ['Canada', 4]] });
  ok(ex.status === 200 && xlsx.read(ex.body, { type: 'buffer' }).SheetNames[0] === 'KPI', 'export XLSX');
  ok((await api('POST', '/api/finance/kpi/export', 'cfo@x.com', { rows: [[{ evil: 1 }]] })).status === 400, 'export : cellule non valide refusée');

  // ---------------------------------------------------------------- copie Billing : suppressions
  billing[CAN] = billing[CAN].filter((s) => s.subscription_number !== 'SUB-00013');
  await syncAndWait();
  ok((await db.query(`SELECT COUNT(*)::int AS n FROM finance_billing_subs WHERE org_id = '${CAN}'`)).rows[0].n === 12, 'abonnement disparu de Zoho : retiré de la copie');
  const keep = billing[CAN];
  billing[CAN] = keep.slice(0, 2); // lecture partielle (2 sur 12)
  await syncAndWait();
  ok((await db.query(`SELECT COUNT(*)::int AS n FROM finance_billing_subs WHERE org_id = '${CAN}'`)).rows[0].n === 12, 'lecture PARTIELLE de Zoho : rien n\'est effacé');
  d1 = await load();
  ok(d1.sources.find((s) => s.source === `billing:${CAN}`).state === 'warning', 'lecture partielle signalée');
  billing[CAN] = keep;

  // ---------------------------------------------------------------- pur : normalisation
  ok(C.normReason('CHANGE OF OWNERSHIP —  NEW SUB CREATED') === C.normReason('Change of Ownership – new sub created'), 'motif CoO : tirets et espaces normalisés');
  ok(!C.cooMatcher(['Change of Ownership – new sub created'])('Change of Ownership – new sub created later'), 'motif CoO : égalité exacte, jamais une sous-chaîne');

  server.close(); fakeSrv.close();
  try { fs.unlinkSync(out); } catch { /* */ }
  console.log(`✅ finance kpi : ${n} vérifications`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
