// Module Finance, phase 2 — import Excel du budget CONSOLIDÉ (effectif + OPEX), de bout en bout
// contre une vraie base Postgres en mémoire (PGlite) et un vrai serveur HTTP :
//   - les lecteurs reproduisent les fichiers de passation du design (payroll_data.js, opex_data.js),
//     extraits des MÊMES classeurs : l'oracle ;
//   - aperçu des vrais classeurs contre le budget importé : 0 ajout / 0 modification / 0 absent ;
//   - classeur modifié (salaire changé, personne ajoutée, personne retirée…) : diff EXACT et application ;
//   - verrou d'approbation, permissions, mode démo, jeton périmé / réutilisé / d'un autre usager, base
//     périmée, tout-ou-rien, modèles relus à l'identique, lignes OPEX sans clé signalées.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/consolidatedImport.test.js [dossier design/finance]
// ⚠️ Échoue si le dossier de passation ou un classeur manque, plutôt que de se déclarer vert.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const express = require('express');
const xlsx = require('xlsx');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerFinanceRoutes } = require('../routes');
const { importHandoff } = require('../import');
const { PROTO } = require('../handoff');
const { computePayroll } = require('../payroll');
const X = require('../consolidatedXlsx');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
const PAYROLL_XLSX = path.join(DIR, 'source_excel', 'salary & contractors.xlsx');
const OPEX_XLSX = path.join(DIR, 'source_excel', 'Book4.xlsx');
for (const f of [path.join(DIR, PROTO), PAYROLL_XLSX, OPEX_XLSX]) if (!fs.existsSync(f)) { console.error(`ÉCHEC : introuvable : ${f}`); process.exit(1); }

const readBook = (buf) => xlsx.read(buf, { type: 'buffer', cellDates: true });
const writeBook = (wb) => xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
const setCell = (ws, addr, v) => {
  if (v === undefined) delete ws[addr];
  else ws[addr] = typeof v === 'number' ? { t: 'n', v } : v instanceof Date ? { t: 'd', v } : { t: 's', v };
  const rg = xlsx.utils.decode_range(ws['!ref']);
  const c = xlsx.utils.decode_cell(addr);
  rg.e.r = Math.max(rg.e.r, c.r); rg.e.c = Math.max(rg.e.c, c.c);
  ws['!ref'] = xlsx.utils.encode_range(rg);
};
const clearRow = (ws, row, cols = 'ABCDEFGHIJKLMN') => { for (const c of cols) delete ws[`${c}${row}`]; };

