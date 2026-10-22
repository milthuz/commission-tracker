// ============================================================================
// Module Finance — calcul de la paie (Salary & Contractors), côté serveur.
//
// Pourquoi ici aussi : les salaires individuels ne quittent le serveur que pour les détenteurs
// de `finance:payroll`. Les autres usagers de la section reçoivent seulement les TOTAUX par
// poste du P&L et par ligne OPEX, calculés ici. La page Salaires refait le même calcul dans le
// navigateur (frontend src/pages/Finance/model.ts, `computePayroll`) pour réagir à la frappe :
// GARDER LES DEUX IDENTIQUES — les bancs d'essai des deux côtés visent les mêmes chiffres.
//
// Règle (prototype, = formule Excel « =G/12*(1+H) ») :
//   mensuel = salaire × allocation ÷ 12 × (1 + charges %) × (1 + hausse % à partir du mois choisi)
// La hausse est UNE marche, pas composée. Un champ par personne laissé vide (null) suit le
// réglage global. Ajout de la phase 1 : mois d'arrivée / de départ (embauches et départs prévus) ;
// hors de cette plage, la personne coûte 0.
// SH-48 : hausse par DÉPARTEMENT (`globals.deptRaise`, code de département → %). Priorité :
// hausse de l'employé > hausse de son département > hausse globale.
// ============================================================================

const MAPS = ['Recurring COGS', 'Service COGS', 'S&M', 'R&D', 'G&A'];
const NET_NEW_RE = /NET NEW|IMPLEMENTATION/;
const z12 = () => Array(12).fill(0);
const num = (v, d = 0) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : d; };
const active = (p, k) => k >= (p.startMo == null ? 0 : p.startMo) && (p.endMo == null || k <= p.endMo);

function computePayroll(employees, contractors, globals = {}) {
  const gBurden = num(globals.burden, 17.5);
  const gRaise = num(globals.raise, 0);
  const gRaiseMo = num(globals.raiseMo, 0);
  const deptRaise = globals.deptRaise && typeof globals.deptRaise === 'object' ? globals.deptRaise : {};
  const emp = employees.map((e) => {
    const salary = num(e.salary);
    const dRaise = deptRaise[e.dept] == null ? gRaise : num(deptRaise[e.dept], gRaise);
    const raise = e.raisePct == null ? dRaise : num(e.raisePct);
    const raiseMo = e.raiseMo == null ? gRaiseMo : num(e.raiseMo);
    const burden = e.burdenPct == null ? gBurden : num(e.burdenPct);
    const incl = salary * num(e.alloc);
    const m = z12().map((_, k) => (active(e, k) ? incl / 12 * (1 + burden / 100) * (k >= raiseMo ? 1 + raise / 100 : 1) : 0));
    return { ...e, salary, raise, raiseMo, burden, incl, m };
  });
  const con = contractors.map((c) => {
    const amt = num(c.amt);
    return { ...c, amt, m: z12().map((_, k) => (active(c, k) ? amt : 0)) };
  });
  const sumM = (list) => list.reduce((acc, x) => acc.map((v, i) => v + x.m[i]), z12());
  const payByMap = Object.fromEntries(MAPS.map((mp) => [mp, sumM(emp.filter((e) => e.map === mp))]));
  const conByMap = Object.fromEntries(MAPS.map((mp) => [mp, sumM(con.filter((c) => c.map === mp))]));
  const payNN = sumM(emp.filter((e) => e.map === 'Service COGS' && NET_NEW_RE.test(e.dept)));
  const payEX = sumM(emp.filter((e) => e.map === 'Service COGS' && !NET_NEW_RE.test(e.dept)));
  // Lignes de paie de l'OPEX : par code de département (« SALES », « R&D »…) ou « con:<poste> ».
  // Le département ignore l'entité (le personnel de Xperio est inclus) et CONTROL PLUS est
  // rangé dans OPERATIONS — comme le prototype.
  const deptPay = (d) => sumM(emp.filter((e) => (d === 'R&D' ? e.map === 'R&D' : (e.dept === d || (d === 'OPERATIONS' && e.dept === 'CONTROL PLUS')))));
  const payLine = (code) => (String(code).startsWith('con:') ? (conByMap[code.slice(4)] || z12()) : deptPay(code));
  return { emp, con, payByMap, conByMap, payNN, payEX, payLine, globals: { burden: gBurden, raise: gRaise, raiseMo: gRaiseMo, deptRaise } };
}

// Ce que reçoit un usager SANS `finance:payroll` : aucun nom, aucun salaire, seulement des
// sommes mensuelles par poste et par ligne de paie de l'OPEX.
function payrollAggregate(employees, contractors, globals, payCodes) {
  const p = computePayroll(employees, contractors, globals);
  const lines = {};
  for (const code of payCodes) lines[code] = p.payLine(code);
  return {
    payByMap: p.payByMap, conByMap: p.conByMap, payNN: p.payNN, payEX: p.payEX, lines,
    headcount: employees.length, contractorCount: contractors.length,
  };
}

module.exports = { MAPS, computePayroll, payrollAggregate };
