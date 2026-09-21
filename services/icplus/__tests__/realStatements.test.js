// Cases taken verbatim off REAL statements, not invented. Each one here was a bug the
// constructed tests passed straight through — which is the whole argument for §9.4's
// "regression-test against cached real statements" rule.
//
// Source: globalpay.pdf — Global Payments, French layout, statement date 31/05/26,
// merchant DINER SAINT SAUVEUR. Rate column on this layout is a PERCENT (0.0900 = 0.09 %),
// so every rate below is divided by 100 before it reaches the classifier.
const C = require('../classify');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

const brand = (desc, pct, volume, total) =>
  C.classifyBrandLine({ desc, rate: pct / 100, volume, total }, { processor: 'global' });

// ---- brand guard.
// ⚠️ Ce relevé RÉEL facture les deux évaluations à 0,0900 %. Tant que la table portait
// 0,0900 % pour les deux réseaux, la proximité de taux ne pouvait pas les séparer et la
// première entrée gagnait : c'est ainsi que « MC ASMTS » est ressorti étiqueté frais VISA,
// et c'est ce qui a fait naître brandConflict().
//
// ⚠️⚠️ Depuis le 2026-09-21 la table porte Visa 0,0900 % et **Mastercard 0,1000 %**
// (Christine). La garde de marque en devient PLUS nécessaire, pas moins : la ligne
// « MC ASMTS » facturée 0,0900 % tombe désormais pile sur l'entrée VISA, et seule la garde
// l'empêche d'être déclarée conforme à un taux qui n'est pas celui de sa marque.
const visaAsmts = brand('VISA ASMTS', 0.0900, 23477.14, 21.14);
const mcAsmts   = brand('MC ASMTS',   0.0900, 17014.83, 15.32);
ok('VISA ASMTS -> Conforme', visaAsmts.status === C.STATUS.CONFORME, visaAsmts.status);
ok('VISA ASMTS -> Visa category', /^Visa/.test(visaAsmts.cat || ''), visaAsmts.cat);

// ⚠️ C'est le fait à retenir de ce relevé : Global facture l'évaluation Mastercard à
// 0,0900 % alors que le réseau publie 0,1000 %. Le marchand paie donc MOINS que le tarif
// publié sur cette ligne — l'outil n'a rien à dénoncer, mais il n'a pas non plus de
// catégorie où la loger, et il le dit : « À vérifier ». C'est le repli voulu ; le silence
// ou un « Conforme » de complaisance seraient tous deux des mensonges.
ok('MC ASMTS -> À vérifier (0,0900 % facturé contre 0,1000 % publié)',
  mcAsmts.status === C.STATUS.A_VERIFIER, mcAsmts.status);
ok('MC ASMTS n\'emprunte PAS la catégorie Visa qui porte le même 0,0900 %',
  !/^Visa/.test(mcAsmts.cat || ''), mcAsmts.cat);
ok('et sous-facturé n\'est jamais signalé SUSPECT', mcAsmts.status !== C.STATUS.SUSPECT, mcAsmts.status);

ok('brand conflict detected', C.brandConflict('MC ASMTS', 'Visa — Frais d\'évaluation') === true);
ok('same brand does not conflict', C.brandConflict('MC ASMTS', 'Mastercard — Frais d\'évaluation') === false);
ok('brandless line never conflicts', C.brandConflict('TOTAL DES FRAIS', 'Visa — quoi que ce soit') === false);
// "/" separates brands; without splitting it, neither token sits at a space boundary.
ok('Visa/Mastercard names both brands', (() => {
  const s = C.brandsIn('Visa/Mastercard — cross-border');
  return s.has('visa') && s.has('mc');
})(), [...C.brandsIn('Visa/Mastercard — cross-border')]);
ok('VISA/MC - CARD BRAND MAINTENANCE names both', (() => {
  const s = C.brandsIn('VISA/MC - CARD BRAND MAINTENANCE');
  return s.has('visa') && s.has('mc');
})(), [...C.brandsIn('VISA/MC - CARD BRAND MAINTENANCE')]);

// ---- TAX REIMBURSEMENT CH.
// Bills 0.0200 % — Visa's ARQ authorization-estimate fee — under a tax-sounding name, with
// no separate ARQ line anywhere on the statement. It matches ARQ perfectly on rate, so
// without the SUSPECT label it reports "Conforme": the opposite of the warning it earns.
const taxReimb = brand('TAX REIMBURSEMENT CH', 0.0200, 40491.97, 8.10);
ok('TAX REIMBURSEMENT CH -> SUSPECT, not Conforme', taxReimb.status === C.STATUS.SUSPECT, taxReimb.status);

// ---- junk fee still fires normally
ok('DATASECFEE -> SUSPECT', brand('DATASECFEE', 0, 0, 25).status === C.STATUS.SUSPECT);

// ---- Interac rows in the FTNQ section are identified by the IDP FLASH prefix, and the
// tier suffix must survive ("IDP FLASH T4" is a real row on this statement).
const flashT4 = C.classifyInteracLine({ desc: 'IDP FLASH T4', rate: 0, volume: 1062.02, total: 0.50 }, { processor: 'global' });
ok('IDP FLASH T4 -> tier recognized', flashT4.tier === 'T4', flashT4.tier);
ok('IDP FLASH T4 -> not Markup processeur', flashT4.status !== C.STATUS.MARKUP, flashT4.status);

// ---- the same statement mixes straight and curly apostrophes: line 191 prints
// "Frais d’équipement" (U+2019) while line 211 prints "Frais d'interchange" (U+0027).
// Any section-header match has to survive both, so norm() must fold them together.
const CURLY = "Frais d’équipement";
const STRAIGHT = "Frais d'équipement";
ok('norm folds curly and straight apostrophes', C.norm(CURLY) === C.norm(STRAIGHT), [C.norm(CURLY), C.norm(STRAIGHT)]);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
