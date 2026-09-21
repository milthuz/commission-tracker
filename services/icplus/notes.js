// ============================================================================
// IC+ calculator — parser notes as structured, translatable records.
//
// A parser never builds a sentence. It emits { code, params } with RAW numbers, and
// rendering happens here, per language, at the last moment. That matters because the same
// note has to come out in three places — the on-screen audit, the client-facing PDF and the
// internal PDF — and two of those are generated server-side, in whichever language the rep
// picked.
//
// WHY THE TEMPLATES LIVE HERE rather than in the frontend's i18n files, which is where UI
// strings normally go: these notes are produced server-side, are consumed server-side by
// the PDF exporters, and interpolate numbers the parser computed. Splitting them would mean
// keeping two copies in sync and would leave the PDFs with no source of text at all. The
// API therefore returns each note as { code, params, text } — `text` already localized for
// the requested `lang`, `code` and `params` there so the frontend can override the wording
// for any note without a backend change.
//
// Adding a note: add a code to TEMPLATES with BOTH languages. A code missing a language
// falls back to French with a marker rather than rendering an empty string, so a gap shows
// up in review instead of silently blanking a line on a client document.
// ============================================================================

// ---------------------------------------------------------------------------
// Locale-aware formatting. Parsers pass numbers; only these functions turn them into text.
// ---------------------------------------------------------------------------
function fmtMoney(v, lang) {
  const n = Number(v) || 0;
  if (lang === 'en') {
    return `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  }
  // French: space as the thousands separator, comma decimal, dollar sign after.
  const [int, dec] = n.toFixed(2).split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')},${dec} $`;
}

// `v` is a decimal rate (0.001017) rendered as a percentage (0.1017 %).
function fmtPct(v, lang, digits = 4) {
  const s = (Number(v) * 100).toFixed(digits);
  return lang === 'en' ? `${s}%` : `${s.replace('.', ',')} %`;
}

function fmtList(items, lang) {
  const arr = (items || []).map(String);
  if (arr.length <= 1) return arr.join('');
  const last = arr[arr.length - 1];
  return `${arr.slice(0, -1).join(', ')} ${lang === 'en' ? 'and' : 'et'} ${last}`;
}

// ---------------------------------------------------------------------------
// The catalogue. `{{param}}` placeholders match i18next's syntax so the frontend can reuse
// these strings verbatim if it ever overrides one.
//
// `money:`/`pct:`/`list:` prefixes on a placeholder name say how to format that param.
// ---------------------------------------------------------------------------
const TEMPLATES = {
  // ---- dispatch
  formatDetected: {
    fr: 'Format détecté : {{processor}}{{layoutSuffix}}.',
    en: 'Format detected: {{processor}}{{layoutSuffix}}.',
  },
  emptyExtraction: {
    fr: "Aucun texte n'a pu être extrait du PDF. Un relevé numérisé (image) doit passer par la saisie JSON.",
    en: 'No text could be extracted from the PDF. A scanned (image) statement has to go through the JSON entry path.',
  },
  notImplemented: {
    fr: "L'analyseur {{processor}} n'est pas encore construit.",
    en: 'The {{processor}} parser has not been built yet.',
  },
  unknownProcessor: {
    fr: 'Processeur inconnu : {{processor}}.',
    en: 'Unknown processor: {{processor}}.',
  },
  unrecognized: {
    fr: "Aucun format reconnu et aucune ligne exploitable trouvée. Utiliser la saisie manuelle ou l'import JSON.",
    en: 'No known format matched and no usable line was found. Use manual entry or the JSON import.',
  },

  // ---- shared
  suspectRows: {
    fr: '{{count}} ligne(s) SUSPECT : {{list:labels}}.',
    en: '{{count}} SUSPECT line(s): {{list:labels}}.',
  },

  // ---- Global Payments
  volumeDiscrepancy: {
    fr: "Le volume de la section Escompte ({{money:escompte}}) dépasse le volume net du sommaire par carte ({{money:net}}) : Global facture sa majoration sur la vente ET sur le retour, donc un mois avec des retours produit légitimement cet écart.",
    en: 'The Discount section volume ({{money:escompte}}) exceeds the card summary net volume ({{money:net}}): Global bills its markup on the sale AND on the return leg, so a month with returns legitimately produces this gap.',
  },
  noDowngradeSection: {
    fr: "Aucune section IDF/FTNQ n'a été divulguée sur ce relevé : l'interchange est ESTIMÉ à partir de la ventilation par sous-marque de la section Escompte, et doit être vérifié.",
    en: 'No IDF/FTNQ section was disclosed on this statement: interchange is ESTIMATED from the Discount section\'s own sub-brand breakdown, and must be verified.',
  },
  reconciled: {
    fr: 'Réconcilié avec le sommaire de facturation du relevé ({{money:total}}).',
    en: "Reconciled against the statement's own billing summary ({{money:total}}).",
  },
  reconcileMismatch: {
    fr: '⚠️ Écart de réconciliation : les sections analysées totalisent {{money:parsed}} alors que le sommaire de facturation du relevé indique {{money:statement}}.',
    en: '⚠️ Reconciliation gap: the parsed sections total {{money:parsed}} while the statement\'s own billing summary says {{money:statement}}.',
  },

  // ---- Clover / Fiserv
  fiservMarkupExcluded: {
    fr: '{{money:amount}} de frais par transaction Fiserv ont été exclus des frais réseau : ce sont les mêmes dollars que la majoration calculée à partir du tableau « Type de carte », et les compter deux fois gonflerait le total du processeur actuel.',
    en: '{{money:amount}} of Fiserv per-transaction fees were excluded from the network fees: they are the same dollars as the markup computed from the Card Type table, and counting them twice would inflate the current processor\'s total.',
  },
  zeroInterchangeDeclared: {
    fr: "⚠️ Le relevé annonce « Frais d'interchange 0,00 $ », mais {{money:amount}} d'interchange réel a été trouvé dans les sections Frais de service / Autres frais, sous des codes non expliqués. Une section d'interchange à 0 $ se lit comme une bonne nouvelle — ici c'est l'inverse.",
    en: '⚠️ The statement declares "Interchange Charges $0.00", yet {{money:amount}} of real interchange was found in the Service Charges / Other Fees sections under unexplained codes. A $0 interchange section reads as good news — here it means the opposite.',
  },
  assessmentInflated: {
    fr: "⚠️ Frais d'évaluation facturés à {{pct:rate}} alors que le taux publié est {{pct:published}} : environ {{money:monthly}} par mois ({{money:annual}} par année) de trop sur ce volume.",
    en: '⚠️ Assessment fees billed at {{pct:rate}} where the published rate is {{pct:published}}: roughly {{money:monthly}} per month ({{money:annual}} per year) too much on this volume.',
  },

  // ---- Moneris
  monerisUnattributed: {
    fr: '{{money:amount}} de frais de transaction sans préfixe de marque ont été répartis entre Visa et Mastercard au prorata de leur volume en dollars.',
    en: '{{money:amount}} of transaction fees with no brand prefix were split between Visa and Mastercard in proportion to their dollar volume.',
  },
  monerisServiceSectionWarning: {
    fr: 'À vérifier à la main : « Visa - Code de Vérification de Carte 2 » et « Mastercard - Mise en oeuvre numérique » peuvent apparaître dans la section des frais de service (censée être à frais fixes) alors que ce sont en réalité des frais réseau par transaction.',
    en: 'Check by hand: "Visa - Card Verification Value 2" and "Mastercard - Digital Enablement" can appear in the service-fees section (nominally fixed fees) even though they are really per-transaction network fees.',
  },

  // ---- Chase / Paymentech
  chaseAlreadyInterchangePlus: {
    fr: 'Ce relevé est déjà en interchange-plus : chaque dollar facturé est soit de l\'interchange réel, soit un vrai frais d\'évaluation réseau, et les deux sont déjà détaillés. La majoration sur le débit, Visa et Mastercard est donc réellement de 0 $ — ce n\'est pas une lecture manquée.',
    en: 'This statement is already interchange-plus: every dollar charged is either real interchange or a real network assessment, both already itemized. Debit, Visa and Mastercard markup is therefore genuinely $0 — not a failed read.',
  },
  chaseAmexIsDiscount: {
    fr: 'La section « Fees » d\'Amex est son taux d\'escompte de gros ({{pct:rate}}), pas de l\'interchange — d\'après l\'avis en page couverture de Chase. Elle est comptée comme une majoration Amex et non comme un frais réseau transféré.',
    en: 'Amex\'s "Fees" section is its wholesale discount rate ({{pct:rate}}), not interchange — per Chase\'s own cover-page notice. It is counted as Amex markup rather than as a pass-through network fee.',
  },

  // ---- Payfacto
  payfactoUnrecognizedTier: {
    fr: '⚠️ {{count}} ligne(s) Interac ({{list:labels}}) dont le palier n\'a pas été reconnu. Une telle ligne est classée « Markup processeur » et disparaît du tableau Interac : ce sont de vrais frais réseau qui manqueraient à la comparaison. À vérifier à la main.',
    en: '⚠️ {{count}} Interac line(s) ({{list:labels}}) whose tier was not recognized. Such a line is classed as processor markup and drops out of the Interac table: those are real network fees that would go missing from the comparison. Check by hand.',
  },

  // ---- Nuvei
  nuveiPushPayment: {
    fr: '⚠️ {{count}} frais de paiement instantané ({{list:labels}}) totalisant {{money:amount}} : ce sont de vrais noms de produits réseau, mais pour un service qu\'un commerçant en présence de carte n\'utilise jamais. Affichés à côté des vrais frais de marque pour que la ressemblance soit visible.',
    en: '⚠️ {{count}} push-payment fee(s) ({{list:labels}}) totalling {{money:amount}}: these are genuine network product names, but for a service a card-present merchant never uses. Shown beside the real brand fees so the resemblance is visible.',
  },

  // ---- JSON import / manual entry (§7)
  jsonImported: {
    fr: 'Données saisies à la main ou importées en JSON, et non lues automatiquement sur le relevé. À vérifier avant de remettre quoi que ce soit au client.',
    en: 'Data entered by hand or imported as JSON, not read automatically off the statement. Verify before handing anything to the client.',
  },
  jsonEmpty: {
    fr: 'Rien à importer : le texte collé est vide.',
    en: 'Nothing to import: the pasted text is empty.',
  },
  jsonBadSyntax: {
    fr: 'Le JSON collé est invalide et n\'a pas pu être lu ({{message}}).',
    en: 'The pasted JSON is invalid and could not be read ({{message}}).',
  },
  jsonNotAnObject: {
    fr: 'Le JSON collé doit être un objet, pas une liste ni une valeur simple.',
    en: 'The pasted JSON must be an object, not a list or a bare value.',
  },
  jsonMissingKeys: {
    fr: 'Clés obligatoires manquantes : {{list:keys}}. Un import doit contenir au minimum « current_processor » et « volume ».',
    en: 'Required keys missing: {{list:keys}}. An import must carry at least "current_processor" and "volume".',
  },
  jsonNotANumber: {
    fr: 'La valeur de « {{field}} » n\'est pas un nombre ({{value}}).',
    en: 'The value of "{{field}}" is not a number ({{value}}).',
  },
  jsonBadLineAudit: {
    fr: '« line_audit » doit être un objet contenant les trois listes interchange, brand et interac.',
    en: '"line_audit" must be an object holding the three lists: interchange, brand and interac.',
  },
  jsonRateLooksLikePercent: {
    fr: '⚠️ « {{field}} » vaut {{value}}, ce qui ressemble à un pourcentage laissé tel quel plutôt qu\'à un taux décimal (1,65 % s\'écrit 0,0165). La valeur a été conservée telle quelle — elle n\'a PAS été corrigée automatiquement, parce que deviner un montant d\'argent est pire que de le signaler.',
    en: '⚠️ "{{field}}" is {{value}}, which looks like a percentage left as-is rather than a decimal rate (1.65% is written 0.0165). The value was kept unchanged — it was NOT auto-corrected, because guessing at a money figure is worse than flagging it.',
  },
  jsonFeeLooksWrong: {
    fr: '⚠️ « {{field}} » vaut {{value}} $ par transaction, ce qui est invraisemblable pour une majoration. Valeur conservée telle quelle, à vérifier.',
    en: '⚠️ "{{field}}" is {{value}} per transaction, which is implausible for a markup. Kept unchanged — please check.',
  },
  jsonNoVolume: {
    fr: '⚠️ Aucun volume n\'a été fourni : la comparaison portera sur zéro dollar.',
    en: '⚠️ No volume was provided: the comparison will be of zero against zero.',
  },

  // ---- generic fallback
  genericFormat: {
    fr: 'Format non reconnu : lecture par mots-clés seulement.',
    en: 'Unrecognized format: keyword reading only.',
  },
  genericTotals: {
    fr: 'Majoration {{money:markup}}, interchange {{money:interchange}}, frais fixes {{money:fixed}}.',
    en: 'Markup {{money:markup}}, interchange {{money:interchange}}, fixed fees {{money:fixed}}.',
  },
  genericUnclassified: {
    fr: '{{count}} ligne(s) non classée(s) ({{money:amount}}) à revoir à la main.',
    en: '{{count}} unclassified line(s) ({{money:amount}}) to review by hand.',
  },
  genericNoAudit: {
    fr: "Aucune vérification ligne par ligne contre les taux publiés n'a été faite : les volumes et les taux doivent être saisis manuellement.",
    en: 'No line-by-line check against published rates was attempted: volumes and rates have to be entered manually.',
  },

  // ---- review help (surfaced next to the audit, keyed by processor in rateTables.HELP)
  helpCrossBorderUplift: {
    fr: "Les frais transfrontaliers publiés sont 0,60 % (CAD / multidevise) et 1,00 % (devise étrangère / DCC). Un relevé Moneris de mai 2026 les facturait à 0,678 % et 1,13 % — soit exactement le taux publié multiplié par 1,13, sur les deux. Ce facteur est trop régulier pour être une erreur de saisie.",
    en: 'The published cross-border fees are 0.60% (CAD / multicurrency) and 1.00% (foreign currency / DCC). A May 2026 Moneris statement billed them at 0.678% and 1.13% — exactly the published rate times 1.13, on both. That factor is too consistent to be a typing error.',
  },
  helpAssessmentInflation: {
    fr: "Les frais d'évaluation Visa/MC (ASMTS) devraient être exactement 0,0900 %. Des taux de 0,1017 %, 0,1250 % et jusqu'à 0,1500 % ont déjà été observés facturés sous ce même nom.",
    en: 'Visa/MC assessment fees (ASMTS) should be exactly 0.0900%. Rates of 0.1017%, 0.1250% and up to 0.1500% have been observed billed under that same name.',
  },
  helpDuplicateSecurityFee: {
    fr: 'DATASECFEE et RISK ASMT sont souvent facturés deux fois sous deux noms différents, pour des montants identiques au cent près.',
    en: 'DATASECFEE and RISK ASMT are often billed twice under two different names, for amounts identical to the cent.',
  },
  helpZeroBasisFee: {
    fr: "Une ligne affichant 0 transaction et 0,0000 % mais un montant fixe non nul (p. ex. « FRAIS DE DÉCLASSEMENT D'INTERC ») est en soi le signal d'un frais caché.",
    en: 'A row showing 0 transactions and 0.0000% but a non-zero fixed amount (e.g. "FRAIS DE DÉCLASSEMENT D\'INTERC") is itself the signal of a hidden fee.',
  },
  helpHiddenArq: {
    fr: "La ligne « TAX REIMBURSEMENT CH » est l'endroit où le vrai frais ARQ de Visa (0,02 %) semble se cacher, sans être isolé séparément.",
    en: 'The "TAX REIMBURSEMENT CH" row is where Visa\'s real ARQ fee (0.02%) seems to hide, without being isolated separately.',
  },
  helpMonerisServiceSection: {
    fr: '« Visa - Code de Vérification de Carte 2 » et « Mastercard - Mise en oeuvre numérique » peuvent apparaître dans la section des frais de service (censée être à frais fixes) alors que ce sont en réalité des frais réseau par transaction. À vérifier à la main.',
    en: '"Visa - Card Verification Value 2" and "Mastercard - Digital Enablement" can appear in the service-fees section (nominally fixed fees) even though they are really per-transaction network fees. Check by hand.',
  },
  helpCloverHiddenInterchange: {
    fr: "La section « INTERCHANGE CHARGES » peut afficher « There are no Interchange Charges » (0,00 $) alors que le vrai coût d'interchange est caché dans « SERVICE CHARGES » sous des codes inexpliqués (p. ex. « CANCNTLSLMWE », « HNW IND2 NAT »).",
    en: 'The "INTERCHANGE CHARGES" section can display "There are no Interchange Charges" ($0.00) while the real interchange cost hides inside "SERVICE CHARGES" under unexplained codes (e.g. "CANCNTLSLMWE", "HNW IND2 NAT").',
  },
  helpNuveiValueAdded: {
    fr: 'Surveiller « PCI NON-COMPLIANCE ASSESSMENT FEE » (souvent facturé sur 100 % du volume), ainsi que « TAX RECOVERY FEE », « WEB REPORTS/ALERTS BUSINESS COACH+ » et « SAQ/SCAN INCOMPLETE ».',
    en: 'Watch for "PCI NON-COMPLIANCE ASSESSMENT FEE" (often billed on 100% of volume), plus "TAX RECOVERY FEE", "WEB REPORTS/ALERTS BUSINESS COACH+" and "SAQ/SCAN INCOMPLETE".',
  },
  helpDiscoverFoldedIntoVisa: {
    fr: "Discover n'a pas de champ dédié dans cet outil : son volume et sa majoration sont repliés dans Visa partout.",
    en: 'Discover has no dedicated field in this tool: its volume and markup fold into Visa throughout.',
  },
};

const LANGS = ['fr', 'en'];

// Build one note. Params carry raw values — never pre-formatted text.
function note(code, params = {}) {
  return { code, params };
}

// Render a single note in `lang`.
function render(n, lang = 'fr') {
  if (!n || !n.code) return '';
  const entry = TEMPLATES[n.code];
  if (!entry) return `[${n.code}]`;                       // visible in review, never silent
  const tpl = entry[lang] || entry.fr || `[${n.code}]`;

  return tpl.replace(/\{\{(\w+:)?(\w+)\}\}/g, (_, kind, key) => {
    const v = n.params ? n.params[key] : undefined;
    if (v === undefined || v === null) return '';
    switch ((kind || '').replace(':', '')) {
      case 'money': return fmtMoney(v, lang);
      case 'pct':   return fmtPct(v, lang);
      case 'list':  return fmtList(v, lang);
      default:      return String(v);
    }
  // Tidy the gaps an empty placeholder leaves behind — but ONLY before a period or comma.
  // French typography puts a space before ':', ';', '!' and '?', so a blanket
  // /\s+([.,;:])/ strips correct punctuation and turns "Format détecté :" into
  // "Format détecté:".
  }).replace(/ +([.,])/g, '$1').replace(/ {2,}/g, ' ').trim();
}

// Render a list of notes into one paragraph, and into the { code, params, text } records
// the API hands the frontend.
function renderAll(notes, lang = 'fr') {
  return (notes || []).map((n) => render(n, lang)).filter(Boolean).join(' ');
}

function toRecords(notes, lang = 'fr') {
  return (notes || []).map((n) => ({ code: n.code, params: n.params || {}, text: render(n, lang) }));
}

// Every code missing a translation — used by the test suite so a note added in one language
// cannot reach a client document half-translated.
function missingTranslations() {
  const gaps = [];
  for (const [code, entry] of Object.entries(TEMPLATES)) {
    for (const lang of LANGS) if (!entry[lang]) gaps.push(`${code}.${lang}`);
  }
  return gaps;
}

module.exports = {
  TEMPLATES, LANGS,
  note, render, renderAll, toRecords,
  fmtMoney, fmtPct, fmtList,
  missingTranslations,
};
