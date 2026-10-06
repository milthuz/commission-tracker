// Paliers Interac Flash mélangés sur un mois complet.
//
// Les paliers sont des prix par TRANSACTION et dépendent du montant de chaque transaction.
// Un relevé mensuel n'imprime qu'une ligne, donc une seule moyenne — qui ne tombe sur
// aucun palier publié dès qu'un seul achat a dépassé 100 $. La ligne sortait alors
// « À vérifier » sans catégorie, indistinguable d'un frais non reconnu sur un document
// remis au marchand.
//
// Ce que ces tests verrouillent :
//   1. la moyenne mélangée est NOMMÉE et expliquée ;
//   2. le MONTANT ne bouge pas (c'était déjà « À vérifier », ça le reste) ;
//   3. un palier exact reste « Conforme » — le filet ne mange pas le cas sain ;
//   4. une majoration du processeur dans la même bande n'est PAS baptisée Interac.
const C = require('../classify');

let fails = 0;
function ok(label, cond, got) {
  if (cond) { console.log(`  ok   ${label}`); return; }
  fails += 1;
  console.log(`  FAIL ${label}${got !== undefined ? ` -> ${JSON.stringify(got)}` : ''}`);
}

const interac = (item) => C.classifyInteracLine(item, { processor: 'moneris' });

// ---------------------------------------------------------------------------
// 0. Le banc d'essai lui-même : sans ça, les assertions d'absence plus bas passeraient
//    pour la mauvaise raison. Les paliers DOIVENT être chargés en table.
// ---------------------------------------------------------------------------
console.log('\n0. le banc mesure bien quelque chose');
const tiers = (require('../rateTables').RATE_TABLES.interacFlash || []).map((e) => e.perItem).sort((a, b) => a - b);
ok('les 4 paliers Flash sont en table', tiers.length === 4, tiers);
ok('bornes 0,02 et 0,055', tiers[0] === 0.02 && tiers[3] === 0.055, tiers);

// ---------------------------------------------------------------------------
// 1. Le cas sain ne doit pas régresser.
// ---------------------------------------------------------------------------
console.log('\n1. un palier exact reste Conforme');
const exact = interac({ desc: 'IDP FLASH', perItem: 0.035, count: 1000, total: 35.00 });
ok('0,035 $ -> Conforme', exact.status === C.STATUS.CONFORME, exact.status);
ok('0,035 $ -> palier 3 nommé', /Palier 3/.test(exact.cat || ''), exact.cat);
ok('0,035 $ -> pas marqué mélangé', !exact.blendedTiers, exact.blendedTiers);

// ---------------------------------------------------------------------------
// 2. Le cas visé : une moyenne entre deux paliers.
// ---------------------------------------------------------------------------
console.log('\n2. une moyenne entre deux paliers est nommée');
const mix = interac({ desc: 'IDP FLASH', perItem: 0.0342, count: 2000, total: 68.40 });
ok('0,0342 $ -> catégorie « paliers mélangés »',
  mix.cat === 'Interac Flash — paliers mélangés', mix.cat);
ok('0,0342 $ -> drapeau blendedTiers', mix.blendedTiers === true, mix.blendedTiers);
ok('0,0342 $ -> reste « À vérifier » (le montant ne bouge pas)',
  mix.status === C.STATUS.A_VERIFIER, mix.status);
ok('0,0342 $ -> explication citant les deux paliers encadrants',
  /0,0250/.test(mix.why) && /0,0350/.test(mix.why), mix.why);
ok('0,0342 $ -> aucun taux publié annoncé',
  mix.publishedRate === null && mix.publishedPerItem === null,
  { r: mix.publishedRate, p: mix.publishedPerItem });

// ⚠️ Le vrai sens du correctif : AVANT, cette ligne n'avait pas de catégorie du tout.
ok('0,0342 $ -> n\'est plus anonyme', !!mix.cat, mix.cat);
ok('0,0342 $ -> n\'est plus « aucune correspondance »',
  !/Aucune correspondance/i.test(mix.why), mix.why);

// ---------------------------------------------------------------------------
// 3. Sans colonne $/transaction, le quotient montant ÷ nombre EST la moyenne du mois.
//    C'est la forme la plus courante : beaucoup de relevés n'impriment pas de colonne.
// ---------------------------------------------------------------------------
console.log('\n3. la moyenne se reconstitue sans colonne $/transaction');
const derived = interac({ desc: 'FRAIS FLASH SANS CONTACT', count: 1500, total: 64.50 });
ok('64,50 $ / 1500 = 0,043 $ -> nommé',
  derived.cat === 'Interac Flash — paliers mélangés', derived.cat);
ok('64,50 $ / 1500 -> explication citant 0,0430',
  /0,0430/.test(derived.why || ''), derived.why);

// ---------------------------------------------------------------------------
// 4. Le garde-fou. C'est la moitié qui protège le marchand.
// ---------------------------------------------------------------------------
console.log('\n4. le libellé Flash est exigé en plus de la bande');
// Une majoration du processeur à 0,03 $/transaction tombe PILE dans la bande des paliers.
// La nommer « Interac Flash » reviendrait à bénir une majoration comme transfert réseau.
const markup = interac({ desc: 'FRAIS DE SERVICE', perItem: 0.03, count: 1000, total: 30.00 });
ok('frais de service à 0,03 $ -> PAS baptisé Interac',
  !/Interac/i.test(markup.cat || ''), markup.cat);
ok('frais de service à 0,03 $ -> pas marqué mélangé', !markup.blendedTiers, markup.blendedTiers);

