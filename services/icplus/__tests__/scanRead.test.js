// Lecture d'un relevé NUMÉRISÉ par le modèle.
//
// L'appel au modèle n'est pas testé ici (il coûte de l'argent et n'est pas déterministe).
// Ce qui EST testé porte la sécurité :
//   • la sortie satisfait la validation de l'import — c'est toute la raison d'être du
//     module, faire emprunter au scan le CHEMIN NORMAL plutôt qu'un second chemin ;
//   • la réconciliation contre le total que le relevé imprime lui-même, seul contrôle
//     capable d'attraper une transcription globalement décalée ;
//   • les signalements sur ce que le modèle renvoie, l'invite ne suffisant jamais.
const S = require('../scanRead');
const I = require('../importJson');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };

// Une transcription plausible, cohérente : la base des cas qui suivent.
const base = () => ({
  document_kind: 'statement',
  merchant_name: 'DINER TEST',
  processor_name: 'Moneris',
  period: 'mai 2026',
  volume: {
    debit_count: 1000, debit_amt: 40000,
    visa_count: 2000, visa_amt: 100000,
    mc_count: 800, mc_amt: 45000,
    amex_count: 0, amex_amt: 0,
  },
  current_processor: {
    visa_rate: 0.002, mc_rate: 0.002, debit_rate: 0, amex_rate: 0,
    visa_fee: 0.015, mc_fee: 0.015, debit_fee: 0.04, amex_fee: 0,
    interchange: 2500,
    fixed_rows: [{ label: 'Location terminal', qty: 1, unit: 29, amount: 29 }],
  },
  printed_total_fees: -1,
  readings: [],
  caveats: [],
});

// ---------------------------------------------------------------------------
// 1. ⚠️ L'ASSERTION QUI JUSTIFIE LE MODULE.
//
// Le relevé numérisé doit rejoindre le chemin normal. Ça n'est vrai que si la sortie
// satisfait EXACTEMENT la forme que importJson police déjà — sinon le chemin de secours
// devient un second chemin, testé à part, et les deux divergent en silence.
// ---------------------------------------------------------------------------
{
  const p = base();
  const payload = {
    current_processor: { ...p.current_processor, name: p.processor_name },
    volume: p.volume,
    merchant_name: p.merchant_name,
  };
  const v = I.validateShape(payload);
  ok('la transcription satisfait la validation de l\'import', v.ok === true, v.errors);

  // Et elle traverse parseImport, c'est-à-dire le chemin que la saisie à la main emprunte.
  const imported = I.parseImport(JSON.stringify(payload), { lang: 'fr' });
  ok('elle traverse parseImport comme un collage humain', imported.ok === true, imported.errors);
  ok('et le volume arrive intact', imported.parsed.volume.visa_amt === 100000, imported.parsed.volume);
}

// ---------------------------------------------------------------------------
// 2. Réconciliation contre le total imprimé par le relevé.
//
// ⚠️ Sans elle, une colonne mal lue produit un document d'apparence normale dont chaque
// chiffre est décalé. C'est le seul contrôle qui voit l'ensemble.
// ---------------------------------------------------------------------------
{
  // markup = 100000×0,002 + 2000×0,015 + 45000×0,002 + 800×0,015 + 1000×0,04
  //        = 200 + 30 + 90 + 12 + 40 = 372 ; + interchange 2500 + fixe 29 = 2901
  const p = base();
  p.printed_total_fees = 2901;
  const r = S.reconcile(p);
  ok('le calcul de réconciliation est juste', r.computed === 2901, r);
  ok('et il réconcilie', r.ok === true, r);

  const off = base();
  off.printed_total_fees = 3200;
  const r2 = S.reconcile(off);
  ok('un écart réel est vu', r2.ok === false && Math.abs(r2.gap + 299) < 0.01, r2);

  // Deux cents d'écart : c'est l'arrondi par ligne qu'un vrai relevé porte déjà.
  const near = base();
  near.printed_total_fees = 2901.02;
  ok('deux cents d\'écart restent réconciliés', S.reconcile(near).ok === true, S.reconcile(near));

  // -1 veut dire « le relevé n'imprime aucun total » : il ne faut pas le prendre pour zéro.
  ok('aucun total imprimé -> pas de réconciliation possible',
    S.reconcile(base()).available === false, S.reconcile(base()));
}

