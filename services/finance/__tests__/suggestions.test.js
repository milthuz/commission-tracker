// Module Finance, lot F — suggestions de drivers selon l'historique.
//   npm install --no-save @electric-sql/pglite   (une fois)
//   node services/finance/__tests__/suggestions.test.js [dossier design/finance]
//
// 1. Calculs PURS (suggestionsCore.js) sur des abonnements et des séries FICTIFS, résultats
//    attendus calculés À LA MAIN dans les commentaires (chaque méthode, cas limites : historique
//    court, mois sans activité, changement de propriétaire exclu, deux organisations qui
//    partagent un numéro d'abonnement).
// 2. De bout en bout (vrai serveur HTTP + PGlite) : permissions, mode démo, paramètres, rien
//    d'écrit au budget, valeurs courantes lues, et un test « contre la prod simulée » : copie
//    PGlite alimentée par le MODÈLE DE TABLES RÉEL avec des abonnements générés sur 36 mois.
// Le dossier de passation (budget réel de la CFO) n'est PAS dans le dépôt : ⚠️ échoue s'il manque.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); } catch { console.error('ÉCHEC : @electric-sql/pglite manquant (npm install --no-save @electric-sql/pglite)'); process.exit(1); }
const { registerFinanceRoutes } = require('../routes');
const { importHandoff } = require('../import');
const { PROTO } = require('../handoff');
const K = require('../kpiCore');
const SC = require('../suggestionsCore');

const DIR = path.resolve(process.argv[2] || path.join(__dirname, '../../../../design/finance'));
if (!fs.existsSync(path.join(DIR, PROTO))) { console.error(`ÉCHEC : paquet de passation introuvable dans ${DIR}`); process.exit(1); }

