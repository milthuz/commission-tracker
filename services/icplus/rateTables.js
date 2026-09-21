// ============================================================================
// IC+ fee-comparison calculator — reference rate data (§2 of the scope).
//
// This is the ground truth every parsed statement line gets checked against. It is
// deliberately a DATA layer with no logic in it: the classifier (classify.js) reads
// these tables, nothing here reads the classifier.
//
// ⚠️ SOURCING RULE — read before adding a number here.
// A rate in this file decides whether a merchant's fee is stamped "Conforme" or
// "SUSPECT" on a document a rep hands to a client. A wrong number here produces a
// confident, wrong accusation. So: every entry carries a `src` naming where the value
// came from (see SOURCES). No entry may be added from memory, from inference, or from
// a plausible-looking round number. A table with nothing sourced yet stays EMPTY —
// see the "empty tables" note below for why that is the safe failure direction.
//
// MAINTENANCE. These tables go stale, AND they can be wrong on arrival: the cross-border
// entries below shipped carrying what Moneris BILLS rather than what the networks PUBLISH,
// and blessed a 13 % overcharge until the published pages were checked (2026-09-21). This file needs an
// owner and a review whenever a network publishes a new schedule — it is not a
// one-time port. Bump DATA_VERSION on every change, so a saved analysis can say which
// rate vintage it was judged against.
// ============================================================================

const DATA_VERSION = '2026-09-21';

// Where each rate came from. Carried into the audit UI so a disputed line can be traced
// back to a document rather than to "the app says so".
const SOURCES = {
  visa_published:    'Visa published rate card (Canada)',
  mc_published:      'Mastercard published rate card (Canada)',
  amex_published:    'Amex published rate card (Canada)',
  visa_intl_irf:     'Visa "International Interchange Reimbursement Fees" table',
  adyen_report:      'Adyen "Interchange & Scheme Fee" report, Canada, June 2026 — ACTUAL OBSERVED network billing, not an official published rate card',
  // ⚠️ Ce qu'une entrée portant cette source vaut, exactement : un chiffre sur lequel DEUX
  // acquéreurs indépendants facturent la même somme au cent près. C'est une corroboration
  // forte d'un transfert réseau, ce n'est pas une carte publiée. Une ligne du même classeur
  // où les deux chiffres DIFFÈRENT n'a rien à faire ici — voir rateCardExcel.js.
  adyen_mapping:     'Internal "Adyen vs <acquirer> — Fee Mapping" workbook — a figure BOTH acquirers bill identically, i.e. corroborated pass-through, not a published rate card',
  moneris_notice:    'Fee-change notice printed on a real Moneris statement',
  interac_published: 'Interac published fee schedule (Switch / Mobile Service Fee, Flash contactless tiers)',
  terminology_dict:  'Internal "Fee Terminology Dictionary" (Adyen naming vs each processor\'s own)',
  statement_obs:     'Observed on a real statement and reconciled against that statement\'s own totals',
};