console.log('\n5. hors de la bande, rien n\'est inventé');
// Les frais de commutation Interac (0,0140) sont SOUS la bande Flash : ils ont leur propre
// table et ne doivent pas se faire absorber.
const switchFee = interac({ desc: 'INTERAC COMMUTATION FLASH', perItem: 0.013985, count: 1000, total: 13.99 });
ok('0,013985 $ -> frais de commutation, pas un palier',
  /commutation/i.test(switchFee.cat || ''), switchFee.cat);
const tooHigh = interac({ desc: 'IDP FLASH', perItem: 0.12, count: 100, total: 12.00 });
ok('0,12 $ -> hors bande, aucune catégorie inventée',
  !tooHigh.blendedTiers && !/paliers mélangés/.test(tooHigh.cat || ''), tooHigh.cat);

// ---------------------------------------------------------------------------
// 6. Un palier IMPRIMÉ garde la main : l'étiquette du relevé bat l'inférence.
// ---------------------------------------------------------------------------
console.log('\n6. un palier imprimé garde la main');
const labelled = interac({ desc: 'IDP FLASH T4', rate: 0, volume: 1062.02, total: 0.50, count: 9 });
ok('« T4 » reconnu comme palier', labelled.tier === 'T4', labelled.tier);
ok('« T4 » -> pas requalifié en mélange', !labelled.blendedTiers, labelled.blendedTiers);

// ---------------------------------------------------------------------------
// 7. La moitié VISIBLE. Le serveur peut classer parfaitement : si la colonne « Taux
//    appliqué » imprime 0,0000 % à côté de « À vérifier », le marchand lit une panne.
// ---------------------------------------------------------------------------
console.log('\n7. le $/transaction s\'affiche au lieu de 0,0000 %');
const N = require('../notes');
ok('palier Flash rendu en $/transaction (fr)',
  N.fmtRateCell(0, 0.035, 'fr') === '0,0350 $/tr.', N.fmtRateCell(0, 0.035, 'fr'));
ok('palier Flash rendu en $/transaction (en)',
  N.fmtRateCell(0, 0.0342, 'en') === '$0.0342/txn', N.fmtRateCell(0, 0.0342, 'en'));
// ⚠️ Comparé à fmtPct() plutôt qu'à « 0,1700 % » écrit en toutes lettres : fmtPct met une
// espace INSÉCABLE devant le %, invisible dans le fichier. Un littéral avec une espace
// ordinaire échoue en affichant deux chaînes rigoureusement identiques à l'écran.
ok('un vrai pourcentage passe toujours par fmtPct',
  N.fmtRateCell(0.0017, 0.05, 'fr') === N.fmtPct(0.0017, 'fr'), N.fmtRateCell(0.0017, 0.05, 'fr'));
ok('rien à montrer reste un tiret', N.fmtRateCell(null, null, 'fr') === '—', N.fmtRateCell(null, null, 'fr'));

// Bout à bout : la ligne mélangée traverse le classifieur ET le rendu.
ok('la ligne mélangée s\'affiche avec son taux moyen',
  N.fmtRateCell(mix.rate, mix.perItem, 'fr') === '0,0342 $/tr.',
  N.fmtRateCell(mix.rate, mix.perItem, 'fr'));
ok('la moyenne reconstituée s\'affiche aussi',
  N.fmtRateCell(derived.rate, derived.perItem, 'fr') === '0,0430 $/tr.',
  N.fmtRateCell(derived.rate, derived.perItem, 'fr'));

// ---------------------------------------------------------------------------
// 8. Les frais de COMMUTATION Interac. Le dictionnaire d alias ne touchait jamais les
//    lignes Interac — les deux autres classificateurs le consultent, celui-ci avait ete
//    oublie. « INTERAC FRAIS DE COMM-FLASH » sortait donc sans categorie, indistinguable
//    d un frais inconnu, alors que nos tables connaissent ce frais.
// ---------------------------------------------------------------------------
console.log("" + String.fromCharCode(10) + "8. une ligne de commutation porte son nom");
const comm = C.classifyInteracLine(
  { desc: "INTERAC FRAIS DE COMM-FLASH", total: 12.59, count: 820, perItem: 12.59 / 820 },
  { processor: "clover" });
ok("la ligne est nommee", /commutation/i.test(comm.cat || ""), comm.cat);
ok("statut A verifier, jamais Conforme", comm.status === C.STATUS.A_VERIFIER, comm.status);
// Le taux facture NE DOIT PAS etre declare conforme : aucun acquereur ne facture notre
// valeur de table, et les deux acquereurs sont en desaccord entre eux.
ok("le taux publie est annonce pour que l ecart soit lisible",
  Number(comm.publishedPerItem) > 0, comm.publishedPerItem);
ok("la raison dit que c est le CHIFFRE qui diverge, pas le nom",
  /taux factur/i.test(comm.why || ""), comm.why);

// Le meme frais chez l autre acquereur, a un chiffre tres different.
const commPf = C.classifyInteracLine(
  { desc: "Frais de commutation Interac", total: 30.83, count: 1467, perItem: 30.83 / 1467 },
  { processor: "payfacto" });
ok("Payfacto nomme aussi sa ligne", /commutation/i.test(commPf.cat || ""), commPf.cat);
ok("et reste A verifier malgre 50 % d ecart", commPf.status === C.STATUS.A_VERIFIER, commPf.status);

// Garde-fou : un alias ne doit pas transformer un ecart en SUSPECT. SUSPECT vise le NOM,
// pas le montant — accuser par le montant masquerait la vraie question (quel est le
// barème publie ?).
ok("un ecart de montant ne devient jamais SUSPECT",
  comm.status !== C.STATUS.SUSPECT && commPf.status !== C.STATUS.SUSPECT);

console.log(fails === 0 ? '\nTOUT PASSE\n' : `\n${fails} ECHEC(S)\n`);
process.exit(fails === 0 ? 0 : 1);
