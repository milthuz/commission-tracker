const K = require('../calc');
const { STATUS } = require('../classify');

let fail = 0;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  -> ' + JSON.stringify(x) : '')); if (!c) fail++; };
const near = (a, b, e = 0.005) => Math.abs(a - b) <= e;

// A statement: 100 debit txns / $5,000; 200 Visa / $20,000; 100 MC / $10,000; 10 Amex / $2,000.
// Current markup 0.20% + $0.05 on every brand. Interchange $900. One $25 DATASECFEE (SUSPECT).
const parsed = {
  current_processor: {
    name: 'Global Payments',
    debit_rate: 0.002, debit_fee: 0.05,
    visa_rate: 0.002,  visa_fee: 0.05,
    mc_rate: 0.002,    mc_fee: 0.05,
    amex_rate: 0.002,  amex_fee: 0.05,
    interchange: 900,
    terminal_wired_qty: 2, terminal_wired_unit: 30,
    pci: 9, account: 7.5, batch: 7, statement: 0,
  },
  volume: {
    debit_count: 100, debit_amt: 5000,
    visa_count: 200,  visa_amt: 20000,
    mc_count: 100,    mc_amt: 10000,
    amex_count: 10,   amex_amt: 2000,
  },
  merchant_name: 'LA CHOPE ANGUS',
  line_audit: {
    interchange: [{ desc: 'VIBS CDN HI-NET STD', rate: 0.0155, volume: 20000, total: 310, status: STATUS.A_VERIFIER, theoretical: null }],
    brand: [{ desc: 'DATASECFEE', volume: 0, total: 25, status: STATUS.SUSPECT }],
    interac: [],
  },
  _note: 'Global Payments FR',
};

const st = K.populate(parsed, {
  clusterRates: { debit: { pct: 0, perItem: 0.04 }, visa: { pct: 0.001, perItem: 0.04 }, mc: { pct: 0.001, perItem: 0.04 }, amex: { pct: 0.001, perItem: 0.04 } },
  clusterFixed: { terminalWired: { qty: 0, unit: 29.99 }, pci: { qty: 1, unit: 9 }, account: { qty: 1, unit: 7.5 }, batch: { qty: 1, unit: 7 } },
});
const out = K.recalc(st);

// --- populate hygiene
ok('merchant name carried', st.merchantName === 'LA CHOPE ANGUS');
ok('terminal qty mirrored to cluster', st.cluster.fixed.terminalWired.qty === 2, st.cluster.fixed.terminalWired);
ok('hidden bump built from SUSPECT row', st.current.hiddenBumps.length === 1 && st.current.hiddenBumps[0].total === 25, st.current.hiddenBumps);

// --- markup: 37000*0.002 + 410*0.05 = 74 + 20.50 = 94.50
ok('current markup', near(out.current.markup, 94.5), out.current.markup);

// --- fixed: 2*30 + 9 + 7.5 + 7 = 83.50
ok('current fixed', near(out.current.fixed, 83.5), out.current.fixed);

// --- THE ASYMMETRY, both halves
// current pretax EXCLUDES the $25 bump: 94.50 + 900 + 83.50 = 1078.00
ok('hidden bump EXCLUDED from current pretax', near(out.current.pretax, 1078), out.current.pretax);
ok('hidden bump still displayed', near(out.current.hiddenBumps, 25), out.current.hiddenBumps);
// cluster interchange SUBTRACTS it: 900 - 25 = 875
ok('suspect SUBTRACTED from cluster interchange', near(out.cluster.interchange, 875), out.cluster.interchange);
ok('cluster is in passthrough mode', out.cluster.interchangeMode === 'passthrough', out.cluster.interchangeMode);

// --- cluster markup: 32000*0.001 + 410*0.04 = 32 + 16.40 = 48.40
ok('cluster markup', near(out.cluster.markup, 48.4), out.cluster.markup);
// cluster fixed: 2*29.99 + 9 + 7.5 + 7 = 83.48
ok('cluster fixed uses mirrored qty', near(out.cluster.fixed, 83.48), out.cluster.fixed);

// --- savings sign: negative = cluster cheaper
ok('cluster cheaper -> negative monthly', out.savings.monthly < 0 && out.savings.clusterIsCheaper, out.savings);
ok('annual = x12', near(out.savings.annual, out.savings.monthly * 12), [out.savings.monthly, out.savings.annual]);

// --- tax
ok('tax = pretax x (mult-1)', near(out.current.tax, out.current.pretax * 0.14975), [out.current.tax, out.current.pretax]);
ok('grand = pretax + tax', near(out.current.grand, out.current.pretax + out.current.tax));

// --- priority 1: estimate mode
const est = K.populate({
  current_processor: { interchange: 100 },
  volume: { visa_amt: 10000, visa_count: 100 },
  line_audit: { interchange: [{ desc: 'estimate', status: STATUS.ESTIME, total: 0, theoretical: 165 }], brand: [{ desc: 'PCI NONCOM', status: STATUS.SUSPECT, total: 15 }], interac: [] },
}, {});
ok('priority 1 = estimate mode', est.cluster.interchangeOverride && est.cluster.interchangeNote === 'estimate', est.cluster);
// 100 + 165 - 15 = 250
ok('estimate adds theoretical, subtracts suspect', near(est.cluster.interchange, 250), est.cluster.interchange);

// --- priority 3: flat fallback
const flat = K.populate({
  current_processor: { interchange: 0 },
  volume: { visa_amt: 10000, mc_amt: 5000, amex_amt: 1000 },
  line_audit: { interchange: [], brand: [], interac: [] },
}, {});
ok('priority 3 = flat fallback', flat.cluster.interchangeNote === 'flat', flat.cluster);
ok('flat = 1.65% of card volume', near(flat.cluster.interchange, 16000 * 0.0165), flat.cluster.interchange);

// --- stale clearing: a second import with no amex must zero amex, not keep the old value
const reimport = K.populate({ current_processor: {}, volume: { visa_count: 1, visa_amt: 100 }, line_audit: {} }, {});
ok('missing brand actively cleared to 0', reimport.volume.amex_amt === 0 && reimport.volume.amex_count === 0, reimport.volume);
ok('merchant name blanked when absent', reimport.merchantName === '', reimport.merchantName);

// --- margin: revenue % divides by TOTAL volume, not the row's own basis (Excel parity)
const m = K.recalc(Object.assign({}, st, { clusterCost: { perTxn: 0.035, discountPct: 0.0005, t1Pct: 0.0001, fixed: 5.5, terminalWireless: 34.72, terminalWired: 27.5 } })).margin;
const txnRow = m.rows.find((r) => r.key === 'transactionFee');
ok('margin row revenue = billed - cost', near(txnRow.revenue, txnRow.billed - txnRow.cost), txnRow);
ok('margin revenue% over TOTAL volume', near(txnRow.revenuePct, (txnRow.revenue / 37000) * 100), [txnRow.revenuePct, (txnRow.revenue / 37000) * 100]);

// --- audit totals only sum verified rows
const tot = K.auditTotals([
  { total: 10, theoretical: 9, delta: 1, status: STATUS.CONFORME },
  { total: 25, theoretical: null, delta: null, status: STATUS.SUSPECT },
]);
ok('theoretical sums verified only', near(tot.theoretical, 9), tot);
ok('suspect annualized', near(tot.suspectAnnual, 300), tot);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
