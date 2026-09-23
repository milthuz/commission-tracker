// ============================================================================
// RH — données d'une embauche : valeurs par défaut, validation, normalisation.
//
// Deux documents sortent d'une embauche :
//   1. l'OFFRE D'EMPLOI (contrat de travail), reprise mot pour mot du gabarit Word de Cluster
//      « Cluster Offer of Employment - Template » ;
//   2. l'ENTENTE DE RÉMUNÉRATION « Sales Representative Compensation Agreement v7.7 », reprise
//      des PDF produits en avril 2026 pour Sophie, Elizabeth, Erika, Gabriella et Giuseppe.
//
// 🔑 LE PLAN PAR DÉFAUT VIENT DU MOTEUR DE CALCUL, PAS D'UNE COPIE. Le quota et les paliers de
// primes sont lus dans les constantes que le calcul des commissions utilise réellement
// (MONTHLY_QUOTA, et les tables `bonus_tiers` rechargées toutes les 60 s). Une entente qui
// promettrait 250 $ à 20 points pendant que le moteur paie autre chose serait un document
// signé qui contredit la paie. Les autres valeurs (10 % matériel, 100 $ d'activation…) sont
// celles de la v7.7 signée.
//
// ⚠️ Modifier le plan D'UNE embauche change le texte de SON entente, jamais le calcul des
// commissions. L'écran le dit, et `planDiffers()` signale tout écart au moteur.
// ============================================================================

const PLAN_VERSION = '7.7';

// Valeurs de la v7.7 signée. Le quota et les paliers sont écrasés par ceux du moteur au moment
// de la lecture (voir engineDefaults).
const BASE_PLAN = {
  version: PLAN_VERSION,
  monthlyQuota: 15,
  pointsInbound: 1,
  pointsOutbound: 2,
  pointsProcessing: 1,
  hardwareRate: 10,          // %
  hardwareReducedRate: 5,    // %
  discountThreshold: 25,     // % de remise client à partir duquel le taux réduit s'applique
  saasFirstMonthPct: 100,    // % du premier mois
  signupBonus: 100,          // $ par compte de traitement activé
  processingCap: 500,        // $ par compte
  biAnnualMinMargin: 100,    // $ de marge mensuelle minimale pour la prime semestrielle
  rampDays: 90,
  monthlyTiers: [{ points: 20, bonus: 250 }, { points: 25, bonus: 500 }, { points: 30, bonus: 1000 }],
  annualTiers: [{ points: 240, bonus: 5000 }, { points: 300, bonus: 7500 }, { points: 360, bonus: 10000 }],
};

// Conditions de l'offre d'emploi que le gabarit Word fixe mais qui changent d'une embauche à
// l'autre en pratique. Tout le reste du gabarit (confidentialité, non-concurrence…) est du texte
// juridique figé : on ne l'expose pas en champ, on ne le reformule pas.
const BASE_TERMS = {
  carAllowance: 6000,        // $ par an ; 0 = phrase retirée
  phoneAllowance: 60,        // $ par mois ; 0 = phrase retirée
  vacationWeeks: 2,
  commissionEligible: true,
};

const sortTiers = (tiers) => [...tiers]
  .map((t) => ({ points: Number(t.points), bonus: Number(t.bonus) }))
  .sort((a, b) => a.points - b.points);

// Plan par défaut = v7.7 + quota et paliers EN VIGUEUR dans le moteur.
function engineDefaults(engine) {
  const plan = { ...BASE_PLAN };
  if (engine) {
    if (Number.isFinite(Number(engine.monthlyQuota))) plan.monthlyQuota = Number(engine.monthlyQuota);
    if (Array.isArray(engine.monthlyTiers) && engine.monthlyTiers.length) plan.monthlyTiers = sortTiers(engine.monthlyTiers);
    if (Array.isArray(engine.annualTiers) && engine.annualTiers.length) plan.annualTiers = sortTiers(engine.annualTiers);
  }
  return plan;
}

const num = (v, { min = 0, max = 1e9, int = false } = {}) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return int ? Math.round(n) : Math.round(n * 100) / 100;
};

function validateTiers(list, label, errors) {
  if (!Array.isArray(list) || !list.length || list.length > 6) { errors.push(`${label}: 1 to 6 tiers`); return null; }
  const out = [];
  for (const t of list) {
    const points = num(t && t.points, { min: 1, max: 100000, int: true });
    const bonus = num(t && t.bonus, { min: 0, max: 1e7 });
    if (points == null || bonus == null) { errors.push(`${label}: invalid tier`); return null; }
    out.push({ points, bonus });
  }
  const sorted = sortTiers(out);
  if (new Set(sorted.map((t) => t.points)).size !== sorted.length) { errors.push(`${label}: duplicate points`); return null; }
  return sorted;
}

