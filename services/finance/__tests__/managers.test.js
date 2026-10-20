// Module Finance — gestionnaires (revenus reportés, amortissement des terminaux, écritures Zoho
// Books), de bout en bout : banc du moteur contre les chiffres CORRIGÉS de la spec, puis les
// routes contre une vraie base Postgres en mémoire (PGlite), un vrai serveur HTTP et un FAUX
// Zoho Books local (jamais le vrai : aucune écriture ne sort de la machine).
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/managers.test.js [dossier design/finance]
//
// Les contrats et lots d'exemple sont LUS dans le prototype du design (design/finance, hors
// dépôt). ⚠️ Échoue s'il manque, plutôt que de se déclarer vert.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const express = require('express');
const xlsx = require('xlsx');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }

process.env.FINANCE_BOOKS_BACKOFF_MS = '20';
process.env.ZOHO_ORG_ID = 'org-test';

const E = require('../managersEngine');
const { registerFinanceRoutes } = require('../routes');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
const PROTO = path.join(DIR, 'Finance Module Prototype.dc.html');
if (!fs.existsSync(PROTO)) { console.error(`ÉCHEC : prototype introuvable dans ${DIR}`); process.exit(1); }

// Échantillons du prototype, tels quels (état initial du composant).
function samples() {
  const html = fs.readFileSync(PROTO, 'utf8');
  const grab = (key) => {
    const m = new RegExp(`${key}: (\\[\\[[^;]*?\\]\\]),`).exec(html);
    if (!m) throw new Error(`échantillon « ${key} » introuvable dans le prototype`);
    return vm.runInNewContext(m[1]);
  };
  return { contracts: grab('contracts'), lots: grab('lots') };
}
const TYPE_OF = { 'Annual SaaS': 'subscription', 'Install fee': 'service', Training: 'training', 'Prepaid 3-yr': 'prepaid' };

