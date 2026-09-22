// ============================================================================
// Lecture d'un relevé NUMÉRISÉ (§7, chemin automatique).
//
// Un PDF scanné n'a pas de couche de texte : l'extraction du navigateur ne rend rien et
// aucun analyseur ne peut travailler. Jusqu'ici la seule issue était la saisie JSON à la
// main. Ce module fait faire cette transcription par le modèle, à partir des IMAGES des
// pages.
//
// ⚠️ IL NE CRÉE AUCUN CHEMIN DE CALCUL NOUVEAU. Sa sortie est exactement la forme que
// importJson.validateShape() police déjà, donc un relevé numérisé traverse ensuite
// populate() comme un relevé analysé automatiquement — même validation, mêmes garde-fous,
// mêmes notes. C'est tout l'intérêt : le chemin de secours reste ÉQUIVALENT au chemin
// normal au lieu d'en devenir un second, testé à part et divergent.
//
// ⚠️ RIEN N'EST CORRIGÉ EN SILENCE. Un modèle rend parfois un taux en pourcentage (1,65)
// là où la forme veut un décimal (0,0165). importJson le SIGNALE et le laisse tel quel,
// et ce module ne fait pas autrement : une majoration de 165 % saute aux yeux à l'écran,
// un nombre « corrigé » discrètement n'est jamais relu.
//
// ⚠️⚠️ ET SURTOUT : CE N'EST PAS UNE ANALYSE, C'EST UNE TRANSCRIPTION PROPOSÉE. Une
// lecture d'image se trompe — un 8 pour un 3, une colonne sautée, un total mal aligné. Le
// résultat est rendu POUR REVUE avec, à côté de chaque montant, ce qui était imprimé ;
// personne ne doit remettre un document à un client sans avoir confronté les deux. La
// réconciliation ci-dessous est ce qui rend cette revue tenable.
// ============================================================================

const MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;
const MAX_PDF_BYTES = 30 * 1024 * 1024;

// Au-delà de cet écart entre la somme des lignes lues et le total imprimé sur le relevé,
// la transcription est déclarée non réconciliée. Deux cents : c'est l'ordre de grandeur
// des arrondis par ligne qu'un vrai relevé porte déjà (Global réconcilie à 2 ¢).
const RECONCILE_TOLERANCE = 0.05;

// Bornes de vraisemblance d'une MAJORATION de processeur — voir review() pour pourquoi
// elles sont plus serrées que celles d'importJson.
const IMPLAUSIBLE_RATE = 0.05;
const IMPLAUSIBLE_FEE = 1;

const MONEY = (desc) => ({ type: 'number', description: desc });

