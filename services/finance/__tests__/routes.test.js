// Module Finance, de bout en bout contre une vraie base Postgres en mémoire (PGlite) et un vrai
// serveur HTTP : import des données de la CFO, permissions, salaires cachés, verrou
// d'approbation, concurrence, effectif, totaux de paie comparés au PROTOTYPE lui-même.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/routes.test.js [dossier design/finance]
//
// Le dossier de passation (données réelles de la CFO) n'est PAS dans le dépôt : par défaut
// ../design/finance à côté du dépôt. ⚠️ Échoue s'il manque, plutôt que de se déclarer vert.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerFinanceRoutes, seedRole } = require('../routes');
const { importHandoff } = require('../import');
const { PROTO } = require('../handoff');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
if (!fs.existsSync(path.join(DIR, PROTO))) { console.error(`ÉCHEC : paquet de passation introuvable dans ${DIR}`); process.exit(1); }

// Le prototype lui-même, exécuté tel quel : c'est l'oracle des chiffres.
function prototype() {
  const html = fs.readFileSync(path.join(DIR, PROTO), 'utf8');
  let src = html.split('data-dc-script')[1];
  src = src.slice(src.indexOf('>') + 1);
  src = src.slice(0, src.lastIndexOf('</script>'));
  src = src.replace('    return {\n      L, navItems', '    this._dbg={payByMap,conByMap,payNN,payEX,payTot,conTot};\n    return {\n      L, navItems');
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  for (const f of ['budget_data.js', 'payroll_data.js', 'opex_data.js']) vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx);
  vm.runInContext('class DCLogic{constructor(){this.props={};}setState(o){Object.assign(this.state,o)}};' + src + ';globalThis.C=Component;', ctx);
  const c = new ctx.C();
  c.renderVals();
  return c._dbg;
}