let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} : ${a} ≠ ${b}`); n++; };
const near = (a, b, m, tol = 0.005) => { assert(Math.abs(a - b) <= tol, `${m} : ${a} ≠ ${b}`); n++; };

// ============================================================================ banc du moteur
function engineBench() {
  const S = samples();
  ok(S.contracts.length === 8 && S.lots.length === 5, 'prototype : 8 contrats et 5 lots d\'exemple');
  const contracts = S.contracts.map(([ref, customer, type, total, startMonth, termMonths]) => ({ ref, customer, type: TYPE_OF[type], total, startMonth, termMonths }));
  ok(contracts.every((c) => c.type), 'chaque type du prototype a son type Sales Hub');

  // ---- Revenus reportés, septembre 2026 (le « NOW » du prototype), SANS rembourrage.
  const s = E.deferredSummary(contracts, '2026-09');
  eq(s.recognized, 14000, 'constaté en septembre (5 contrats, sans les 125 640 $ de rembourrage)');
  eq(s.balance, 196600, 'solde reporté (sans les 864 000 $ de rembourrage)');
  eq(s.openContracts, 6, 'contrats ouverts');
  eq(s.newDeferrals, 21600, 'nouveaux reports de septembre (Sushi Kaito)');
  eq(s.newCount, 1, 'un nouveau contrat en septembre');
  const wf = s.waterfall.map((w) => w.amount);
  assert.deepStrictEqual(wf, [15200, 15200, 15200, 15200, 15200, 15200, 8000, 8000, 8000, 8000, 8000, 6200], `waterfall corrigé de la spec : ${wf}`); n++;
  eq(s.waterfall[0].month, '2026-10', 'le waterfall commence le mois suivant');
  eq(s.waterfall[11].month, '2027-09', 'et finit 12 mois plus tard');
  eq(s.next12, 137400, '12 prochains mois = 137 400 $');
  eq(s.beyond12, 59200, 'au-delà de 12 mois');
  ok(wf.every((v) => v > 0) && wf[5] === 15200, 'Lafleur (avril 2026, 12 mois) est bien là jusqu\'en mars 2027 (bogue du prototype corrigé)');
  // Écriture par TYPE de contrat (le prototype appliquait 69 / 22 / 9 %).
  const j = s.journal;
  assert.deepStrictEqual(j.lines.map((l) => [l.side, l.code, l.amount]), [['debit', '2400', 14000], ['credit', '4000', 13500], ['credit', '4100', 500]], 'écriture de septembre par type'); n++;
  ok(j.balanced && j.debit === j.credit, 'écriture équilibrée');
  eq(s.recognizedByType.subscription + s.recognizedByType.prepaid, 13500, 'SaaS annuel 9 000 + prépayé 4 500 → 4000');
  eq(s.recognizedByType.training, 0, 'formation : 0 en septembre (Poutinerie finie en avril)');
  const cafe = E.contractAt(contracts.find((c) => c.customer === 'Café Étoile'), E.ym('2026-09'));
  ok(cafe.status === 'upcoming' && cafe.thisMonth === 0, 'Café Étoile commence en octobre : rien en septembre');
  eq(E.contractAt(contracts[3], E.ym('2026-09')).status, 'complete', 'Poutinerie : terminé');
  // Le mois courant n'est plus figé : un autre mois donne d'autres chiffres.
  eq(E.deferredSummary(contracts, '2026-10').recognized, 15200, 'octobre 2026 : 15 200 $');

  // ---- Arrondi : la somme des mois retombe exactement sur le montant, Dt = Ct chaque mois.
  const odd = [
    { type: 'subscription', total: 1000, startMonth: '2026-01', termMonths: 7 },
    { type: 'service', total: 333.33, startMonth: '2026-02', termMonths: 12 },
    { type: 'training', total: 99.99, startMonth: '2026-03', termMonths: 36 },
  ];
  for (const c of odd) {
    let tot = 0;
    for (let m = E.ym(c.startMonth); m < E.ym(c.startMonth) + c.termMonths; m++) tot += Math.round(E.contractAt(c, m).thisMonth * 100);
    eq(tot, Math.round(c.total * 100), `Σ mois = montant au cent (${c.total} / ${c.termMonths})`);
  }
  for (let m = E.ym('2026-01'); m < E.ym('2029-06'); m++) {
    const jj = E.deferredSummary(odd, E.mStr(m)).journal;
    if (!jj.balanced) assert.fail(`écriture déséquilibrée en ${E.mStr(m)}`);
  }
  n++;
  // Facturé après le début : rattrapage le mois de la facture, jamais un 2400 négatif.
  const late = { type: 'subscription', total: 1200, startMonth: '2026-01', termMonths: 12, billedDate: '2026-03-15' };
  eq(E.contractAt(late, E.ym('2026-02')).thisMonth, 0, 'pas encore facturé : rien ne sort du reporté');
  eq(E.contractAt(late, E.ym('2026-02')).status, 'notBilled', 'statut « pas facturé »');
  eq(E.contractAt(late, E.ym('2026-03')).thisMonth, 300, 'mois de la facture : janvier à mars rattrapés');
  // Fermeture anticipée.
  const rel = { type: 'subscription', total: 1200, startMonth: '2026-01', termMonths: 12, closedMonth: '2026-04', closeTreatment: 'release' };
  eq(E.contractAt(rel, E.ym('2026-04')).thisMonth, 900, 'fermeture « release » : avril constate le solde restant (100 + 800)');
  eq(E.contractAt(rel, E.ym('2026-05')).thisMonth, 0, 'plus rien après la fermeture');
  const can = { ...rel, closeTreatment: 'cancel' };
  eq(E.contractAt(can, E.ym('2026-04')).thisMonth, 0, 'fermeture « cancel » : aucun revenu au mois de fermeture');
  eq(E.deferredSummary([can], '2026-04').balance, 0, '« cancel » : le solde sort du reporté');
  eq(E.contractAt(can, E.ym('2026-04')).recognizedToDate, 300, '« cancel » : 3 mois constatés');
  // Remainder sur la dernière ligne (entrées fractionnaires).
  const bl = E.balanceLines([{ cents: 1000.4 }], [{ cents: 333.4 }, { cents: 333.4 }, { cents: 333.4 }]);
  assert.deepStrictEqual(bl.credits.map((l) => l.cents), [333, 333, 334], 'le reste va à la dernière ligne'); n++;

  // ---- Amortissement, septembre 2026.
  const lots = S.lots.map(([ref, description, quantity, unitCost, inServiceMonth]) => ({ ref, description, quantity, unitCost, inServiceMonth, usefulLife: 36, salvage: 0 }));
  const M = E.ym('2026-09');
  const want = [[8622.22, 43111.11], [6788.89, 74677.78], [6438.89, 103022.22], [4333.33, 95333.33], [2210, 59670]];
  lots.forEach((l, i) => {
    const c = E.lotAt(l, M);
    near(c.monthly, want[i][0], `${l.ref} : charge mensuelle`);
    near(c.nbv, want[i][1], `${l.ref} : VNC au 30 septembre`);
  });
  const a = E.amortSummary(lots, '2026-09');
  eq(a.cost, 1022160, 'coût brut');
  near(a.nbv, 375814.44, 'VNC totale');
  eq(Math.round(a.nbvPct * 100), 37, 'VNC = 37 % du coût');
  near(a.monthly, 28393.33, 'charge de septembre (± 1 ¢ : arrondi cumulatif)', 0.011);
  eq(a.unitsDeployed, 2146, 'terminaux déployés');
  near(a.projection[0].nbv, 375814.44, 'projection : point de départ');
  near(a.projection[1].nbv, 347421.11, 'projection : octobre');
  ok(a.journal.balanced && a.journal.lines.length === 2 && a.journal.lines[0].code === '6200' && a.journal.lines[1].code === '1590', 'écriture : Dt 6200 / Ct 1590');
  // Lot pas encore en service : aucune charge (le prototype ajoutait 2 888,89 $).
  const withFuture = [...lots, { ref: 'NEW', description: 'PAX A920 Pro', quantity: 200, unitCost: 520, inServiceMonth: '2026-10', usefulLife: 36, salvage: 0 }];
  const af = E.amortSummary(withFuture, '2026-09');
  near(af.monthly, a.monthly, 'lot d\'octobre : rien en septembre (bogue du prototype corrigé)');
  eq(af.notInService, 1, 'un lot pas encore en service');
  eq(E.lotAt(withFuture[5], M).status, 'notInService', 'statut « pas en service »');
  near(E.lotAt(withFuture[5], E.ym('2026-10')).thisMonth, 2888.89, 'il commence en octobre');
  // Radiation de L-2026-01 en septembre.
  const wo = lots.map((l) => (l.ref === 'L-2026-01' ? { ...l, writtenOffMonth: '2026-09' } : l));
  const settings = { ...E.DEFAULT_AMORT_SETTINGS, assetAccount: '1580', lossAccount: '6900' };
  const aw = E.amortSummary(wo, '2026-09', settings);
  near(aw.monthly, a.monthly - 2210, 'radiation : plus de charge pour ce lot (26 183 $)', 0.011);
  near(aw.nbv, 316144.44, 'VNC après radiation (316 K$)');
  eq(aw.cost, 1022160 - 79560, 'sortie de l\'actif : le coût quitte le total (le prototype le gardait)');
  eq(aw.writtenOff, 1, 'un lot radié');
  assert.deepStrictEqual(aw.writeOffJournal.lines.map((l) => [l.side, l.code, l.amount]),
    [['debit', '1590', 17680], ['debit', '6900', 61880], ['credit', '1580', 79560]], 'écriture de radiation (sortie de l\'actif)'); n++;
  ok(aw.writeOffJournal.balanced, 'radiation équilibrée');
  const acc = E.amortSummary(wo, '2026-09', { ...settings, writeOffMode: 'accelerate' });
  assert.deepStrictEqual(acc.writeOffJournal.lines.map((l) => [l.side, l.code, l.amount]), [['debit', '6900', 61880], ['credit', '1590', 61880]], 'radiation en amortissement accéléré'); n++;
  eq(acc.cost, 1022160, 'accéléré : l\'actif reste au coût');
  near(acc.nbv, 316144.44, 'accéléré : même VNC');
  const missing = E.amortSummary(wo, '2026-09').writeOffJournal;
  ok(missing.missingAccounts.includes('terminalAsset') && missing.missingAccounts.includes('writeOffLoss'), 'comptes perte et actif non configurés : signalés');
  // Valeur résiduelle et somme exacte sur la vie.
  const sv = { quantity: 7, unitCost: 333.33, inServiceMonth: '2026-01', usefulLife: 36, salvage: 100 };
  let tot = 0;
  for (let m = E.ym('2025-06'); m < E.ym('2030-01'); m++) tot += Math.round(E.lotAt(sv, m).thisMonth * 100);
  eq(tot, Math.round((7 * 333.33 - 100) * 100), 'Σ charges sur la vie = coût − valeur résiduelle, au cent');
  eq(E.lotAt(sv, E.ym('2030-01')).nbv, 100, 'VNC finale = valeur résiduelle');
  eq(E.lotAt(sv, E.ym('2028-12')).status, 'fullyAmortized', 'entièrement amorti');
  // Dates.
  eq(E.lastDay(E.ym('2028-02')), '2028-02-29', 'dernier jour du mois (bissextile)');
  ok(E.isMonth(E.currentMonth()) && E.currentMonth(new Date('2026-11-01T03:00:00Z')) === '2026-10', 'mois courant à Toronto (3 h UTC le 1er = encore octobre)');
  return { contracts, lots };
}

// ============================================================================ faux Zoho Books
function fakeBooks() {
  const st = { scope: true, fail429: 0, fail401: 0, journals: [], coaCalls: 0 };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.query.organization_id !== 'org-test') return res.status(400).json({ code: 2, message: 'org' });
    if (st.fail429 > 0) { st.fail429--; return res.status(429).json({ code: 44, message: 'Too many requests' }); }
    if (st.fail401 > 0) { st.fail401--; return res.status(401).json({ code: 14, message: 'Invalid OAuth token' }); }
    if (!st.scope) return res.status(401).json({ code: 57, message: 'You are not authorized to perform this operation' });
    next();
  });
  const COA = [
    { account_id: '9001', account_code: '2400', account_name: 'Deferred Revenue', account_type: 'other_current_liability', is_active: true },
    { account_id: '9002', account_code: '4000', account_name: 'SaaS Revenue', account_type: 'income', is_active: true },
    { account_id: '9003', account_code: '4100', account_name: 'Installation Revenue', account_type: 'income', is_active: true },
    { account_id: '9004', account_code: '4150', account_name: 'Training Revenue', account_type: 'income', is_active: true },
    { account_id: '9005', account_code: '6200', account_name: 'Amortization Expense', account_type: 'expense', is_active: true },
    { account_id: '9006', account_code: '1590', account_name: 'Accumulated Amortization', account_type: 'fixed_asset', is_active: true },
    { account_id: '9007', account_code: '1580', account_name: 'Terminals', account_type: 'fixed_asset', is_active: true },
    { account_id: '9008', account_code: '6900', account_name: 'Loss on disposal', account_type: 'expense', is_active: true },
  ];
  app.get('/books/v3/chartofaccounts', (req, res) => {
    st.coaCalls++;
    const page = Number(req.query.page) || 1;
    const slice = page === 1 ? COA.slice(0, 5) : COA.slice(5);
    res.json({ code: 0, chartofaccounts: slice, page_context: { page, has_more_page: page === 1 } });
  });
  app.post('/books/v3/journals', (req, res) => {
    st.journals.push({ body: req.body, auth: req.headers.authorization });
    res.status(201).json({ code: 0, journal: { journal_id: `J${st.journals.length}`, entry_number: `MJ-${st.journals.length}` } });
  });
  const server = http.createServer(app).listen(0);
  return { st, server, url: `http://127.0.0.1:${server.address().port}` };
}