const SCHEMA = {
  type: 'object',
  properties: {
    document_kind: {
      type: 'string',
      description: "'statement' si c'est bien un relevé de marchand, 'other' sinon (carte de taux, contrat, page sans rapport).",
    },
    // ⚠️ LE MODÈLE TARIFAIRE CHANGE OÙ VONT LES CHIFFRES — voir la règle 4 de l'invite.
    pricing_model: {
      type: 'string',
      description: "'interchange_plus' si le relevé sépare l'interchange du réseau de la majoration du processeur ; 'bundled' s'il facture un taux unique qui fond les deux (« Discount », « escompte », taux par marque sans ligne d'interchange distincte) ; 'unknown' si indéterminable.",
    },
    merchant_name: { type: 'string', description: "Le nom du marchand tel qu'imprimé, ou '' si absent." },
    processor_name: { type: 'string', description: "Le processeur qui émet le relevé (Moneris, Global Payments, Clover, Chase, Nuvei, Payfacto…), ou ''." },
    period: { type: 'string', description: "La période couverte, telle qu'imprimée, ou ''." },

    volume: {
      type: 'object',
      description: 'Les volumes traités, par marque. Montants en dollars, comptes en nombre de transactions.',
      properties: {
        debit_count: MONEY('Nombre de transactions Interac / débit.'),
        debit_amt: MONEY('Volume en dollars Interac / débit.'),
        visa_count: MONEY('Nombre de transactions Visa.'),
        visa_amt: MONEY('Volume en dollars Visa.'),
        mc_count: MONEY('Nombre de transactions Mastercard.'),
        mc_amt: MONEY('Volume en dollars Mastercard.'),
        amex_count: MONEY('Nombre de transactions Amex (et Discover, qui se replie sur Amex).'),
        amex_amt: MONEY('Volume en dollars Amex (et Discover).'),
      },
      required: ['debit_count', 'debit_amt', 'visa_count', 'visa_amt', 'mc_count', 'mc_amt', 'amex_count', 'amex_amt'],
      additionalProperties: false,
    },

    current_processor: {
      type: 'object',
      description: "Ce que le processeur facture, par marque. En tarification INTERCHANGE+, c'est ce qu'il prend AU-DESSUS du transfert réseau. En tarification GROUPÉE, c'est le taux forfaitaire COMPLET (interchange compris) et interchange vaut 0 — voir la règle 4.",
      properties: {
        visa_rate: MONEY("Majoration en FRACTION DÉCIMALE du volume Visa. 0,20 % -> 0.002. 0 si le relevé n'en montre pas."),
        mc_rate: MONEY('Idem pour Mastercard.'),
        debit_rate: MONEY('Idem pour le débit.'),
        amex_rate: MONEY('Idem pour Amex.'),
        visa_fee: MONEY("Majoration en DOLLARS PAR TRANSACTION Visa. 0,015 $ -> 0.015. 0 si absente."),
        mc_fee: MONEY('Idem pour Mastercard.'),
        debit_fee: MONEY('Idem pour le débit.'),
        amex_fee: MONEY('Idem pour Amex.'),
        interchange: MONEY("Le total en dollars de l'interchange et des frais de réseau refacturés, si le relevé le donne. 0 sinon."),
        fixed_rows: {
          type: 'array',
          description: "Les frais fixes : location de terminal, frais mensuels, frais d'état de compte, etc.",
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: "Le libellé tel qu'imprimé." },
              qty: MONEY('La quantité, 1 par défaut.'),
              unit: MONEY('Le prix unitaire en dollars.'),
              amount: MONEY('Le montant total de la ligne en dollars.'),
            },
            required: ['label', 'qty', 'unit', 'amount'],
            additionalProperties: false,
          },
        },
      },
      required: ['visa_rate', 'mc_rate', 'debit_rate', 'amex_rate',
        'visa_fee', 'mc_fee', 'debit_fee', 'amex_fee', 'interchange', 'fixed_rows'],
      additionalProperties: false,
    },

    // ⚠️ La pièce qui rend la revue tenable : ce que le relevé affiche LUI-MÊME comme
    // total, pour pouvoir confronter la transcription à un chiffre imprimé.
    printed_total_fees: MONEY("Le TOTAL DES FRAIS AVANT TAXES que le marchand paie sur la période, en dollars : ce que le relevé totalise, PLUS l'équipement et les frais de service s'ils sont facturés à part, MOINS les taxes. C'est ce total qui doit correspondre à la somme de ce que tu as transcrit. -1 si rien ne permet de le former."),

    readings: {
      type: 'array',
      description: "Chaque montant important AVEC son texte imprimé, pour que l'humain confronte la lecture au papier sans rouvrir le PDF.",
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: "Le champ renseigné (ex. 'volume.visa_amt')." },
          printed_as: { type: 'string', description: 'Le texte exact lu sur la page, verbatim.' },
          page: { type: 'integer', description: 'La page où il a été lu.' },
          confidence: { type: 'string', description: "'high', 'medium' ou 'low' selon la netteté de l'image à cet endroit." },
        },
        required: ['field', 'printed_as', 'page', 'confidence'],
        additionalProperties: false,
      },
    },

    caveats: {
      type: 'array',
      description: "Ce qu'un humain DOIT vérifier : zones floues, colonnes ambiguës, pages ignorées, sections partiellement coupées.",
      items: { type: 'string' },
    },
  },
  required: ['document_kind', 'pricing_model', 'merchant_name', 'processor_name', 'period',
    'volume', 'current_processor', 'printed_total_fees', 'readings', 'caveats'],
  additionalProperties: false,
};

