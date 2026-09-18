const C = require('../classify');
const T = require('../rateTables');

let fail = 0;
const ok = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined && !cond ? '  -> ' + JSON.stringify(extra) : '')); if (!cond) fail++; };

// --- Interac tier recognition: Arabic AND Roman, both languages (Payfacto / EN Moneris)
for (const s of ['Palier II', 'PALIER 2', 'Niveau 3', 'TIER I', 'Tier 4', 'CAN-ZTI3 FLASH STAND NIVEAU 3', 'T2']) {
  ok('tier recognized: ' + s, C.interacTier(s) !== null, C.interacTier(s));
}
ok('non-tier not matched', C.interacTier('INTERAC SWITCH FEE') === null, C.interacTier('INTERAC SWITCH FEE'));

// --- the \b-after-) trap from the scope: make sure our Roman branch actually fires
ok('roman branch fires (TIER III)', /tier\s*(i{1,3}|iv)\b/i.test('TIER III'));

// --- SUSPECT labels: bare PCI matches as a word, not as a substring
ok('PCI suspect (global)', C.suspectLabel('PCI ADMIN FEE', 'global') !== null);
ok('DATASECFEE suspect', C.suspectLabel('DATASECFEE', 'global') === 'DATASECFEE');
ok('PCIX not suspect', C.suspectLabel('PCIX SOMETHING', 'global') === null, C.suspectLabel('PCIX SOMETHING', 'global'));
ok('push payment suspect (nuvei)', C.suspectLabel('MASTERCARD SEND DOMESTIC', 'nuvei') !== null);
ok('push payment NOT suspect for global', C.suspectLabel('MASTERCARD SEND DOMESTIC', 'global') === null);

// --- matchByRate: exact assessment matches; inflated 0.1017% does NOT
const nf = T.networkFees;
const m09 = C.matchByRate(0.0009, nf, undefined, 'VISA ASSESSMENT');
ok('0.0900% matches assessment', !!m09, m09);
const m1017 = C.matchByRate(0.001017, nf, undefined, 'VISA ASSESSMENT');
ok('0.1017% does NOT match (inflated)', m1017 === null, m1017);

// --- weak entries need keyword corroboration
const weakNoDesc = C.matchByRate(0.00678, nf, undefined, 'RANDOM FEE');
ok('weak entry rejected without keyword overlap', weakNoDesc === null, weakNoDesc);
const weakWithDesc = C.matchByRate(0.00678, nf, undefined, 'FRAIS EVALUATION TRANSFRONTALIER CROSS-BORDER');
ok('weak entry accepted with keyword overlap', !!weakWithDesc, weakWithDesc);

// --- empty tables fail toward "A verifier", never Conforme/SUSPECT
const r = C.classifyInterchangeLine({ desc: 'VIBS CDN HI-NET STD', rate: 0.0155, volume: 1000, total: 15.5 });
ok('empty interchange table -> A verifier', r.status === C.STATUS.A_VERIFIER, r.status);

// --- Moneris VS-ASSESSMENT override, and its containment
const mon = C.classifyMonerisBrandLine({ desc: 'VS - ASSESSMENT', rate: 0.001017, volume: 10000, total: 10.17 });
ok('Moneris VS-ASSESSMENT gets a category', !!mon.cat, mon);
const monFr = C.classifyMonerisBrandLine({ desc: 'VS - ÉVALUATION', rate: 0.001017, volume: 10000, total: 10.17 });
ok('Moneris VS-EVALUATION (fr) gets a category', !!monFr.cat, monFr);
const globalSame = C.classifyBrandLine({ desc: 'VS - ASSESSMENT', rate: 0.001017, volume: 10000, total: 10.17 }, { processor: 'global' });
ok('override does NOT leak to other processors', !globalSame.cat, globalSame);

// --- Global alias identity beats a coincidental rate match (the Interac mislabel bug)
const g = C.classifyGlobalInterchangeLine({ desc: 'VIBS CDN HI-NET STD', rate: 0.0009, volume: 1000, total: 0.9 });
// The alias drives matching; `desc` must keep the statement's own wording, or the row
// cannot be found on the paper the rep is reconciling against.
ok('global alias keeps the statement label', g.desc === 'VIBS CDN HI-NET STD', g.desc);
ok('global alias recorded separately', g.aliasOf === 'Visa — Business Standard, réseau haut', g.aliasOf);

// --- hidden bumps duplicate, never replace
const rows = [
  { desc: 'DATASECFEE', status: C.STATUS.SUSPECT, total: 25 },
  { desc: 'VISA ASSESSMENT', status: C.STATUS.CONFORME, total: 10 },
];
const split = C.splitHiddenBumps(rows);
ok('suspect stays in section rows', split.rows.length === 2);
ok('suspect duplicated into hidden', split.hidden.length === 1 && /déjà inclus/.test(split.hidden[0].label), split.hidden);

console.log(fail ? `\n${fail} FAILING` : '\nall green');
process.exit(fail ? 1 : 0);