// Plan reçu du navigateur → plan complet et validé (les champs absents prennent le défaut).
function normalizePlan(input, defaults) {
  const src = { ...defaults, ...(input || {}) };
  const errors = [];
  const f = (k, opts) => {
    const v = num(src[k], opts);
    if (v == null) errors.push(k);
    return v;
  };
  const plan = {
    version: PLAN_VERSION,
    monthlyQuota: f('monthlyQuota', { min: 1, max: 1000, int: true }),
    pointsInbound: f('pointsInbound', { min: 0, max: 100 }),
    pointsOutbound: f('pointsOutbound', { min: 0, max: 100 }),
    pointsProcessing: f('pointsProcessing', { min: 0, max: 100 }),
    hardwareRate: f('hardwareRate', { min: 0, max: 100 }),
    hardwareReducedRate: f('hardwareReducedRate', { min: 0, max: 100 }),
    discountThreshold: f('discountThreshold', { min: 0, max: 100 }),
    saasFirstMonthPct: f('saasFirstMonthPct', { min: 0, max: 1000 }),
    signupBonus: f('signupBonus', { min: 0, max: 100000 }),
    processingCap: f('processingCap', { min: 0, max: 1e7 }),
    biAnnualMinMargin: f('biAnnualMinMargin', { min: 0, max: 1e7 }),
    rampDays: f('rampDays', { min: 0, max: 365, int: true }),
    monthlyTiers: validateTiers(src.monthlyTiers, 'monthlyTiers', errors),
    annualTiers: validateTiers(src.annualTiers, 'annualTiers', errors),
  };
  return errors.length ? { ok: false, errors } : { ok: true, plan };
}

// Forme canonique pour comparer. ⚠️ JSONB RÉORDONNE les clés d'un objet (par longueur puis
// octets : un palier relu de la base sort { bonus, points }) — un JSON.stringify direct
// signalait donc un écart fantôme sur chaque fiche enregistrée.
const canon = (v) => (Array.isArray(v)
  ? `[${v.map(canon).join(',')}]`
  : (v && typeof v === 'object'
    ? `{${Object.keys(v).sort().map((k) => `${k}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : v)));

// Liste des clés où l'entente diverge du moteur — affichée en avertissement.
function planDiffers(plan, defaults) {
  if (!plan || !defaults) return [];
  const out = [];
  for (const k of Object.keys(defaults)) {
    if (k === 'version') continue;
    if (canon(plan[k]) !== canon(defaults[k])) out.push(k);
  }
  return out;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

// Fiche d'embauche reçue du navigateur → colonnes validées. `partial` = mise à jour d'un
// brouillon (tous les champs restent exigés : on renvoie toujours la fiche complète).
function normalizeHire(body, defaults) {
  const b = body || {};
  const errors = [];
  const hire = {
    firstName: str(b.firstName, 100),
    lastName: str(b.lastName, 100),
    email: str(b.email, 200).toLowerCase(),
    phone: str(b.phone, 40),
    addressLine1: str(b.addressLine1, 200),
    city: str(b.city, 100) || 'Montreal',
    province: str(b.province, 10) || 'QC',
    postalCode: str(b.postalCode, 12).toUpperCase(),
    country: str(b.country, 60) || 'Canada',
    position: str(b.position, 120) || 'Sales Representative',
    positionFr: str(b.positionFr, 120) || 'Représentant(e) des ventes',
    startDate: str(b.startDate, 10),
    offerDate: str(b.offerDate, 10) || new Date().toISOString().slice(0, 10),
    reportsToTitle: str(b.reportsToTitle, 120),
    // Titre du supérieur dans la version française de l'offre ; vide = même titre que l'anglais.
    reportsToTitleFr: str(b.reportsToTitleFr, 120),
    reportsToName: str(b.reportsToName, 120),
    supervisorName: str(b.supervisorName, 120),
    annualSalary: num(b.annualSalary, { min: 0, max: 10000000 }),
    agreementLang: b.agreementLang === 'fr' ? 'fr' : 'en',
    includeAgreement: b.includeAgreement !== false,
    notes: str(b.notes, 4000),
  };
  if (!hire.firstName) errors.push('firstName');
  if (!hire.lastName) errors.push('lastName');
  if (!EMAIL_RE.test(hire.email)) errors.push('email');
  if (!ISO_RE.test(hire.startDate)) errors.push('startDate');
  if (!ISO_RE.test(hire.offerDate)) errors.push('offerDate');
  if (!hire.reportsToName) errors.push('reportsToName');
  if (!hire.reportsToTitle) errors.push('reportsToTitle');
  if (hire.annualSalary == null) errors.push('annualSalary');
  if (!hire.supervisorName) hire.supervisorName = hire.reportsToName;

  const t = { ...BASE_TERMS, ...(b.terms || {}) };
  const terms = {
    carAllowance: num(t.carAllowance, { min: 0, max: 1e6 }),
    phoneAllowance: num(t.phoneAllowance, { min: 0, max: 1e5 }),
    vacationWeeks: num(t.vacationWeeks, { min: 0, max: 12, int: true }),
    commissionEligible: t.commissionEligible !== false,
  };
  for (const k of ['carAllowance', 'phoneAllowance', 'vacationWeeks']) if (terms[k] == null) errors.push(`terms.${k}`);

  const p = normalizePlan(b.plan, defaults);
  if (!p.ok) errors.push(...p.errors.map((e) => `plan.${e}`));

  if (errors.length) return { ok: false, errors };
  return { ok: true, hire, terms, plan: p.plan };
}

module.exports = {
  PLAN_VERSION, BASE_PLAN, BASE_TERMS,
  engineDefaults, normalizePlan, normalizeHire, planDiffers,
};