const PROMPT = `Tu transcris un RELEVÉ DE MARCHAND numérisé (une image, pas du texte) pour qu'un calculateur puisse le comparer à une autre tarification.

Tu ne fais pas d'analyse : tu RECOPIES des chiffres. Tout jugement vient après, ailleurs.

RÈGLES, dans l'ordre d'importance :

1. N'INVENTE AUCUN CHIFFRE. Si une zone est floue, coupée, ou si tu hésites entre deux lectures, mets 0 et écris-le dans caveats. Un champ à zéro est visible et sans danger. Un chiffre inventé produit une comparaison fausse remise à un marchand, et rien ne le rattrape en aval.

2. LES TAUX SORTENT EN FRACTION DÉCIMALE, jamais en pourcentage. « 0,20 % » -> 0.002. « 1,65 % » -> 0.0165. C'est l'erreur la plus coûteuse ici : un facteur 100 fausse tout le document.

3. DISTINGUE UN TAUX D'UN MONTANT PAR TRANSACTION. « 0,20 % » va dans *_rate ; « 0,015 $ par transaction » va dans *_fee. Une même marque peut porter les deux, et les confondre calcule la majoration sur le mauvais volume.

4. DEUX MODÈLES TARIFAIRES, DEUX TRAITEMENTS. Dis lequel dans pricing_model.

   a) INTERCHANGE+ : le relevé sépare l'interchange du réseau de la majoration du
      processeur. Mets dans current_processor la SEULE majoration, et le total de
      l'interchange refacturé dans interchange.

   b) GROUPÉ (« bundled », « Discount », « escompte ») : un taux unique par marque qui fond
      l'interchange et la marge, sans ligne d'interchange distincte. Alors mets ce taux
      COMPLET dans les *_rate / *_fee de current_processor, et interchange à 0.

      La raison : du point de vue du marchand, un forfait n'a rien de séparable. Tout ce
      qu'il paie est ce que le processeur lui facture. Laisser les taux à 0 « par prudence »
      fait disparaître la quasi-totalité de son coût — un relevé à 1 850 $ de frais
      ressortait à 215 $, ce qui est bien pire qu'imprécis.

5. NE TRANSCRIS JAMAIS LES TAXES (TPS, TVQ, GST, HST, QST). Le calculateur applique son
   propre multiplicateur de taxe : les reprendre ici les compterait DEUX FOIS. Elles ne vont
   ni dans fixed_rows, ni dans printed_total_fees.

6. Discover n'a pas de champ à lui : replie-le sur Amex, comme le font les relevés eux-mêmes.

7. RECOPIE printed_total_fees TEL QUE LE RELEVÉ L'AFFICHE. C'est ce qui permet de vérifier ta transcription contre le papier. S'il n'imprime aucun total de frais, mets -1 — ne le calcule pas toi-même.

8. Pour chaque montant que tu renseignes, ajoute une entrée dans readings avec le texte EXACT lu sur la page et ta confiance. Une lecture d'image se trompe ; c'est ce qui permet à un humain de vérifier sans rouvrir le PDF.

9. Si ce document n'est pas un relevé de marchand, dis-le dans document_kind et renvoie des volumes à zéro plutôt que d'extraire n'importe quoi.

Mets dans caveats tout ce qu'un humain doit revoir : zones illisibles, colonnes dont l'en-tête est ambigu, pages que tu n'as pas pu traiter, sections manifestement coupées au scan.`;

