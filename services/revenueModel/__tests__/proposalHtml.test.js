// Garde-fou du document CLIENT : aucun coût, marge ni commission de Cluster ne doit pouvoir
// atteindre les pages de tarification d'une proposition de chaîne.
//   node services/revenueModel/__tests__/proposalHtml.test.js
//
// Méthode : chaque champ interne reçoit une valeur « signature » impossible à confondre, puis on
// vérifie qu'aucune n'apparaît dans le HTML — sous aucune des formes qu'un formateur produirait.
// ⚠️ Un test d'ABSENCE passe pour la mauvaise raison si le document est vide : on vérifie donc
// d'abord que les VRAIS prix, eux, y sont bien (voir feedback-verify-the-harness).
const assert = require('assert');
const { renderPricingHtml, buildPricing, PRICE_KEYS } = require('../proposalHtml');
const { DEFAULTS } = require('../defaults');

const INTERNAL = {
  creditCostPct: 0.0917, creditCostPerTxn: 0.0913, interacCostPct: 0.0719, interacCostPerTxn: 0.0931,
  aofCost: 71.37, pciCost: 72.47, bankCost: 73.57,
  termWarrantyCost: 7.93, termUnitCost: 9137, hwCost: 8317.29, instCost: 1397.71,
  commSaasMonths: 7.3, commPayPerLoc: 913.7, commHwPct: 37.1, commInstPct: 19.3,
};
const scenario = { ...DEFAULTS, ...INTERNAL, pciRev: 5, aofRev: 3, bankRev: 2, merchantName: "Resto l'Essai" };

// Chaque forme sous laquelle une valeur pourrait s'écrire (point, virgule, séparateurs FR/EN).
const forms = (v) => {
  const out = new Set([String(v), String(v).replace('.', ',')]);
  for (const loc of ['fr-CA', 'en-CA']) for (const d of [0, 2, 6]) {
    out.add(v.toLocaleString(loc, { maximumFractionDigits: d }));
    out.add(v.toLocaleString(loc, { minimumFractionDigits: d, maximumFractionDigits: d }));
  }
  return [...out].filter((f) => f.replace(/[\s\u00a0\u202f]/g, '').length >= 3); // « 7 », « 19 » : trop courts pour être une signature
};
const norm = (s) => s.replace(/[\u00a0\u202f]/g, ' ');

let n = 0;
for (const lang of ['fr', 'en']) {
  const html = norm(renderPricingHtml(scenario, { lang, startPage: 7 }));
  const body = html.slice(html.indexOf('<body>')); // le CSS (police en base64) n'est pas du contenu

  // 1) Le document n'est pas vide : les vrais prix y sont.
  for (const must of lang === 'fr' ? ['4 679 $', '1 650 $', '119 $', '180 $', '0,08 %', "Resto l'Essai", 'Confidentiel · 07']
                                   : ['$4,679', '$1,650', '$119', '$180', '0.08 %', "Resto l'Essai", 'Confidential · 07']) {
    assert(body.includes(must), `[${lang}] prix attendu absent : ${must}`); n++;
  }
  // 2) Aucun champ interne, sous aucune forme.
  for (const [k, v] of Object.entries(INTERNAL)) {
    for (const f of forms(v)) { assert(!body.includes(norm(f)), `[${lang}] FUITE de ${k} (« ${f} ») dans le document client`); n++; }
  }
  // 3) Ni coût, ni marge, ni commission dans le vocabulaire.
  //    Seule exception voulue : l'interchange « refacturé au coût réel » / « at actual cost », qui
  //    parle du coût du RÉSEAU refacturé au client, pas d'un coût de Cluster.
  // Texte VISIBLE seulement : « margin » d'un attribut style= n'est pas un mot du document.
  const prose = body.replace(/<[^>]*>/g, ' ').toLowerCase().replaceAll('au coût réel', '').replaceAll('at actual cost', ''); // TOUTES les occurrences
  for (const w of lang === 'fr' ? ['coût', 'marge', 'commission', 'garantie'] : ['cost', 'margin', 'commission', 'warranty']) {
    assert(!prose.includes(w), `[${lang}] mot interne « ${w} » dans le document client`); n++;
  }
}

// 4) buildPricing ne lit QUE la liste blanche : changer un champ interne ne change rien.
const a = JSON.stringify(buildPricing(scenario));
const b = JSON.stringify(buildPricing({ ...scenario, ...Object.fromEntries(Object.keys(INTERNAL).map((k) => [k, 0])) }));
assert.strictEqual(a, b, 'buildPricing dépend d’un champ interne'); n++;
assert(!PRICE_KEYS.some((k) => k in INTERNAL), 'un champ interne est dans PRICE_KEYS'); n++;

// 5) Un nom de marchand hostile est échappé.
const evil = renderPricingHtml({ ...scenario, merchantName: '<script>x</script>' }, { lang: 'fr' });
assert(!evil.includes('<script>x'), 'nom de marchand non échappé'); n++;

console.log(`proposalHtml : ${n} vérifications OK`);