// ---------------------------------------------------------------------------
// The tables.
//
// Entry shape: { cat, rate, weak?, src }
//   cat   — category label, also what matchByName() fuzzy-matches a description against
//   rate  — decimal (0.0009 === 0.0900 %)
//   weak  — see below
//   src   — a SOURCES key
//
// `weak: true` marks a rate that is only trustworthy as a match if the line's own
// description ALSO shares keywords with `cat`. Some rate values coincidentally collide
// across unrelated fee categories, and a bare numeric hit on one of those is not
// evidence of anything. matchByRate() refuses to accept a weak entry on rate proximity
// alone — see classify.js.
//
// ✅ LES TABLES SONT REMPLIES DEPUIS LE 2026-09-21. Pendant tout le portage elles étaient
// VIDES : le devis (§2) nommait les huit tables et fixait leur forme, mais les VALEURS
// vivaient dans l'implémentation de référence (Cluster_IC_Calculateur.html), introuvable
// à l'époque. Plutôt que de les amorcer avec des nombres inventés, elles ont voyagé vides
// — un échec dans la bonne direction : rien ne correspond, donc tout tombe sur
// « À vérifier », jamais un faux « Conforme » ni un faux « SUSPECT ».
//
// Le fichier de référence a fini par être fourni. Les 113 valeurs qu'il portait sont ici,
// recoupées contre le classeur « Adyen vs Moneris » : 35 des 36 taux du classeur s'y
// retrouvent À L'IDENTIQUE, aucun « proche mais différent ».
//
// ⚠️ UNE ENTRÉE PORTE UN TAUX **OU** UN MONTANT PAR TRANSACTION, jamais les deux. Le
// fichier de référence rangeait ses dollars par transaction dans un champ nommé `rate` —
// il s'en tirait parce que ses appelants lui passaient un montant par transaction, mais
// il imprimait « 3,500 % » pour 0,035 $ dans une note destinée au client. Les 15 entrées
// concernées (Interac Flash et réseau, et les lignes « USD/txn » d'Adyen) sont ici en
// `perItem`. Le classeur Moneris confirme l'unité de son côté : CAN-ZTI3 = 0,035 $/item.
//
// SUSPECT ne dépend toujours pas de ces tables : il vient des listes de libellés en bas
// de ce fichier, et fonctionnait déjà quand tout était vide.
// ---------------------------------------------------------------------------

// Visa domestic interchange (Canada), by qualifying category.
// ⚠️ Chargées le 2026-09-21 depuis le calculateur HTML de référence
// (Cluster_IC_Calculateur.html), enfin retrouvé — c'est la source dont le devis
// d'ingénierie avait été rétro-conçu et où ces valeurs vivaient.
//
// Recoupées contre le classeur « Adyen vs Moneris » : 35 des 36 taux qu'il porte se
// retrouvent ICI À L'IDENTIQUE, et aucun « proche mais différent ». La seule absente
// est Discover, qui n'a pas de table dans ce modèle.
const visaDomestic = [
  { cat: 'Visa Crédit conso. — Petit commerçant CP', rate: 0.0077, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Électronique (Classic/Gold/Platinum)', rate: 0.0125, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Électronique (Infinite)', rate: 0.0157, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Électronique (Infinite+)', rate: 0.016, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Électronique (Infinite Privilege)', rate: 0.0208, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Programme industrie (Besoins courants)', rate: 0.011, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Programme industrie (Essence)', rate: 0.0107, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Programme industrie (Épicerie)', rate: 0.0095, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Programme Performance CP', rate: 0.012, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Petit commerçant CNP', rate: 0.013, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Carte non présente', rate: 0.014, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Paiements récurrents', rate: 0.0125, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Standard (non qualifiée)', rate: 0.0145, src: 'visa_published' },
  { cat: 'Visa Crédit conso. — Segments émergents', rate: 0.0098, src: 'visa_published' },
  { cat: 'Visa Affaires — Standard (Business)', rate: 0.02, src: 'visa_published' },
  { cat: 'Visa Affaires — Standard (Infinite Business)', rate: 0.0235, src: 'visa_published' },
  { cat: 'Visa Corporatif/Achat — Électronique', rate: 0.019, src: 'visa_published' },
  { cat: 'Visa Corporatif/Achat — Standard (Corporate/Purchasing)', rate: 0.02, src: 'visa_published' },
  { cat: 'Visa Corporatif/Achat — Données enrichies Essence (Fuel)', rate: 0.018, src: 'visa_published' },
  { cat: 'Visa Corporatif/Achat — Données enrichies Niveau 2', rate: 0.016, src: 'visa_published' },
  { cat: 'Visa Corporatif/Achat — Données enrichies Niveau 3', rate: 0.014, src: 'visa_published' },
  { cat: 'Visa Corporatif/Achat — Gros achat Palier 1 (100 000$-249 999$)', rate: 0.013, src: 'visa_published' },
  { cat: 'Visa Corporatif/Achat — Gros achat Palier 2 (250 000$+)', rate: 0.01, src: 'visa_published' },
  { cat: 'Visa Prépayée conso. — Électronique', rate: 0.0142, src: 'visa_published' },
  { cat: 'Visa Prépayée conso. — Standard', rate: 0.0152, src: 'visa_published' },
  { cat: 'Visa Prépayée commerciale — Standard', rate: 0.02, src: 'visa_published' },
  { cat: 'Visa Débit — Standard', rate: 0.0115, src: 'visa_published' },
  { cat: 'Visa Débit — Paiements récurrents', rate: 0.006, src: 'visa_published' },
];

