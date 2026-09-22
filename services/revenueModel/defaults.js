// ============================================================================
// Modélisateur de revenus — valeurs par défaut et bornes des champs.
//
// ⚠️ POURQUOI C'EST SUR LE SERVEUR. Ces valeurs sont les COÛTS de Cluster (coût réseau
// crédit et Interac, coût d'achat d'un terminal, marge matériel, garantie). Le bundle du
// frontend est téléchargeable par n'importe qui sur Netlify : une constante codée dans la
// page serait publique. Servies ici, elles ne sortent que derrière `revmodel:use`.
//
// Les pourcentages sont en POINTS DE POURCENTAGE, comme dans le brief : markupRate = 0.08
// veut dire 0,08 % du volume, pas 8 %. Les formules divisent par 100.
// ============================================================================

// Marchand d'exemple du brief : Chez Cora, volume réel 2025 (125 emplacements).
const DEFAULTS = Object.freeze({
  merchantName: 'Chez Cora',
  numLocs: 125,
  termsPerLoc: 6,

  gmvCredit: 93774430,
  txnCredit: 1798293,
  gmvInterac: 64693357,
  txnInterac: 1334591,

  saasPerLoc: 119,

  markupRate: 0.08,
  txnFeeCredit: 0.04,
  txnFeeInterac: 0.04,

  creditCostPct: 0.04, // 0,04 % du volume (David, 2026-09-22 ; était 0,06 % dans le brief)
  creditCostPerTxn: 0,
  interacCostPerTxn: 0.03, // 0,03 $ par transaction (David, 2026-09-22 ; était 0,035 $ dans le brief)

  termRentalRev: 30,
  termWarrantyCost: 3.5,
  termUnitCost: 663,

  // Matériel : prix d'ACHAT et prix de VENTE par emplacement ; la marge en découle.
  // (Avant le 2026-09-22 on saisissait une marge en % : 4 679 $ à 40 % = 2 807,40 $ d'achat.)
  hwCost: 2807.4,
  hwPrice: 4679,
  instPrice: 1650,

  commSaasMonths: 1,
  commPayPerLoc: 100,
  commHwPct: 10,
  commInstPct: 10,
});

// Les trois paliers SaaS (pastilles + tableau de comparaison Bas / Base / Haut). Valeurs de
// départ seulement : les paliers en vigueur vivent dans app_settings ('revenue_model_saas_tiers'),
// modifiables depuis la page par qui détient `revmodel:settings`.
const SAAS_TIERS = Object.freeze([89, 119, 149]);

// Trois paliers exactement (la page les nomme Bas / Base / Haut), strictement croissants,
// chacun entre 0 et le plafond de saasPerLoc. Refusés sinon, jamais triés ni corrigés.
function validateTiers(raw) {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const t = raw.map(Number);
  const [min, max] = BOUNDS_SAAS;
  if (t.some((v) => !Number.isFinite(v) || v <= min || v > max)) return null;
  if (!(t[0] < t[1] && t[1] < t[2])) return null;
  return t.map((v) => Math.round(v * 100) / 100);
}

// Bornes de chaque champ numérique. Une valeur hors bornes est REFUSÉE à l'enregistrement,
// jamais corrigée : un scénario sauvegardé doit se relire exactement comme il a été saisi.
// Les plafonds sont larges (une chaîne nationale entière tient dedans) ; ils servent surtout
// à attraper un pourcentage tapé comme un montant.
const BOUNDS = Object.freeze({
  numLocs: [0, 100000],
  termsPerLoc: [0, 1000],
  gmvCredit: [0, 1e11],
  txnCredit: [0, 1e10],
  gmvInterac: [0, 1e11],
  txnInterac: [0, 1e10],
  saasPerLoc: [0, 100000],
  markupRate: [0, 100],
  txnFeeCredit: [0, 100],
  txnFeeInterac: [0, 100],
  creditCostPct: [0, 100],
  creditCostPerTxn: [0, 100],
  interacCostPerTxn: [0, 100],
  termRentalRev: [0, 100000],
  termWarrantyCost: [0, 100000],
  termUnitCost: [0, 1e6],
  hwCost: [0, 1e7],
  hwPrice: [0, 1e7],
  instPrice: [0, 1e7],
  commSaasMonths: [0, 120],
  commPayPerLoc: [0, 1e6],
  commHwPct: [0, 100],
  commInstPct: [0, 100],
});

const MAX_NAME = 120;
const BOUNDS_SAAS = BOUNDS.saasPerLoc;

// Scénario d'avant le 2026-09-22 : une marge en % au lieu d'un prix d'achat. On en déduit le
// prix d'achat qui donne EXACTEMENT la même marge, pour que le scénario se relise à l'identique.
function upgradeInputs(raw) {
  if (!raw || raw.hwCost != null || raw.hwMarginPct == null) return raw;
  const price = raw.hwPrice == null ? DEFAULTS.hwPrice : Number(raw.hwPrice);
  const { hwMarginPct, ...rest } = raw;
  return { ...rest, hwCost: Math.round(price * (1 - Number(hwMarginPct) / 100) * 100) / 100 };
}

// Rend { ok, inputs } ou { ok:false, field }. Seules les clefs connues passent : un champ
// inconnu envoyé par le navigateur est ignoré, un champ manquant prend sa valeur par défaut.
function validateInputs(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, field: 'inputs' };
  raw = upgradeInputs(raw);
  const out = {};
  const name = raw.merchantName == null ? DEFAULTS.merchantName : String(raw.merchantName).trim();
  if (name.length > MAX_NAME) return { ok: false, field: 'merchantName' };
  out.merchantName = name;
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    const v = raw[key] == null ? DEFAULTS[key] : Number(raw[key]);
    if (!Number.isFinite(v) || v < min || v > max) return { ok: false, field: key };
    out[key] = v;
  }
  return { ok: true, inputs: out };
}

module.exports = { DEFAULTS, SAAS_TIERS, BOUNDS, MAX_NAME, validateInputs, validateTiers, upgradeInputs };