(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
  `);
  const perms = {
    'cfo@x.com': ['finance:view', 'finance:edit', 'finance:payroll', 'finance:approve'],
    'analyste@x.com': ['finance:view', 'finance:edit'],
    'lecteur@x.com': ['finance:view'],
    'rh@x.com': ['finance:view', 'finance:payroll'],
    'nobody@x.com': [],
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
    return { status: r.status, body: await r.json() };
  };
  let n = 0; const ok = (c, m) => { assert(c, m); n++; };
  const s12 = (a) => a.reduce((x, y) => x + y, 0);
  const near = (a, b, m) => ok(Math.abs(a - b) < 0.005, `${m} : ${a} ≠ ${b}`);

  // ---------------------------------------------------------------- avant l'import
  ok((await api('GET', '/api/finance/budget', 'nobody@x.com')).status === 403, 'sans permission : 403');
  ok((await api('GET', '/api/finance/budget', 'cfo@x.com', null, { 'x-test-demo': '1' })).status === 403, 'mode démo : bloqué (vrais chiffres)');
  ok((await api('GET', '/api/finance/budget', 'cfo@x.com')).body.empty === true, 'aucun budget importé : empty');

  // ---------------------------------------------------------------- import
  const dry = await importHandoff(pool, DIR, { apply: false });
  ok(dry.action === 'create' && dry.dryRun && dry.employees === 73 && dry.contractors === 28, 'simulation : 73 employés, 28 contractuels, rien écrit');
  ok((await api('GET', '/api/finance/budget', 'cfo@x.com')).body.empty === true, 'la simulation n\'a rien écrit');
  const imp = await importHandoff(pool, DIR, { apply: true, actor: 'test' });
  ok(imp.action === 'create' && imp.budgetId, 'import appliqué');
  ok((await importHandoff(pool, DIR, { apply: true })).action === 'refused_exists', 'un 2e import est refusé (l\'effectif saisi ne se perd pas)');
  ok((await importHandoff(pool, DIR, { apply: true, referenceOnly: true })).action === 'replace_reference', '--reference-only remplace la référence');

  // ---------------------------------------------------------------- lecture et salaires cachés
  const cfo = (await api('GET', '/api/finance/budget', 'cfo@x.com')).body;
  const id = cfo.budget.id;
  ok(cfo.roster && cfo.roster.employees.length === 73, 'CFO : reçoit l\'effectif nominatif');
  ok(cfo.caps.canEdit && cfo.caps.canPayroll && cfo.caps.canApprove, 'CFO : toutes les capacités');
  const lec = (await api('GET', '/api/finance/budget', 'lecteur@x.com')).body;
  ok(!lec.roster && !lec.caps.canEdit, 'lecteur : ni effectif ni écriture');
  const raw = JSON.stringify(lec);
  const someone = cfo.roster.employees[0];
  ok(!raw.includes(someone.name) && !raw.includes('"salary"'), 'lecteur : aucun nom, aucun salaire dans la réponse');

  // Totaux de paie = prototype, au cent près.
  const P = prototype();
  for (const mp of Object.keys(P.payByMap)) near(s12(lec.payroll.payByMap[mp]), s12(P.payByMap[mp]), `payByMap ${mp}`);
  for (const mp of Object.keys(P.conByMap)) near(s12(lec.payroll.conByMap[mp]), s12(P.conByMap[mp]), `conByMap ${mp}`);
  near(s12(lec.payroll.payNN), s12(P.payNN), 'payNN');
  near(s12(lec.payroll.payEX), s12(P.payEX), 'payEX');
  near(s12(lec.payroll.payNN) + s12(lec.payroll.payEX) + s12(lec.payroll.payByMap['Recurring COGS']) + s12(lec.payroll.payByMap['S&M']) + s12(lec.payroll.payByMap['R&D']) + s12(lec.payroll.payByMap['G&A']), s12(P.payTot), 'paie 2027 totale');
  ok(Math.round(s12(P.payTot)) === 6001863, 'paie 2027 = 6 001 863 $ (chiffre de la spec)');
  ok(Object.keys(lec.payroll.lines).length === 10, '10 lignes de paie dans l\'OPEX');

  // ---------------------------------------------------------------- sections
  const put = (user, section, data, version) => api('PUT', `/api/finance/budgets/${id}/state/${section}`, user, { data, version });
  const drv = { intAdds: Array(12).fill(30) };
  ok((await put('lecteur@x.com', 'drivers', { drv }, 0)).status === 403, 'lecteur : ne peut pas modifier');
  let r = await put('analyste@x.com', 'drivers', { drv }, 0);
  ok(r.status === 200 && r.body.version === 1, 'drivers enregistrés (v1)');
  ok((await put('cfo@x.com', 'drivers', { drv: { intAdds: Array(12).fill(31) } }, 0)).status === 409, 'concurrence : version 0 alors que v1 existe → 409');
  r = await put('cfo@x.com', 'drivers', { drv: { intAdds: Array(12).fill(31) } }, 1);
  ok(r.status === 200 && r.body.version === 2, 'drivers v2');
  const stale = await put('analyste@x.com', 'drivers', { drv }, 1);
  ok(stale.status === 409 && stale.body.current.version === 2 && stale.body.current.data.drv.intAdds[0] === 31, 'version périmée → 409 + version courante');
  ok((await put('cfo@x.com', 'drivers', { drv: { pirate: Array(12).fill(1) } }, 2)).body.error === 'unknown_driver:pirate', 'driver inconnu refusé');
  ok((await put('cfo@x.com', 'drivers', { drv: { intAdds: [1, 2] } }, 2)).status === 400, '12 mois exigés');
  ok((await put('cfo@x.com', 'opex', { opx: { gaRent: { 0: 30000 } }, opxG: { smMktg: 2 } }, 0)).status === 200, 'OPEX : cellule + croissance');
  ok((await put('cfo@x.com', 'opex', { opx: { smSalesWages: { 0: 1 } }, opxG: {} }, 1)).body.error === 'unknown_opex:smSalesWages', 'OPEX : une ligne de PAIE n\'est pas modifiable');
  ok((await put('cfo@x.com', 'opex', { opx: { smTravel: { 0: 1 } }, opxG: {} }, 1)).status === 400, 'OPEX : une ligne de voyage passe par le budget de voyages');
  ok((await put('cfo@x.com', 'opex', { opx: { gaRent: { 12: 1 } }, opxG: {} }, 1)).status === 400, 'OPEX : mois hors plage refusé');
  ok((await put('analyste@x.com', 'payroll', { burden: 20, raise: 3, raiseMo: 6 }, 0)).status === 403, 'réglages de paie : finance:payroll exigée');
  ok((await put('cfo@x.com', 'payroll', { burden: 20, raise: 3, raiseMo: 6 }, 0)).status === 200, 'réglages de paie enregistrés');
  ok((await put('cfo@x.com', 'trips', { trips: [{ name: 'Salon', dept: 'S&M', month: 3, people: 2, airfare: 600, nights: 2, hotel: 220, days: 3, perDiem: 85, other: 0 }] }, 0)).status === 200, 'voyages enregistrés');
  ok((await put('cfo@x.com', 'trips', { trips: [{ name: 'X', dept: 'Marketing', month: 3, people: 1, airfare: 0, nights: 0, hotel: 0, days: 0, perDiem: 0, other: 0 }] }, 1)).status === 400, 'voyage : département inconnu refusé');

  const after = (await api('GET', '/api/finance/budget', 'lecteur@x.com')).body;
  ok(after.state.drivers.data.drv.intAdds[0] === 31 && after.state.opex.data.opxG.smMktg === 2, 'les ajustements sont relus');
  ok(after.payrollGlobals.burden === 20, 'les réglages de paie sont relus par tous');
  ok(s12(after.payroll.payByMap['G&A']) > s12(lec.payroll.payByMap['G&A']), 'les totaux de paie suivent les nouveaux réglages');

  // ---------------------------------------------------------------- effectif
  const addE = (user, b) => api('POST', `/api/finance/budgets/${id}/employees`, user, b);
  const hire = { ent: 'Cluster', dept: 'sales', name: 'Embauche prévue', salary: 80000, alloc: 1, map: 'S&M', startMo: 6 };
  ok((await addE('analyste@x.com', hire)).status === 403, 'ajouter un employé : finance:payroll exigée');
  ok((await addE('rh@x.com', hire)).status === 403, 'ajouter un employé : finance:edit exigée aussi');
  ok((await addE('cfo@x.com', { ...hire, map: 'Marketing' })).body.error === 'bad_map', 'poste du P&L inconnu refusé');
  ok((await addE('cfo@x.com', { ...hire, endMo: 3 })).body.error === 'end_before_start', 'départ avant l\'arrivée : refusé');
  const e = (await addE('cfo@x.com', hire)).body.employee;
  ok(e.id && e.dept === 'SALES' && e.salaryBase === null && e.startMo === 6, 'embauche ajoutée (département en majuscules, pas de salaire importé)');
  ok((await api('PATCH', `/api/finance/budgets/${id}/employees/${e.id}`, 'cfo@x.com', { endMo: 2 })).body.error === 'end_before_start', 'modification : départ avant l\'arrivée refusé');
  r = await api('PATCH', `/api/finance/budgets/${id}/employees/${e.id}`, 'cfo@x.com', { salary: 85000, raisePct: null });
  ok(r.status === 200 && r.body.employee.salary === 85000 && r.body.employee.raisePct === null, 'salaire modifié, hausse = globale');
  const emp0 = cfo.roster.employees[0];
  await api('PATCH', `/api/finance/budgets/${id}/employees/${emp0.id}`, 'cfo@x.com', { salary: 1, burdenPct: 30 });
  const c0 = cfo.roster.contractors[0];
  ok((await api('PATCH', `/api/finance/budgets/${id}/contractors/${c0.id}`, 'cfo@x.com', { amt: 123 })).body.contractor.amt === 123, 'contractuel modifié');
  const nc = (await api('POST', `/api/finance/budgets/${id}/contractors`, 'cfo@x.com', { co: 'Firme', name: '', svc: 'Dev', amt: 5000, map: 'R&D', dept: 'development' })).body.contractor;
  ok(nc && nc.amt === 5000, 'contractuel ajouté');
  ok((await api('DELETE', `/api/finance/budgets/${id}/contractors/${nc.id}`, 'cfo@x.com')).body.ok, 'contractuel retiré');
  ok((await api('DELETE', `/api/finance/budgets/${id}/contractors/${nc.id}`, 'cfo@x.com')).status === 404, 'retiré deux fois : 404');

  r = await api('POST', `/api/finance/budgets/${id}/payroll/reset`, 'cfo@x.com');
  const back = r.body.roster.employees.find((x) => x.id === emp0.id);
  ok(back.salary === emp0.salary && back.burdenPct === null, 'réinitialiser : salaire importé et charges globales rétablis');
  ok(r.body.roster.employees.some((x) => x.id === e.id), 'réinitialiser : l\'embauche ajoutée reste');
  ok(r.body.roster.contractors.find((x) => x.id === c0.id).amt === c0.amt, 'réinitialiser : montant du contractuel rétabli');
  ok(r.body.payrollGlobals.burden === 17.5, 'réinitialiser : charges 17,5 %');

  // ---------------------------------------------------------------- verrou d'approbation
  ok((await api('POST', `/api/finance/budgets/${id}/approve`, 'analyste@x.com')).status === 403, 'approuver : finance:approve exigée');
  r = await api('POST', `/api/finance/budgets/${id}/approve`, 'cfo@x.com');
  ok(r.body.budget.status === 'approved' && r.body.budget.approvedBy === 'cfo@x.com', 'budget approuvé');
  const cur = (await api('GET', '/api/finance/budget', 'cfo@x.com')).body.state.drivers.version;
  ok((await put('cfo@x.com', 'drivers', { drv: {} }, cur)).body.error === 'locked', 'approuvé : drivers verrouillés (même pour la CFO)');
  ok((await addE('cfo@x.com', hire)).body.error === 'locked', 'approuvé : effectif verrouillé');
  ok((await api('POST', `/api/finance/budgets/${id}/payroll/reset`, 'cfo@x.com')).body.error === 'locked', 'approuvé : réinitialisation verrouillée');
  ok((await api('POST', `/api/finance/budgets/${id}/unlock`, 'cfo@x.com')).body.budget.status === 'draft', 'déverrouillé');
  r = await put('cfo@x.com', 'drivers', { drv: {} }, cur);
  ok(r.status === 200, 'déverrouillé : on peut réécrire');
  ok(logs.some((l) => l.ev === 'reset' && l.extra.metadata.section === 'drivers'), 'drivers vidés : « réinitialisé » au journal');
  ok(logs.some((l) => l.ev === 'approved') && logs.some((l) => l.ev === 'unlocked'), 'approbation et déverrouillage au journal');
  ok(!logs.some((l) => /\d{5}/.test(l.d)), 'aucun montant de salaire dans les descriptions du journal');

  // Le rôle de la CFO, semé au démarrage (20 s plus tard en vrai : appelé ici directement).
  await seedRole(pool);
  await db.query("UPDATE roles SET permissions = '[\"finance:view\"]' WHERE name = 'Finance (CFO)'");
  await seedRole(pool);
  const role = (await db.query("SELECT permissions FROM roles WHERE name = 'Finance (CFO)'")).rows;
  ok(role.length === 1 && role[0].permissions.length === 1, 'rôle Finance (CFO) semé une fois, jamais écrasé ensuite');
  // Rôle existant AVANT les nouvelles clés : elles sont ajoutées une seule fois.
  await db.query("DELETE FROM app_settings WHERE key = 'finance_role_perms_v2'");
  await seedRole(pool);
  let perms2 = (await db.query("SELECT permissions FROM roles WHERE name = 'Finance (CFO)'")).rows[0].permissions;
  ok(perms2.includes('finance:kpi') && perms2.includes('finance:post_je') && perms2.length === 10, 'rôle existant : les 9 nouvelles clés ajoutées');
  await db.query(`UPDATE roles SET permissions = permissions - 'finance:post_je' WHERE name = 'Finance (CFO)'`);
  await seedRole(pool);
  perms2 = (await db.query("SELECT permissions FROM roles WHERE name = 'Finance (CFO)'")).rows[0].permissions;
  ok(!perms2.includes('finance:post_je'), 'une clé retirée par un admin n\'est jamais remise');
  // Lot suivant (aides à la décision) : ajouté UNE fois, sans toucher aux clés retirées du lot précédent.
  await db.query("DELETE FROM app_settings WHERE key = 'finance_role_perms_v3'");
  await seedRole(pool);
  perms2 = (await db.query("SELECT permissions FROM roles WHERE name = 'Finance (CFO)'")).rows[0].permissions;
  ok(['finance:suggestions', 'finance:ai_budget', 'finance:driver_approve', 'finance:progress', 'finance:guide'].every((p) => perms2.includes(p)) && perms2.length === 14, 'lot v3 : les 5 nouvelles clés ajoutées');
  ok(!perms2.includes('finance:post_je'), 'lot v3 : la clé retirée du lot v2 reste retirée');
  await db.query(`UPDATE roles SET permissions = permissions - 'finance:guide' WHERE name = 'Finance (CFO)'`);
  await seedRole(pool);
  ok(!(await db.query("SELECT permissions FROM roles WHERE name = 'Finance (CFO)'")).rows[0].permissions.includes('finance:guide'), 'lot v3 : appliqué une seule fois');

  server.close();
  console.log(`✅ finance routes : ${n} vérifications`);
})().catch((e) => { console.error('❌', e.stack || e.message); process.exit(1); });