// ---------------------------------------------------------------------------
// Vérifications AU RETOUR. L'invite demande des décimales et interdit d'inventer ; on ne
// s'y fie pas. Ces contrôles sont l'équivalent, pour une image, de la réconciliation que
// les analyseurs font contre le total imprimé du relevé.
// ---------------------------------------------------------------------------
function review(parsed) {
  const flags = [];
  const cp = (parsed && parsed.current_processor) || {};
  const vol = (parsed && parsed.volume) || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  if (parsed.document_kind !== 'statement') flags.push({ code: 'notAStatement', kind: parsed.document_kind });

  // Un volume entièrement nul veut dire que rien n'a été lu — le cas le plus probable
  // quand le scan est trop pâle. Mieux vaut le dire que rendre un calcul sur du vide.
  const totalVolume = ['debit_amt', 'visa_amt', 'mc_amt', 'amex_amt'].reduce((s, f) => s + num(vol[f]), 0);
  if (totalVolume === 0) flags.push({ code: 'noVolumeRead' });

  // ⚠️ SEUILS PLUS SERRÉS QU'IMPORTJSON, DÉLIBÉRÉMENT. importJson tolère jusqu'à 0,5
  // (« 50 % de majoration, qu'aucun processeur ne facture ») parce qu'un humain qui colle
  // du JSON a dérivé ses chiffres exprès. Une lecture d'IMAGE, elle, se trompe d'un
  // facteur 100 tout le temps : « 0,20 % » ressort 0.20. À 0,5, tout l'intervalle où
  // atterrissent la plupart de ces erreurs — 0,01 à 0,5 — passait au travers.
  //
  // Une majoration de processeur au-dessus de 5 % n'existe pas ; au-dessus de 1 $ par
  // transaction non plus. Signalé, jamais corrigé : c'est l'humain qui tranche à l'écran.
  for (const f of ['visa_rate', 'mc_rate', 'debit_rate', 'amex_rate']) {
    if (num(cp[f]) > IMPLAUSIBLE_RATE) flags.push({ code: 'rateLooksLikePercent', field: f, value: num(cp[f]) });
  }
  for (const f of ['visa_fee', 'mc_fee', 'debit_fee', 'amex_fee']) {
    if (num(cp[f]) > IMPLAUSIBLE_FEE) flags.push({ code: 'feeLooksWrong', field: f, value: num(cp[f]) });
  }

  // ⚠️ TARIFICATION GROUPÉE : décision de David du 2026-09-22. Tout le taux forfaitaire va
  // dans la MAJORATION et l'interchange reste à 0, parce qu'un forfait n'a rien de
  // séparable du point de vue du marchand. L'écran doit le DIRE : la comparaison qui suit
  // oppose un forfait à une tarification interchange+, ce qui n'est pas anodin.
  if (parsed.pricing_model === 'bundled') {
    flags.push({ code: 'bundledPricing' });
    // Un forfait annoncé mais sans aucun taux porté veut dire que la lecture a échoué là
    // où elle comptait le plus : c'est le relevé entier qui disparaît.
    const totalTaux = ['visa_rate', 'mc_rate', 'debit_rate', 'amex_rate', 'visa_fee', 'mc_fee', 'debit_fee', 'amex_fee']
      .reduce((s2, f) => s2 + num(cp[f]), 0);
    if (totalTaux === 0) flags.push({ code: 'bundledButNoRate' });
    if (num(cp.interchange) > 0) flags.push({ code: 'bundledButInterchange', value: num(cp.interchange) });
  }

  const lowConfidence = (parsed.readings || []).filter((r) => r && r.confidence === 'low');
  if (lowConfidence.length) flags.push({ code: 'lowConfidenceReadings', n: lowConfidence.length });

  return flags;
}