// Mastercard domestic interchange (Canada), by qualifying category.
const mcDomestic = [
  { cat: 'Mastercard Crédit conso. — Carte présente EMV — PME (Core)', rate: 0.007, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Carte présente EMV (Core)', rate: 0.0092, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Carte présente EMV (World)', rate: 0.0122, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Carte présente EMV (World Elite)', rate: 0.0156, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Carte présente EMV (World Legend)', rate: 0.0195, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Contactless (Core)', rate: 0.0092, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Contactless (World)', rate: 0.0122, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Contactless (World Elite)', rate: 0.0156, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Commerce numérique (Core)', rate: 0.0167, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Standard (Core, non qualifiée)', rate: 0.0196, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Standard (World)', rate: 0.0219, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Remboursement CP (Core)', rate: 0.0055, src: 'mc_published' },
  { cat: 'Mastercard Crédit conso. — Remboursement CNP (Core)', rate: 0.0106, src: 'mc_published' },
  { cat: 'Mastercard Prépayée conso. — Électronique', rate: 0.0144, src: 'mc_published' },
  { cat: 'Mastercard Prépayée conso. — Standard', rate: 0.0155, src: 'mc_published' },
  { cat: 'Mastercard Commercial Standard — PME/Prépayée', rate: 0.02, src: 'mc_published' },
  { cat: 'Mastercard Commercial Standard — Large Market', rate: 0.02, src: 'mc_published' },
  { cat: 'Mastercard Commercial Standard — World Elite for Business', rate: 0.0235, src: 'mc_published' },
  { cat: 'Mastercard Commercial Charity', rate: 0.018, src: 'mc_published' },
  { cat: 'Mastercard Commercial — Data Rate 1 (Large Market)', rate: 0.018, src: 'mc_published' },
  { cat: 'Mastercard Commercial — Data Rate 2 (Large Market)', rate: 0.014, src: 'mc_published' },
  { cat: 'Mastercard Commercial — Large Ticket (Large Market)', rate: 0.012, src: 'mc_published' },
  { cat: 'Mastercard Débit — Standard', rate: 0.0115, src: 'mc_published' },
  { cat: 'Mastercard Débit — Paiements récurrents', rate: 0.006, src: 'mc_published' },
];

// Visa international / cross-border interchange.
const visaInternational = [
  { cat: 'Visa International — Carte présente (Base) — Classic/Gold/Platinum/Electron', rate: 0.011, src: 'visa_intl_irf' },
  { cat: 'Visa International — Carte présente (Base) — Signature/Premium', rate: 0.0185, src: 'visa_intl_irf' },
  { cat: 'Visa International — Carte présente (Base) — Signature Preferred/Infinite', rate: 0.0198, src: 'visa_intl_irf' },
  { cat: 'Visa International — Carte présente (Base) — Tous produits commerciaux', rate: 0.02, src: 'visa_intl_irf' },
  { cat: 'Visa International — Carte absente (Alternative) — Classic/Gold/Platinum/Electron', rate: 0.016, src: 'visa_intl_irf' },
  { cat: 'Visa International — Carte absente (Alternative) — Signature/Premium', rate: 0.0185, src: 'visa_intl_irf' },
  { cat: 'Visa International — Carte absente (Alternative) — Signature Preferred/Infinite', rate: 0.0198, src: 'visa_intl_irf' },
  { cat: 'Visa International — Carte absente (Alternative) — Tous produits commerciaux', rate: 0.02, src: 'visa_intl_irf' },
  { cat: 'Visa International — Déclassé (Downgrade) — Classic/Gold/Platinum/Electron', rate: 0.0165, src: 'visa_intl_irf' },
  { cat: 'Visa International — Déclassé (Downgrade) — Signature/Premium', rate: 0.019, src: 'visa_intl_irf' },
  { cat: 'Visa International — Déclassé (Downgrade) — Signature Preferred/Infinite', rate: 0.0203, src: 'visa_intl_irf' },
  { cat: 'Visa International — Déclassé (Downgrade) — Tous produits commerciaux', rate: 0.0205, src: 'visa_intl_irf' },
  { cat: 'Visa International — Bon de crédit (Credit Voucher) — Classic/Gold/Platinum/Electron', rate: 0.01, src: 'visa_intl_irf' },
  { cat: 'Visa International — Bon de crédit (Credit Voucher) — Signature/Premium', rate: 0.01, src: 'visa_intl_irf' },
  { cat: 'Visa International — Bon de crédit (Credit Voucher) — Signature Preferred/Infinite', rate: 0.01, src: 'visa_intl_irf' },
  { cat: 'Visa International — Bon de crédit (Credit Voucher) — Tous produits commerciaux', rate: 0.018, src: 'visa_intl_irf' },
];

// Mastercard international / cross-border interchange.
const mcInternational = [
  { cat: 'Mastercard International — Consumer Rate II CP (Core)', rate: 0.011, src: 'mc_published' },
  { cat: 'Mastercard International — Consumer Rate II CP (Premium)', rate: 0.0185, src: 'mc_published' },
  { cat: 'Mastercard International — Consumer Rate II CP (Super Premium)', rate: 0.0198, src: 'mc_published' },
  { cat: 'Mastercard International — Consumer Rate I Commerce numérique (Core)', rate: 0.016, src: 'mc_published' },
  { cat: 'Mastercard International — Consumer Rate III Base (Core)', rate: 0.0165, src: 'mc_published' },
  { cat: 'Mastercard International — Commercial Standard', rate: 0.02, src: 'mc_published' },
  { cat: 'Mastercard International — Commercial Electronic Product', rate: 0.0185, src: 'mc_published' },
];

// Network fees that are neither interchange nor a scheme fee — assessments, access and
// licence fees the acquirer passes straight through.
const networkFees = [
  // Visa's and Mastercard's domestic assessment. The scope document is explicit that the
  // correct figure is 0.0900 %, and that this line is a known inflation target: 0.1017 %,
  // 0.1250 % and 0.1500 % have all been observed billed under this same name. Those
  // inflated values are deliberately NOT entered as categories of their own — they are
  // not real rates, and adding them would let an inflated charge match as "Conforme".
  // They belong in the help text instead (HELP.assessmentInflation).
  { cat: 'Visa — Frais d\'évaluation (assessment, domestique)',       rate: 0.0009,  src: 'visa_published' },

  // ⚠️ CORRIGÉ le 2026-09-21 : Mastercard est à 0,1000 %, pas 0,0900 %. Les deux réseaux
  // avaient été saisis à la même valeur ; ils diffèrent. (Christine, tranché en séance.)
  //
  // Ce qui l'a levé : dans le classeur de correspondance, Adyen facture 0,0900 % pour Visa
  // et 0,1000 % pour Mastercard — DEUX valeurs distinctes — alors que Moneris aplatit les
  // deux à 0,1017 %. Un acquéreur qui distingue là où l'autre uniformise, c'est celui qui
  // distingue qui suit la carte publiée.
  //
  // Conséquence sur les verdicts : le 0,1017 % facturé reste une inflation sur les DEUX
  // réseaux, mais d'ampleur très différente — ×1,13 sur Visa, seulement ×1,017 sur MC.
  { cat: 'Mastercard — Frais d\'évaluation (assessment, domestique)', rate: 0.0010,  src: 'mc_published'   },

  // ⚠️ CORRIGÉ le 2026-09-21 à partir des pages publiées de Visa et de Mastercard, fournies
  // par Christine. Ces entrées portaient 0,678 % et 1,13 %, valeurs tirées d'un avis de
  // changement de tarif imprimé sur un relevé MONERIS — donc ce que Moneris FACTURE, jamais
  // ce que les réseaux PUBLIENT.
  //
  // Le rapport le dit sans ambiguïté : 0,678 / 0,60 = 1,1300 et 1,13 / 1,00 = 1,1300. Les
  // deux sont le taux publié multiplié par exactement 1,13. Tant que les mauvaises valeurs
  // étaient ici, un relevé facturant 0,678 % ressortait « Conforme » et l'outil bénissait
  // une surfacturation de 13 % au lieu de la dénoncer — l'inverse exact de son travail.
  //
  // Visa nomme ça l'IASF, Mastercard l'Acquirer Cross-Border Assessment; les libellés
  // diffèrent, les chiffres non. Ils sont donc portés par réseau, avec le libellé de chacun.
  { cat: 'Visa — IASF, achat multidevise (international)',                       rate: 0.0060, src: 'visa_published' },
  { cat: 'Visa — IASF, achat en devise unique (international)',                  rate: 0.0100, src: 'visa_published' },
  { cat: 'Mastercard — Évaluation transfrontalière, transaction en CAD',         rate: 0.0060, src: 'mc_published' },
  { cat: 'Mastercard — Évaluation transfrontalière, devise autre que CAD (DCC)', rate: 0.0100, src: 'mc_published' },

  // Visa's authorization-estimate fee. The scope document notes this one "seems to hide"
  // inside Global's TAX REIMBURSEMENT CH row without being isolated separately — so a
  // match here is informative even when the row is named something else entirely.
  { cat: 'Visa — ARQ (estimation d\'autorisation)',                   rate: 0.0002,  src: 'visa_published' },

  // Amex's assessment column as disclosed on Clover/Fiserv statements. Approximate by
  // nature (the column prints rounded), hence `weak`.
  { cat: 'Amex — Assessment',                                         rate: 0.0012,  weak: true, src: 'statement_obs' },
  { cat: 'Amex — Frais transaction non présentée (CNP)',               rate: 0.0030,  src: 'amex_published' },
];

// Scheme fees (Canada) — what the networks charge the acquirer for running the
// transaction, distinct from both interchange and assessments.
const schemeFeesCA = [
  { cat: 'Visa — CA Domestic Assessment Fee (Adyen, TPS incluse)', rate: 0.0009, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA Commercial Solutions Fee (Adyen, TPS incluse)', rate: 0.0001, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA Domestic Card-Present Token Fee (Adyen)', rate: 0.0001, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA Cross-Border Card-Present Token Fee (Adyen)', rate: 0.0005, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA International Assessment Fee, réglé en CAD (Adyen, TPS incluse)', rate: 0.0063, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA International Assessment CP Fee, réglé hors CAD (Adyen, TPS incluse)', rate: 0.0105, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA Domestic Digital Commerce Services Fee (Adyen, TPS incluse)', rate: 0.0002, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA International Digital Commerce Services Fee (Adyen, TPS incluse)', rate: 0.0004, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA Address Verification Service (AVS) Fee, USD/txn (Adyen, TPS incluse)', perItem: 0.00105, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA CVV2 Transaction Fee, USD/txn (Adyen, TPS incluse)', perItem: 0.002625, weak: true, src: 'adyen_report' },
  { cat: 'Visa — CA Domestic Account Verifications Fee, USD/txn (Adyen)', perItem: 0.01, weak: true, src: 'adyen_report' },
  { cat: 'Visa — Misuse of Authorisation Fee, USD/txn (Adyen)', perItem: 0.05, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Domestic Assessment Fee (Adyen, TPS incluse)', rate: 0.001, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA International Assessment Fee (Adyen, TPS incluse)', rate: 0.001, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Mastercard License Fee (Adyen, TPS incluse)', rate: 0.0001, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Digital Enablement Fee (Adyen, TPS incluse)', rate: 0.0002, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA MO/TO Fee (Adyen, TPS incluse)', rate: 0.0002, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Global Wholesale Program Fee (Adyen, TPS incluse)', rate: 0.0079, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Cross-Border Purchase Local Currency Fee, réglé en CAD (Adyen, TPS incluse)', rate: 0.0063, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Cross-Border Purchase Local Currency Fee, réglé hors CAD (Adyen, TPS incluse)', rate: 0.0105, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)', perItem: 0.009765, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Acquirer Clearing Fee, petit montant, USD/txn (Adyen, TPS incluse)', perItem: 0.00525, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Acquirer Clearing Fee, gros montant, USD/txn (Adyen, TPS incluse)', perItem: 0.02, weak: true, src: 'adyen_report' },
  { cat: 'Mastercard — CA Decline Reason Code Service Pricing, USD/txn (Adyen)', perItem: 0.02, weak: true, src: 'adyen_report' },
  { cat: 'Amex — Inbound Fee CAD, international (Adyen)', rate: 0.006, weak: true, src: 'adyen_report' },
  { cat: 'Discover — Acquirer Assessment Fee (Adyen, TPS incluse)', rate: 0.0007, weak: true, src: 'adyen_report' },
  { cat: 'Discover — International Processing Fee (Adyen, TPS incluse)', rate: 0.0042, weak: true, src: 'adyen_report' },
  { cat: 'Diners Club — Acquirer Assessment Fee (Adyen, TPS incluse)', rate: 0.0007, weak: true, src: 'adyen_report' },
  { cat: 'Diners Club — International Processing Fee (Adyen, TPS incluse)', rate: 0.0042, weak: true, src: 'adyen_report' },
  { cat: 'UnionPay — International POS Scheme Fees (Adyen)', rate: 0.001, weak: true, src: 'adyen_report' },
];

// Interac Switch / Mobile Service Fee.
const interacNetwork = [
  { cat: 'Interac — Frais de commutation (retrait GAB)', perItem: 0.015881, src: 'interac_published' },
  { cat: 'Interac — Frais de commutation (Puce et NIP / sans contact)', perItem: 0.013985, src: 'interac_published' },
  { cat: 'Interac — Frais de service mobile (sans contact mobile)', perItem: 0.013985, src: 'interac_published' },
];

// Interac Flash contactless interchange, by tier.
const interacFlash = [
  { cat: 'Interac Flash — Palier 1 (petits commerçants admissibles, ≤100$)', perItem: 0.02, src: 'interac_published' },
  { cat: 'Interac Flash — Palier 2 (haut volume ≥20M txn/an, ≤100$)', perItem: 0.025, src: 'interac_published' },
  { cat: 'Interac Flash — Palier 3 (tous les autres commerçants, ≤100$)', perItem: 0.035, src: 'interac_published' },
  { cat: 'Interac Flash — Palier 4 (100,01$-250$, tous commerçants)', perItem: 0.055, src: 'interac_published' },
];

const RATE_TABLES = {
  visaDomestic, mcDomestic, visaInternational, mcInternational,
  networkFees, schemeFeesCA, interacNetwork, interacFlash,
};

// Which tables actually carry sourced data. The UI reads this so an audit run against
// incomplete data SAYS so, instead of quietly returning "À vérifier" on every line and
// looking like a parsing failure.
function tableStatus() {
  const status = {};
  for (const [name, rows] of Object.entries(RATE_TABLES)) {
    status[name] = { entries: rows.length, sourced: rows.length > 0 };
  }
  return status;
}

function tablesIncomplete() {
  return Object.values(RATE_TABLES).some((rows) => rows.length === 0);
}

// Names of the tables still waiting on sourced data — surfaced verbatim in the UI banner
// so whoever fills them knows exactly what is outstanding.
function unsourcedTables() {
  return Object.entries(RATE_TABLES).filter(([, rows]) => rows.length === 0).map(([name]) => name);
}

// ---------------------------------------------------------------------------
// Alias dictionaries — a processor's own cryptic codes → a normalized description.
//
// ⚠️ Alias identity is checked BEFORE rate-proximity matching (see classify.js). That
// ordering is not cosmetic: it fixes a real bug where Global Payments interchange rows
// that had a perfectly good alias match were being reclassified as Interac purely
// because their dollar-derived rate happened to land near an Interac rate. A known name
// beats a coincidental number, always.
// ---------------------------------------------------------------------------

// Global Payments interchange row codes. The VIBS/VINF families are Visa qualifying
// categories; note the hyphenated forms ("HI-NET") — the row-label regex in the Global
// parser must stay permissive of hyphens or these rows vanish silently (a reproducible
// ~$72.50 total mismatch against a real statement).
const GLOBAL_INTERCHANGE_ALIASES = {
  'VIBS CDN HI-NET STD': 'Visa — Business Standard, réseau haut',
  'VINF CDN HI-NET EMV': 'Visa — Infinite EMV, réseau haut',
};

// Global Payments brand / assessment row codes.
const GLOBAL_BRAND_ALIASES = {
  'ASMTS': 'Visa/Mastercard — Frais d\'évaluation (assessment)',
};

// Moneris section-4 rows that look like Moneris's own markup but are genuine network
// pass-through. Established by reconciling section 6's rollup, which equals section 2 +
// section 3 exactly and therefore leaves zero room for a section-4 network row: anything
// here that IS a network fee has to move out of the markup total and into interchange,
// or the two sides stop adding up.
// ⚠️ DOCUMENTATION, pas une liste active. Le partage de la section 4 se fait sur la présence
// du mot « TRANSACTION » (voir isSection4Markup dans parsers/moneris.js) ; ceci recense les
// lignes de transfert réseau réellement observées, pour qu'on sache ce que la section
// contient. Trois lignes en ont été RETIRÉES le 2026-09-21 — voir juste en dessous.
const MONERIS_SECTION4_NETWORK_ROWS = [
  'MC - FRAIS COMPENSATION',
  'MC - CLEARING FEE - SMALL TICKET',
  'MC - CLEARING FEE - LARGE TICKET',
  'FRAIS DE CONNEXION AU RÉSEAU',
  'NETWORK CONNECTIVITY FEE',
  'VISA/MC - CARD BRAND MAINTENANCE',
];

// ⚠️ MAJORATION DE L'ACQUÉREUR DÉGUISÉE EN FRAIS RÉSEAU (Moneris).
//
// Le devis §4 listait ces trois lignes comme du transfert réseau authentique « déguisé en
// majoration ». C'est l'inverse : elles sont facturées par l'acquéreur, pas par le réseau.
//
// Le test qui tranche, et il est décisif : **Adyen ne les facture pas.** Un vrai frais de
// réseau, tout acquéreur le paie et le refacture — un concurrent qui traite les mêmes
// réseaux canadiens ne peut pas y échapper. Qu'un autre acquéreur ne le charge pas prouve
// que ce n'est pas le réseau qui le réclame. (Confirmé par Christine, 2026-09-21, sur la
// base du classeur « Adyen vs Moneris ».)
//
// Le libellé français le disait déjà : « (ACQUÉREUR) ». Un frais nommé d'après l'acquéreur
// est par définition le sien, pas celui du réseau.
//
// Effet : la ligne reste comptée dans le total du processeur actuel — le marchand l'a bel
// et bien payée — mais elle est marquée SUSPECT, dupliquée dans les frais cachés, et
// SOUSTRAITE de l'interchange Cluster. Cluster ne reprend pas la majoration d'un autre.
const MONERIS_ACQUIRER_MARKUP_ROWS = [
  'VISA - FRAIS D\'ACCÈS AU SYSTÈME',
  'VISA - SYSTEM ACCESS FEE',
  'MC - FRAIS D\'ÉVALUATION (ACQUÉREUR)',
  'MC - ACQUIRER LICENSE FEE',
  'MC - FRAIS DE SAFETY NET (ACQUÉREUR)',
  'MC - SAFETY NET ACQUIRER FEE',
];

// ---------------------------------------------------------------------------
// SUSPECT labels — fee names with no corresponding real network fee, regardless of what
// rate or basis the statement discloses next to them.
//
// Centralized and extensible on purpose: every processor invents new junk-fee names, and
// the next one to be added should land here rather than inside a parser.
// ---------------------------------------------------------------------------

const GLOBAL_SUSPECT_LABELS = [
  'DATASECFEE', 'PCI NONCOM', 'PNCOMPFEE', 'PCI ADMIN',
  'NETWKACCES', 'RISK ASMT', 'PCI', 'DÉCLASSEMENT',
  // Flagged not because the dollars are fake but because the NAME hides what the row is.
  // Confirmed on a real Global statement (May 2026): the row bills 0.0200 % — Visa's ARQ
  // authorization-estimate fee — under a tax-sounding label, with no separate ARQ line
  // anywhere on the statement. Without this entry the row matches ARQ cleanly and reports
  // "Conforme", which is the opposite of the warning it deserves. See HELP.hiddenArq.
  'TAX REIMBURSEMENT CH',
];

// No card network publishes a "PCI non-compliance" fee — it is a processor penalty
// deliberately named to resemble a network charge.
const NUVEI_SUSPECT_LABELS = [
  'PCI',
  'PCI NON-COMPLIANCE ASSESSMENT FEE',
];

// Real-time push-payment product names. These ARE real fees — for a product a normal
// card-present merchant would never legitimately be charged for. Routed into the BRAND
// audit table specifically so the resemblance to real network terminology is visible
// side by side.
const PUSH_PAYMENT_SUSPECT_LABELS = [
  'MASTERCARD SEND',
  'VISA DIRECT',
];

const SUSPECT_LABELS = {
  global:  GLOBAL_SUSPECT_LABELS,
  nuvei:   [...NUVEI_SUSPECT_LABELS, ...PUSH_PAYMENT_SUSPECT_LABELS],
  moneris: MONERIS_ACQUIRER_MARKUP_ROWS,
  shared:  ['PCI NONCOM', 'PNCOMPFEE'],
};

// ---------------------------------------------------------------------------
// Review help — which hints apply to which processor. Wording lives in notes.js so every
// piece of rep-facing text in this feature renders through one bilingual catalogue.
// ---------------------------------------------------------------------------
const HELP = [
  { code: 'helpCrossBorderUplift',      processors: ['moneris', 'global', 'clover', 'nuvei', 'payfacto', 'chase'] },
  { code: 'helpAssessmentInflation',    processors: ['global', 'moneris', 'clover', 'nuvei', 'payfacto', 'chase'] },
  { code: 'helpDuplicateSecurityFee',   processors: ['global'] },
  { code: 'helpZeroBasisFee',           processors: ['global'] },
  { code: 'helpHiddenArq',              processors: ['global'] },
  { code: 'helpMonerisServiceSection',  processors: ['moneris'] },
  { code: 'helpCloverHiddenInterchange',processors: ['clover'] },
  { code: 'helpNuveiValueAdded',        processors: ['nuvei'] },
  { code: 'helpDiscoverFoldedIntoVisa', processors: ['moneris'] },
];

// The review hints that apply to one processor, as note records the caller renders in the
// rep's own language. The wording itself lives in notes.js, with the parser notes.
function helpFor(processor) {
  return HELP.filter((h) => h.processors.includes(processor)).map((h) => ({ code: h.code, params: {} }));
}

module.exports = {
  DATA_VERSION,
  SOURCES,
  RATE_TABLES,
  visaDomestic, mcDomestic, visaInternational, mcInternational,
  networkFees, schemeFeesCA, interacNetwork, interacFlash,
  tableStatus, tablesIncomplete, unsourcedTables,
  GLOBAL_INTERCHANGE_ALIASES, GLOBAL_BRAND_ALIASES,
  MONERIS_SECTION4_NETWORK_ROWS, MONERIS_ACQUIRER_MARKUP_ROWS,
  SUSPECT_LABELS, GLOBAL_SUSPECT_LABELS, NUVEI_SUSPECT_LABELS, PUSH_PAYMENT_SUSPECT_LABELS,
  HELP, helpFor,
};