// ============================================================================ routes
(async () => {
  const bench = engineBench();
  const books = fakeBooks();

  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
  `);
  const perms = {
    'cfo@x.com': ['finance:view', 'finance:edit', 'finance:deferred', 'finance:amortization', 'finance:post_je'],
    'analyste@x.com': ['finance:view', 'finance:edit', 'finance:deferred', 'finance:amortization'],
    'lecteur@x.com': ['finance:view', 'finance:deferred'],
    'poster@x.com': ['finance:view', 'finance:deferred', 'finance:post_je'],
    'budget@x.com': ['finance:view', 'finance:edit'],
    'nobody@x.com': [],
  };
  const has = (req, p) => (perms[req.user.email] || []).includes(p);
  const logs = [];
  let authCalls = 0;
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
    late: () => ({ getAdminBooksAuth: async () => { authCalls++; return { accessToken: `tok${authCalls}`, apiDomain: books.url }; } }),
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, user, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()), ct };
  };
  const upload = async (p, user, buf, name = 'f.xlsx') => {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name);
    const r = await fetch(base + p, { method: 'POST', headers: { 'x-test-user': user }, body: fd });
    return { status: r.status, body: await r.json() };
  };
  const book = (rows, sheet = 'S') => { const wb = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), sheet); return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }); };
  const D = '/api/finance/deferred';
  const A = '/api/finance/amortization';

  // ---------------------------------------------------------------- permissions
  eq((await api('GET', `${D}?month=2026-09`, 'nobody@x.com')).status, 403, 'sans permission : 403');
  eq((await api('GET', `${D}?month=2026-09`, 'budget@x.com')).status, 403, 'finance:view + edit sans finance:deferred : 403');
  eq((await api('GET', `${A}?month=2026-09`, 'lecteur@x.com')).status, 403, 'lecteur des revenus reportés : pas l\'amortissement');
  eq((await api('GET', `${D}?month=2026-09`, 'cfo@x.com', null, { 'x-test-demo': '1' })).status, 403, 'mode démo : bloqué');
  let r = await api('GET', `${D}?month=2026-09`, 'lecteur@x.com');
  ok(r.status === 200 && r.body.caps.canEdit === false && r.body.caps.canPost === false && r.body.contracts.length === 0, 'lecteur : lecture seule, aucune donnée inventée');
  eq(r.body.summary.balance, 0, 'sans contrat : solde 0 (pas de rembourrage)');
  r = await api('GET', D, 'lecteur@x.com');
  eq(r.body.month, E.currentMonth(), 'mois par défaut = mois courant à Toronto');

  // ---------------------------------------------------------------- contrats
  const add = (user, b) => api('POST', `${D}/contracts`, user, b);
  eq((await add('lecteur@x.com', { customer: 'X', type: 'subscription', total: 1, startMonth: '2026-01', termMonths: 12 })).status, 403, 'lecteur : ne crée pas');
  eq((await add('cfo@x.com', { customer: '  ', type: 'subscription', total: 1, startMonth: '2026-01', termMonths: 12 })).body.error, 'bad_customer', 'client obligatoire');
  eq((await add('cfo@x.com', { customer: 'X', type: 'pirate', total: 1, startMonth: '2026-01', termMonths: 12 })).body.error, 'bad_type', 'type inconnu');
  eq((await add('cfo@x.com', { customer: 'X', type: 'subscription', total: 1, startMonth: '2026-13', termMonths: 12 })).body.error, 'bad_start', 'mois de début invalide');
  eq((await add('cfo@x.com', { customer: 'X', type: 'subscription', total: 1, startMonth: '2026-01', termMonths: 0 })).body.error, 'bad_term', 'durée ≥ 1');
  eq((await add('cfo@x.com', { customer: 'X', type: 'subscription', total: -5, startMonth: '2026-01', termMonths: 3 })).body.error, 'bad_total', 'montant positif');
  eq((await add('cfo@x.com', { customer: 'X', type: 'subscription', total: 5, startMonth: '2026-01', termMonths: 3, billedDate: '2026-02-30' })).body.error, 'bad_billed_date', 'date de facturation invalide');
  const created = [];
  for (const c of bench.contracts) {
    const x = await add('analyste@x.com', { customer: c.customer, type: c.type, total: c.total, startMonth: c.startMonth, termMonths: c.termMonths });
    ok(x.status === 200, `contrat ajouté : ${c.customer}`);
    created.push(x.body.contract);
  }
  const refs = created.map((c) => c.ref);
  eq(new Set(refs).size, 8, 'références uniques');
  ok(refs.includes('CT-2026-0001') && refs.includes('CT-2026-0005') && refs.includes('CT-2025-0003'), 'références CT-AAAA-NNNN générées par le serveur, par année de début');
  ok(logs.some((l) => l.t === 'finance_deferred' && l.ev === 'contract_added'), 'journal d\'activité : finance_deferred');

  r = await api('GET', `${D}?month=2026-09`, 'lecteur@x.com');
  eq(r.body.summary.recognized, 14000, 'API : constaté en septembre');
  eq(r.body.summary.balance, 196600, 'API : solde');
  assert.deepStrictEqual(r.body.summary.waterfall.map((w) => w.amount), [15200, 15200, 15200, 15200, 15200, 15200, 8000, 8000, 8000, 8000, 8000, 6200], 'API : waterfall corrigé'); n++;
  eq(r.body.journal.lines.length, 3, 'API : écriture à 3 lignes');
  ok(r.body.journal.unmapped.includes('2400') && !r.body.journal.post, 'API : comptes Books pas encore associés, rien de passé');

  // Concurrence optimiste.
  const lafleur = created.find((c) => c.customer.startsWith('Groupe Resto'));
  eq((await api('PATCH', `${D}/contracts/${lafleur.id}`, 'cfo@x.com', { notes: 'v1', version: lafleur.version })).status, 200, 'modification avec la bonne version');
  r = await api('PATCH', `${D}/contracts/${lafleur.id}`, 'analyste@x.com', { notes: 'v-périmée', version: lafleur.version });
  ok(r.status === 409 && r.body.error === 'conflict' && r.body.current.notes === 'v1', 'version périmée → 409 + version courante');
  eq((await api('PATCH', `${D}/contracts/${lafleur.id}`, 'cfo@x.com', { termMonths: 0, version: r.body.current.version })).body.error, 'bad_term', 'modification validée');
  // Fermeture / réouverture.
  const nino = created.find((c) => c.customer.startsWith('Pizzeria'));
  eq((await api('POST', `${D}/contracts/${nino.id}/close`, 'cfo@x.com', { month: '2026-10', treatment: 'oops', version: nino.version })).body.error, 'bad_treatment', 'traitement de fermeture validé');
  r = await api('POST', `${D}/contracts/${nino.id}/close`, 'cfo@x.com', { month: '2026-10', treatment: 'release', reason: 'Résiliation', version: nino.version });
  ok(r.status === 200 && r.body.contract.closedMonth === '2026-10', 'contrat fermé');
  eq((await api('GET', `${D}?month=2026-10`, 'lecteur@x.com')).body.summary.recognized, 15200 - 2700 + 62100, 'octobre : le solde restant de Nino est constaté (« release »)');
  r = await api('POST', `${D}/contracts/${nino.id}/reopen`, 'cfo@x.com', { version: r.body.contract.version });
  ok(r.status === 200 && r.body.contract.closedMonth === null, 'contrat rouvert');

  // Réglages : types et comptes.
  r = await api('GET', `${D}?month=2026-09`, 'cfo@x.com');
  const st0 = r.body.settings;
  eq((await api('PUT', `${D}/settings`, 'cfo@x.com', { data: { ...st0.data, types: st0.data.types.filter((t) => t.key !== 'service') }, version: st0.version })).body.error, 'type_in_use', 'un type encore utilisé ne disparaît pas');
  eq((await api('PUT', `${D}/settings`, 'lecteur@x.com', { data: st0.data, version: st0.version })).status, 403, 'réglages : finance:edit exigée');
  r = await api('PUT', `${D}/settings`, 'cfo@x.com', { data: { ...st0.data, types: st0.data.types.map((t) => (t.key === 'service' ? { ...t, account: '4105' } : t)) }, version: st0.version });
  ok(r.status === 200 && r.body.settings.version === 1, 'réglages enregistrés (v1)');
  eq((await api('PUT', `${D}/settings`, 'cfo@x.com', { data: st0.data, version: 0 })).status, 409, 'réglages : concurrence optimiste');
  r = await api('GET', `${D}?month=2026-09`, 'cfo@x.com');
  ok(r.body.journal.lines.some((l) => l.code === '4105' && l.amount === 500), 'le compte du type « service » suit le réglage');
  const st1 = r.body.settings;
  await api('PUT', `${D}/settings`, 'cfo@x.com', { data: st0.data, version: st1.version });

  // ---------------------------------------------------------------- import Excel
  r = await api('GET', `${D}/template`, 'cfo@x.com');
  ok(r.status === 200 && r.ct.includes('spreadsheetml'), 'modèle Excel téléchargeable');
  const tpl = xlsx.read(r.body, { type: 'buffer' });
  ok(tpl.SheetNames.includes('Types') && String(xlsx.utils.sheet_to_json(tpl.Sheets.Contracts, { header: 1 })[0][0]).includes('Customer'), 'modèle : colonnes et liste des types');
  const head = xlsx.utils.sheet_to_json(tpl.Sheets.Contracts, { header: 1 })[0];
  const imp = book([head,
    ['Nouveau Client', 'Abonnement SaaS annuel', '2026-09', 12, '12 000,00', '2026-09-05', '', '', 'via Excel'],
    ['Mauvais Type', 'Hamburger', '2026-09', 12, 1000, '', '', '', ''],
    ['Sushi Kaito', 'subscription', '2026-09', 12, 21600, '', '', '', ''],
    ['Date Excel', 'service', new Date(2026, 9, 1), 6, 600, new Date(2026, 9, 1), '', 'CT-IMP-1', ''],
  ]);
  eq((await upload(`${D}/import/preview`, 'lecteur@x.com', imp)).status, 403, 'import : finance:edit exigée');
  eq((await upload(`${D}/import/preview`, 'cfo@x.com', book([['a', 'b'], [1, 2]]))).body.error, 'headers_not_found', 'import : en-têtes introuvables');
  const pv = await upload(`${D}/import/preview`, 'cfo@x.com', imp);
  ok(pv.status === 200 && pv.body.rows.length === 4 && pv.body.valid === 3 && pv.body.invalid === 1, 'aperçu : 3 lignes valides, 1 erreur');
  ok(pv.body.rows[0].body.type === 'subscription' && pv.body.rows[0].body.total === 12000, 'aperçu : libellé FR reconnu, « 12 000,00 » lu');
  ok(pv.body.rows[1].errors.includes('bad_type'), 'aperçu : type inconnu signalé');
  ok(pv.body.rows[2].warnings.includes('duplicate'), 'aperçu : doublon d\'un contrat existant signalé');
  ok(pv.body.rows[3].body.startMonth === '2026-10' && pv.body.rows[3].body.billedDate === '2026-10-01', 'aperçu : dates Excel lues');
  const before = (await api('GET', `${D}?month=2026-09`, 'cfo@x.com')).body.contracts.length;
  r = await api('POST', `${D}/import/confirm`, 'cfo@x.com', { rows: pv.body.rows.map((x) => x.body) });
  ok(r.status === 400 && r.body.error === 'invalid_rows' && r.body.rows[0].index === 1, 'confirmation : une ligne invalide → tout est refusé');
  eq((await api('GET', `${D}?month=2026-09`, 'cfo@x.com')).body.contracts.length, before, 'rien n\'a été écrit');
  r = await api('POST', `${D}/import/confirm`, 'cfo@x.com', { rows: [pv.body.rows[0].body, pv.body.rows[3].body] });
  ok(r.status === 200 && r.body.imported === 2, 'confirmation : 2 contrats importés');
  ok(r.body.contracts.some((c) => c.ref === 'CT-IMP-1') && r.body.contracts.some((c) => /^CT-2026-\d{4}$/.test(c.ref) && c.source === 'import'), 'référence fournie gardée, sinon générée');
  eq((await api('POST', `${D}/import/confirm`, 'cfo@x.com', { rows: [pv.body.rows[3].body] })).body.error, 'ref_taken', 'référence déjà prise : refusée');
  ok(logs.some((l) => l.ev === 'contracts_imported'), 'import au journal');
  const imported = r.body.contracts;
  // Retirer les deux importés pour garder les chiffres de la spec (aucune écriture passée).
  for (const c of imported) eq((await api('DELETE', `${D}/contracts/${c.id}?version=${c.version}`, 'cfo@x.com')).status, 200, `contrat importé supprimé : ${c.ref}`);

  // ---------------------------------------------------------------- comptes Books
  eq((await api('GET', '/api/finance/je/accounts', 'analyste@x.com')).status, 403, 'comptes Books : finance:post_je exigée');
  books.st.scope = false;
  r = await api('POST', '/api/finance/je/accounts/refresh', 'cfo@x.com');
  ok(r.status === 502 && r.body.error === 'books_scope_missing', 'plan comptable sans portée accountants.READ → « Zoho Books à reconnecter »');
  books.st.scope = true;
  r = await api('POST', '/api/finance/je/accounts/refresh', 'cfo@x.com');
  ok(r.status === 200 && r.body.accounts.length === 8, 'plan comptable lu (2 pages)');
  ok(r.body.suggestions['2400'] === '9001' && r.body.suggestions['6200'] === '9005', 'suggestions par code de compte');
  ok(r.body.needed.some((x) => x.code === '4000') && !r.body.needed.some((x) => x.code === ''), 'codes à associer (sans les comptes non configurés)');
  eq(Object.keys(r.body.map).length, 0, 'rien n\'est associé sans confirmation');
  eq((await api('PUT', '/api/finance/je/accounts/map', 'poster@x.com', { map: r.body.suggestions, version: 0 })).status, 403, 'associer : finance:edit exigée');
  eq((await api('PUT', '/api/finance/je/accounts/map', 'cfo@x.com', { map: { 2400: '0000' }, version: 0 })).body.error, 'unknown_account', 'compte Books inconnu refusé');
  r = await api('PUT', '/api/finance/je/accounts/map', 'cfo@x.com', { map: { 2400: '9001', 4000: '9002' }, version: 0 });
  ok(r.status === 200 && r.body.map['2400'].confirmedBy === 'cfo@x.com', 'association partielle confirmée');
  const mapV = r.body.version;

  // ---------------------------------------------------------------- écriture des revenus reportés
  let dj = (await api('GET', `${D}?month=2026-09`, 'poster@x.com')).body.journal;
  const post = (user, body) => api('POST', `${D}/je/post`, user, body);
  eq((await post('analyste@x.com', { month: '2026-09', hash: dj.hash })).status, 403, 'passer une écriture : finance:post_je exigée');
  r = await post('poster@x.com', { month: '2026-09', hash: dj.hash });
  ok(r.status === 409 && r.body.error === 'accounts_unmapped' && r.body.codes.includes('4100'), 'compte 4100 pas associé : refusé avant Books');
  await api('PUT', '/api/finance/je/accounts/map', 'cfo@x.com', { map: { 2400: '9001', 4000: '9002', 4100: '9003', 4150: '9004', 6200: '9005', 1590: '9006' }, version: mapV });
  eq((await post('poster@x.com', { month: '2026-09', hash: 'pas-la-bonne' })).body.error, 'changed', 'aperçu périmé → 409 « changed »');
  eq((await post('poster@x.com', { month: '2025-01', hash: 'x' })).body.error, 'nothing_to_post', 'mois sans constatation : rien à passer');
  eq(books.st.journals.length, 0, 'aucune écriture n\'a atteint Books jusqu\'ici');
  books.st.scope = false;
  r = await post('poster@x.com', { month: '2026-09', hash: dj.hash });
  ok(r.status === 502 && r.body.error === 'books_scope_missing' && r.body.post.status === 'failed', 'sans accountants.CREATE : « Zoho Books à reconnecter », envoi marqué échoué');
  ok(logs.some((l) => l.ev === 'je_failed' && l.t === 'finance_deferred'), 'échec au journal d\'activité');
  books.st.scope = true;
  books.st.fail401 = 1;
  const authBefore = authCalls;
  r = await post('poster@x.com', { month: '2026-09', hash: dj.hash });
  ok(r.status === 200 && r.body.post.status === 'posted' && r.body.post.booksJournalId === 'J1' && r.body.post.attempts === 2, 'reprise de l\'envoi échoué : passé (même ligne, 2e tentative)');
  ok(authCalls - authBefore === 2, '401 : jeton relu puis UNE nouvelle tentative');
  eq(books.st.journals.length, 1, 'Books : une seule écriture');
  const jb = books.st.journals[0].body;
  ok(jb.journal_date === '2026-09-30' && jb.reference_number === 'SH-DEF-2026-09', 'date = dernier jour du mois, référence SH-DEF-AAAA-MM');
  const dr = jb.line_items.filter((l) => l.debit_or_credit === 'debit').reduce((a, l) => a + Math.round(l.amount * 100), 0);
  const cr = jb.line_items.filter((l) => l.debit_or_credit === 'credit').reduce((a, l) => a + Math.round(l.amount * 100), 0);
  ok(dr === cr && dr === 1400000, 'Books : Dt = Ct = 14 000,00 $');
  ok(jb.line_items.find((l) => l.account_id === '9001').debit_or_credit === 'debit' && jb.line_items.find((l) => l.account_id === '9002').amount === 13500, 'Books : comptes associés (Dt 2400, Ct 4000 13 500 $)');
  r = await post('cfo@x.com', { month: '2026-09', hash: dj.hash });
  ok(r.status === 409 && r.body.error === 'already_posted' && r.body.post.booksEntryNumber === 'MJ-1', 'IDEMPOTENT : 2e écriture du même mois refusée');
  eq(books.st.journals.length, 1, 'Books : toujours une seule écriture');
  ok(logs.some((l) => l.ev === 'je_posted' && l.t === 'finance_deferred' && l.id === '2026-09'), 'écriture au journal d\'activité');
  // Un contrat ajouté après coup : l'écran le signale.
  const extra = (await add('cfo@x.com', { customer: 'Tardif', type: 'subscription', total: 1200, startMonth: '2026-09', termMonths: 12 })).body.contract;
  dj = (await api('GET', `${D}?month=2026-09`, 'poster@x.com')).body.journal;
  ok(dj.changedSincePost && dj.post.status === 'posted', 'contrat ajouté après l\'écriture : « changé depuis l\'envoi »');
  eq((await api('DELETE', `${D}/contracts/${extra.id}?version=${extra.version}`, 'cfo@x.com')).body.error, 'posted_periods', 'suppression refusée : une écriture passée couvre la période');
  // Marquer annulée, puis repasser.
  eq((await api('POST', `/api/finance/je/posts/${dj.post.id}/void`, 'poster@x.com', { reason: '' })).body.error, 'bad_reason', 'annulation : motif obligatoire');
  eq((await api('POST', `/api/finance/je/posts/${dj.post.id}/void`, 'analyste@x.com', { reason: 'Annulée dans Books' })).status, 403, 'annulation : finance:post_je exigée');
  r = await api('POST', `/api/finance/je/posts/${dj.post.id}/void`, 'poster@x.com', { reason: 'Annulée dans Books (contrat oublié)' });
  ok(r.status === 200 && r.body.post.status === 'voided', 'écriture marquée annulée');
  ok(logs.some((l) => l.ev === 'je_voided'), 'annulation au journal');
  r = await post('poster@x.com', { month: '2026-09', hash: dj.hash });
  ok(r.status === 200 && r.body.post.reference === 'SH-DEF-2026-09-R1' && books.st.journals.length === 2, 'après annulation : nouvelle écriture permise (référence -R1)');
  eq(books.st.journals[1].body.line_items.reduce((a, l) => a + (l.debit_or_credit === 'debit' ? l.amount : 0), 0), 14100, 'la nouvelle écriture inclut le contrat ajouté');
  r = await api('GET', '/api/finance/je/posts?module=deferred', 'lecteur@x.com');
  ok(r.status === 200 && r.body.posts.length === 2 && r.body.posts.some((p) => p.status === 'voided'), 'historique : l\'écriture annulée est gardée');

  // ---------------------------------------------------------------- amortissement
  const addLot = (user, b) => api('POST', `${A}/lots`, user, b);
  eq((await addLot('lecteur@x.com', { description: 'X', quantity: 1, unitCost: 1, inServiceMonth: '2026-01' })).status, 403, 'lots : finance:amortization exigée');
  eq((await addLot('cfo@x.com', { description: 'X', quantity: 0, unitCost: 1, inServiceMonth: '2026-01' })).body.error, 'bad_quantity', 'quantité ≥ 1');
  eq((await addLot('cfo@x.com', { description: 'X', quantity: 1, unitCost: 100, inServiceMonth: '2026-01', salvage: 500 })).body.error, 'salvage_above_cost', 'valeur résiduelle ≤ coût');
  const lots = [];
  for (const l of bench.lots) {
    const x = await addLot('analyste@x.com', { description: l.description, quantity: l.quantity, unitCost: l.unitCost, inServiceMonth: l.inServiceMonth });
    ok(x.status === 200 && x.body.lot.usefulLife === 36 && x.body.lot.salvage === 0, `lot ajouté (36 mois, résiduelle 0 par défaut) : ${x.body.lot && x.body.lot.ref}`);
    lots.push(x.body.lot);
  }
  const f1 = (await addLot('cfo@x.com', { description: 'PAX A920 Pro', quantity: 200, unitCost: 520, inServiceMonth: '2026-10' })).body.lot;
  const f2 = (await addLot('cfo@x.com', { description: 'PAX A920 Pro', quantity: 10, unitCost: 520, inServiceMonth: '2026-10' })).body.lot;
  ok(f1.ref === 'L-2026-10-01' && f2.ref === 'L-2026-10-02', 'deux lots du même mois : références distinctes (le prototype les confondait)');
  r = await api('GET', `${A}?month=2026-09`, 'cfo@x.com');
  near(r.body.summary.monthly, 28393.33, 'API : charge de septembre sans les lots d\'octobre', 0.011);
  eq(r.body.summary.notInService, 2, 'API : 2 lots pas encore en service');
  ok(r.body.lots.find((l) => l.id === f1.id).calc.thisMonth === 0, 'API : lot d\'octobre, 0 en septembre');
  let aj = r.body.journal;
  ok(aj.lines.length === 2 && !aj.unmapped.length, 'API : écriture 6200 / 1590 associée');
  r = await api('POST', `${A}/je/post`, 'cfo@x.com', { month: '2026-09', kind: 'amortization', hash: aj.hash });
  ok(r.status === 200 && r.body.post.reference === 'SH-AMO-2026-09', 'amortissement de septembre passé');
  // 429 : pause puis UNE nouvelle tentative.
  books.st.fail429 = 1;
  aj = (await api('GET', `${A}?month=2026-10`, 'cfo@x.com')).body.journal;
  r = await api('POST', `${A}/je/post`, 'cfo@x.com', { month: '2026-10', kind: 'amortization', hash: aj.hash });
  ok(r.status === 200 && books.st.fail429 === 0, '429 : pause puis nouvelle tentative réussie');
  const nj = books.st.journals.length;
  // Radiation.
  const pax80 = lots.find((l) => l.description === 'PAX A80');
  eq((await api('POST', `${A}/lots/${pax80.id}/write-off`, 'cfo@x.com', { month: '2026-11', reason: '', version: pax80.version })).body.error, 'bad_reason', 'radiation : motif obligatoire');
  r = await api('POST', `${A}/lots/${pax80.id}/write-off`, 'cfo@x.com', { month: '2026-11', reason: 'Terminaux volés', version: pax80.version });
  ok(r.status === 200 && r.body.lot.writtenOffMonth === '2026-11', 'lot radié en novembre');
  const woLot = r.body.lot;
  eq((await api('POST', `${A}/lots/${pax80.id}/write-off`, 'cfo@x.com', { month: '2026-12', reason: 'encore', version: woLot.version })).body.error, 'already_written_off', 'radier deux fois : refusé');
  r = await api('GET', `${A}?month=2026-11`, 'cfo@x.com');
  let wj = r.body.writeOffJournal;
  ok(wj.lines.length === 3 && wj.missingAccounts.length === 2, 'écriture de radiation : comptes perte et actif à configurer');
  eq((await api('POST', `${A}/je/post`, 'cfo@x.com', { month: '2026-11', kind: 'writeoff', hash: wj.hash })).body.error, 'accounts_missing', 'radiation sans comptes : refusée');
  const as0 = r.body.settings;
  r = await api('PUT', `${A}/settings`, 'cfo@x.com', { data: { ...as0.data, assetAccount: '1580', lossAccount: '6900' }, version: as0.version });
  ok(r.status === 200, 'comptes de radiation configurés');
  r = await api('GET', `${A}?month=2026-11`, 'cfo@x.com');
  wj = r.body.writeOffJournal;
  // NBV au début de novembre : 79 560 − 2 210 × 10 = 57 460.
  assert.deepStrictEqual(wj.lines.map((l) => [l.side, l.code, l.amount]), [['debit', '1590', 22100], ['debit', '6900', 57460], ['credit', '1580', 79560]], 'API : écriture de radiation'); n++;
  ok(wj.unmapped.includes('1580') && wj.unmapped.includes('6900'), 'comptes 1580 / 6900 pas encore associés');
  const mp = (await api('GET', '/api/finance/je/accounts', 'cfo@x.com')).body;
  ok(mp.needed.some((x) => x.code === '6900') && mp.suggestions['6900'] === '9008', 'les nouveaux codes apparaissent dans la correspondance');
  await api('PUT', '/api/finance/je/accounts/map', 'cfo@x.com', { map: { ...Object.fromEntries(Object.entries(mp.map).map(([k, v]) => [k, v.accountId])), 1580: '9007', 6900: '9008' }, version: mp.version });
  r = await api('POST', `${A}/je/post`, 'cfo@x.com', { month: '2026-11', kind: 'writeoff', hash: wj.hash });
  ok(r.status === 200 && r.body.post.reference === 'SH-WO-2026-11' && books.st.journals.length === nj + 1, 'radiation passée dans Books');
  eq((await api('POST', `${A}/je/post`, 'cfo@x.com', { month: '2026-11', kind: 'writeoff', hash: wj.hash })).body.error, 'already_posted', 'radiation : idempotente');
  eq((await api('POST', `${A}/lots/${pax80.id}/restore`, 'cfo@x.com', { version: woLot.version })).body.error, 'writeoff_posted', 'annuler une radiation déjà passée : refusé');
  r = await api('GET', `${A}?month=2026-11`, 'cfo@x.com');
  near(r.body.summary.monthly, 28393.33 - 2210 + 2888.89 + 144.44, 'novembre : sans le lot radié, avec les lots d\'octobre', 0.03);
  eq((await api('DELETE', `${A}/lots/${lots[0].id}?version=${lots[0].version}`, 'cfo@x.com')).body.error, 'posted_periods', 'supprimer un lot déjà amorti dans Books : refusé');
  eq((await api('DELETE', `${A}/lots/${f2.id}?version=${f2.version + 5}`, 'cfo@x.com')).status, 409, 'suppression : version exigée');

  // Import / export des lots.
  r = await api('GET', `${A}/template`, 'cfo@x.com');
  const lh = xlsx.utils.sheet_to_json(xlsx.read(r.body, { type: 'buffer' }).Sheets.Lots, { header: 1 })[0];
  const lp = await upload(`${A}/import/preview`, 'cfo@x.com', book([lh, ['Clover Mini', 50, '399,99', '2027-01', '', '', '', ''], ['Sans quantité', '', 100, '2027-01', 36, 0, '', '']]));
  ok(lp.status === 200 && lp.body.valid === 1 && lp.body.rows[1].errors.includes('bad_quantity') && lp.body.rows[0].body.usefulLife === 36, 'lots : aperçu (vie par défaut, quantité manquante signalée)');
  r = await api('POST', `${A}/import/confirm`, 'cfo@x.com', { rows: [lp.body.rows[0].body] });
  ok(r.status === 200 && r.body.lots[0].ref === 'L-2027-01-01' && r.body.lots[0].unitCost === 399.99, 'lots : import confirmé');
  r = await api('GET', `${A}/export?month=2026-11`, 'cfo@x.com');
  const ex = xlsx.utils.sheet_to_json(xlsx.read(r.body, { type: 'buffer' }).Sheets['Lots 2026-11'], { header: 1 });
  ok(r.status === 200 && ex.length === 1 + 8, 'export Excel des lots (8 lots)');
  r = await api('GET', `${D}/export?month=2026-09`, 'lecteur@x.com');
  ok(r.status === 200 && r.ct.includes('spreadsheetml'), 'export Excel des contrats');

  // Aucune donnée nominative dans les descriptions envoyées à Books.
  ok(books.st.journals.every((j) => j.body.line_items.every((l) => !/Lafleur|Kaito|Nino/.test(l.description))), 'aucun nom de client dans les lignes Books');
  ok(books.st.journals.every((j) => /^Zoho-oauthtoken tok\d+$/.test(j.auth)), 'jeton admin transmis');

  server.close();
  books.server.close();
  console.log(`✅ finance managers : ${n} vérifications`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