// ---------------------------------------------------------------------------
// Réconciliation contre le total que le relevé imprime LUI-MÊME.
//
// ⚠️ C'est le seul contrôle qui puisse attraper une transcription globalement fausse. Les
// analyseurs de texte s'en servent déjà (« reconciled » / « reconcileMismatch ») ; une
// lecture d'image en a bien plus besoin encore. Sans lui, une colonne mal lue produit un
// document d'apparence normale dont chaque chiffre est décalé.
// ---------------------------------------------------------------------------
function reconcile(parsed) {
  const printed = Number(parsed && parsed.printed_total_fees);
  if (!Number.isFinite(printed) || printed < 0) return { available: false };

  const cp = parsed.current_processor || {};
  const vol = parsed.volume || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const markup = num(vol.visa_amt) * num(cp.visa_rate) + num(vol.visa_count) * num(cp.visa_fee)
    + num(vol.mc_amt) * num(cp.mc_rate) + num(vol.mc_count) * num(cp.mc_fee)
    + num(vol.debit_amt) * num(cp.debit_rate) + num(vol.debit_count) * num(cp.debit_fee)
    + num(vol.amex_amt) * num(cp.amex_rate) + num(vol.amex_count) * num(cp.amex_fee);
  const fixed = (cp.fixed_rows || []).reduce((s, r) => s + num(r.amount), 0);
  const computed = markup + num(cp.interchange) + fixed;

  const gap = computed - printed;
  return {
    available: true,
    printed,
    computed: Math.round(computed * 100) / 100,
    gap: Math.round(gap * 100) / 100,
    ok: Math.abs(gap) <= RECONCILE_TOLERANCE,
  };
}

// ---------------------------------------------------------------------------
async function readScannedStatement({ anthropic, pdfBase64, filename }) {
  if (!anthropic) return { ok: false, reason: 'ai_not_configured' };
  if (!pdfBase64) return { ok: false, reason: 'no_file' };

  const bytes = Buffer.byteLength(pdfBase64, 'base64');
  if (bytes > MAX_PDF_BYTES) return { ok: false, reason: 'too_large', bytes };

  let message;
  try {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
          { type: 'text', text: PROMPT + (filename ? `\n\nNom du fichier déposé : ${filename}` : '') },
        ],
      }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    });
    message = await stream.finalMessage();
  } catch (e) {
    console.error('[icplus] lecture du relevé numérisé échouée:', e.message);
    return { ok: false, reason: 'ai_error', detail: e.message };
  }

  // ⚠️ Un refus arrive en HTTP 200 avec stop_reason 'refusal' : lire stop_reason AVANT le
  // contenu, sinon on analyse du vide sans comprendre pourquoi.
  if (message.stop_reason === 'refusal') {
    return { ok: false, reason: 'refused', detail: message.stop_details && message.stop_details.category };
  }

  const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'unparseable', detail: text.slice(0, 200) };
  }

  const flags = review(parsed);
  const rec = reconcile(parsed);
  if (rec.available && !rec.ok) flags.push({ code: 'reconcileMismatch', gap: rec.gap });

  // L'objet rendu est PRÊT pour /api/icplus/import — même forme, même validation.
  const payload = {
    current_processor: { ...(parsed.current_processor || {}), name: parsed.processor_name || 'Relevé numérisé' },
    volume: parsed.volume || {},
    merchant_name: parsed.merchant_name || null,
  };

  return {
    ok: true,
    payload,
    documentKind: parsed.document_kind || 'other',
    pricingModel: parsed.pricing_model || 'unknown',
    processorName: parsed.processor_name || '',
    period: parsed.period || '',
    readings: Array.isArray(parsed.readings) ? parsed.readings.slice(0, 60) : [],
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats.slice(0, 20) : [],
    reconcile: rec,
    flags,
    // ⚠️ Ce que l'écran doit dire tout haut : une transcription n'est pas une analyse.
    needsReview: true,
    model: MODEL,
  };
}

module.exports = {
  readScannedStatement, review, reconcile,
  SCHEMA, MODEL, MAX_PDF_BYTES, RECONCILE_TOLERANCE, IMPLAUSIBLE_RATE, IMPLAUSIBLE_FEE,
};
