// ============================================================================
// Comment chaque processeur NOMME, sur son relevé, un frais que nos tables connaissent
// sous un autre libellé.
//
// Tiré du « Fee Terminology Dictionary » (feuilles « Card Brand Fees » et « Interchange
// Programs »), généré le 2026-09-21. Une ligne du dictionnaire donne le nom canonique
// d'un frais AVEC son vrai taux, puis la façon dont sept processeurs l'impriment.
//
// ⚠️ POURQUOI CE FICHIER EXISTE. Le classificateur apparie une ligne de relevé à une
// catégorie de deux façons : par le TAUX et par le NOM. Le nom échoue presque toujours
// entre processeurs — « MC - EVALUATION » (Moneris) contre « Mastercard — Frais
// d'évaluation (assessment, domestique) » (notre table) ne fait que 0,70 de ressemblance,
// sous le seuil de 0,75. Restait donc le taux seul, ce qui ne distingue pas deux frais
// tarifés pareil. Ces alias rendent l'appariement par nom EXACT.
//
// ⚠️ LA JOINTURE A ÉTÉ FAITE SUR LE TAUX, PAS SUR LE NOM. La colonne canonique du
// dictionnaire porte le vrai taux ; c'est lui qui a désigné l'entrée de table. Joindre
// sur la ressemblance des noms est précisément ce qui s'est montré inutilisable ailleurs
// dans ce module (l'évaluation internationale y pointait la domestique).
//
// ⚠️ CE QUI A ÉTÉ REFUSÉ, et qu'il ne faut pas « compléter » à la main sans source :
//   • 19 lignes du dictionnaire sur 54 n'ont pas été jointes. Cinq sont RÉELLEMENT
//     ambiguës — « Visa interregional premium - 1.85 % » correspond aussi bien à
//     « Carte présente (Base) » qu'à « Carte absente (Alternative) », toutes deux à
//     1,85 %, et le dictionnaire ne tranche pas. Neuf n'ont aucune entrée de table à
//     leur valeur (Safety Net, BASE II, commutation Interac à 0,01 $, débit Visa à
//     0,03 $, Amex, Discover). Une n'annonce pas de taux du tout. CINQ décrivent
//     PLUSIEURS produits à plusieurs taux sur une seule ligne (« MC consumer contactless
//     Core / World / World Elite - 0.92 / 1.22 / 1.56% », avec trois codes Moneris en
//     face) : les joindre à une entrée unique accrochait les trois codes au mauvais
//     produit — CAN-C6A, le Core à 0,92 %, ressortait étiqueté World Elite à 1,56 %.
//   • 2 alias sont AMBIGUS chez leur processeur et ont été écartés : « ASSESSMENT FEES »
//     chez Chase désigne Visa OU Mastercard selon la section du relevé, et
//     « MC ACQ CLEARING FEE » couvre le petit et le gros montant. Un alias ambigu produit
//     un « Conforme » sur la mauvaise catégorie — pire que pas d'alias du tout.
//
// Régénérer : relire le dictionnaire et refaire la jointure ; ne pas éditer à la main
// sans noter la source dans le commentaire de la ligne.
// ============================================================================

