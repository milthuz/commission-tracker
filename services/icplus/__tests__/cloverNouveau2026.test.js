// Clover / Fiserv — mise en page 2026 (« relevé repensé »).
//
// Fixture : fixtures/clover-nouveau-2026.lines.txt — un VRAI relevé français de la période
// 07/01/2026–07/31/2026, caviardé (nom, adresse, numéro de commerçant, numéros fiscaux
// remplacés). Tous les tableaux de chiffres sont intacts, octet pour octet : c'est eux qui
// font la valeur du banc d'essai.
//
// Ce que le relevé imprime lui-même :
//   Frais             -20,22 $
//   Frais de service -475,01 $
//   -----------------------------
//   Total            -495,23 $
//
// Ce que l'outil doit en faire, et pourquoi (voir §5 du document de spécification) :
//   majoration Fiserv    67,91 $   0,15 % du crédit + 0,03 $/transaction Interac
//   transfert réseau    427,39 $   interchange + marques + frais réseau + Interac
//   -----------------------------
//   avant taxes         495,30 $   7 ¢ au-dessus de l'imprimé, par arrondi de ligne
//
// ⚠️ L'écart de 7 ¢ est VOULU et doit le rester. Le tableau d'interchange publie des TAUX,
// pas des dollars ; les montants sont reconstitués ligne à ligne et chacun s'arrondit au
// cent. Un banc d'essai qui exigerait 495,23 $ forcerait à truquer l'arrondi.
const fs = require('fs');
const path = require('path');
const dispatch = require('../parsers');
const clover = require('../parsers/clover');
const { STATUS } = require('../classify');

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'clover-nouveau-2026.lines.txt'), 'utf8').split('\n');

let fails = 0;
function ok(label, cond, got) {
  if (cond) { console.log(`  ok   ${label}`); return; }
  fails += 1;
  console.log(`  FAIL ${label}${got !== undefined ? ` -> ${JSON.stringify(got)}` : ''}`);
}
const near = (a, b, tol = 0.005) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
console.log('\n0. le banc mesure bien quelque chose');
ok('la fixture est chargée', lines.length > 300, lines.length);
ok('aucune identité ne subsiste',
  !lines.some((l) => /SAOKO|COUILLAR|GRANDE ALLEE|29445760010/i.test(l)));
ok('les tableaux de chiffres sont intacts',
  lines.some((l) => l.includes('Interac Flash 820 $19,928.16 0 $0.00 0.0000 0.0300 $65.23')));

// ---------------------------------------------------------------------------
console.log('\n1. détection et aiguillage');
ok('détecté comme Clover', dispatch.detect(lines) === 'clover', dispatch.detect(lines));
const out = dispatch.parse(lines);
ok('la note dit que c\'est la nouvelle mise en page',
  (out.notes || []).some((n) => n.code === 'cloverNewLayout'),
  (out.notes || []).map((n) => n.code));
ok('le nom du marchand vient de la ligne sous la période',
  out.merchant_name === 'COMMERCE TEMOIN', out.merchant_name);

// ---------------------------------------------------------------------------
// 2. Les volumes. C'est la base de TOUT le reste : une majoration se calcule en
//    multipliant un taux par un volume, donc un volume faux fausse l'argumentaire entier.
// ---------------------------------------------------------------------------
console.log('\n2. volumes');
const v = out.volume;
// ⚠️ débit = Interac (60) + Interac Flash (820) SEULEMENT. Visa Debit est facturé au
// pourcentage du crédit et appartient à Visa — l'avoir mis en débit faussait le comparatif.
ok('débit  880 / 21 568,09 $', v.debit_count === 880 && near(v.debit_amt, 21568.09), [v.debit_count, v.debit_amt]);
ok('Visa   459 / 12 989,38 $ (crédit 448 + débit 11)',
  v.visa_count === 459 && near(v.visa_amt, 12989.38), [v.visa_count, v.visa_amt]);
