// ============================================================================
// Module Finance — gestionnaires (revenus reportés, amortissement des terminaux) : le CALCUL,
// sans base ni HTTP. Fonctions pures, testées par __tests__/managers.test.js.
//
// Tous les montants internes sont en CENTS ENTIERS. Chaque mois reçoit la différence de deux
// cumuls arrondis au cent (cumul(m) − cumul(m−1)) : la somme des mois retombe EXACTEMENT sur le
// montant du contrat (ou le coût amortissable du lot), le dernier mois absorbe l'arrondi, et
// une écriture de journal est équilibrée au cent sans « ajustement » caché.
//
// Corrections du prototype (design/finance/ecarts/managers.md) :
//   - waterfall : un contrat finit à début + DURÉE (le prototype coupait à début + mois restants) ;
//   - écriture des revenus : crédit PAR TYPE DE CONTRAT (plus de 69 / 22 / 9 % fixes) ;
//   - aucun « rembourrage » de portefeuille, mois courant réel (fuseau de Toronto) ;
//   - un lot pas encore en service ne s'amortit pas ; une radiation passe une écriture.
// ============================================================================

const crypto = require('crypto');

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// ---------------------------------------------------------------------------- mois
/** 'AAAA-MM' → index de mois (année*12 + mois-1) ; null si illisible. */
function ym(s) {
  const m = MONTH_RE.exec(String(s || ''));
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}
/** index → 'AAAA-MM'. */
function mStr(i) {
  const y = Math.floor(i / 12), mo = i - y * 12 + 1;
  return `${y}-${String(mo).padStart(2, '0')}`;
}
/** Dernier jour du mois, 'AAAA-MM-JJ' (date de l'écriture de journal). */
function lastDay(i) {
  const y = Math.floor(i / 12), mo = i - y * 12; // 0..11
  const d = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return `${mStr(i)}-${String(d).padStart(2, '0')}`;
}
/** Mois courant à Toronto, 'AAAA-MM' (le mois de clôture de la CFO ; jamais le fuseau du serveur). */
function currentMonth(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }).slice(0, 7);
}
const isMonth = (s) => ym(s) != null;
const isDate = (s) => {
  const m = DATE_RE.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCDate() === Number(m[3]);
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cents = (dollars) => Math.round(Number(dollars) * 100);
const dollars = (c) => c / 100;

// ---------------------------------------------------------------------------- réglages par défaut
// Codes de comptes = VALEURS PAR DÉFAUT seulement : la CFO les modifie à l'écran (réglages).
const DEFAULT_DEFERRED_SETTINGS = {
  deferredAccount: '2400',
  types: [
    { key: 'subscription', labelEn: 'Annual SaaS subscription', labelFr: 'Abonnement SaaS annuel', account: '4000' },
    { key: 'prepaid', labelEn: 'Prepaid multi-year SaaS', labelFr: 'SaaS prépayé pluriannuel', account: '4000' },
    { key: 'service', labelEn: 'Installation / service fee', labelFr: 'Frais d\'installation / service', account: '4100' },
    { key: 'training', labelEn: 'Training', labelFr: 'Formation', account: '4150' },
    { key: 'licence', labelEn: 'Licence', labelFr: 'Licence', account: '4150' },
  ],
};
// Radiation : deux traitements, au choix de la CFO (réglage), documentés dans ecarts/managers.md.
//   derecognize (par défaut, sortie de l'actif) : Dt amortissement cumulé (cumul à date)
//                                                 Dt perte sur radiation (VNC)
//                                                 Ct actif « terminaux » (coût)
//   accelerate (amortissement accéléré)         : Dt perte / charge (VNC)
//                                                 Ct amortissement cumulé (VNC) — l'actif reste au coût.
// Les comptes « perte » et « actif » n'ont PAS de valeur par défaut (inconnus) : tant qu'ils
// manquent, l'écriture de radiation est affichée mais ne peut pas être passée.
const DEFAULT_AMORT_SETTINGS = {
  expenseAccount: '6200',
  accumAccount: '1590',
  assetAccount: '',
  lossAccount: '',
  writeOffMode: 'derecognize',
  defaultLife: 36,
};

// ---------------------------------------------------------------------------- revenus reportés
/**
 * Contrat normalisé : { totalC, st, term, closedAt, treatment, billedAt }.
 *   closedAt / treatment : fermeture anticipée au mois C —
 *     'release' : le solde restant est constaté en revenu au mois C ;
 *     'cancel'  : la constatation s'arrête après C−1, le solde restant sort du reporté sans
 *                 revenu (remboursement / note de crédit passés dans Books par ailleurs).
 *   billedAt : mois de facturation (date facturée, sinon le mois de début) — sert aux
 *              « nouveaux reports » du mois. Un contrat facturé APRÈS le mois choisi n'est pas
 *              encore un passif : il est hors solde et hors waterfall ce mois-là.
 */
function normContract(c) {
  const st = ym(c.startMonth);
  return {
    totalC: cents(c.total),
    st,
    term: Number(c.termMonths),
    closedAt: c.closedMonth ? ym(c.closedMonth) : null,
    treatment: c.closeTreatment || null,
    billedAt: c.billedDate ? ym(String(c.billedDate).slice(0, 7)) : st,
    hasBilledDate: !!c.billedDate,
  };
}
const normalCum = (k, m) => Math.round((k.totalC * clamp(m - k.st + 1, 0, k.term)) / k.term);
/** Cents constatés du début jusqu'à la fin du mois m inclus. */
function recCum(k, m) {
  if (k.closedAt != null && m >= k.closedAt) return k.treatment === 'release' ? k.totalC : normalCum(k, k.closedAt - 1);
  return normalCum(k, m);
}
/** Cents sortis du reporté sans revenu (fermeture « cancel ») au plus tard en m. */
const cancelledBy = (k, m) => (k.closedAt != null && k.treatment === 'cancel' && m >= k.closedAt ? k.totalC - normalCum(k, k.closedAt - 1) : 0);
/** Le contrat fait-il partie du passif à la fin de m ? (facturé, sinon saisi = facturé) */
const inBook = (k, m) => !k.hasBilledDate || k.billedAt <= m;
// Rien ne sort du compte 2400 avant la facture : un contrat commencé AVANT d'être facturé
// rattrape, le mois de la facture, les mois déjà écoulés (sinon le 2400 deviendrait négatif).
const bookCum = (k, m) => (inBook(k, m) ? recCum(k, m) : 0);
/** Cents constatés (sortis du reporté) dans le mois m. */
const recIn = (k, m) => bookCum(k, m) - bookCum(k, m - 1);

function contractStatus(k, m) {
  if (k.closedAt != null && m >= k.closedAt) return 'closed';
  if (!inBook(k, m)) return 'notBilled';
  if (recCum(k, m) >= k.totalC) return 'complete';
  if (k.st > m) return 'upcoming';
  return 'recognizing';
}

/** Ligne de contrat calculée au mois M (index). */
function contractAt(c, M) {
  const k = normContract(c);
  const rec = bookCum(k, M);
  const remaining = inBook(k, M) ? k.totalC - rec - cancelledBy(k, M) : 0;
  return {
    status: contractStatus(k, M),
    recognizedToDate: dollars(rec),
    remaining: dollars(Math.max(0, remaining)),
    thisMonth: dollars(recIn(k, M)),
    monthly: dollars(Math.round(k.totalC / k.term)),
    endMonth: mStr(k.st + k.term - 1),
    inBook: inBook(k, M),
  };
}

/**
 * Tableau de bord des revenus reportés au mois `month` ('AAAA-MM').
 * Retourne les tuiles, le waterfall des 12 mois suivants et l'écriture de journal du mois.
 */
function deferredSummary(contracts, month, settings = DEFAULT_DEFERRED_SETTINGS) {
  const M = ym(month);
  if (M == null) throw new Error('bad_month');
  const ks = contracts.map((c) => ({ c, k: normContract(c) }));
  let recognized = 0, balance = 0, newDef = 0, newCount = 0, open = 0;
  const byType = {};
  const wf = Array(12).fill(0);
  for (const { c, k } of ks) {
    const r = recIn(k, M);
    recognized += r;
    byType[c.type] = (byType[c.type] || 0) + r;
    if (k.billedAt === M) { newDef += k.totalC; newCount++; }
    if (!inBook(k, M)) continue;
    const rem = k.totalC - recCum(k, M) - cancelledBy(k, M);
    balance += rem;
    if (rem > 0) open++;
    for (let i = 0; i < 12; i++) wf[i] += recIn(k, M + 1 + i);
  }
  const next12 = wf.reduce((a, b) => a + b, 0);
  return {
    month,
    recognized: dollars(recognized),
    recognizedByType: Object.fromEntries(Object.entries(byType).map(([t, v]) => [t, dollars(v)])),
    balance: dollars(balance),
    openContracts: open,
    newDeferrals: dollars(newDef),
    newCount,
    next12: dollars(next12),
    beyond12: dollars(balance - next12),
    waterfall: wf.map((v, i) => ({ month: mStr(M + 1 + i), amount: dollars(v) })),
    journal: deferredJournal(ks, M, settings),
  };
}

/** Écriture du mois M : Dt reporté / Ct revenus PAR COMPTE des types de contrat. */
function deferredJournal(ks, M, settings) {
  const typeAcct = Object.fromEntries((settings.types || []).map((t) => [t.key, t.account]));
  const credit = new Map();
  let total = 0;
  const unknownTypes = new Set();
  for (const { c, k } of ks) {
    const r = recIn(k, M);
    if (!r) continue;
    const acct = typeAcct[c.type];
    if (!acct) { unknownTypes.add(c.type); continue; }
    total += r;
    credit.set(acct, (credit.get(acct) || 0) + r);
  }
  const debits = total ? [{ code: settings.deferredAccount, role: 'deferred', cents: total }] : [];
  const credits = [...credit.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, v]) => ({ code, role: 'revenue', cents: v }));
  return finishJournal('deferred', 'recognition', M, debits, credits, { unknownTypes: [...unknownTypes] });
}

