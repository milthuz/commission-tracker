// Lecture d'une carte de taux par le modèle.
//
// L'appel au modèle n'est pas testé ici (il coûte de l'argent et n'est pas déterministe).
// Ce qui EST testé est la partie qui porte la sécurité : la revérification de ce que le
// modèle renvoie. L'invite demande des décimales — on ne s'y fie pas, et c'est ce filet
// qui décide si une ligne arrive cochée ou marquée à revoir.
const X = require('../rateCardExtract');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

const one = (e) => X.review([e])[0];

// ---- une ligne propre passe et arrive cochée.
const good = one({ cat: 'Visa — Electronic Standard', rate: 0.0142, printed_as: '1.42%', per_item_fee: false, page: 3, note: '' });
ok('une ligne correcte est acceptée', good.accept === true && good.flags.length === 0, good);
ok('le taux est conservé tel quel', good.rate === 0.0142, good.rate);
ok('le texte imprimé est conservé pour vérification', good.printedAs === '1.42%', good.printedAs);

// ---------------------------------------------------------------------------
// ⚠️ LE contrôle. Un taux > 1 veut dire que le modèle a rendu un pourcentage malgré la
// consigne. Il est SIGNALÉ, jamais divisé : diviser en devinant est exactement ce que tout
// le reste de ce calculateur refuse de faire.
// ---------------------------------------------------------------------------
const pct = one({ cat: 'Visa — Test', rate: 1.42, printed_as: '1.42%', per_item_fee: false, page: 1, note: '' });
ok('un pourcentage non converti est marqué', pct.flags.includes('looksLikePercent'), pct.flags);
ok('et il arrive DÉCOCHÉ', pct.accept === false, pct.accept);
ok('et sa valeur n\'a PAS été corrigée', pct.rate === 1.42, pct.rate);

// ---------------------------------------------------------------------------
// ⚠️ Le contrôle que la seule borne « > 1 » laisserait passer : 0,42 au lieu de 0,0042.
// Les deux sont sous 1, donc seule la comparaison avec le texte imprimé l'attrape.
// ---------------------------------------------------------------------------
const off100 = one({ cat: 'Visa — Test', rate: 0.42, printed_as: '0.42%', per_item_fee: false, page: 1, note: '' });
ok('un facteur 100 sous 1 est attrapé par le texte imprimé', off100.flags.includes('printedMismatch'), off100.flags);
ok('et cette ligne arrive décochée aussi', off100.accept === false);

const consistent = one({ cat: 'X', rate: 0.0042, printed_as: '0.42%', per_item_fee: false, page: 1, note: '' });
ok('la même ligne bien convertie passe', consistent.accept === true, consistent.flags);
// La virgule décimale des cartes de taux françaises ne doit pas déclencher un faux positif.
const frDecimal = one({ cat: 'X', rate: 0.0142, printed_as: '1,42 %', per_item_fee: false, page: 1, note: '' });
ok('une virgule décimale ne crée pas de faux positif', frDecimal.accept === true, frDecimal.flags);

// ---- un montant fixe par transaction n'est pas un taux de volume.
const perItem = one({ cat: 'Interac — par transaction', rate: 0.04, printed_as: '0,04 $', per_item_fee: true, page: 2, note: '' });
ok('un frais par transaction est marqué', perItem.flags.includes('perItemFee'), perItem.flags);
ok('et décoché', perItem.accept === false);

// ---- valeurs aberrantes.
ok('un taux négatif est marqué', one({ cat: 'X', rate: -0.01, printed_as: '', per_item_fee: false, page: 1, note: '' }).flags.includes('negative'));
ok('un taux illisible est marqué', one({ cat: 'X', rate: 'beaucoup', printed_as: '', per_item_fee: false, page: 1, note: '' }).flags.includes('rateUnreadable'));
ok('un taux minuscule est signalé sans être rejeté',
  one({ cat: 'X', rate: 0.00001, printed_as: '', per_item_fee: false, page: 1, note: '' }).flags.includes('unusuallySmall'));

// ---- une ligne sans libellé est écartée : elle ne pourrait correspondre à rien.
ok('une ligne sans libellé est écartée', X.review([{ cat: '  ', rate: 0.01 }]).length === 0);

// ---- la réserve écrite par le modèle est conservée telle quelle.
const noted = one({ cat: 'X', rate: 0.01, printed_as: '1%', per_item_fee: false, page: 4, note: 'Tarif « à partir de », conditions en page 9.' });
ok('la réserve du modèle est conservée', /à partir de/.test(noted.note), noted.note);
ok('la page est conservée', noted.page === 4, noted.page);

// ---- rien ne passe sans client configuré ni sans fichier : pas d'appel silencieux.
(async () => {
  ok('sans client IA → refus explicite', (await X.extractRateCard({ anthropic: null, pdfBase64: 'x' })).reason === 'ai_not_configured');
  ok('sans fichier → refus explicite', (await X.extractRateCard({ anthropic: {}, pdfBase64: '' })).reason === 'no_file');
  ok('source inconnue → refus', (await X.extractRateCard({ anthropic: {}, pdfBase64: 'eA==', src: 'un ami' })).reason === 'unknown_source');

  // Un refus du modèle arrive en HTTP 200 : il doit être reconnu, pas parsé comme du vide.
  const refusing = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'refusal', stop_details: { category: 'other' }, content: [] }) }) } };
  const r = await X.extractRateCard({ anthropic: refusing, pdfBase64: 'eA==' });
  ok('un refus du modèle est reconnu', r.ok === false && r.reason === 'refused', r);

  // Une réponse non-JSON ne doit pas remonter comme une extraction vide réussie.
  const garbled = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'désolé, je ne peux pas' }] }) }) } };
  const g = await X.extractRateCard({ anthropic: garbled, pdfBase64: 'eA==' });
  ok('une réponse illisible est un échec, pas un succès vide', g.ok === false && g.reason === 'unparseable', g);

  // Chemin nominal, avec une ligne propre et une piégée.
  const okClient = { messages: { stream: () => ({ finalMessage: async () => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify({
      document_kind: 'rate_card', network: 'Visa', caveats: ['Page 7 illisible.'],
      entries: [
        { cat: 'Visa — A', rate: 0.0142, printed_as: '1.42%', per_item_fee: false, page: 1, note: '' },
        { cat: 'Visa — B', rate: 1.65, printed_as: '1.65%', per_item_fee: false, page: 1, note: '' },
      ],
    }) }],
  }) }) } };
  const okOut = await X.extractRateCard({ anthropic: okClient, pdfBase64: 'eA==', src: 'visa_published' });
  ok('extraction nominale', okOut.ok === true && okOut.entries.length === 2, okOut);
  ok('le décompte distingue propre et à revoir', okOut.summary.clean === 1 && okOut.summary.flagged === 1, okOut.summary);
  ok('les réserves du modèle remontent', okOut.caveats.length === 1, okOut.caveats);
  ok('la source choisie est conservée', okOut.src === 'visa_published', okOut.src);

  console.log(fail ? `\n${fail} FAILING` : '\nall green');
  process.exit(fail ? 1 : 0);
})();