ok('MC     511 / 13 799,16 $', v.mc_count === 511 && near(v.mc_amt, 13799.16), [v.mc_count, v.mc_amt]);
ok('Amex    35 /    881,70 $', v.amex_count === 35 && near(v.amex_amt, 881.70), [v.amex_count, v.amex_amt]);

// ---------------------------------------------------------------------------
console.log('\n3. taux de majoration Fiserv');
const cp = out.current_processor;
ok('crédit à 0,15 %', near(cp.visa_rate, 0.0015, 1e-9) && near(cp.mc_rate, 0.0015, 1e-9) && near(cp.amex_rate, 0.0015, 1e-9),
  [cp.visa_rate, cp.mc_rate, cp.amex_rate]);
ok('débit à 0,03 $/transaction, 0 %', near(cp.debit_fee, 0.03, 1e-9) && cp.debit_rate === 0, [cp.debit_rate, cp.debit_fee]);

// ---------------------------------------------------------------------------
console.log('\n4. le relevé se referme');
const markup = v.visa_amt * cp.visa_rate + v.visa_count * cp.visa_fee
  + v.mc_amt * cp.mc_rate + v.mc_count * cp.mc_fee
  + v.amex_amt * cp.amex_rate + v.amex_count * cp.amex_fee
  + v.debit_amt * cp.debit_rate + v.debit_count * cp.debit_fee;
const fixed = (cp.fixed_rows || []).reduce((s, r) => s + r.amount, 0);
ok('majoration Fiserv = 67,91 $', near(markup, 67.91), markup);
ok('transfert réseau = 427,39 $', near(cp.interchange, 427.39), cp.interchange);
// ⚠️ Rien de fixe sur ce relevé. Les deux lignes « Visa Digital Commerce » y tombaient
// faute de mot-clé : une charge fixe est un frais que Cluster REMPLACE, un frais de réseau
// est un transfert que Cluster paie aussi. Mal rangées, elles surévaluaient l'économie.
ok('aucun frais fixe', near(fixed, 0), cp.fixed_rows);
ok('total avant taxes = 495,30 $ (7 ¢ au-dessus des 495,23 $ imprimés)',
  near(markup + cp.interchange + fixed, 495.30, 0.01), markup + cp.interchange + fixed);

// ---------------------------------------------------------------------------
// 5. Le double comptage. La majoration de Fiserv est imprimée DEUX FOIS sur ce relevé :
//    une fois comme taux dans le tableau de résumé, une fois comme ligne de frais. La
//    compter aux deux endroits gonfle le processeur actuel de sa marge entière.
// ---------------------------------------------------------------------------
console.log('\n5. la majoration de Fiserv n\'est comptée qu\'une fois');
const all = [...out.line_audit.interchange, ...out.line_audit.brand, ...out.line_audit.interac];
ok('« FRAIS DE TRANSACTION » (41,50 $) hors du transfert réseau',
  !all.some((r) => /FRAIS DE TRANSACTION/i.test(r.desc)), all.filter((r) => /FRAIS DE TRANSACTION/i.test(r.desc)).map((r) => r.desc));
ok('« FRAIS PAR TRAN » (26,40 $) hors du transfert réseau',
  !all.some((r) => /FRAIS PAR TRAN/i.test(r.desc)), all.filter((r) => /FRAIS PAR TRAN/i.test(r.desc)).map((r) => r.desc));
// Les codes d'interchange du tableau des frais (VSMELECONN, CANCNTLSSMCR…) sont écartés
// parce que le tableau de programme reconstitue les MÊMES dollars à partir des taux.
ok('les codes d\'interchange bruts sont écartés',
  !all.some((r) => /^(VSMELECONN|CANCNTLSSMCR|VCANPREM)$/i.test(String(r.desc).trim())),
  all.map((r) => r.desc).filter((d) => /^V[SC]|^CAN/.test(d)));