const PROCESSOR_ALIASES = {
  // 15 alias
  global: {
    'AMEX ASMTS': 'Amex — Assessment',
    'AMEX XB CDN': 'Amex — Inbound Fee CAD, international (Adyen)',
    'DISC ASMTS': 'Discover — Acquirer Assessment Fee (Adyen, TPS incluse)',
    'DISC INTL': 'Discover — International Processing Fee (Adyen, TPS incluse)',
    'MC ASMTS': 'Mastercard — Frais d\'évaluation (assessment, domestique)',
    'MC DATA USAGE': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'MC LICENSE FEE': 'Mastercard — CA Mastercard License Fee (Adyen, TPS incluse)',
    'MCASMTS': 'Mastercard — Frais d\'évaluation (assessment, domestique)',
    'MCCLEARMAX': 'Mastercard — CA Acquirer Clearing Fee, gros montant, USD/txn (Adyen, TPS incluse)',
    'MCCLEARMIN': 'Mastercard — CA Acquirer Clearing Fee, petit montant, USD/txn (Adyen, TPS incluse)',
    'MCLICENSEFEE': 'Mastercard — CA Mastercard License Fee (Adyen, TPS incluse)',
    'VISA ASMTS': 'Visa — Frais d\'évaluation (assessment, domestique)',
    'VISA XB CDN': 'Visa — IASF, achat multidevise (international)',
    'VISAASMTS': 'Visa — Frais d\'évaluation (assessment, domestique)',
    'VISAXBCDN': 'Visa — IASF, achat multidevise (international)',
  },

  // 17 alias
  chase: {
    'IASF/CROSS BORDER FEE': 'Visa — IASF, achat multidevise (international)',
    'MC ACQUIRING LICENSE FEE': 'Mastercard — CA Mastercard License Fee (Adyen, TPS incluse)',
    'MC COMMERCIAL ELEC': 'Mastercard Commercial Standard — Large Market',
    'MC CONNECTIVITY FEE': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'MC CONSUMER PP ELEC': 'Mastercard Prépayée conso. — Électronique',
    'MC FGN CORPORATE': 'Mastercard International — Commercial Standard',
    'OPTBLUE INTERNATIONAL FEE': 'Amex — Inbound Fee CAD, international (Adyen)',
    'OPTBLUE NETWORK FEE': 'Amex — Assessment',
    'VI BUSINESS STANDARD': 'Visa Affaires — Standard (Business)',
    'VI CA STD INFINITE BUS CAD': 'Visa Affaires — Standard (Infinite Business)',
    'VI COMMERCIAL SOLUTIONS': 'Visa — CA Commercial Solutions Fee (Adyen, TPS incluse)',
    'VI CORPORATE ELEC': 'Visa Corporatif/Achat — Électronique',
    'VI EVRDAY NEED RST INF CAD': 'Visa Crédit conso. — Électronique (Infinite)',
    'VI EVRDAY NEED RST INFPRVCAD': 'Visa Crédit conso. — Électronique (Infinite Privilege)',
    'VI INTERREGIONAL NON-PREM CARD PRESENT': 'Visa International — Carte présente (Base) — Classic/Gold/Platinum/Electron',
    'VI PREPAID STANDARD': 'Visa Prépayée conso. — Électronique',
    'VI PURCHASE ELEC': 'Visa Corporatif/Achat — Électronique',
  },

  // 30 alias
  moneris: {
    'CAN-CE01 PERSONNELLE-ELECTR-PUCE COMPLETES': 'Visa Crédit conso. — Électronique (Classic/Gold/Platinum)',
    'CAN-CE55 INFINITE PLUS ELECTRONIQUE-SNRN': 'Visa Crédit conso. — Électronique (Infinite+)',
    'CAN-CF07 INFINITE ELECR PUCE COMPL-SNRN': 'Visa Crédit conso. — Électronique (Infinite)',
    'CAN-CF27 INFINITE CA-SNRN': 'Visa International — Déclassé (Downgrade) — Classic/Gold/Platinum/Electron',
    'CAN-CF65 INFINITE PRIVILEGE CONSOM ELEC': 'Visa Crédit conso. — Électronique (Infinite Privilege)',
    'CAN-CU9 CONSOMMATEUR INTERIEUR PREPAYEE ELECTR': 'Mastercard Prépayée conso. — Électronique',
    'CAN-EE11 ELECTR-SRNR-PUCE PARTIELLE-PREPAYE': 'Visa Prépayée conso. — Électronique',
    'CAN-WFA1': 'Visa Affaires — Standard (Infinite Business)',
    'CAN-X40 MC INTRAPAYS TAUX 1': 'Mastercard Commercial Standard — Large Market',
    'CAN-XE05 ENTREPRISE-ELECTR-PUCE': 'Visa Corporatif/Achat — Électronique',
    'CAN-XE07 ACHAT-ELECTR PUCE': 'Visa Corporatif/Achat — Électronique',
    'CAN-XFA1 INFINITE PRIVILEGE AFFAIRES': 'Visa Affaires — Standard (Infinite Business)',
    'CAN-XS03 PROFESSIONNELLE-STAND-SNRN-PUCE': 'Visa Affaires — Standard (Business)',
    'DISCOVER - EVALUATION': 'Discover — Acquirer Assessment Fee (Adyen, TPS incluse)',
    'DISCOVER - TRAITEMENT INTERNATIONALE': 'Discover — International Processing Fee (Adyen, TPS incluse)',
    'FRAIS DE CONNEXION AU RESEAU': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'INT-C986 NON PREMIERE DE BASE': 'Visa International — Carte présente (Base) — Classic/Gold/Platinum/Electron',
    'INT-X61': 'Mastercard International — Commercial Standard',
    'INT-X63': 'Mastercard International — Commercial Standard',
    'INT-XIP': 'Mastercard International — Commercial Standard',
    'MASTERCARD - MISE EN OEUVRE NUMERIQUE': 'Mastercard — CA Digital Enablement Fee (Adyen, TPS incluse)',  // Mastercard - Mise en oeuvre numerique
    'MC - COMMANDES POSTALES/TELEPHONIQUES': 'Mastercard — CA MO/TO Fee (Adyen, TPS incluse)',
    'MC - EVAL. INTERNATIONALE - DEVISE ETRANGERE': 'Mastercard — CA Cross-Border Purchase Local Currency Fee, réglé hors CAD (Adyen, TPS incluse)',
    'MC - EVALUATION': 'Mastercard — Frais d\'évaluation (assessment, domestique)',
    'MC - FRAIS COMPENSATION - MONTANT ELEVE FACT': 'Mastercard — CA Acquirer Clearing Fee, gros montant, USD/txn (Adyen, TPS incluse)',  // MC - FRAIS COMPENSATION - Montant eleve fact
    'MC - FRAIS COMPENSATION - PETIT MONTANT FACT': 'Mastercard — CA Acquirer Clearing Fee, petit montant, USD/txn (Adyen, TPS incluse)',  // MC - FRAIS COMPENSATION - Petit montant fact
    'VISA - EVAL. INTERNATIONALE - UNE SEULE DEVISE': 'Visa — CA International Assessment CP Fee, réglé hors CAD (Adyen, TPS incluse)',
    'VISA - EVALUATION': 'Visa — Frais d\'évaluation (assessment, domestique)',
    'VISA - EVALUATION DE SOLUTIONS COMMERCIALES': 'Visa — CA Commercial Solutions Fee (Adyen, TPS incluse)',
    'VISA - EVALUATION INTERNATIONALE': 'Visa — IASF, achat multidevise (international)',
  },

  // 43 alias
  clover: {
    'AMEXASSESSMENTFEES': 'Amex — Assessment',
    'BUSNATL': 'Visa Affaires — Standard (Business)',
    'CANCROSSBORDERFEE': 'Visa — IASF, achat multidevise (international)',
    'CANSTDFLEXEL': 'Mastercard Prépayée conso. — Électronique',
    'CCOMMWELBUS': 'Mastercard Commercial Standard — World Elite for Business',
    'CNCONPPELEC': 'Mastercard Prépayée conso. — Électronique',
    'CNINFBSSTDNA': 'Visa Affaires — Standard (Infinite Business)',
    'DBNATL': 'Visa Débit — Standard',
    'DE COMP MC': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'ELECORNAT': 'Visa Corporatif/Achat — Électronique',
    'ELEPPNATL': 'Visa Prépayée conso. — Électronique',
    'FRAISACQMAST-TPSINCLUSE': 'Mastercard — Frais d\'évaluation (assessment, domestique)',
    'FRAISACQVISA-TPSINCLUSE': 'Visa — Frais d\'évaluation (assessment, domestique)',
    'FRAISDECONNEC D AUTH MC': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',  // FRAISDECONNEC D'AUTH MC
    'FRAISDEVOLUMEPERMISDEMC': 'Mastercard — CA Mastercard License Fee (Adyen, TPS incluse)',
    'HNWIND2NAT': 'Visa Crédit conso. — Électronique (Infinite Privilege)',
    'INFIND2NAT': 'Visa Crédit conso. — Électronique (Infinite)',
    'MASTASSESSMENTFEES': 'Mastercard — Frais d\'évaluation (assessment, domestique)',
    'MC CANADA PREPAID ELECTRONIC': 'Mastercard Prépayée conso. — Électronique',
    'MCACQCLEARLARGETICKET': 'Mastercard — CA Acquirer Clearing Fee, gros montant, USD/txn (Adyen, TPS incluse)',
    'MCACQCLEARSMALLTICKET': 'Mastercard — CA Acquirer Clearing Fee, petit montant, USD/txn (Adyen, TPS incluse)',
    'MCAUTHCONNECTIVITYFEE': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'MCCANCOM': 'Mastercard Commercial Standard — Large Market',
    'MCCLEARINGCONNECTIVITYFEE': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'MCLICENSEVOLUMEFEE': 'Mastercard — CA Mastercard License Fee (Adyen, TPS incluse)',
    'NATSETLINF': 'Visa International — Déclassé (Downgrade) — Classic/Gold/Platinum/Electron',
    'VCANNPREM': 'Visa International — Carte présente (Base) — Classic/Gold/Platinum/Electron',
    'VCANPURCH': 'Visa Corporatif/Achat — Électronique',
    'VDBTASSESSMENTFEES': 'Visa — Frais d\'évaluation (assessment, domestique)',
    'VI-COMMERCIALSOLUTIONSFEE': 'Visa — CA Commercial Solutions Fee (Adyen, TPS incluse)',
    'VI-FRAISVALUATIONCOMMERCIAL': 'Visa — CA Commercial Solutions Fee (Adyen, TPS incluse)',
    'VISAASSESSMENTFEES': 'Visa — Frais d\'évaluation (assessment, domestique)',
    'VISAIASFMULTICURR': 'Visa — IASF, achat multidevise (international)',
    'VS CA SM ELECTRONIC INF NNSS': 'Visa Crédit conso. — Électronique (Infinite)',
    'VS CA SM ELECTRONIC INF PRIV': 'Visa Crédit conso. — Électronique (Infinite Privilege)',
    'VS CA SMALL MERCHANT ELECTRONIC CGP NNSS': 'Visa Crédit conso. — Électronique (Classic/Gold/Platinum)',
    'VS CA STANDARD INFINITE BUSINESS': 'Visa Affaires — Standard (Infinite Business)',
    'VS CANADA NONCHIP ELEC PPAID': 'Visa Prépayée conso. — Électronique',
    'VS CANADA STANDARD BUSINESS': 'Visa Affaires — Standard (Business)',
    'VS INTERREG NON PREMIUM BASE': 'Visa International — Carte présente (Base) — Classic/Gold/Platinum/Electron',
    'VSMELECONN': 'Visa Crédit conso. — Électronique (Classic/Gold/Platinum)',
    'VSMELEHNWN': 'Visa Crédit conso. — Électronique (Infinite Privilege)',
    'VSMELEINFN': 'Visa Crédit conso. — Électronique (Infinite)',
  },

  // 25 alias
  nuvei: {
    'ACQUIRER CLEARING FEE GT 25': 'Mastercard — CA Acquirer Clearing Fee, gros montant, USD/txn (Adyen, TPS incluse)',
    'ACQUIRER CLEARING FEE LE 25': 'Mastercard — CA Acquirer Clearing Fee, petit montant, USD/txn (Adyen, TPS incluse)',
    'BUSNATL': 'Visa Affaires — Standard (Business)',
    'CNCONPPELEC': 'Mastercard Prépayée conso. — Électronique',
    'ELECORNAT': 'Visa Corporatif/Achat — Électronique',
    'ELEPPNATL': 'Visa Prépayée conso. — Électronique',
    'MC ACQUIRER LICENSE FEE': 'Mastercard — CA Mastercard License Fee (Adyen, TPS incluse)',
    'MC ASSESSMENT': 'Mastercard — Frais d\'évaluation (assessment, domestique)',
    'MC CANADA PREPAID ELECTRONIC': 'Mastercard Prépayée conso. — Électronique',
    'MC SERVICE': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'MC TRANSMISSION': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',
    'MCCANCOM': 'Mastercard Commercial Standard — Large Market',
    'VS ASSESSMENT': 'Visa — Frais d\'évaluation (assessment, domestique)',
    'VS CA COMMERCIAL SOLUTIONS FEE': 'Visa — CA Commercial Solutions Fee (Adyen, TPS incluse)',
    'VS CA IASF MULTICURRENCY PURCHASE': 'Visa — IASF, achat multidevise (international)',
    'VS CA SM ELECTRONIC INF NNSS': 'Visa Crédit conso. — Électronique (Infinite)',
    'VS CA SM ELECTRONIC INF PRIV': 'Visa Crédit conso. — Électronique (Infinite Privilege)',
    'VS CA SMALL MERCHANT ELECTRONIC CGP NNSS': 'Visa Crédit conso. — Électronique (Classic/Gold/Platinum)',
    'VS CA STANDARD INFINITE BUSINESS': 'Visa Affaires — Standard (Infinite Business)',
    'VS CANADA NONCHIP ELEC PPAID': 'Visa Prépayée conso. — Électronique',
    'VS CANADA STANDARD BUSINESS': 'Visa Affaires — Standard (Business)',
    'VS INTERREG NON PREMIUM BASE': 'Visa International — Carte présente (Base) — Classic/Gold/Platinum/Electron',
    'VSMELECONN': 'Visa Crédit conso. — Électronique (Classic/Gold/Platinum)',
    'VSMELEHNWN': 'Visa Crédit conso. — Électronique (Infinite Privilege)',
    'VSMELEINFN': 'Visa Crédit conso. — Électronique (Infinite)',
  },

  // 22 alias
  payfacto: {
    'COMMERCIAL PREM STANDARD': 'Mastercard International — Commercial Standard',  // Commercial Prem Standard
    'FLEXIBLE PPD ELECTRONIC': 'Mastercard Prépayée conso. — Électronique',  // Flexible PPD Electronic
    'MC CA ACQUIRER ASSESSMENT FEE': 'Mastercard — Frais d\'évaluation (assessment, domestique)',  // MC CA Acquirer Assessment Fee
    'MC CA ACQUIRER CLEARING FEE GT 25': 'Mastercard — CA Acquirer Clearing Fee, gros montant, USD/txn (Adyen, TPS incluse)',  // MC CA Acquirer Clearing Fee GT 25
    'MC CA ACQUIRER CLEARING FEE LE 25': 'Mastercard — CA Acquirer Clearing Fee, petit montant, USD/txn (Adyen, TPS incluse)',  // MC CA Acquirer Clearing Fee LE 25
    'MC CA COMMERCIAL LARGE MKT': 'Mastercard Commercial Standard — Large Market',  // MC CA Commercial Large Mkt
    'MC CA COMMERCIAL WORLD ELITE': 'Mastercard Commercial Standard — World Elite for Business',  // MC CA Commercial World Elite
    'MC CA PPD ELECTRONIC': 'Mastercard Prépayée conso. — Électronique',  // MC CA PPD Electronic
    'MC INTERREG CORP STANDARD': 'Mastercard International — Commercial Standard',  // MC InterReg Corp Standard
    'VI CA ACQUIRER ASSESSMENT FEE': 'Visa — Frais d\'évaluation (assessment, domestique)',  // VI CA Acquirer Assessment Fee
    'VI/MC CARD BRAND NETWORK ACCESS FEE': 'Mastercard — CA Connectivity Fee, USD/txn (Adyen, TPS incluse)',  // VI/MC Card Brand Network Access Fee
    'VS CA COMMERCIAL SOLUTIONS FEE': 'Visa — CA Commercial Solutions Fee (Adyen, TPS incluse)',  // VS CA Commercial Solutions Fee
    'VS CA CONS ELECTRONIC PPD': 'Visa Prépayée conso. — Électronique',  // VS CA Cons Electronic PPD
    'VS CA ELECTRONIC HNW': 'Visa Crédit conso. — Électronique (Infinite Privilege)',  // VS CA Electronic HNW
    'VS CA ELECTRONIC INFINITE': 'Visa Crédit conso. — Électronique (Infinite)',  // VS CA Electronic Infinite
    'VS CA IASF MULTICURRENCY PURCHASE': 'Visa — IASF, achat multidevise (international)',  // VS CA IASF Multicurrency Purchase
    'VS CA NON CHIP ELECTRONIC CORP': 'Visa Corporatif/Achat — Électronique',  // VS CA Non Chip Electronic Corp
    'VS CA NON CHIP ELECTRONIC CR': 'Visa Crédit conso. — Électronique (Classic/Gold/Platinum)',  // VS CA Non Chip Electronic CR
    'VS CA STANDARD BUSINESS': 'Visa Affaires — Standard (Business)',  // VS CA Standard Business
    'VS CA STANDARD INFINITE BUSINESS': 'Visa Affaires — Standard (Infinite Business)',  // VS CA Standard Infinite Business
    'VS ESTIMATED AUTHORIZATION': 'Visa — ARQ (estimation d\'autorisation)',  // VS Estimated Authorization
    'VS INTERREG NON PREM BASE': 'Visa International — Carte présente (Base) — Classic/Gold/Platinum/Electron',  // VS InterReg Non Prem Base
  },
};

module.exports = { PROCESSOR_ALIASES };
