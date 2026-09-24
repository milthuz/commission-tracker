// ============================================================================
// L'offre standard Cluster IC+ : ce que Cluster facture, et ce que ça lui coûte.
//
// ⚠️⚠️ POURQUOI CE FICHIER EXISTE. Jusqu'ici `populate()` retombait sur des taux Cluster À
// ZÉRO quand l'appelant n'en fournissait pas — et le frontend n'en a jamais fourni. Le
// calculateur présentait donc Cluster comme ne facturant RIEN.
//
// Ce n'était pas un panneau vide, c'était le chiffre en tête du document client. Sur le
// relevé PATISSERIE AFRODITI (2026-09-24), Sales Hub annonçait 883,81 $ d'économies par
// mois et 10 605,71 $ par année ; le calculateur de Christine, avec la vraie offre,
// donnait −76,17 $ par mois. Le marchand paierait PLUS, et un rep serait parti vendre une
// économie qui n'existe pas.
//
// ⚠️ LA SÉPARATION QUI COMPTE : STANDARD_RATES et STANDARD_FIXED sont ce que le MARCHAND
// voit — ils peuvent voyager jusqu'au navigateur. STANDARD_COST est ce que Cluster PAIE :
// il ne sort que derrière la permission `icplus:margin`, jamais dans le paquet du client.
// C'est la même règle que le modélisateur de revenus applique à ses propres coûts.
//
// Source : l'offre standard telle qu'affichée par le calculateur de référence de Christine
// (capture du 2026-09-23, section « MARGE CLUSTER IC+ (OFFRE STANDARD) »). Ces valeurs
// sont une TARIFICATION COMMERCIALE, pas une donnée de marché : elles changent par
// décision, pas par observation. Toute modification devrait venir de la direction et être
// datée ici.
// ============================================================================

// Ce que Cluster facture au marchand, par marque : un pourcentage du volume ET un montant
// par transaction, jamais fondus en un seul taux.
const STANDARD_RATES = {
  debit: { pct: 0,      perItem: 0.05 },
  visa:  { pct: 0.0030, perItem: 0.05 },
  mc:    { pct: 0.0030, perItem: 0.05 },
  amex:  { pct: 0.0030, perItem: 0.05 },
};

// Les frais fixes mensuels de l'offre. Les terminaux sont à quantité ZÉRO par défaut : ils
// ne se facturent que si le marchand en prend, et c'est au rep de saisir la quantité.
const STANDARD_FIXED = {
  pci:              { qty: 1, unit: 7.50 },
  account:          { qty: 1, unit: 9.00 },
  batch:            { qty: 1, unit: 7.00 },
  statement:        { qty: 0, unit: 0 },
  terminalWireless: { qty: 0, unit: 45.00 },
  terminalWired:    { qty: 0, unit: 30.00 },
};

// ⚠️ INTERNE. Ce que ces mêmes composantes coûtent à Cluster. Ne doit jamais atteindre un
// appelant sans `icplus:margin` — c'est la rentabilité de l'entreprise, pas une donnée de
// comparaison.
const STANDARD_COST = {
  perTxn:           0.03,   // $ par transaction, toutes marques
  discountPct:      0.0005, // 0,05 % du volume
  t1Pct:            0.0001, // 0,01 % — dépôt accéléré, absorbé (facturé 0)
  fixed:            5.50,   // $ par mois, hors terminaux
  terminalWireless: 34.77,  // $ par unité et par mois
  terminalWired:    27.50,
};

// Copies profondes : `populate()` range ces objets dans un état que l'appelant peut
// ensuite modifier. Rendre la référence laisserait une analyse écraser l'offre standard
// pour toutes les suivantes du même processus.
const clone = (o) => JSON.parse(JSON.stringify(o));

module.exports = {
  STANDARD_RATES, STANDARD_FIXED, STANDARD_COST,
  standardRates: () => clone(STANDARD_RATES),
  standardFixed: () => clone(STANDARD_FIXED),
  standardCost:  () => clone(STANDARD_COST),
};