// ---------------------------------------------------------------------------- amortissement
function normLot(l) {
  const costC = cents(Number(l.quantity) * Number(l.unitCost));
  return {
    costC,
    salvageC: Math.min(costC, cents(l.salvage || 0)),
    st: ym(l.inServiceMonth),
    life: Number(l.usefulLife),
    wo: l.writtenOffMonth ? ym(l.writtenOffMonth) : null,
    qty: Number(l.quantity),
  };
}
/** Amortissement cumulé « normal » (sans radiation) à la fin de m, en cents. Rien avant la mise en service. */
const regCum = (k, m) => (m < k.st ? 0 : Math.round(((k.costC - k.salvageC) * clamp(m - k.st + 1, 0, k.life)) / k.life));
const written = (k, m) => k.wo != null && m >= k.wo;
/** Charge du mois m : aucune le mois de la radiation ni après (la VNC passe en perte ce mois-là). */
const chargeIn = (k, m) => (written(k, m) ? 0 : regCum(k, m) - regCum(k, m - 1));
const accumAt = (k, m) => (written(k, m) ? regCum(k, k.wo - 1) : regCum(k, m));
const nbvAt = (k, m) => (written(k, m) ? 0 : k.costC - regCum(k, m));
/** VNC passée en perte au mois de la radiation (valeur résiduelle comprise : aucun produit de cession saisi). */
const writeOffNbv = (k) => k.costC - regCum(k, k.wo - 1);