let n = 0;
const ok = (c, m) => { assert(c, m); n++; };
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, `${m} : ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); n++; };
const near = (a, b, m) => { assert(a != null && Math.abs(a - b) < 1e-9, `${m} : ${a} ≠ ${b}`); n++; };

// ============================================================================ 1. calculs purs
const LAST = '2026-09';
const MONTHS = K.monthRange(K.addMonths(LAST, -23), LAST); // 2024-10 … 2026-09
const TARGETS = Array.from({ length: 12 }, (_, i) => `2027-${String(i + 1).padStart(2, '0')}`);
eq([MONTHS[0], MONTHS[23], MONTHS.length], ['2024-10', '2026-09', 24], 'fenêtre de 24 mois clos');
const sug = (key, hist, opts) => SC.buildSuggestion(key, hist, MONTHS, TARGETS, opts);

// --- moyenne : last12 = [10,12,14,16,18,20,10,12,14,16,18,20]
{
  const hist = Array(12).fill(10).concat([10, 12, 14, 16, 18, 20, 10, 12, 14, 16, 18, 20]);
  // 3 derniers = 16,18,20 → 18 ; 6 derniers = 10,12,14,16,18,20 → 15 ; 12 derniers → 180/12 = 15
  const s3 = sug('intAdds', hist, { window: 3, method: 'avg' });
  eq(s3.suggested, Array(12).fill(18), 'moyenne 3 mois = 18');
  eq(s3.basis.sample, [16, 18, 20], 'échantillon 3 mois');
  const s6 = sug('intAdds', hist, { window: 6, method: 'avg' });
  eq(s6.suggested, Array(12).fill(15), 'moyenne 6 mois = 15');
  eq(sug('intAdds', hist, { window: 12, method: 'avg' }).suggested, Array(12).fill(15), 'moyenne 12 mois = 15');
  eq(s6.basis.why, 'chosen', 'méthode imposée : dit « choisie »');
  eq(s6.alternatives.filter((a) => a.method === 'avg').map((a) => [a.windowMonths, a.suggested[0]]), [[3, 18], [6, 15], [12, 15]], 'alternatives : trois fenêtres');
  const d = sug('intAdds', hist, {});
  ok(d.basis.method === 'avg' && d.basis.windowMonths === 6, 'défaut : moyenne 6 mois');
  eq(d.history.values.length, 24, 'historique = 24 mois');
  eq(d.history.months[23], '2026-09', 'historique : dernier mois clos');
}
// --- constante : stable, confiance haute, jamais de division par zéro
{
  const s = sug('canChurn', Array(24).fill(10), {});
  eq(s.suggested, Array(12).fill(10), 'série constante → 10');
  ok(s.basis.why === 'stable' && s.confidence === 'high' && s.basis.cv === 0, 'constante : stable, confiance haute, cv = 0');
  const z = sug('canChurn', Array(24).fill(0), {});
  ok(z.suggested.every((v) => v === 0) && z.basis.cv === 0 && z.confidence === 'high', 'mois sans aucune activité : 0 (pas de NaN)');
  const alt = Array.from({ length: 24 }, (_, i) => (i % 2 ? 1 : -1));
  const g = sug('canArpuG', alt, {});
  ok(g.basis.cv === null && g.confidence === 'low', 'moyenne nulle et série variable : cv indéfini → null, confiance basse');
  ok(g.suggested.every((v) => Number.isFinite(v)), 'aucune valeur NaN');
}
// --- tendance : v_i = 2 i + 10 ; 12 derniers = 34 + 2 j (j = 0..11), projetés à x = 11 + k
{
  const hist = Array.from({ length: 24 }, (_, i) => 2 * i + 10);
  const s = sug('intAdds', hist, {});
  // janvier 2027 : k = 4 → x = 15 → 34 + 30 = 64 ; chaque mois +2 ; décembre : k = 15 → 86
  eq(s.suggested, Array.from({ length: 12 }, (_, i) => 64 + 2 * i), 'tendance : 64, 66 … 86');
  ok(s.basis.method === 'trend' && s.basis.why === 'trend', 'rampe régulière → tendance (pas une saisonnalité)');
  eq(s.alternatives.find((a) => a.method === 'avg' && a.windowMonths === 3).suggested[0], 54, 'moyenne 3 mois de la rampe = 54');
  eq(s.alternatives.find((a) => a.method === 'avg' && a.windowMonths === 6).suggested[0], 51, 'moyenne 6 mois de la rampe = 51');
  eq(s.alternatives.find((a) => a.method === 'avg' && a.windowMonths === 12).suggested[0], 45, 'moyenne 12 mois de la rampe = 45');
  eq(s.alternatives.find((a) => a.method === 'seasonal').suggested[0], 40, 'même mois l\'an dernier (janvier 2026 = 34 + 2·3)');
  // Une tendance baissière ne passe jamais sous zéro : 12 → 1 sur les 12 derniers mois.
  const down = Array.from({ length: 24 }, (_, i) => 24 - i);
  const sd = sug('canChurn', down, {});
  ok(sd.basis.method === 'trend' && sd.suggested.every((v) => v === 0), 'tendance baissière : plancher à 0 pour un compte');
  // Une croissance folle est bornée à ±50 %.
  eq(sug('canArpuG', Array(24).fill(200), {}).suggested, Array(12).fill(50), 'croissance mensuelle bornée à 50');
}
// --- même mois l'an dernier : 2 saisons identiques (Oct 2025 … Sep 2026 = P)
{
  const P = [5, 5, 5, 5, 10, 20, 30, 20, 10, 5, 5, 5]; // Oct, Nov, Déc, Jan, Fév, Mar, Avr, Mai, Juin, Juil, Août, Sept
  const s = sug('intAdds', P.concat(P), {});
  ok(s.basis.method === 'seasonal' && s.basis.why === 'seasonal', 'saison qui se répète → même mois l\'an dernier');
  // janvier = P[3] = 5 … février 10, mars 20, avril 30, mai 20, juin 10, juil 5, août 5, sept 5, oct P[0] = 5, nov 5, déc 5
  eq(s.suggested, [5, 10, 20, 30, 20, 10, 5, 5, 5, 5, 5, 5], 'janvier à décembre = mêmes mois de la dernière année');
  ok(s.confidence !== 'high', 'série très variable : jamais confiance haute');
  // Un ARPU (croissance) n'a pas de « même mois » : jamais saisonnier.
  ok(sug('canArpuG', P.concat(P), {}).basis.method !== 'seasonal', 'croissance d\'ARPU : pas de méthode saisonnière');
  // Moins de 24 mois de données complètes : pas de saisonnier.
  const short = Array(4).fill(null).concat(P.concat(P).slice(4));
  ok(!sug('intAdds', short, {}).alternatives.some((a) => a.method === 'seasonal'), 'données incomplètes : pas de saisonnier');
}
// --- historique court
{
  const h = Array(20).fill(null).concat([4, 6, 8, 10]);
  const s = sug('intAdds', h, {});
  // 4 points : moyenne de 6 mois = (4+6+8+10)/4 = 7 ; confiance basse
  ok(s.basis.why === 'short_history' && s.confidence === 'low' && s.suggested[0] === 7, 'historique court : moyenne des points connus, confiance basse');
  ok(!s.alternatives.some((a) => a.method === 'trend'), 'historique court : pas de tendance (6 points au moins)');
  eq(sug('intAdds', Array(22).fill(null).concat([3, 5]), {}), null, 'deux points seulement : aucune suggestion');
  eq(sug('intAdds', [], {}), null, 'aucun historique : aucune suggestion');
  eq(sug('inconnu', Array(24).fill(1), {}), null, 'driver hors catalogue : aucune suggestion');
}
// --- bornes et validation (mêmes exigences que validateSection('drivers'))
{
  eq(SC.normalizeValues('intAdds', Array(12).fill(3.6)).values, Array(12).fill(4), 'un compte est arrondi');
  eq(SC.normalizeValues('intAdds', Array(12).fill(-1)).error, 'out_of_bounds', 'compte négatif refusé');
  eq(SC.normalizeValues('intAdds', Array(12).fill(1e6)).error, 'out_of_bounds', 'compte démesuré refusé');
  eq(SC.normalizeValues('convPct', Array(12).fill(101)).error, 'out_of_bounds', 'pourcentage > 100 refusé');
  eq(SC.normalizeValues('canArpuG', Array(12).fill(-51)).error, 'out_of_bounds', 'croissance < −50 refusée');
  eq(SC.normalizeValues('intAdds', [1, 2]).error, 'bad_length', '12 mois exigés');
  eq(SC.normalizeValues('intAdds', Array(12).fill('3')).error, 'not_finite', 'une chaîne n\'est pas un nombre');
  eq(SC.normalizeValues('intAdds', Array(12).fill(NaN)).error, 'not_finite', 'NaN refusé');
  eq(SC.normalizeValues('intAdds', Array(12).fill(1e10)).error, 'not_finite', 'au-delà du plafond de routes.js');
  eq(SC.normalizeValues('pirate', Array(12).fill(1)).error, 'unknown_driver', 'driver inconnu');
  ok(SC.DEAD_DRIVERS.every((k) => !SC.CATALOG[k]), 'les inputs morts (remplacés par la paie) ne sont pas au catalogue');
}

// --- historique Billing sur des abonnements fictifs (calculé à la main)
const sub = (o) => ({ customer_id: null, customer_name: '', status: 'live', cancelled_at: null, cancel_reason: null, monthly_amount: 0, ...o });
const COO = 'Change of Ownership – new sub created';
const CAN = 'ORG-CAN', USA = 'ORG-USA', XP = 'ORG-XP';
const rows = [
  // Même numéro SUB-00001 dans les trois organisations : doivent coexister sans se mélanger.
  sub({ org_id: CAN, subscription_number: 'SUB-00001', customer_id: 'c1', customer_name: 'Resto Un', activated_at: '2025-01-01', monthly_amount: 100 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00002', customer_id: 'cz', customer_name: 'Resto Zed', activated_at: '2025-02-01', monthly_amount: 200 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00003', customer_id: 'c5', customer_name: 'Chez Marie', activated_at: '2025-03-01', cancelled_at: '2026-09-15', status: 'cancelled', cancel_reason: 'change of ownership-new  sub created', monthly_amount: 60 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00004', customer_id: 'c6', customer_name: 'Bar Fermé', activated_at: '2025-04-01', cancelled_at: '2026-09-20', status: 'cancelled', cancel_reason: 'Closed business', monthly_amount: 80 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00005', customer_id: 'c7', customer_name: 'Deli Gamma', activated_at: '2025-05-01', cancelled_at: '2026-09-21', status: 'cancelled', cancel_reason: 'Change of ownership', monthly_amount: 40 }),
  // Septembre 2026
  sub({ org_id: CAN, subscription_number: 'SUB-00006', customer_id: 'c0', customer_name: 'Café Nouveau', activated_at: '2026-09-05', monthly_amount: 120 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00007', customer_id: 'cS', customer_name: 'SC - Pizza Roma', activated_at: '2026-09-10', monthly_amount: 90 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00008', customer_id: 'c3', customer_name: 'Chez Trois', activated_at: '2026-09-12', monthly_amount: 150 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00009', customer_id: 'c1', customer_name: 'Resto Un', activated_at: '2026-09-14', monthly_amount: 100 }), // 2e abonnement d'un client existant
  sub({ org_id: CAN, subscription_number: 'SUB-00010', customer_id: 'c5', customer_name: 'Chez Marie', activated_at: '2026-09-16', monthly_amount: 70 }), // remplace SUB-00003 (CoO)
  // Août 2026
  sub({ org_id: CAN, subscription_number: 'SUB-00011', customer_id: 'c8', customer_name: 'Nouveau Huit', activated_at: '2026-08-03', monthly_amount: 110 }),
  sub({ org_id: CAN, subscription_number: 'SUB-00012', customer_id: 'c9', customer_name: 'Nouveau Neuf', activated_at: '2026-08-20', monthly_amount: 130 }),
  // États-Unis : même numéro que SUB-00001 du Canada
  sub({ org_id: USA, subscription_number: 'SUB-00001', customer_id: 'u1', customer_name: 'NY Deli', activated_at: '2026-03-01', monthly_amount: 50 }),
  sub({ org_id: USA, subscription_number: 'SUB-00002', customer_id: 'u2', customer_name: 'Boston Bar', activated_at: '2025-06-01', cancelled_at: '2026-09-03', status: 'cancelled', cancel_reason: 'Closed', monthly_amount: 30 }),
  sub({ org_id: USA, subscription_number: 'SUB-00003', customer_id: 'u3', customer_name: 'LA Tacos', activated_at: '2025-07-01', cancelled_at: '2026-09-04', status: 'cancelled', cancel_reason: COO, monthly_amount: 20 }),
  // Xperio : première activité en juillet 2026
  sub({ org_id: XP, subscription_number: 'SUB-00001', customer_id: 'x1', customer_name: 'Xperio Un', activated_at: '2026-09-02', monthly_amount: 300 }),
  sub({ org_id: XP, subscription_number: 'SUB-00002', customer_id: 'x2', customer_name: 'Xperio Deux', activated_at: '2026-07-01', cancelled_at: '2026-09-10', status: 'cancelled', cancel_reason: 'Closed', monthly_amount: 250 }),
];
const ctx = {
  canadaOrgs: [CAN], usaOrgs: [USA], xpOrgs: [XP], cooReasons: [COO],
  aliases: K.buildResellerAliases([], ['SC']), mrrStatuses: K.DEFAULT_MRR_STATUSES,
};
const H = SC.billingHistory(rows, MONTHS, ctx);
const at = (key, m) => H[key][MONTHS.indexOf(m)];
{
  // Canada, septembre 2026 : activations = SUB-6,7,8,9,10 = 5 ; revendeur « SC » = SUB-7 → 1 ;
  // résiliations CoO = SUB-3 (motif normalisé) → 1 ; « Change of ownership » tout court n'en est PAS un.
  // intAdds = 5 − 1 − 1 = 3 ; resAdds = 1 ; résiliations = SUB-3, 4, 5 = 3, moins 1 CoO → canChurn = 2.
  eq(at('intAdds', '2026-09'), 3, 'Canada sept. : ajouts internes = activations − revendeurs − CoO = 3');
  eq(at('resAdds', '2026-09'), 1, 'revendeur en MOTS ENTIERS (SC) = 1');
  eq(at('canChurn', '2026-09'), 2, 'attrition Canada = 3 résiliations − 1 CoO = 2 (le CoO est exclu)');
  // Nouveaux clients : ajouts internes hors revendeur et hors remplaçant CoO = SUB-6, 8, 9 ;
  // SUB-9 est le 2e abonnement du client c1 (déjà actif en 2025) → 2 nouveaux sur 3.
  near(at('newClientPct', '2026-09'), (100 * 2) / 3, 'part de nouveaux clients = 2/3');
  eq(at('intAdds', '2026-08'), 2, 'Canada août : 2 ajouts internes');
  near(at('newClientPct', '2026-08'), 100, 'août : deux nouveaux clients = 100 %');
  eq(at('intAdds', '2026-07'), 0, 'mois sans activité = 0 (pas null)');
  eq(at('newClientPct', '2026-07'), null, 'mois sans ajout : pas de part (division par zéro évitée)');
  eq(at('canChurn', '2026-08'), 0, 'août : aucune résiliation');
  // ARPU de fin de mois. 31 août : SUB-1,2,3,4,5,11,12 actifs = 100+200+60+80+40+110+130 = 720 / 7.
  // 30 sept. : SUB-1,2,6,7,8,9,10,11,12 = 100+200+120+90+150+100+70+110+130 = 1070 / 9 (SUB-3,4,5 résiliés).
  // 31 juillet : SUB-1,2,3,4,5 = 480 / 5 = 96.
  near(at('canArpuG', '2026-09'), ((1070 / 9) / (720 / 7) - 1) * 100, 'croissance mensuelle de l\'ARPU en septembre');
  near(at('canArpuG', '2026-08'), ((720 / 7) / 96 - 1) * 100, 'croissance mensuelle de l\'ARPU en août');
  // É.-U. : la résiliation CoO (SUB-3) est exclue ; SUB-00001 du Canada n'est pas celui des É.-U.
  eq(at('usaChurn', '2026-09'), 1, 'É.-U. sept. : 2 résiliations − 1 CoO = 1');
  eq(at('intAdds', '2026-03'), 0, 'l\'abonnement É.-U. activé en mars ne compte pas dans le Canada (même numéro, autre organisation)');
  // Xperio : ajouts = activations − CoO ; avant juillet 2026 (début d'activité) la série est INCONNUE.
  eq(at('xpAdds', '2026-09'), 1, 'Xperio sept. : 1 ajout');
  eq(at('xpChurn', '2026-09'), 1, 'Xperio sept. : 1 attrition');
  eq(at('xpAdds', '2026-07'), 1, 'Xperio juillet : 1 ajout');
  eq(at('xpAdds', '2026-06'), null, 'Xperio avant sa première activation : inconnu (null), pas zéro');
  eq(at('xpAdds', '2026-08'), 0, 'Xperio août : 0');
  eq(H._present, { can: true, usa: true, xp: true }, 'les trois organisations ont des données');
  // Sans aucune ligne pour une organisation → absente
  eq(SC.billingHistory(rows.filter((r) => r.org_id !== XP), MONTHS, ctx)._present.xp, false, 'organisation sans abonnement : absente');
}
// --- Zentact : ajouts par mois et ARPU
{
  const merchants = [
    { activated_at: '2026-07-04' }, { activated_at: '2026-07-20' }, { activated_at: '2026-08-02' },
    { activated_at: null }, { activated_at: '2026-09-30' }, { activated_at: '2026-09-01' }, { activated_at: '2026-09-15' },
  ];
  // profit + autres revenus par marchand, mêmes marchands deux mois de suite (CAD) ; une ligne USD ignorée.
  const rev = [
    { year: 2026, month: 7, currency: 'CAD', total_volume_cents: 1000, payments_count: 5, transaction_profit_cents: 10000, other_revenue_cents: null },
    { year: 2026, month: 7, currency: 'CAD', total_volume_cents: 2000, payments_count: 9, transaction_profit_cents: 20000, other_revenue_cents: 0 },
    { year: 2026, month: 8, currency: 'CAD', total_volume_cents: 1000, payments_count: 5, transaction_profit_cents: 12000, other_revenue_cents: 0 },
    { year: 2026, month: 8, currency: 'CAD', total_volume_cents: 2000, payments_count: 9, transaction_profit_cents: 24000, other_revenue_cents: 0 },
    { year: 2026, month: 8, currency: 'CAD', total_volume_cents: 0, payments_count: 0, transaction_profit_cents: 999999, other_revenue_cents: 0 }, // sans volume : ignorée
    { year: 2026, month: 8, currency: 'USD', total_volume_cents: 5, payments_count: 1, transaction_profit_cents: 777, other_revenue_cents: 0 },
  ];
  const Z = SC.zentactHistory(merchants, rev, MONTHS);
  const zi = (m) => MONTHS.indexOf(m);
  eq([Z.adyenTarget[zi('2026-07')], Z.adyenTarget[zi('2026-08')], Z.adyenTarget[zi('2026-09')]], [2, 1, 3], 'marchands activés par mois : 2, 1, 3');
  eq(Z.adyenTarget[zi('2026-06')], null, 'avant le premier marchand : inconnu');
  // ARPU juillet = 30000/2 = 15000 ; août = 36000/2 = 18000 → croissance août = +20 %. Septembre : pas de revenu → null.
  near(Z.adyenArpuG[zi('2026-08')], 20, 'croissance de l\'ARPU paiements = +20 %');
  eq(Z.adyenArpuG[zi('2026-09')], null, 'mois sans revenu : pas de croissance');
  eq(Z.adyenArpuG[zi('2026-07')], null, 'premier mois de revenu : pas de croissance');
  eq(SC.zentactHistory(null, null, MONTHS).adyenTarget, null, 'Zentact absent : pas de série');
}
// --- assemblage : suggestions et « indisponibles » avec raison
{
  const keys = SC.DRIVER_KEYS.concat(SC.DEAD_DRIVERS);
  const all = SC.suggestAll({ months: MONTHS, targets: TARGETS, keys, billingRows: rows, zentact: { merchants: null, revenue: null }, ctx, window: 6, current: {} });
  const sk = all.suggestions.map((s) => s.key);
  ok(!SC.DEAD_DRIVERS.some((k) => sk.includes(k) || all.unavailable.some((u) => u.key === k)), 'inputs morts : ni suggestion ni liste');
  const reason = (k) => (all.unavailable.find((u) => u.key === k) || {}).reason;
  eq(reason('hwPerNew'), 'ledger_required', 'matériel : réels du grand livre requis');
  eq(reason('merchantFees'), 'ledger_required', 'pourcentages et coûts de COGS : réels du grand livre requis');
  eq(reason('adyenChurn'), 'no_closure_date', 'attrition des paiements : pas de date de fermeture');
  eq(reason('convPct'), 'no_reliable_join', 'conversion : pas de jointure fiable');
  eq(reason('adyenTarget'), 'zentact_empty', 'Zentact vide : indisponible, avec raison');
  eq(reason('contractsG'), 'no_source', 'contrats de service : aucune source');
  ok(all.unavailable.every((u) => u.detail), 'chaque indisponible a sa phrase');
  ok(sk.includes('intAdds') && sk.includes('canArpuG') && sk.includes('usaChurn'), 'suggestions Billing présentes');
  eq(all.suggestions.every((s) => s.suggested.length === 12 && s.current.length === 12), true, '12 valeurs par suggestion');
  const none = SC.suggestAll({ months: MONTHS, targets: TARGETS, keys, billingRows: [], zentact: null, ctx, current: {} });
  eq(none.suggestions.length, 0, 'Billing non synchronisé : aucune suggestion');
  eq(none.unavailable.find((u) => u.key === 'intAdds').reason, 'billing_not_synced', 'raison : Billing non synchronisé');
  const noXp = SC.suggestAll({ months: MONTHS, targets: TARGETS, keys, billingRows: rows.filter((r) => r.org_id !== XP), zentact: null, ctx, current: {} });
  eq(noXp.unavailable.find((u) => u.key === 'xpAdds').reason, 'no_history', 'organisation sans abonnement : « pas d\'historique »');
  ok(all.suggestions.find((s) => s.key === 'canArpuG').confidence === 'low', 'ARPU reconstruit : confiance plafonnée à basse');
}

// ============================================================================ 2. de bout en bout
(async () => {
  const db = new PGlite();
  const pool = { query: (q, p) => db.query(q, p) };
  await db.exec(`
    CREATE TABLE activity_log (id SERIAL, entity_type TEXT, entity_id TEXT, event_type TEXT, description TEXT, actor TEXT, amount NUMERIC, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE roles (id SERIAL PRIMARY KEY, name TEXT UNIQUE, description TEXT, permissions JSONB, is_system BOOLEAN);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ);
  `);
  const perms = {
    'cfo@x.com': ['finance:view', 'finance:edit', 'finance:payroll', 'finance:approve', 'finance:suggestions', 'finance:ai_budget'],
    'sugg@x.com': ['finance:view', 'finance:suggestions'],
    'lecteur@x.com': ['finance:view'],
    'sansvue@x.com': ['finance:suggestions'],
    'nobody@x.com': [],
  };
  const has = (req, p) => (perms[req.user.email] || []).includes(p);
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const authenticateToken = (req, res, next) => {
    const e = req.headers['x-test-user']; if (!e) return res.status(401).json({ error: 'auth' });
    req.user = { email: e, isAdmin: false, isDemo: req.headers['x-test-demo'] === '1' }; next();
  };
  registerFinanceRoutes(app, {
    authenticateToken, pool,
    hasPerm: async (req, p) => has(req, p),
    requirePerm: async (req, res, p) => { if (has(req, p)) return true; res.status(403).json({ error: 'perm' }); return false; },
    logActivity: async () => {},
    late: () => ({}),
  });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, user, body, extra = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const GET = '/api/finance/suggestions';

  // ---- avant l'import et permissions
  ok((await api('GET', GET)).status === 401, 'sans jeton : 401');
  ok((await api('GET', GET, 'nobody@x.com')).status === 403, 'sans permission : 403');
  ok((await api('GET', GET, 'lecteur@x.com')).status === 403, 'finance:view seule : refusé (finance:suggestions exigée)');
  ok((await api('GET', GET, 'sansvue@x.com')).status === 403, 'finance:suggestions sans finance:view : refusé');
  const demo = await api('GET', GET, 'cfo@x.com', null, { 'x-test-demo': '1' });
  ok(demo.status === 403 && demo.body.demo === true, 'mode démo : bloqué');
  const pre = await api('GET', GET, 'cfo@x.com');
  ok(pre.status === 200 && pre.body.empty === true && pre.body.suggestions.length === 0, 'aucun budget importé : réponse vide, pas d\'erreur');

  const imp = await importHandoff(pool, DIR, { apply: true, actor: 'test' });
  ok(imp.action === 'create' && imp.budgetId, 'import du budget réel (pour les clés et les valeurs courantes)');
  const id = imp.budgetId;

  // ---- Billing pas encore synchronisé : « pas de réels » proprement
  let r = await api('GET', GET, 'cfo@x.com');
  ok(r.status === 200 && r.body.empty === false && r.body.suggestions.length === 0, 'Billing vide : aucune suggestion, pas d\'erreur');
  ok(r.body.unavailable.length > 30 && r.body.unavailable.every((u) => u.reason && u.detail), 'chaque driver sans suggestion a sa raison');
  ok(r.body.unavailable.find((u) => u.key === 'intAdds').reason === 'billing_not_synced', 'raison : Billing non synchronisé');
  ok(r.body.unavailable.find((u) => u.key === 'hwPerNew').reason === 'ledger_required', 'matériel : réels requis');
  const ref = (await db.query('SELECT reference FROM finance_budgets WHERE id = $1', [id])).rows[0].reference;
  const known = Object.keys(ref.drvDefaults);
  ok(known.every((k) => SC.DEAD_DRIVERS.includes(k) || r.body.unavailable.some((u) => u.key === k)), 'chaque driver du budget (hors inputs morts) est soit suggéré soit expliqué');

  // ---- « prod simulée » : tables réelles, abonnements générés sur 36 mois (3 organisations)
  const CANID = '697704869', USAID = '802470810', XPID = '905113716';
  const lastClosed = K.lastCompleteMonth(new Date());
  const m36 = K.monthRange(K.addMonths(lastClosed, -35), lastClosed);
  const subs = [];
  let seq = 0;
  const perOrg = {};
  const mk = (org, month, day, extra = {}) => {
    seq++;
    perOrg[org] = (perOrg[org] || 0) + 1;
    const number = `SUB-${String(perOrg[org]).padStart(5, '0')}`; // numéros réutilisés d'une organisation à l'autre
    subs.push({ org, number, cust: `cu${org.slice(-3)}-${seq}`, name: extra.name || `Client ${org.slice(-3)} ${seq}`, status: extra.cancelled ? 'cancelled' : 'live', act: `${month}-${String(day).padStart(2, '0')}`, can: extra.cancelled || null, reason: extra.reason || null, amt: extra.amt || 100 });
    return number;
  };
  m36.forEach((m, i) => {
    // Canada : 18 à 23 ajouts par mois dont un sur quatre revendeur ; 6 résiliations par mois à partir du 13e mois.
    const adds = 18 + (i % 6);
    for (let j = 0; j < adds; j++) {
      const cancelM = j % 4 === 0 && i + 8 < m36.length ? m36[i + 8] : null;
      mk(CANID, m, 1 + (j % 27), { name: j % 4 === 1 ? `SC - Resto ${seq}` : undefined, amt: 90 + (i % 10) * 3, cancelled: cancelM ? `${cancelM}-15` : null, reason: cancelM ? (j % 8 === 0 ? 'Closed business' : COO) : null });
    }
    for (let j = 0; j < 2; j++) mk(USAID, m, 3 + j, { amt: 120, cancelled: i + 6 < m36.length && j === 0 ? `${m36[i + 6]}-10` : null, reason: 'Closed' });
    if (i >= 12) for (let j = 0; j < 3; j++) mk(XPID, m, 5 + j, { amt: 60, cancelled: i + 5 < m36.length && j === 0 ? `${m36[i + 5]}-12` : null, reason: 'Closed' });
  });
  for (let i = 0; i < subs.length; i += 500) {
    const chunk = subs.slice(i, i + 500);
    const ph = chunk.map((_, k) => `($${k * 9 + 1},$${k * 9 + 2},$${k * 9 + 3},$${k * 9 + 4},$${k * 9 + 5},$${k * 9 + 6}::date,$${k * 9 + 7}::date,$${k * 9 + 8},$${k * 9 + 9})`).join(',');
    await db.query(`INSERT INTO finance_billing_subs (org_id, subscription_number, customer_id, customer_name, status, activated_at, cancelled_at, cancel_reason, monthly_amount) VALUES ${ph}`,
      chunk.flatMap((s) => [s.org, s.number, s.cust, s.name, s.status, s.act, s.can, s.reason, s.amt]));
  }
  // Zentact (tables de server.js, sous-ensemble de colonnes) : 15 mois.
  await db.exec(`
    CREATE TABLE zentact_merchants (id SERIAL PRIMARY KEY, merchant_account_id VARCHAR(255) UNIQUE NOT NULL, status VARCHAR(50) DEFAULT '', activated_at DATE);
    CREATE TABLE zentact_merchant_revenue (id SERIAL PRIMARY KEY, merchant_account_id VARCHAR(255) NOT NULL, year INT NOT NULL, month INT NOT NULL, currency VARCHAR(8),
      total_volume_cents BIGINT DEFAULT 0, payments_count INT DEFAULT 0, transaction_profit_cents BIGINT DEFAULT 0, other_revenue_cents BIGINT, UNIQUE (merchant_account_id, year, month));
  `);
  const z15 = K.monthRange(K.addMonths(lastClosed, -14), lastClosed);
  let mseq = 0;
  for (const [i, m] of z15.entries()) {
    for (let j = 0; j < 5 + (i % 3); j++) { mseq++; await db.query("INSERT INTO zentact_merchants (merchant_account_id, status, activated_at) VALUES ($1, 'ACTIVE', $2::date)", [`M${mseq}`, `${m}-10`]); }
  }
  for (let k = 1; k <= mseq; k++) {
    for (const [i, m] of z15.entries()) {
      await db.query("INSERT INTO zentact_merchant_revenue (merchant_account_id, year, month, currency, total_volume_cents, payments_count, transaction_profit_cents) VALUES ($1, $2, $3, 'CAD', 100000, 50, $4)",
        [`M${k}`, +m.slice(0, 4), +m.slice(5), 8000 + i * 40]);
    }
  }

  r = await api('GET', GET, 'cfo@x.com');
  ok(r.status === 200 && r.body.suggestions.length >= 11, `suggestions produites (${r.body.suggestions.length})`);
  const S = Object.fromEntries(r.body.suggestions.map((s) => [s.key, s]));
  ok(r.body.meta.lastClosedMonth === lastClosed && r.body.meta.months.length === 24, 'fenêtre de 24 mois clos, mois en cours exclu');
  ok(!r.body.meta.months.includes(new Date().toISOString().slice(0, 7)) || lastClosed >= new Date().toISOString().slice(0, 7), 'le mois en cours n\'est pas dans l\'historique');
  ok(r.body.suggestions.every((s) => s.suggested.length === 12 && s.suggested.every((v) => Number.isFinite(v))), '12 nombres finis par suggestion');
  ok(r.body.suggestions.every((s) => { const b = SC.boundsOf(s.key); return s.suggested.every((v) => v >= b[0] && v <= b[1]); }), 'toutes les valeurs dans les bornes du catalogue');
  ok(r.body.suggestions.every((s) => SC.normalizeValues(s.key, s.suggested).values), 'valeurs acceptées par la validation du budget (12 nombres finis < 1e10)');
  ok(['intAdds', 'resAdds', 'canChurn', 'usaChurn', 'xpAdds', 'xpChurn', 'adyenTarget'].every((k) => S[k].suggested.every(Number.isInteger)), 'comptes : entiers');
  // Plages plausibles (données générées : ~14-17 ajouts internes, ~4-6 ajouts revendeurs par mois…)
  ok(S.intAdds.suggested[0] >= 10 && S.intAdds.suggested[0] <= 25, `ajouts internes plausibles (${S.intAdds.suggested[0]})`);
  ok(S.resAdds.suggested[0] >= 3 && S.resAdds.suggested[0] <= 8, `ajouts revendeurs plausibles (${S.resAdds.suggested[0]})`);
  ok(S.canChurn.suggested[0] >= 0 && S.canChurn.suggested[0] <= 12, `attrition Canada plausible (${S.canChurn.suggested[0]})`);
  ok(S.usaChurn.suggested[0] >= 0 && S.usaChurn.suggested[0] <= 3, `attrition É.-U. plausible (${S.usaChurn.suggested[0]})`);
  ok(S.xpAdds.suggested[0] >= 1 && S.xpAdds.suggested[0] <= 4, `ajouts Xperio plausibles (${S.xpAdds.suggested[0]})`);
  ok(S.canArpuG.suggested[0] > -5 && S.canArpuG.suggested[0] < 5, `croissance d'ARPU plausible (${S.canArpuG.suggested[0]} %)`);
  ok(S.newClientPct.suggested[0] > 50 && S.newClientPct.suggested[0] <= 100, `part de nouveaux clients plausible (${S.newClientPct.suggested[0]} %)`);
  ok(S.adyenTarget.suggested[0] >= 4 && S.adyenTarget.suggested[0] <= 8, `ajouts Adyen plausibles (${S.adyenTarget.suggested[0]})`);
  ok(S.adyenArpuG && S.adyenArpuG.confidence === 'low', 'ARPU des paiements suggéré, confiance basse');
  ok(r.body.unavailable.every((u) => u.reason && u.detail), 'indisponibles : raison et phrase');
  ok(!r.body.suggestions.some((s) => r.body.unavailable.some((u) => u.key === s.key)), 'un driver est soit suggéré soit indisponible');
  ok(S.intAdds.basis.method && S.intAdds.basis.why && Array.isArray(S.intAdds.basis.sample) && S.intAdds.basis.unit === 'count', 'base de calcul dite : méthode, pourquoi, échantillon, unité');
  ok(S.intAdds.alternatives.length >= 3 && S.intAdds.alternatives.every((a) => a.suggested.length === 12), 'alternatives (3/6/12 mois, tendance, saisonnier)');
  ok(S.intAdds.history.values.length === 24 && S.intAdds.history.months[23] === lastClosed, 'historique de 24 mois');
  ok(r.body.caps.canApply === true && r.body.caps.canAiBudget === true, 'caps du CFO');
  // Le Canada ne mélange pas les organisations malgré les numéros d'abonnement réutilisés.
  const canActs = subs.filter((s) => s.org === CANID && s.act.startsWith(lastClosed)).length;
  const canResv = subs.filter((s) => s.org === CANID && s.act.startsWith(lastClosed) && /^SC - /.test(s.name)).length;
  const lastIdx = S.intAdds.history.months.indexOf(lastClosed);
  const cooLast = subs.filter((s) => s.org === CANID && s.can && s.can.startsWith(lastClosed) && s.reason === COO).length;
  eq(S.resAdds.history.values[lastIdx], canResv, 'revendeurs du dernier mois : comptés sur le Canada seulement');
  eq(S.intAdds.history.values[lastIdx], Math.max(0, canActs - canResv - cooLast), 'ajouts internes du dernier mois = activations − revendeurs − CoO (comptes générés)');

  // Fenêtre et méthode
  const w3 = (await api('GET', `${GET}?window=3&method=avg`, 'cfo@x.com')).body.suggestions.find((s) => s.key === 'intAdds');
  ok(w3.basis.method === 'avg' && w3.basis.windowMonths === 3 && w3.basis.sample.length === 3, 'window=3&method=avg : moyenne des 3 derniers mois');
  const sum3 = w3.basis.sample.reduce((a, b) => a + b, 0);
  eq(w3.suggested[0], Math.round(sum3 / 3), 'moyenne 3 mois recalculée à partir de l\'échantillon');
  ok((await api('GET', `${GET}?window=5`, 'cfo@x.com')).body.error === 'bad_window', 'fenêtre inconnue : 400');
  ok((await api('GET', `${GET}?method=magic`, 'cfo@x.com')).body.error === 'bad_method', 'méthode inconnue : 400');

  // Lecture seule : rien n'a été écrit au budget ; permissions d'écriture dans caps
  const nState = Number((await db.query('SELECT COUNT(*)::int AS n FROM finance_state WHERE budget_id = $1', [id])).rows[0].n);
  eq(nState, 0, 'les suggestions n\'écrivent rien au budget');
  const sg = await api('GET', GET, 'sugg@x.com');
  ok(sg.status === 200 && sg.body.caps.canApply === false && sg.body.caps.canAiBudget === false, 'finance:suggestions sans finance:edit : lecture, pas d\'application');

  // Les valeurs courantes suivent l'état de la CFO
  const put = await api('PUT', `/api/finance/budgets/${id}/state/drivers`, 'cfo@x.com', { data: { drv: { intAdds: Array(12).fill(31) } }, version: 0 });
  ok(put.status === 200, 'la CFO ajuste intAdds');
  const cur = (await api('GET', GET, 'cfo@x.com')).body.suggestions.find((s) => s.key === 'intAdds');
  eq(cur.current, Array(12).fill(31), 'valeur courante = état de la CFO');
  const other = (await api('GET', GET, 'cfo@x.com')).body.suggestions.find((s) => s.key === 'resAdds');
  eq(other.current, Array(12).fill(ref.drvDefaults.resAdds), 'valeur courante sans ajustement = valeur par défaut × 12');

  console.log(`suggestions.test.js : ${n} vérifications OK`);
  server.close();
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC', e); process.exit(1); });