// ---------------------------------------------------------------------------
// 3. Les signalements. L'invite demande des décimales et interdit d'inventer ; on ne s'y fie pas.
// ---------------------------------------------------------------------------
const codes = (p) => S.review(p).map((f) => f.code);

{
  ok('une transcription propre ne signale rien', codes(base()).length === 0, codes(base()));

  const pasUnReleve = base(); pasUnReleve.document_kind = 'other';
  ok('un document qui n\'est pas un relevé est signalé', codes(pasUnReleve).includes('notAStatement'));

  // ⚠️ Le cas le plus probable quand le scan est trop pâle : le modèle ne lit rien et rend
  // des zéros. Un calcul sur du vide a l'air normal et ne vaut rien.
  const vide = base();
  vide.volume = { debit_count: 0, debit_amt: 0, visa_count: 0, visa_amt: 0, mc_count: 0, mc_amt: 0, amex_count: 0, amex_amt: 0 };
  ok('un volume entièrement nul est signalé', codes(vide).includes('noVolumeRead'), codes(vide));

  // ⚠️ LE cas de la lecture d'image : « 0,20 % » ressort 0.20 au lieu de 0.002. Le seuil
  // d'importJson (0,5) le laissait passer — c'est précisément l'intervalle où atterrit la
  // plupart des erreurs de facteur 100, d'où un seuil plus serré ici.
  const pct = base(); pct.current_processor.visa_rate = 0.20;
  ok('un taux qui ressemble à un pourcentage est signalé', codes(pct).includes('rateLooksLikePercent'), codes(pct));
  ok('et sa valeur n\'est PAS corrigée', pct.current_processor.visa_rate === 0.20);
  ok('le seuil de scan est plus serré que celui de la saisie à la main',
    S.IMPLAUSIBLE_RATE < 0.5, S.IMPLAUSIBLE_RATE);

  // Et une vraie majoration reste sous le seuil : 0,20 % correctement converti, ou même
  // un forfait groupé à 1,39 %, ne doivent rien déclencher.
  for (const r of [0.002, 0.0139, 0.0235]) {
    const bon = base(); bon.current_processor.visa_rate = r;
    ok(`une majoration réelle de ${(r * 100).toFixed(2)} % ne déclenche rien`, codes(bon).length === 0, codes(bon));
  }

  const fee = base(); fee.current_processor.mc_fee = 15;
  ok('un montant par transaction invraisemblable est signalé', codes(fee).includes('feeLooksWrong'), codes(fee));

  const flou = base();
  flou.readings = [{ field: 'volume.visa_amt', printed_as: '100 000,00', page: 1, confidence: 'low' }];
  ok('les lectures peu sûres sont signalées', codes(flou).includes('lowConfidenceReadings'), codes(flou));
}

// ---------------------------------------------------------------------------
// 3bis. TARIFICATION GROUPÉE — décision de David, 2026-09-22.
//
// ⚠️ Tous les relevés d'un même processeur n'ont pas le même modèle tarifaire. Quand le
// relevé facture un taux UNIQUE par marque qui fond l'interchange et la marge, ce taux
// COMPLET va dans la majoration et l'interchange reste à 0 — parce que du point de vue du
// marchand, un forfait n'a rien de séparable : tout ce qu'il paie est ce que le processeur
// lui facture.
//
// Ce que la consigne précédente coûtait, mesuré sur un vrai relevé Global numérisé :
// laisser les taux à 0 « par prudence » faisait ressortir 215 $ de frais là où le marchand
// en payait 1 850. Une comparaison bâtie là-dessus est fausse dans le sens le plus coûteux
// — elle sous-estime ce que le marchand paie aujourd'hui, donc l'économie annoncée.
// ---------------------------------------------------------------------------
{
  const groupe = base();
  groupe.pricing_model = 'bundled';
  groupe.current_processor.visa_rate = 0.0139;
  groupe.current_processor.mc_rate = 0.0143;
  groupe.current_processor.interchange = 0;
  ok('un relevé groupé est signalé comme tel', codes(groupe).includes('bundledPricing'), codes(groupe));

  // ⚠️ Le contrôle qui rattraperait l'ancienne consigne si elle revenait : un forfait
  // annoncé dont AUCUN taux n'est porté, c'est le relevé entier qui disparaît.
  const vide = base();
  vide.pricing_model = 'bundled';
  for (const f of ['visa_rate', 'mc_rate', 'debit_rate', 'amex_rate',
    'visa_fee', 'mc_fee', 'debit_fee', 'amex_fee']) {
    vide.current_processor[f] = 0;
  }
  ok('un forfait sans aucun taux est signalé', codes(vide).includes('bundledButNoRate'), codes(vide));

  // ⚠️ Et l'incohérence inverse : un forfait ne peut pas porter d'interchange séparé, par
  // définition. S'il y en a un, une des deux lectures est fausse.
  const incoherent = base();
  incoherent.pricing_model = 'bundled';
  incoherent.current_processor.visa_rate = 0.0139;
  incoherent.current_processor.interchange = 2500;
  ok('un forfait AVEC interchange séparé est signalé comme incohérent',
    codes(incoherent).includes('bundledButInterchange'), codes(incoherent));

  // Un relevé interchange+ normal ne déclenche évidemment rien de tout cela.
  const ic = base();
  ic.pricing_model = 'interchange_plus';
  ok('un relevé interchange+ ne déclenche aucun de ces signalements',
    !codes(ic).some((c) => c.indexOf('bundled') === 0), codes(ic));
}