function lotStatus(k, m) {
  if (written(k, m)) return 'writtenOff';
  if (k.st > m) return 'notInService';
  if (regCum(k, m) >= k.costC - k.salvageC) return 'fullyAmortized';
  return 'amortizing';
}

function lotAt(l, M) {
  const k = normLot(l);
  return {
    status: lotStatus(k, M),
    cost: dollars(k.costC),
    accumulated: dollars(accumAt(k, M)),
    nbv: dollars(nbvAt(k, M)),
    thisMonth: dollars(chargeIn(k, M)),
    monthly: dollars(Math.round((k.costC - k.salvageC) / k.life)),
    endMonth: mStr(k.st + k.life - 1),
    writeOffAmount: k.wo != null ? dollars(writeOffNbv(k)) : null,
  };
}

function amortSummary(lots, month, settings = DEFAULT_AMORT_SETTINGS) {
  const M = ym(month);
  if (M == null) throw new Error('bad_month');
  const derecognize = settings.writeOffMode !== 'accelerate';
  const ks = lots.map((l) => ({ l, k: normLot(l) }));
  let cost = 0, accum = 0, monthly = 0, units = 0, held = 0, notInService = 0, writtenOff = 0;
  for (const { k } of ks) {
    monthly += chargeIn(k, M);
    if (written(k, M)) {
      writtenOff++;
      // Amortissement accéléré : l'actif reste au bilan, entièrement amorti.
      if (!derecognize) { cost += k.costC; accum += k.costC; }
      continue;
    }
    held++;
    cost += k.costC;
    accum += regCum(k, M);
    if (k.st <= M) units += k.qty; else notInService++;
  }
  // Projection de la VNC : fin du mois choisi, puis 24 mois (radiations futures respectées).
  const projection = [];
  for (let i = 0; i <= 24; i++) {
    let v = 0;
    for (const { k } of ks) v += nbvAt(k, M + i);
    projection.push({ month: mStr(M + i), nbv: dollars(v) });
  }
  const nbv = cost - accum;
  return {
    month,
    cost: dollars(cost),
    accumulated: dollars(accum),
    nbv: dollars(nbv),
    nbvPct: cost ? nbv / cost : null,
    monthly: dollars(monthly),
    unitsDeployed: units,
    lots: held,
    notInService,
    writtenOff,
    projection,
    journal: amortJournal(ks, M, settings),
    writeOffJournal: writeOffJournal(ks, M, settings),
  };
}

