// ============================================================================
// IC+ — lecture d'une carte de taux (PDF) pour proposer des entrées de table.
//
// Christine dépose la carte de taux publiée d'un réseau ; Claude en extrait les couples
// catégorie → taux ; l'écran les affiche comme BROUILLON dans l'éditeur existant.
//
// ⚠️ CE MODULE N'ÉCRIT JAMAIS EN BASE, ET CE N'EST PAS UN DÉTAIL D'IMPLÉMENTATION.
// Un taux décide si un frais est « Conforme » ou « SUSPECT » sur un document remis à un
// client. Une extraction automatique est faillible — une colonne mal lue, une note de bas
// de page prise pour une ligne, un taux « à partir de ». Donc :
//   1. l'extraction PROPOSE des lignes,
//   2. l'humain les revoit dans l'éditeur,
//   3. l'enregistrement passe par le MÊME chemin que la saisie manuelle — validate(),
//      remplacement transactionnel, trace dans activity_log.
// Rien ne court-circuite l'étape 2. C'est la même discipline que partout ailleurs dans ce
// calculateur : on signale, on ne devine pas.
//
// ⚠️ LE TAUX DOIT SORTIR EN DÉCIMAL. Une carte de taux imprime « 1,42 % » ; la table
// stocke 0.0142. La consigne est explicite dans l'invite ET revérifiée au retour : tout ce
// qui dépasse 1 est marqué douteux plutôt que divisé par 100 en silence.
// ============================================================================

const rateTables = require('./rateTables');

const MODEL = 'claude-opus-5';

// Une carte de taux peut contenir cent catégories; on laisse de la place et on diffuse,
// pour ne pas se faire couper par un délai HTTP.
const MAX_TOKENS = 32000;
const MAX_PDF_BYTES = 30 * 1024 * 1024;

const SCHEMA = {
  type: 'object',
  properties: {
    document_kind: {
      type: 'string',
      description: "Ce que le document semble être : 'rate_card' pour une carte de taux publiée d'un réseau, 'statement' pour un relevé de marchand, 'other' sinon.",
    },
    network: {
      type: 'string',
      description: "Le réseau concerné, tel qu'il apparaît : Visa, Mastercard, Interac, Amex, ou '' si indéterminable.",
    },
    entries: {
      type: 'array',
      description: 'Une entrée par catégorie de taux lisible dans le document.',
      items: {
        type: 'object',
        properties: {
          cat: { type: 'string', description: "Le libellé de la catégorie, tel qu'imprimé." },
          rate: {
            type: 'number',
            description: "Le taux en FRACTION DÉCIMALE du volume, jamais en pourcentage. 1,42 % doit sortir 0.0142. 0,09 % doit sortir 0.0009.",
          },
          printed_as: { type: 'string', description: "Le taux tel qu'il est imprimé dans le document, verbatim (ex. '1.42%'). Sert à vérifier la conversion." },
          per_item_fee: { type: 'boolean', description: "true si la ligne est un montant fixe par transaction plutôt qu'un pourcentage du volume." },
          page: { type: 'integer', description: 'Page du document où la ligne a été lue.' },
          note: { type: 'string', description: "Toute réserve : valeur ambiguë, condition attachée, « à partir de », etc. Vide s'il n'y en a pas." },
        },
        required: ['cat', 'rate', 'printed_as', 'per_item_fee', 'page', 'note'],
        additionalProperties: false,
      },
    },
    caveats: {
      type: 'array',
      description: "Ce qu'un humain doit vérifier : sections illisibles, tableaux ignorés, dates d'entrée en vigueur, etc.",
      items: { type: 'string' },
    },
  },
  required: ['document_kind', 'network', 'entries', 'caveats'],
  additionalProperties: false,
};

const PROMPT = `Tu lis une carte de taux publiée par un réseau de cartes (Visa, Mastercard, Interac, Amex) pour en extraire les taux d'interchange ou de frais réseau.

RÈGLES, dans l'ordre d'importance :

1. LE TAUX SORT EN FRACTION DÉCIMALE, jamais en pourcentage. « 1,42 % » → 0.0142. « 0,09 % » → 0.0009. C'est l'erreur la plus coûteuse possible ici : un facteur 100 sur un taux fausse une comparaison remise à un client. Recopie aussi le taux tel qu'imprimé dans printed_as pour que la conversion soit vérifiable.

2. N'INVENTE RIEN. Si une valeur est illisible, ambiguë, conditionnelle ou donnée comme « à partir de », soit tu l'omets, soit tu l'inclus avec la réserve écrite dans note. Une table incomplète est sans danger — elle fait afficher « À vérifier ». Un taux inventé produit une accusation fausse et assurée.

3. Une ligne qui est un MONTANT FIXE par transaction (ex. « 0,04 $ / transaction ») n'est pas un taux de volume : marque per_item_fee à true. Ces tables ne stockent que des pourcentages du volume.

4. Recopie le libellé de catégorie TEL QU'IMPRIMÉ, sans le traduire ni l'abréger. C'est ce libellé qui sera comparé aux lignes des relevés.

5. Si le document n'est pas une carte de taux (un relevé de marchand, par exemple), dis-le dans document_kind et renvoie une liste entries vide plutôt que d'extraire n'importe quoi.

Mets dans caveats tout ce qu'un humain devrait vérifier : sections que tu n'as pas pu lire, tableaux que tu as ignorés et pourquoi, date d'entrée en vigueur si elle figure au document.`;