// ---------------------------------------------------------------------------
// 4. Les refus francs, sans appeler le modèle.
// ---------------------------------------------------------------------------
(async () => {
  const sansIA = await S.readScannedStatement({ anthropic: null, pdfBase64: 'AAAA' });
  ok('sans IA configurée, refus explicite', sansIA.ok === false && sansIA.reason === 'ai_not_configured', sansIA);

  const sansFichier = await S.readScannedStatement({ anthropic: {}, pdfBase64: '' });
  ok('sans fichier, refus explicite', sansFichier.ok === false && sansFichier.reason === 'no_file', sansFichier);

  const trop = await S.readScannedStatement({
    anthropic: {}, pdfBase64: 'A'.repeat(Math.ceil(S.MAX_PDF_BYTES * 4 / 3) + 100),
  });
  ok('un PDF trop lourd est refusé', trop.ok === false && trop.reason === 'too_large', trop.reason);

  // ⚠️ Un refus du modèle arrive en HTTP 200 avec stop_reason 'refusal'. Le lire APRÈS le
  // contenu ferait analyser du vide sans comprendre pourquoi.
  const faux = (message) => ({ messages: { stream: () => ({ finalMessage: async () => message }) } });
  const refus = await S.readScannedStatement({
    anthropic: faux({ stop_reason: 'refusal', stop_details: { category: 'x' }, content: [] }),
    pdfBase64: 'AAAA',
  });
  ok('un refus du modèle est reconnu comme tel', refus.ok === false && refus.reason === 'refused', refus);

  const illisible = await S.readScannedStatement({
    anthropic: faux({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'pas du json' }] }),
    pdfBase64: 'AAAA',
  });
  ok('une réponse inexploitable est reconnue', illisible.ok === false && illisible.reason === 'unparseable', illisible.reason);

  // ---- bout en bout, avec une réponse valide simulée
  const p = base();
  p.printed_total_fees = 2901;
  const bon = await S.readScannedStatement({
    anthropic: faux({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(p) }] }),
    pdfBase64: 'AAAA', filename: 'releve.pdf',
  });
  ok('une lecture valide rend une charge utile', bon.ok === true, bon.reason);
  ok('la charge porte le nom du processeur lu', bon.payload.current_processor.name === 'Moneris', bon.payload.current_processor.name);
  ok('elle satisfait la validation de l\'import', I.validateShape(bon.payload).ok === true, I.validateShape(bon.payload).errors);
  ok('la réconciliation est portée dans la réponse', bon.reconcile.ok === true, bon.reconcile);
  // ⚠️ Le drapeau qui empêche l'écran de présenter ça comme une analyse.
  ok('la réponse se déclare À REVOIR', bon.needsReview === true);
  ok('aucun signalement sur une transcription propre', bon.flags.length === 0, bon.flags);

  // Un écart de réconciliation doit remonter dans les signalements, pas seulement dans
  // l'objet reconcile : c'est la liste que l'écran affiche.
  const decale = base(); decale.printed_total_fees = 3200;
  const bancal = await S.readScannedStatement({
    anthropic: faux({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(decale) }] }),
    pdfBase64: 'AAAA',
  });
  ok('un écart de réconciliation est signalé à l\'écran',
    bancal.flags.some((f) => f.code === 'reconcileMismatch'), bancal.flags);

  console.log(fail ? `\n${fail} FAILING` : '\nall green');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