// ---------------------------------------------------------------------------
// 6. Le garde-fou de marque. Le format 2026 colle la marque au produit par un TRAIT
//    D'UNION ; le jeton n'étant pas à une frontière d'espace, douze lignes Mastercard
//    sont ressorties étiquetées de catégories VISA, avec la mention « Conforme ».
// ---------------------------------------------------------------------------
console.log('\n6. une ligne Mastercard ne porte jamais une catégorie Visa');
const mcRows = out.line_audit.interchange.filter((r) => /^MC-/i.test(r.desc));
ok('les lignes MC- sont bien là', mcRows.length >= 10, mcRows.length);
const mcMislabelled = mcRows.filter((r) => r.cat && /\bVisa\b/i.test(r.cat));
ok('aucune ligne MC- étiquetée Visa', mcMislabelled.length === 0,
  mcMislabelled.map((r) => `${r.desc} -> ${r.cat}`));
const viRows = out.line_audit.interchange.filter((r) => /^VI-/i.test(r.desc));
const viMislabelled = viRows.filter((r) => r.cat && /Mastercard/i.test(r.cat));
ok('aucune ligne VI- étiquetée Mastercard', viMislabelled.length === 0,
  viMislabelled.map((r) => `${r.desc} -> ${r.cat}`));

// ---------------------------------------------------------------------------
// 7. Interac. Le mois mélange les paliers Flash : c'est le cas réel qui a motivé le
//    correctif des paliers mélangés (voir interacFlashBlend.test.js).
// ---------------------------------------------------------------------------
console.log('\n7. Interac');
const interac = out.line_audit.interac;
ok('trois lignes Interac, 41,48 $', interac.length === 3 && near(interac.reduce((s, r) => s + r.total, 0), 41.48),
  interac.map((r) => [r.desc, r.total]));
const flashIC = interac.find((r) => /INTERCH.*FLASH/i.test(r.desc));
ok('l\'interchange Flash est rattaché aux 820 transactions', flashIC && flashIC.count === 820, flashIC && flashIC.count);
ok('soit 0,0342 $/transaction', flashIC && near(flashIC.perItem, 0.0342, 1e-4), flashIC && flashIC.perItem);
ok('reconnu comme un mois à paliers mélangés', !!(flashIC && flashIC.blendedTiers), flashIC && flashIC.cat);
ok('et non laissé sans catégorie', !!(flashIC && flashIC.cat), flashIC && flashIC.cat);
ok('statut « À vérifier », jamais SUSPECT',
  !!(flashIC && flashIC.status === STATUS.A_VERIFIER), flashIC && flashIC.status);

// ---------------------------------------------------------------------------
// 8. L'ancienne mise en page ne doit RIEN changer. C'est la moitié du contrat : les vieux
//    relevés circulent encore des mois après la refonte.
// ---------------------------------------------------------------------------
console.log('\n8. l\'ancienne mise en page passe toujours par l\'ancien chemin');
const vieux = fs.readFileSync(path.join(__dirname, 'fixtures', 'clover-fr.lines.txt'), 'utf8').split('\n');
ok('aucune ligne du tableau 2026 dans l\'ancien relevé',
  clover.parseNewSummaryRows(vieux.map((l) => l)).length === 0,
  clover.parseNewSummaryRows(vieux).length);
const vieuxOut = dispatch.parse(vieux);
ok('l\'ancien relevé ne porte pas la note « nouvelle mise en page »',
  !(vieuxOut.notes || []).some((n) => n.code === 'cloverNewLayout'));
ok('l\'ancien relevé produit toujours ses volumes',
  vieuxOut.volume.visa_amt > 0 || vieuxOut.volume.debit_amt > 0, vieuxOut.volume);

console.log(fails === 0 ? '\nTOUT PASSE\n' : `\n${fails} ECHEC(S)\n`);
process.exit(fails === 0 ? 0 : 1);