(async () => {
  let n = 0; const ok = (c, m) => { assert(c, m); n++; };
  const near = (a, b, m, eps = 0.005) => ok(Number.isFinite(a) && Math.abs(a - b) < eps, `${m} : ${a} ≠ ${b}`);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const codes = (list) => list.map((x) => x.code).sort().join(',');

  // ---------------------------------------------------------------- 1. oracle : les lecteurs
  const ctx = { window: {} };
  vm.createContext(ctx);
  for (const f of ['payroll_data.js', 'opex_data.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f });
  const W = ctx.window;
  ok(W.PAYROLL.employees.length === 73 && W.PAYROLL.contractors.length === 28, 'oracle : 73 employés, 28 contractuels (données bien chargées)');
  ok(W.OPEX.filter((i) => i.t === 'line').length === 42 && W.OPEX.every((i) => i.t !== 'line' || i.v.length === 36), 'oracle : 42 lignes OPEX de 36 mois');

  const PAY = fs.readFileSync(PAYROLL_XLSX), OPX = fs.readFileSync(OPEX_XLSX);
  const R = X.parseRoster(PAY);
  ok(R.errors.length === 0 && R.warnings.length === 0, `classeur de paie lu sans erreur ni avertissement (${JSON.stringify(R.errors.concat(R.warnings).slice(0, 3))})`);
  ok(R.employees.length === 73 && R.contractors.length === 28 && R.sheets.employees === 'Payroll' && R.sheets.contractors === 'Contractors', 'classeur de paie : 73 + 28 personnes, feuilles Payroll / Contractors');
  W.PAYROLL.employees.forEach((e, i) => { for (const k of ['ent', 'dept', 'name', 'salary', 'alloc', 'map']) ok(R.employees[i][k] === e[k], `employé ${i} ${k} : ${R.employees[i][k]} ≠ ${e[k]}`); });
  W.PAYROLL.contractors.forEach((c, i) => { for (const k of ['co', 'name', 'svc', 'rate', 'hours', 'amt', 'map', 'dept']) ok(R.contractors[i][k] === c[k], `contractuel ${i} ${k} : ${R.contractors[i][k]} ≠ ${c[k]}`); });

  const O = X.parseOpex(OPX);
  ok(O.errors.length === 0 && O.warnings.length === 0 && O.sheet === 'OPEX', `classeur OPEX lu sans erreur (${JSON.stringify(O.errors.concat(O.warnings).slice(0, 3))})`);
  let sec = null, lines = 0;
  for (const it of W.OPEX) {
    if (it.t === 'sec') { sec = X.sectionKey(it.name); continue; }
    if (it.t !== 'line') continue;
    const row = O.rows.find((r) => r.section === sec && r.norm === X.norm(it.name));
    ok(row && row.v.length === 36, `OPEX : « ${it.name} » trouvée dans le classeur`);
    ok(row.v.every((v, i) => Math.abs(v - it.v[i]) < 1e-9), `OPEX : « ${it.name} » — 36 mois identiques à l'oracle`);
    lines++;
  }
  ok(lines === 42, 'OPEX : les 42 lignes de l\'oracle comparées');
  // Lecture robuste : les nombres écrits en texte, les pourcentages, les négatifs.
  ok(X.toNum('$1,234.50') === 1234.5 && X.toNum('(1 000)') === -1000 && X.toNum('40%', true) === 0.4 && Number.isNaN(X.toNum('abc')) && X.toNum('') === null, 'toNum : texte monétaire, négatif en parenthèses, pourcentage, illisible, vide');

  // ---------------------------------------------------------------- 2. serveur
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
  `);
  const FULL = ['finance:view', 'finance:edit', 'finance:payroll', 'finance:approve'];
  const perms = {
    'cfo@x.com': FULL, 'cfo2@x.com': FULL, 'fail@x.com': FULL, 'spam@x.com': FULL,
    'analyste@x.com': ['finance:view', 'finance:edit'],
    'rh@x.com': ['finance:view', 'finance:payroll'],
    'lecteur@x.com': ['finance:view'],
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
  const upload = async (p, user, buf, filename = 'book.xlsx', extra = {}) => {
    const fd = new FormData();
    if (buf) fd.append('file', new Blob([buf]), filename);
    const r = await fetch(base + p, { method: 'POST', headers: { ...(user ? { 'x-test-user': user } : {}), ...extra }, body: fd });
    return { status: r.status, body: await r.json() };
  };
  const RP = '/api/finance/consolidated/roster', OP = '/api/finance/consolidated/opex';
  const rosterPrev = (buf, user = 'cfo@x.com', name) => upload(`${RP}/preview`, user, buf, name);
  const opexPrev = (buf, user = 'cfo@x.com', name) => upload(`${OP}/preview`, user, buf, name);
  const confirm = (kind, user, pv, extra = {}) => api('POST', `${kind === 'roster' ? RP : OP}/confirm`, user, { token: pv.token, base: pv.base, ...extra });
  const getBudget = async () => (await api('GET', '/api/finance/budget', 'cfo@x.com')).body;

  // Avant l'import du paquet : pas de budget → 404.
  ok((await rosterPrev(PAY)).body.error === 'no_budget', 'sans budget consolidé : 404 no_budget');
  const imp = await importHandoff(pool, DIR, { apply: true, actor: 'test' });
  ok(imp.action === 'create', 'paquet de passation importé');
  let B = await getBudget();
  const bid = B.budget.id;
  ok(B.roster.employees.length === 73 && B.roster.contractors.length === 28, 'budget : 73 + 28 personnes');
  const idsBefore = new Map(B.roster.employees.map((e) => [`${e.dept}|${e.name}`, e.id]));
  const refBefore = JSON.parse(JSON.stringify(B.reference));

  // ---------------------------------------------------------------- 3. permissions, garde, fichier
  ok((await rosterPrev(PAY, 'analyste@x.com')).status === 403, 'effectif sans finance:payroll : 403');
  ok((await rosterPrev(PAY, 'rh@x.com')).status === 403, 'effectif sans finance:edit : 403');
  ok((await rosterPrev(PAY, 'lecteur@x.com')).status === 403, 'lecteur : 403');
  ok((await api('GET', `${RP}/template`, 'analyste@x.com')).status === 403, 'modèle d\'effectif sans finance:payroll : 403');
  ok((await opexPrev(OPX, 'lecteur@x.com')).status === 403, 'OPEX sans finance:edit : 403');
  ok((await api('GET', `${OP}/template`, 'lecteur@x.com')).status === 403, 'modèle OPEX sans finance:edit : 403');
  ok((await rosterPrev(PAY, 'cfo@x.com', 'x.xlsx')).status === 200 && (await upload(`${RP}/preview`, 'cfo@x.com', PAY, 'x.xlsx', { 'x-test-demo': '1' })).status === 403, 'mode démo : bloqué');
  ok((await upload(`${RP}/preview`, null, PAY)).status === 401, 'sans jeton d\'authentification : 401');
  ok((await upload(`${RP}/preview`, 'cfo@x.com', null)).body.error === 'no_file', 'sans fichier : no_file');
  ok((await rosterPrev(PAY, 'cfo@x.com', 'budget.csv')).body.error === 'not_xlsx', 'extension .csv : not_xlsx');
  ok((await rosterPrev(Buffer.from('ceci n\'est pas un classeur'), 'cfo@x.com')).body.error === 'not_xlsx', 'faux .xlsx (texte) : not_xlsx');
  ok((await rosterPrev(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 7)]), 'cfo@x.com')).body.error === 'unreadable', 'zip corrompu : unreadable');
  ok((await opexPrev(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(11 * 1024 * 1024, 1)]))).body.error === 'file_too_large', 'plus de 10 Mo : file_too_large');
  // Un classeur sans les tables attendues : 400 invalid_workbook (et non un aperçu vide).
  const blank = xlsx.utils.book_new(); xlsx.utils.book_append_sheet(blank, xlsx.utils.aoa_to_sheet([['rien'], [1, 2]]), 'Autre');
  let r = await rosterPrev(writeBook(blank));
  ok(r.status === 400 && r.body.error === 'invalid_workbook' && r.body.errors[0].code === 'no_roster_tables', 'classeur sans tables d\'effectif : invalid_workbook');
  r = await opexPrev(writeBook(blank));
  ok(r.status === 400 && r.body.error === 'invalid_workbook' && r.body.errors[0].code === 'no_opex_table', 'classeur sans table OPEX : invalid_workbook');
  ok((await api('POST', `${RP}/confirm`, 'cfo@x.com', { token: 'inconnu', base: 'x' })).status === 410, 'jeton inconnu : 410 token_expired');

  // ---------------------------------------------------------------- 4. effectif : vrai classeur = 0 écart
  r = await rosterPrev(PAY);
  let pv = r.body.preview;
  ok(r.status === 200 && pv.canConfirm && pv.token && pv.errors.length === 0 && pv.warnings.length === 0, 'aperçu du vrai classeur : confirmable, sans erreur ni avertissement');
  ok(pv.employees.added.length === 0 && pv.employees.changed.length === 0 && pv.employees.missing.length === 0 && pv.employees.unchanged === 73, 'employés : 0 ajouté / 0 modifié / 0 absent / 73 inchangés');
  ok(pv.contractors.added.length === 0 && pv.contractors.changed.length === 0 && pv.contractors.missing.length === 0 && pv.contractors.unchanged === 28, 'contractuels : 0 ajouté / 0 modifié / 0 absent / 28 inchangés');
  ok(pv.totals.before.headcount === 73 && pv.totals.before.contractorCount === 28 && JSON.stringify(pv.totals.before) === JSON.stringify(pv.totals.after) && JSON.stringify(pv.totals.before) === JSON.stringify(pv.totals.afterRemoveMissing), 'totaux avant = après');
  // Totaux : comparés à computePayroll appliqué au paquet lui-même.
  const g0 = B.payrollGlobals;
  const expect0 = computePayroll(B.roster.employees, B.roster.contractors, g0);
  near(pv.totals.before.payroll, sum(expect0.emp.map((e) => sum(e.m))), 'totaux : paie avant (= computePayroll)', 0.01);
  near(pv.totals.before.contractors, sum(expect0.con.map((c) => sum(c.m))), 'totaux : contractuels avant', 0.01);
  near(pv.totals.before.total, pv.totals.before.payroll + pv.totals.before.contractors, 'totaux : somme', 0.01);
  // L'aperçu n'a rien écrit.
  ok(JSON.stringify((await getBudget()).roster) === JSON.stringify(B.roster), 'aperçu : rien écrit');
  const countLogs = () => logs.filter((l) => l.ev === 'roster_imported').length;
  ok(countLogs() === 0, 'aperçu : rien au journal');
  // Confirmer un fichier sans écart est permis (met salary_base à jour) et ne bouge personne.
  r = await confirm('roster', 'cfo@x.com', pv);
  ok(r.status === 200 && JSON.stringify(r.body.applied) === JSON.stringify({ employees: { added: 0, changed: 0, removed: 0 }, contractors: { added: 0, changed: 0, removed: 0 } }), 'confirmation sans écart : rien d\'appliqué');
  ok((await confirm('roster', 'cfo@x.com', pv)).status === 410, 'jeton déjà utilisé : 410');
  ok(countLogs() === 1 && logs.at(-1).t === 'finance_budget' && logs.at(-1).id === String(bid), 'journal : roster_imported sur finance_budget');

  // ---------------------------------------------------------------- 5. effectif : classeur modifié
  // Surcharges propres à une personne, à conserver : hausse + charges + mois d'arrivée / de départ.
  const david = B.roster.employees.find((e) => e.name === 'David Lafleur');
  const jean = B.roster.employees.find((e) => e.name === 'Jean Abraham Chéry');
  const sachin = B.roster.contractors.find((c) => c.name === 'Sachin');
  const erdrich = B.roster.contractors.find((c) => c.name === 'Erdrich Mambeke');
  const sumner = B.roster.employees.find((e) => e.name === 'Spicer Amy');
  ok((await api('PATCH', `/api/finance/budgets/${bid}/employees/${david.id}`, 'cfo@x.com', { raisePct: 5, raiseMo: 3, burdenPct: 20, startMo: 1, endMo: 10 })).status === 200, 'surcharges posées sur David');
  ok((await api('PATCH', `/api/finance/budgets/${bid}/employees/${sumner.id}`, 'cfo@x.com', { salary: 99999 })).status === 200, 'salaire de Spicer modifié dans l\'app (≠ fichier)');

  const wb = readBook(PAY);
  const P = wb.Sheets.Payroll, C = wb.Sheets.Contractors;
  const rowOf = (ws, name, col) => { for (let i = 1; i < 200; i++) if (ws[`${col}${i}`] && ws[`${col}${i}`].v === name) return i; throw new Error(`ligne introuvable : ${name}`); };
  const rDavid = rowOf(P, 'David Lafleur', 'C'), rJean = rowOf(P, 'Jean Abraham Chéry', 'C'), rAmy = rowOf(P, 'Spicer Amy', 'C'), rIT = rowOf(P, 'Atem Lucas', 'C');
  setCell(P, `D${rDavid}`, 210000);                 // salaire changé
  setCell(P, `E${rIT}`, 0.5);                       // allocation changée
  setCell(P, `F${rIT}`, 'R&D');                     // mappe changée
  clearRow(P, rJean);                               // personne retirée
  setCell(P, 'A89', 'Xperio'); setCell(P, 'B89', 'sales'); setCell(P, 'C89', 'Nouvelle Recrue'); setCell(P, 'D89', 60000); setCell(P, 'E89', 1); setCell(P, 'F89', 's&m'); // ajoutée (casse tolérée)
  const rErd = rowOf(C, 'Erdrich Mambeke', 'B'), rSach = rowOf(C, 'Sachin', 'B');
  setCell(C, `I${rErd}`, 6000); setCell(C, `D${rErd}`, 20);  // montant et taux changés
  clearRow(C, rSach);                                         // contractuel retiré
  setCell(C, 'A47', 'Nouveau Studio'); setCell(C, 'B47', 'Jane Nouvelle'); setCell(C, 'C47', 'Development'); setCell(C, 'D47', 40); setCell(C, 'E47', 100); setCell(C, 'H47', 'R&D'); setCell(C, 'I47', 4000);
  const MOD = writeBook(wb);

  r = await rosterPrev(MOD);
  pv = r.body.preview;
  ok(r.status === 200 && pv.canConfirm && pv.errors.length === 0, 'aperçu du classeur modifié : confirmable');
  const eAdded = pv.employees.added, eCh = pv.employees.changed, eMiss = pv.employees.missing;
  ok(eAdded.length === 1 && eAdded[0].name === 'Nouvelle Recrue' && eAdded[0].ent === 'Xperio' && eAdded[0].dept === 'SALES' && eAdded[0].map === 'S&M' && eAdded[0].salary === 60000, 'employés : 1 ajouté (casse normalisée : SALES, S&M)');
  ok(eMiss.length === 1 && eMiss[0].name === 'Jean Abraham Chéry' && eMiss[0].id === jean.id, 'employés : 1 absent du fichier (Jean), identifiant donné');
  ok(eCh.length === 3, `employés : 3 modifiés (David, Atem, Spicer) — a ${eCh.map((x) => x.name)}`);
  const chOf = (list, name) => list.find((x) => x.name === name).changes.map((c) => `${c.field}:${c.before}>${c.after}`).sort().join('|');
  ok(chOf(eCh, 'David Lafleur') === 'salary:200000>210000', `David : ${chOf(eCh, 'David Lafleur')}`);
  ok(chOf(eCh, 'Atem Lucas') === 'alloc:0.25>0.5|map:G&A>R&D', `Atem : ${chOf(eCh, 'Atem Lucas')}`);
  ok(chOf(eCh, 'Spicer Amy') === 'salary:99999>85000', `Spicer (modifié dans l'app) : ${chOf(eCh, 'Spicer Amy')}`);
  ok(pv.employees.unchanged === 73 - 1 - 3, 'employés : 69 inchangés');
  const cAdded = pv.contractors.added, cCh = pv.contractors.changed, cMiss = pv.contractors.missing;
  ok(cAdded.length === 1 && cAdded[0].co === 'Nouveau Studio' && cAdded[0].amt === 4000 && cAdded[0].dept === 'DEVELOPMENT', 'contractuels : 1 ajouté (département déduit de la mappe)');
  ok(cMiss.length === 1 && cMiss[0].name === 'Sachin' && cMiss[0].id === sachin.id, 'contractuels : 1 absent (Sachin)');
  ok(cCh.length === 1 && cCh[0].name === 'Erdrich Mambeke' && cCh[0].changes.map((c) => `${c.field}:${c.before}>${c.after}`).sort().join('|') === 'amt:5576>6000|rate:16>20', 'contractuels : Erdrich — montant et taux');
  ok(pv.contractors.unchanged === 28 - 1 - 1, 'contractuels : 26 inchangés');
  // Totaux attendus, calculés indépendamment avec computePayroll sur l'effectif attendu.
  const Bnow = await getBudget(); // avec les surcharges et le salaire de Spicer posés plus haut
  const exp = (removeMissing) => {
    const E = Bnow.roster.employees.map((e) => ({ ...e }));
    const Cn = Bnow.roster.contractors.map((c) => ({ ...c }));
    const e1 = (name) => E.find((e) => e.name === name);
    e1('David Lafleur').salary = 210000; e1('Atem Lucas').alloc = 0.5; e1('Atem Lucas').map = 'R&D'; e1('Spicer Amy').salary = 85000;
    E.push({ id: 0, ent: 'Xperio', dept: 'SALES', name: 'Nouvelle Recrue', salary: 60000, alloc: 1, map: 'S&M', raisePct: null, raiseMo: null, burdenPct: null, startMo: 0, endMo: null });
    Cn.find((c) => c.name === 'Erdrich Mambeke').amt = 6000;
    Cn.push({ id: 0, co: 'Nouveau Studio', name: 'Jane Nouvelle', svc: 'Development', rate: 40, hours: 100, amt: 4000, map: 'R&D', dept: 'DEVELOPMENT', startMo: 0, endMo: null });
    const E2 = removeMissing ? E.filter((e) => e.name !== 'Jean Abraham Chéry') : E;
    const C2 = removeMissing ? Cn.filter((c) => c.name !== 'Sachin') : Cn;
    const p = computePayroll(E2, C2, g0);
    return { headcount: E2.length, contractorCount: C2.length, payroll: sum(p.emp.map((e) => sum(e.m))), contractors: sum(p.con.map((c) => sum(c.m))) };
  };
  for (const [key, rm] of [['after', false], ['afterRemoveMissing', true]]) {
    const e = exp(rm), t = pv.totals[key];
    ok(t.headcount === e.headcount && t.contractorCount === e.contractorCount, `totaux ${key} : effectifs ${e.headcount}/${e.contractorCount}`);
    near(t.payroll, e.payroll, `totaux ${key} : paie`, 0.01);
    near(t.contractors, e.contractors, `totaux ${key} : contractuels`, 0.01);
  }
  ok(pv.totals.after.payroll !== pv.totals.before.payroll, 'totaux : la paie change');

  // Base périmée : quelqu'un modifie l'effectif entre l'aperçu et la confirmation → 409 conflict, RIEN d'écrit.
  ok((await api('PATCH', `/api/finance/budgets/${bid}/employees/${jean.id}`, 'cfo2@x.com', { salary: 75001 })).status === 200, 'un autre usager modifie Jean');
  r = await confirm('roster', 'cfo@x.com', pv);
  ok(r.status === 409 && r.body.error === 'conflict', 'base périmée : 409 conflict');
  ok((await getBudget()).roster.employees.length === 73 && (await getBudget()).roster.employees.find((e) => e.id === david.id).salary === 200000, 'conflit : rien d\'écrit');
  ok((await api('PATCH', `/api/finance/budgets/${bid}/employees/${jean.id}`, 'cfo2@x.com', { salary: jean.salary })).status === 200, 'Jean remis');

  // Nouvel aperçu ; jeton d'un AUTRE usager refusé ; verrou refusé ; puis application.
  r = await rosterPrev(MOD); pv = r.body.preview;
  ok(pv.employees.changed.length === 3, 'nouvel aperçu : 3 modifiés');
  ok((await confirm('roster', 'cfo2@x.com', pv)).status === 403 && (await confirm('roster', 'cfo2@x.com', pv)).body.error === 'token_forbidden', 'jeton d\'un autre usager : 403 token_forbidden');
  ok((await confirm('roster', 'analyste@x.com', pv)).status === 403, 'confirmation sans finance:payroll : 403');
  ok((await api('POST', `/api/finance/budgets/${bid}/approve`, 'cfo@x.com')).status === 200, 'budget approuvé');
  r = await confirm('roster', 'cfo@x.com', pv);
  ok(r.status === 409 && r.body.error === 'locked', 'budget approuvé : confirmation refusée (409 locked)');
  r = await rosterPrev(MOD);
  ok(r.status === 409 && r.body.error === 'locked' && r.body.approvedBy === 'cfo@x.com', 'budget approuvé : aperçu refusé (409 locked)');
  ok((await api('GET', `${RP}/template`, 'cfo@x.com')).status === 409, 'budget approuvé : modèle refusé aussi');
  ok((await api('POST', `/api/finance/budgets/${bid}/unlock`, 'cfo@x.com')).status === 200, 'budget déverrouillé');
  // Le jeton survit au verrou : on l'applique.
  r = await confirm('roster', 'cfo@x.com', pv);
  ok(r.status === 200, `confirmation (removeMissing = faux) : ${JSON.stringify(r.body)}`);
  ok(JSON.stringify(r.body.applied) === JSON.stringify({ employees: { added: 1, changed: 3, removed: 0 }, contractors: { added: 1, changed: 1, removed: 0 } }), `appliqué : ${JSON.stringify(r.body.applied)}`);
  B = await getBudget();
  const EM = new Map(B.roster.employees.map((e) => [e.name, e]));
  ok(B.roster.employees.length === 74 && B.roster.contractors.length === 29, 'effectif : 74 + 29 (personnes absentes NON supprimées)');
  ok(EM.has('Jean Abraham Chéry') && B.roster.contractors.some((c) => c.name === 'Sachin'), 'les absents du fichier sont gardés');
  const dv = EM.get('David Lafleur');
  ok(dv.id === david.id && dv.salary === 210000 && dv.salaryBase === 210000, 'David : même id, salaire et salaire de base mis à jour');
  ok(dv.raisePct === 5 && dv.raiseMo === 3 && dv.burdenPct === 20 && dv.startMo === 1 && dv.endMo === 10, 'David : surcharges et mois d\'arrivée / de départ conservés');
  const am = EM.get('Spicer Amy');
  ok(am.salary === 85000 && am.salaryBase === 85000, 'Spicer : l\'ajustement local est remplacé par le fichier');
  ok(EM.get('Atem Lucas').alloc === 0.5 && EM.get('Atem Lucas').map === 'R&D', 'Atem : allocation et mappe');
  const nr = EM.get('Nouvelle Recrue');
  ok(nr && nr.salary === 60000 && nr.salaryBase === 60000 && nr.ent === 'Xperio' && nr.dept === 'SALES' && nr.startMo === 0 && nr.endMo === null && nr.raisePct === null, 'nouvelle recrue : créée avec salary_base');
  for (const e of B.roster.employees) if (idsBefore.has(`${e.dept}|${e.name}`)) ok(idsBefore.get(`${e.dept}|${e.name}`) === e.id, `identifiant gardé : ${e.name}`);
  const er = B.roster.contractors.find((c) => c.name === 'Erdrich Mambeke');
  ok(er.id === erdrich.id && er.amt === 6000 && er.amtBase === 6000 && er.rate === 20, 'Erdrich : montant, montant de base, taux');
  const ns = B.roster.contractors.find((c) => c.name === 'Jane Nouvelle');
  ok(ns && ns.amt === 4000 && ns.amtBase === 4000 && ns.rate === 40 && ns.hours === 100 && ns.map === 'R&D' && ns.dept === 'DEVELOPMENT', 'nouveau contractuel créé');
  const lastLog = logs.at(-1);
  ok(lastLog.ev === 'roster_imported' && lastLog.extra.metadata.applied.employees.added === 1 && lastLog.actor === 'cfo@x.com', 'journal : application détaillée');
  // « Réinitialiser la paie » revient à l'import (salary_base) : David = 210000, plus de surcharge.
  r = await api('POST', `/api/finance/budgets/${bid}/payroll/reset`, 'cfo@x.com');
  ok(r.status === 200 && r.body.roster.employees.find((e) => e.id === david.id).salary === 210000 && r.body.roster.employees.find((e) => e.id === david.id).raisePct === null, 'réinitialiser la paie : revient au nouvel import');

  // Re-aperçu du même fichier : l'effectif a rattrapé le fichier, restent les 2 absents ; removeMissing → supprimés.
  r = await rosterPrev(MOD); pv = r.body.preview;
  ok(pv.employees.added.length === 0 && pv.employees.changed.length === 0 && pv.employees.missing.length === 1 && pv.contractors.added.length === 0 && pv.contractors.changed.length === 0 && pv.contractors.missing.length === 1, 'idempotent : seuls les 2 absents restent');
  r = await confirm('roster', 'cfo@x.com', pv, { removeMissing: true });
  ok(r.status === 200 && r.body.applied.employees.removed === 1 && r.body.applied.contractors.removed === 1, 'removeMissing : 1 employé et 1 contractuel retirés');
  B = await getBudget();
  ok(B.roster.employees.length === 73 && !B.roster.employees.some((e) => e.name === 'Jean Abraham Chéry') && B.roster.contractors.length === 28 && !B.roster.contractors.some((c) => c.name === 'Sachin'), 'effectif après retrait : 73 + 28, absents partis');
  const sortList = B.roster.employees.map((e) => e.id);
  ok(B.roster.employees.at(-1).name === 'Nouvelle Recrue', 'la personne ajoutée est à la fin de la liste');

  // ---------------------------------------------------------------- 6. effectif : validation du contenu
  const bad = readBook(PAY);
  const BP = bad.Sheets.Payroll, BC = bad.Sheets.Contractors;
  setCell(BP, `F${rDavid}`, 'Marketing');            // mappe inconnue
  setCell(BP, `E${rowOf(BP, 'Cohen Jordan', 'C')}`, 1.7);   // allocation hors plage
  setCell(BP, `D${rowOf(BP, 'Regan Evan', 'C')}`, -5);       // salaire négatif
  setCell(BP, `A${rowOf(BP, 'Eric Savard', 'C')}`, 'Mars');  // entité inconnue
  BP[`D${rowOf(BP, 'Josh Wong', 'C')}`] = { t: 'n', f: '1+1' }; // formule sans valeur enregistrée
  setCell(BP, 'A89', 'Cluster'); setCell(BP, 'B89', 'ACCOUNTING'); setCell(BP, 'C89', 'le-goff,  JAMES'); setCell(BP, 'D89', 62000); setCell(BP, 'E89', 1); setCell(BP, 'F89', 'G&A'); // doublon (nom normalisé)
  setCell(BC, `H${rowOf(BC, 'Ghita Boula', 'B')}`, 'Inconnue');
  r = await rosterPrev(writeBook(bad));
  pv = r.body.preview;
  ok(r.status === 200 && pv.canConfirm === false && pv.token === null, 'avec erreurs : aperçu rendu mais NON confirmable, aucun jeton');
  const ec = pv.errors.map((e) => `${e.sheet}:${e.code}`).sort().join(',');
  ok(ec === 'Contractors:unknown_map,Payroll:bad_alloc,Payroll:bad_ent,Payroll:bad_salary,Payroll:bad_salary,Payroll:unknown_map', `erreurs détectées : ${ec}`);
  ok(pv.errors.every((e) => e.row > 15), 'erreurs : numéro de ligne Excel donné');
  ok(/^(cell_error|no_cached_value),duplicate_name$|^duplicate_name,(cell_error|no_cached_value)$/.test(codes(pv.warnings)), `avertissements : ${codes(pv.warnings)}`); // SheetJS relit une formule sans valeur comme cellule en erreur ou sans valeur enregistrée
  ok((await api('POST', `${RP}/confirm`, 'cfo@x.com', { token: null, base: pv.base })).status === 410, 'confirmer sans jeton : 410');

  // Classeur sans feuille de contractuels : comparés = faux, aucun « absent » inventé.
  const noC = readBook(PAY); delete noC.Sheets.Contractors; noC.SheetNames = noC.SheetNames.filter((s) => s !== 'Contractors');
  r = await rosterPrev(writeBook(noC)); pv = r.body.preview;
  ok(pv.contractors.compared === false && pv.contractors.missing.length === 0 && pv.employees.compared === true && codes(pv.warnings) === 'no_contractor_table' && pv.canConfirm, 'sans feuille Contractors : contractuels non comparés, avertissement');
  const before28 = B.roster.contractors.length;
  r = await confirm('roster', 'cfo@x.com', pv, { removeMissing: true });
  ok(r.status === 200 && (await getBudget()).roster.contractors.length === before28, 'sans feuille Contractors + removeMissing : aucun contractuel supprimé');

  // Changement de département d'une personne = déplacement (même id), pas une sortie + une arrivée.
  const mv = readBook(PAY);
  setCell(mv.Sheets.Payroll, `B${rowOf(mv.Sheets.Payroll, 'Maria Julian', 'C')}`, 'ACCOUNTING');
  r = await rosterPrev(writeBook(mv)); pv = r.body.preview;
  const mj = pv.employees.changed.find((x) => x.name === 'Maria Julian');
  ok(mj && mj.changes.map((c) => c.field).join() === 'dept' && mj.changes[0].before === 'OPERATIONS' && mj.changes[0].after === 'ACCOUNTING', 'changement de département : reconnu comme une modification');
  ok(pv.employees.added.length === 0 || pv.employees.added.every((a) => a.name !== 'Maria Julian'), 'déplacement : pas un ajout');

  // ---------------------------------------------------------------- 7. effectif : modèle relu à l'identique
  B = await getBudget();
  await api('PATCH', `/api/finance/budgets/${bid}/contractors/${B.roster.contractors[0].id}`, 'cfo@x.com', { startMo: 3 });
  r = await api('GET', `${RP}/template`, 'cfo@x.com');
  ok(r.status === 200 && Buffer.isBuffer(r.body) && X.isXlsxBuffer(r.body), 'modèle d\'effectif : un .xlsx');
  const TPL = r.body;
  const tp = X.parseRoster(TPL);
  ok(tp.errors.length === 0 && tp.warnings.length === 0 && tp.employees.length === B.roster.employees.length && tp.contractors.length === B.roster.contractors.length && tp.hasContractorDept, 'modèle relu : mêmes effectifs, aucune anomalie');
  r = await rosterPrev(TPL); pv = r.body.preview;
  ok(pv.employees.added.length + pv.employees.changed.length + pv.employees.missing.length === 0 && pv.employees.unchanged === 73 && pv.contractors.added.length + pv.contractors.changed.length + pv.contractors.missing.length === 0 && pv.contractors.unchanged === 28, 'modèle d\'effectif : réimporté = 0 écart');
  ok(JSON.stringify(pv.totals.before) === JSON.stringify(pv.totals.after), 'modèle : totaux inchangés');
  // Le modèle peut être modifié à la main (une cellule) et réimporté.
  const tw = readBook(TPL); setCell(tw.Sheets.Payroll, 'D5', 123456);
  r = await rosterPrev(writeBook(tw)); pv = r.body.preview;
  ok(pv.employees.changed.length === 1 && pv.employees.changed[0].changes[0].after === 123456, 'modèle modifié à la main : 1 écart exact');
  const tl = (await api('GET', `${RP}/template?lang=fr`, 'cfo@x.com')).body;
  ok(readBook(tl).Sheets.Notes.A1.v.includes('Modèle'), 'modèle : notice en français (?lang=fr)');

  // ---------------------------------------------------------------- 8. tout-ou-rien (effectif)
  await db.exec("ALTER TABLE finance_employees ADD CONSTRAINT no_boom CHECK (name <> 'Boom Echec')");
  const fail = readBook(PAY);
  setCell(fail.Sheets.Payroll, `D${rDavid}`, 333333);
  setCell(fail.Sheets.Payroll, 'A89', 'Cluster'); setCell(fail.Sheets.Payroll, 'B89', 'SALES'); setCell(fail.Sheets.Payroll, 'C89', 'Boom Echec'); setCell(fail.Sheets.Payroll, 'D89', 1000); setCell(fail.Sheets.Payroll, 'E89', 1); setCell(fail.Sheets.Payroll, 'F89', 'S&M');
  r = await rosterPrev(writeBook(fail)); pv = r.body.preview;
  ok(pv.canConfirm && pv.employees.added.some((a) => a.name === 'Boom Echec'), 'tout-ou-rien : aperçu prêt');
  const snap = JSON.stringify((await getBudget()).roster);
  const logN = logs.length;
  r = await confirm('roster', 'cfo@x.com', pv);
  ok(r.status === 500 && r.body.error === 'import_failed', 'transaction en échec : 500 import_failed');
  ok(JSON.stringify((await getBudget()).roster) === snap, 'tout-ou-rien : AUCUN changement (la modification de David est annulée)');
  ok(logs.length === logN, 'tout-ou-rien : rien au journal');
  await db.exec('ALTER TABLE finance_employees DROP CONSTRAINT no_boom');

  // ---------------------------------------------------------------- 9. OPEX : vrai classeur = 0 écart
  r = await opexPrev(OPX); pv = r.body.preview;
  ok(r.status === 200 && pv.canConfirm && pv.errors.length === 0 && pv.warnings.length === 0, 'OPEX : aperçu du vrai classeur confirmable, sans avertissement');
  ok(pv.changed.length === 0 && pv.unmatched.length === 0 && pv.notInFile.length === 0 && pv.unchanged === 42, 'OPEX : 0 modifiée / 0 sans clé / 0 absente / 42 inchangées');
  ok(JSON.stringify(pv.totals.before) === JSON.stringify(pv.totals.after), 'OPEX : totaux avant = après');
  near(pv.totals.before[1], sum(refBefore.opex.filter((i) => i.t === 'line').map((i) => sum(i.v.slice(12, 24)))), 'OPEX : total FY27 stocké = Σ des lignes', 0.01);
  r = await confirm('opex', 'cfo@x.com', pv);
  ok(r.status === 200 && r.body.applied.lines === 0, 'OPEX : confirmation sans écart');
  ok(JSON.stringify((await getBudget()).reference) === JSON.stringify(refBefore), 'OPEX : référence identique (octet pour octet) après une confirmation sans écart');

  // ---------------------------------------------------------------- 10. OPEX : classeur modifié
  const ow = readBook(OPX);
  const OS = ow.Sheets.OPEX;
  const orow = (label, nth = 1) => { let k = 0; for (let i = 1; i < 100; i++) if (OS[`A${i}`] && String(OS[`A${i}`].v).trim() === label && ++k === nth) return i; throw new Error(label); };
  const colOf = (i) => xlsx.utils.encode_col(1 + i); // mois i (0 = Jan-26)
  const rSw = orow('Sales & Marketing Software Expenses');
  for (let i = 12; i < 24; i++) setCell(OS, `${colOf(i)}${rSw}`, 3000 + i);          // FY27 modifié
  const rWater = orow('Water');
  for (let i = 0; i < 36; i++) delete OS[`${colOf(i)}${rWater}`];                       // ligne vidée = absente du fichier
  const rSales = orow('Sales Wages & Salaries');
  for (let i = 24; i < 36; i++) setCell(OS, `${colOf(i)}${rSales}`, 50000);            // ligne de PAIE : FY28 modifié
  const rTrav = orow('Travel', 1);
  setCell(OS, `${colOf(13)}${rTrav}`, 777);                                           // ligne de VOYAGE
  const rNew = 68;                                                                    // ligne neuve (aucune clé)
  setCell(OS, `A${rNew}`, 'Brand New Line'); for (let i = 0; i < 36; i++) setCell(OS, `${colOf(i)}${rNew}`, 10);
  const rRent = orow('Rent'); setCell(OS, `${colOf(0)}${rRent}`, 1); // FY26 Jan modifié
  const OMOD = writeBook(ow);

  // Ajustements de la CFO sur la ligne « Software » (FY27) : ils priment sur la base importée.
  B = await getBudget();
  const smSw = B.reference.opex.find((i) => i.key === 'smSw');
  ok((await api('PUT', `/api/finance/budgets/${bid}/state/opex`, 'cfo@x.com', { data: { opx: { smSw: { 0: 1111 } }, opxG: {} }, version: 0 })).status === 200, 'ajustement FY27 saisi sur smSw');
  r = await opexPrev(OMOD); pv = r.body.preview;
  ok(r.status === 200 && pv.canConfirm && pv.errors.length === 0, 'OPEX modifié : aperçu confirmable');
  const names = pv.changed.map((c) => c.name).sort().join('|');
  ok(names === 'Rent|Sales & Marketing Software Expenses|Sales Wages & Salaries|Travel', `OPEX : lignes modifiées exactes (${names})`);
  const chg = (name) => pv.changed.find((c) => c.name === name);
  ok(chg('Sales Wages & Salaries').special === 'payroll' && chg('Travel').special === 'travel' && !chg('Rent').special, 'OPEX : lignes de paie / de voyage marquées');
  near(chg('Sales & Marketing Software Expenses').fy[1].after, sum([...Array(12).keys()].map((i) => 3000 + 12 + i)), 'OPEX : FY27 après (Software)', 1e-6);
  near(chg('Sales & Marketing Software Expenses').fy[1].before, smSw.v.slice(12, 24).reduce((a, b) => a + b, 0), 'OPEX : FY27 avant (Software)', 1e-6);
  near(chg('Sales Wages & Salaries').fy[2].after, 600000, 'OPEX : FY28 après (paie)');
  near(chg('Rent').fy[0].after - chg('Rent').fy[0].before, 1 - 25716.666666666668, 'OPEX : FY26 Rent écart');
  ok(chg('Rent').months === 1 && chg('Travel').months === 1, 'OPEX : nombre de mois modifiés');
  ok(pv.unmatched.length === 1 && pv.unmatched[0].name === 'Brand New Line' && pv.unmatched[0].fy[0] === 120, 'OPEX : ligne neuve listée comme non importée (sans clé)');
  ok(pv.notInFile.length === 1 && pv.notInFile[0].name === 'Water', 'OPEX : ligne de l\'app absente du fichier listée');
  ok(pv.warnings.some((w) => w.code === 'fy27_adjustments_win' && w.value === 'Sales & Marketing Software Expenses'), 'OPEX : avertissement — les ajustements FY27 priment');
  ok(pv.warnings.some((w) => w.code === 'computed_lines' && w.value.includes('Sales Wages & Salaries') && w.value.includes('Travel')), 'OPEX : avertissement — lignes de paie / voyage calculées par l\'app');
  const dB = pv.totals.before, dA = pv.totals.after;
  near(dA[0] - dB[0], 1 - 25716.666666666668 - 0, 'OPEX : total FY26 : seulement Rent (Water absente = inchangée)', 1e-6);
  near(dA[2] - dB[2], 600000 - sum(B.reference.opex.find((i) => i.key === 'smSalesWages').v.slice(24, 36)), 'OPEX : total FY28 : la paie', 1e-6);
  near(pv.totals.fy27Editable.after - pv.totals.fy27Editable.before, sum([...Array(12).keys()].map((i) => 3000 + 12 + i)) - smSw.v.slice(12, 24).reduce((a, b) => a + b, 0), 'OPEX : FY27 modifiable : seulement Software (Travel/paie exclus)', 1e-6);

  // Concurrence : deux aperçus, la 1re confirmation passe, la 2e voit la référence changée.
  // 2e aperçu d'un AUTRE fichier (le jeton est le hachage de la charge utile : le même fichier redonne le même jeton).
  const ow2 = readBook(OPX); setCell(ow2.Sheets.OPEX, `${colOf(14)}${orow('Rent')}`, 4242);
  const pv2 = (await opexPrev(writeBook(ow2))).body.preview;
  ok(pv2.token && pv2.token !== pv.token, 'OPEX : fichiers différents → jetons différents');
  r = await confirm('opex', 'cfo2@x.com', pv); // jeton de cfo@x.com refusé pour un autre usager
  ok(r.status === 403 && r.body.error === 'token_forbidden', 'OPEX : jeton d\'un autre usager refusé');
  ok((await api('POST', `/api/finance/budgets/${bid}/approve`, 'cfo@x.com')).status === 200 && (await confirm('opex', 'cfo@x.com', pv)).body.error === 'locked', 'OPEX : budget approuvé — confirmation refusée');
  ok((await opexPrev(OMOD)).body.error === 'locked' && (await api('GET', `${OP}/template`, 'cfo@x.com')).status === 409, 'OPEX : approuvé — aperçu et modèle refusés');
  await api('POST', `/api/finance/budgets/${bid}/unlock`, 'cfo@x.com');
  r = await confirm('opex', 'cfo@x.com', pv);
  ok(r.status === 200 && r.body.applied.lines === 4, `OPEX : appliqué (4 lignes) ${JSON.stringify(r.body)}`);
  r = await confirm('opex', 'cfo@x.com', pv2);
  ok(r.status === 409 && r.body.error === 'conflict', 'OPEX : 2e aperçu périmé → 409 conflict');
  ok((await confirm('opex', 'cfo@x.com', pv)).status === 410, 'OPEX : jeton déjà utilisé → 410');
  const after = (await getBudget()).reference;
  const strip = (ref) => ref.opex.map(({ v, ...rest }) => rest);
  ok(JSON.stringify(strip(after)) === JSON.stringify(strip(refBefore)), 'OPEX : clés, mappes de paie et structure INTACTES');
  ok(JSON.stringify({ ...after, opex: null }) === JSON.stringify({ ...refBefore, opex: null }), 'OPEX : le reste de la référence est intact');
  const aOf = (k) => after.opex.find((i) => i.key === k).v, bOf = (k) => refBefore.opex.find((i) => i.key === k).v;
  ok(aOf('smSw').slice(12, 24).every((v, i) => v === 3012 + i) && aOf('smSw').slice(0, 12).every((v, i) => v === bOf('smSw')[i]), 'OPEX : smSw FY27 remplacé, FY26 intact');
  ok(aOf('smSalesWages').slice(24).every((v) => v === 50000) && aOf('smTravel')[13] === 777, 'OPEX : valeurs des lignes de paie / voyage stockées');
  ok(aOf('gaWater').every((v, i) => v === bOf('gaWater')[i]), 'OPEX : ligne absente du fichier intacte');
  ok(aOf('gaRent')[0] === 1 && aOf('gaRent').slice(1).every((v, i) => v === bOf('gaRent')[i + 1]), 'OPEX : Rent — un seul mois changé');
  ok(after.opex.length === refBefore.opex.length && !after.opex.some((i) => i.name === 'Brand New Line'), 'OPEX : la ligne neuve n\'est PAS créée');
  const lg = logs.at(-1);
  ok(lg.ev === 'opex_imported' && lg.extra.metadata.lines.length === 4, 'journal : opex_imported');
  // La page reçoit toujours le calcul de paie : FY27 d'une ligne de paie = payroll, pas la base importée (inchangé côté API).
  ok((await getBudget()).payroll.lines.SALES.length === 12, 'API : les lignes de paie restent calculées depuis la paie');

  // Modèle OPEX relu à l'identique (référence modifiée comprise).
  r = await api('GET', `${OP}/template`, 'cfo@x.com');
  ok(r.status === 200 && X.isXlsxBuffer(r.body), 'modèle OPEX : un .xlsx');
  const tparse = X.parseOpex(r.body);
  ok(tparse.errors.length === 0 && tparse.warnings.length === 0 && tparse.rows.length > 42, 'modèle OPEX relu : aucune anomalie');
  pv = (await opexPrev(r.body)).body.preview;
  ok(pv.changed.length === 0 && pv.unmatched.length === 0 && pv.notInFile.length === 0 && pv.unchanged === 42 && JSON.stringify(pv.totals.before) === JSON.stringify(pv.totals.after), 'modèle OPEX : réimporté = 0 écart, 0 ligne sans clé');
  // Les sous-totaux du modèle sont ignorés (ils ne deviennent pas des lignes).
  ok(tparse.rows.some((x) => x.norm === 'total opex'), 'modèle OPEX : contient les sous-totaux (ignorés à l\'import)');

  // ---------------------------------------------------------------- 11. OPEX : validation, permissions
  r = await opexPrev(OPX, 'analyste@x.com');
  ok(r.status === 200 && r.body.preview.canConfirm, 'OPEX : finance:payroll NON requis (finance:edit suffit)');
  const ob = readBook(OPX); const OB = ob.Sheets.OPEX;
  setCell(OB, `C${orow('Rent')}`, 'beaucoup'); setCell(OB, `D${orow('Rent')}`, 5);
  r = await opexPrev(writeBook(ob)); pv = r.body.preview;
  ok(r.status === 200 && !pv.canConfirm && pv.token === null && pv.errors.length === 1 && pv.errors[0].code === 'bad_number' && pv.errors[0].row === orow('Rent'), 'OPEX : nombre illisible → erreur à la ligne, non confirmable');
  const om = readBook(OPX); const OM = om.Sheets.OPEX;
  setCell(OM, 'C5', new Date(2026, 5, 1)); // mois 2 : juin au lieu de février
  r = await opexPrev(writeBook(om));
  ok(r.status === 400 && r.body.error === 'invalid_workbook' && r.body.errors[0].code === 'bad_months', 'OPEX : en-têtes de mois décalés → bad_months');
  const od = readBook(OPX); const OD = od.Sheets.OPEX;
  const rr = orow('Rent'); // doublon : une 2e ligne « Rent » dans la même section
  setCell(OD, 'A68', 'Rent'); for (let i = 0; i < 36; i++) setCell(OD, `${colOf(i)}68`, 5);
  pv = (await opexPrev(writeBook(od))).body.preview;
  ok(pv.warnings.some((w) => w.code === 'duplicate_line') && pv.unmatched.some((u) => u.duplicate) && rr > 0, 'OPEX : doublon dans la même section → avertissement, non importé');
  // Formule sans valeur enregistrée → avertissement + zéro (jamais une valeur inventée).
  const of = readBook(OPX); const OF = of.Sheets.OPEX;
  OF[`E${orow('Cleaning')}`] = { t: 'n', f: '1+1' };
  pv = (await opexPrev(writeBook(of))).body.preview;
  ok(pv.warnings.some((w) => w.code === 'no_cached_value' || w.code === 'cell_error') && pv.changed.length === 5 && pv.changed.some((c) => c.name === 'Cleaning' && c.months === 1 && c.fy[0].after < c.fy[0].before), 'OPEX : formule sans valeur enregistrée signalée (0 sur ce mois, jamais une valeur inventée ; les 4 autres écarts viennent de l\'import précédent)');

  // ---------------------------------------------------------------- 12. OPEX : tout-ou-rien, limitation
  await db.exec("ALTER TABLE finance_budgets ADD CONSTRAINT no_fail CHECK (imported_by IS DISTINCT FROM 'fail@x.com')");
  pv = (await opexPrev(OMOD, 'fail@x.com')).body.preview;
  ok(pv.canConfirm, 'OPEX tout-ou-rien : aperçu prêt');
  const refSnap = JSON.stringify((await getBudget()).reference);
  r = await confirm('opex', 'fail@x.com', pv);
  ok(r.status === 500 && r.body.error === 'import_failed' && JSON.stringify((await getBudget()).reference) === refSnap, 'OPEX : transaction en échec → 500, référence intacte');
  await db.exec('ALTER TABLE finance_budgets DROP CONSTRAINT no_fail');
  let limited = 0;
  for (let i = 0; i < 70; i++) if ((await api('GET', `${OP}/template`, 'spam@x.com')).status === 429) limited++;
  ok(limited >= 9, `limitation : ${limited} demandes refusées (429) au-delà de 60 par 10 min`);
  ok((await api('GET', `${OP}/template`, 'cfo@x.com')).status === 200, 'limitation : par usager');
  ok(sortList.length === 73, 'fin');

  server.close();
  console.log(`✅ consolidatedImport : ${n} vérifications OK`);
  process.exit(0);
})().catch((e) => { console.error('❌', e && e.stack || e); process.exit(1); });
