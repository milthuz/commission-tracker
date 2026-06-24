// ============================================================================
// Savings calculator engine — replicates "Rate Calculator v1.xlsx"
// (payment processing, Interchange+ model, Québec GST+QST tax).
// PURE: no I/O, no DB. Single source of truth for the rate-calculator tool.
//
// Conventions: rates are DECIMALS (0.0015 = 0.15%); perTrx fees and $ amounts
// are dollars. "Current" = the competitor statement (all input). "Cluster" =
// our proposed rates + internal costs (from the rep's pricing template).
// ============================================================================

const TAX_RATE = 0.14975; // QC GST (5%) + QST (9.975%)

// Per-category fee = (#trx × per-trx $) + (volume $ × rate %)
function catFee(vol, r) {
  return ((vol.trx || 0) * (r.perTrx || 0)) + ((vol.amount || 0) * (r.rate || 0));
}
const fx = (x) => (x && x.qty ? x.qty : 0) * (x && x.unit ? x.unit : 0);

// input = {
//   volumes: { debit:{trx,amount}, credit:{trx,amount}, amex:{trx,amount} },
//   current: {
//     rates: { debit:{rate,perTrx}, credit:{rate,perTrx}, amex:{rate,perTrx} },
//     interchange: <$ pass-through interchange + card brand>,
//     fixed: [ {label, qty, unit}, ... ]            // any number of fixed-fee lines
//   },
//   cluster: {
//     rates: { debit:{rate,perTrx}, credit:{rate,perTrx}, amex:{rate,perTrx} },
//     interchange: <$ — defaults to current.interchange (pass-through is the same)>,
//     fixed: { terminalS1F2:{qty,unit}, terminalWired:{qty,unit}, pci:{qty,unit},
//              acctOnFile:{qty,unit}, batch:{qty,unit}, lte:{qty,unit} },
//     costs: { perTrx, discountRate, t1Rate, monthlyFixed, terminalS1F2, terminalWired }
//   }
// }
function computeSavings(input) {
  const v = input.volumes;
  const totalTrx = (v.debit.trx || 0) + (v.credit.trx || 0) + (v.amex.trx || 0);
  const totalAmt = (v.debit.amount || 0) + (v.credit.amount || 0) + (v.amex.amount || 0);

  // ---- CURRENT processor ----
  const cur = input.current;
  const curMarkup = catFee(v.debit, cur.rates.debit) + catFee(v.credit, cur.rates.credit) + catFee(v.amex, cur.rates.amex);
  const curTxnFees = curMarkup + (cur.interchange || 0);
  const curFixedTotal = (cur.fixed || []).reduce((s, f) => s + (f.qty || 0) * (f.unit || 0), 0);
  const curBeforeTax = curTxnFees + curFixedTotal;
  const curTax = curFixedTotal * TAX_RATE; // Excel B25: ALL current fixed fees taxed
  const curTotal = curBeforeTax + curTax;

  // ---- CLUSTER (proposed) ----
  const cl = input.cluster;
  const clInterchange = (cl.interchange != null ? cl.interchange : (cur.interchange || 0));
  const clMarkup = catFee(v.debit, cl.rates.debit) + catFee(v.credit, cl.rates.credit) + catFee(v.amex, cl.rates.amex);
  const clTxnFees = clMarkup + clInterchange;
  const f = cl.fixed || {};
  const termS1F2 = fx(f.terminalS1F2), termWired = fx(f.terminalWired), pci = fx(f.pci),
        acct = fx(f.acctOnFile), batch = fx(f.batch), lte = fx(f.lte);
  const clFixedTotal = termS1F2 + termWired + pci + acct + batch + lte;
  const clBeforeTax = clTxnFees + clFixedTotal;
  const clTax = (termS1F2 + pci + acct) * TAX_RATE; // Excel G25: only terminal rental(S1F2)+PCI+acct taxed
  const clTotal = clBeforeTax + clTax;

  // ---- SAVINGS ----
  const monthly = curTotal - clTotal;

  // ---- CLUSTER MARGIN (what we charge the merchant − our internal cost) ----
  const c = cl.costs || {};
  const perTrxRev = (v.debit.trx || 0) * (cl.rates.debit.perTrx || 0)
                  + (v.credit.trx || 0) * (cl.rates.credit.perTrx || 0)
                  + (v.amex.trx || 0) * (cl.rates.amex.perTrx || 0);
  const mTxn = perTrxRev - totalTrx * (c.perTrx || 0);
  const discRev = (v.credit.amount || 0) * (cl.rates.credit.rate || 0) + (v.amex.amount || 0) * (cl.rates.amex.rate || 0);
  const mDisc = discRev - ((v.credit.amount || 0) + (v.amex.amount || 0)) * (c.discountRate || 0);
  const mT1 = 0 - totalAmt * (c.t1Rate || 0);
  const mFixed = (pci + acct + batch + lte) - (c.monthlyFixed || 0);
  const mTermS1F2 = termS1F2 - ((f.terminalS1F2 && f.terminalS1F2.qty) || 0) * (c.terminalS1F2 || 0);
  const mTermWired = termWired - ((f.terminalWired && f.terminalWired.qty) || 0) * (c.terminalWired || 0);
  const marginTotal = mTxn + mDisc + mT1 + mFixed + mTermS1F2 + mTermWired;

  return {
    totals: { trx: totalTrx, amount: totalAmt },
    current: { markup: curMarkup, interchange: cur.interchange || 0, txnFees: curTxnFees, fixed: curFixedTotal, beforeTax: curBeforeTax, tax: curTax, total: curTotal },
    cluster: { markup: clMarkup, interchange: clInterchange, txnFees: clTxnFees, fixed: clFixedTotal, beforeTax: clBeforeTax, tax: clTax, total: clTotal },
    savings: { monthly, yearly: monthly * 12 },
    margin: { txn: mTxn, discount: mDisc, t1: mT1, fixed: mFixed, terminalS1F2: mTermS1F2, terminalWired: mTermWired, total: marginTotal, pctOfVolume: totalAmt ? marginTotal / totalAmt : 0 },
  };
}

module.exports = { computeSavings, TAX_RATE };