function amortJournal(ks, M, s) {
  let total = 0;
  for (const { k } of ks) total += chargeIn(k, M);
  const debits = total ? [{ code: s.expenseAccount, role: 'amortExpense', cents: total }] : [];
  const credits = total ? [{ code: s.accumAccount, role: 'accumAmort', cents: total }] : [];
  return finishJournal('amortization', 'amortization', M, debits, credits);
}

function writeOffJournal(ks, M, s) {
  let costC = 0, accumC = 0, nbvC = 0;
  const lotsIn = [];
  for (const { l, k } of ks) {
    if (k.wo !== M) continue;
    const acc = regCum(k, M - 1);
    costC += k.costC; accumC += acc; nbvC += k.costC - acc;
    lotsIn.push(l.ref || l.id);
  }
  let debits = [], credits = [];
  if (lotsIn.length) {
    if (s.writeOffMode === 'accelerate') {
      if (nbvC) { debits = [{ code: s.lossAccount, role: 'writeOffLoss', cents: nbvC }]; credits = [{ code: s.accumAccount, role: 'accumAmort', cents: nbvC }]; }
    } else {
      debits = [
        ...(accumC ? [{ code: s.accumAccount, role: 'accumAmort', cents: accumC }] : []),
        ...(nbvC ? [{ code: s.lossAccount, role: 'writeOffLoss', cents: nbvC }] : []),
      ];
      credits = costC ? [{ code: s.assetAccount, role: 'terminalAsset', cents: costC }] : [];
    }
  }
  return finishJournal('amortization', 'writeoff', M, debits, credits, { lots: lotsIn, mode: s.writeOffMode === 'accelerate' ? 'accelerate' : 'derecognize' });
}

// ---------------------------------------------------------------------------- écriture de journal
/**
 * Arrondi au cent, RESTE SUR LA DERNIÈRE LIGNE de crédit : Σ débits = Σ crédits exactement.
 * Avec des cents entiers, le reste est nul en pratique ; la règle protège contre toute entrée
 * fractionnaire (montants en dollars arrondis séparément).
 */
function balanceLines(debits, credits) {
  const d = debits.map((l) => ({ ...l, cents: Math.round(l.cents) }));
  const c = credits.map((l) => ({ ...l, cents: Math.round(l.cents) }));
  const sd = d.reduce((a, l) => a + l.cents, 0);
  const sc = c.reduce((a, l) => a + l.cents, 0);
  if (c.length && sd !== sc) c[c.length - 1].cents += sd - sc;
  return { debits: d, credits: c };
}

function finishJournal(module, kind, M, debits0, credits0, extra = {}) {
  const { debits, credits } = balanceLines(debits0, credits0);
  const lines = [
    ...debits.filter((l) => l.cents).map((l) => ({ side: 'debit', code: l.code || '', role: l.role, amount: dollars(l.cents) })),
    ...credits.filter((l) => l.cents).map((l) => ({ side: 'credit', code: l.code || '', role: l.role, amount: dollars(l.cents) })),
  ];
  const debit = debits.reduce((a, l) => a + l.cents, 0);
  const credit = credits.reduce((a, l) => a + l.cents, 0);
  const period = mStr(M);
  return {
    module, kind, period, date: lastDay(M), lines,
    debit: dollars(debit), credit: dollars(credit),
    balanced: debit === credit,
    missingAccounts: [...new Set(lines.filter((l) => !l.code).map((l) => l.role))],
    hash: journalHash(module, kind, period, lines),
    ...extra,
  };
}

/** Empreinte des lignes : ce que la CFO a vu à l'aperçu = ce qui part dans Books. */
function journalHash(module, kind, period, lines) {
  const s = JSON.stringify([module, kind, period, lines.map((l) => [l.side, l.code, Math.round(l.amount * 100)])]);
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

module.exports = {
  ym, mStr, lastDay, currentMonth, isMonth, isDate, cents, dollars,
  DEFAULT_DEFERRED_SETTINGS, DEFAULT_AMORT_SETTINGS,
  contractAt, deferredSummary, lotAt, amortSummary, balanceLines, journalHash,
};