// ---------------------------------------------------------------------------
// Vérifications au RETOUR. L'invite demande des décimales; on ne s'y fie pas.
// ---------------------------------------------------------------------------
function review(entries) {
  const out = [];
  for (const e of entries || []) {
    const cat = String(e.cat || '').trim();
    const rate = Number(e.rate);
    const flags = [];

    if (!cat) continue;
    if (!Number.isFinite(rate)) { flags.push('rateUnreadable'); }
    // ⚠️ Le contrôle qui compte. Un taux > 1 veut dire que le modèle a rendu un
    // pourcentage malgré la consigne. On le SIGNALE — on ne le divise pas : diviser en
    // devinant, c'est exactement ce que tout le reste de ce calculateur refuse de faire.
    else if (rate > 1) flags.push('looksLikePercent');
    else if (rate < 0) flags.push('negative');
    // Un taux d'interchange sous 0,01 % est possible (certains frais réseau) mais assez
    // rare pour mériter un coup d'œil.
    else if (rate > 0 && rate < 0.0001) flags.push('unusuallySmall');

    // Cohérence entre le décimal rendu et le texte imprimé : c'est ce qui attrape une
    // conversion ratée que la seule borne « > 1 » laisserait passer (0,42 au lieu de 0,0042).
    const printed = String(e.printed_as || '');
    const m = printed.match(/([\d.,]+)\s*%/);
    if (m && Number.isFinite(rate)) {
      const printedPct = Number(m[1].replace(',', '.'));
      if (Number.isFinite(printedPct) && Math.abs(printedPct / 100 - rate) > 1e-6) {
        flags.push('printedMismatch');
      }
    }

    if (e.per_item_fee) flags.push('perItemFee');

    out.push({
      cat,
      rate: Number.isFinite(rate) ? rate : 0,
      printedAs: printed,
      page: Number.isFinite(Number(e.page)) ? Number(e.page) : null,
      note: String(e.note || '').slice(0, 300),
      flags,
      // Une ligne marquée est proposée quand même, mais décochée : l'humain décide.
      accept: flags.length === 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
async function extractRateCard({ anthropic, pdfBase64, filename, src }) {
  if (!anthropic) return { ok: false, reason: 'ai_not_configured' };
  if (!pdfBase64) return { ok: false, reason: 'no_file' };

  const bytes = Buffer.byteLength(pdfBase64, 'base64');
  if (bytes > MAX_PDF_BYTES) return { ok: false, reason: 'too_large', bytes };
  if (src && !rateTables.SOURCES[src]) return { ok: false, reason: 'unknown_source' };

  let message;
  try {
    // Diffusion : une carte de taux longue peut produire beaucoup de sortie, et un appel
    // non diffusé risque le délai HTTP.
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
    console.error('[icplus] extraction de la carte de taux échouée:', e.message);
    return { ok: false, reason: 'ai_error', detail: e.message };
  }

  // ⚠️ Un refus arrive en HTTP 200 avec stop_reason 'refusal' : lire stop_reason AVANT
  // le contenu, sinon on parse du vide sans comprendre pourquoi.
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

  const entries = review(parsed.entries);
  return {
    ok: true,
    documentKind: parsed.document_kind || 'other',
    network: parsed.network || '',
    caveats: Array.isArray(parsed.caveats) ? parsed.caveats.slice(0, 20) : [],
    entries,
    // Ce que l'écran doit dire tout haut avant que quiconque enregistre.
    summary: {
      total: entries.length,
      clean: entries.filter((e) => e.accept).length,
      flagged: entries.filter((e) => !e.accept).length,
    },
    src: src || null,
    model: MODEL,
  };
}

module.exports = { extractRateCard, review, SCHEMA, MODEL, MAX_PDF_BYTES };
