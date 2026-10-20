// ============================================================================
// Module Finance — gestionnaires : validation des saisies et import / export Excel.
//
// Une seule validation pour la saisie à l'écran ET l'import : une ligne d'Excel passe par les
// mêmes règles qu'un contrat tapé dans la fenêtre. L'import se fait en deux temps : aperçu
// (le serveur lit, valide, renvoie chaque ligne avec ses erreurs), puis confirmation (le client
// renvoie les lignes, le serveur les REVALIDE et enregistre tout ou rien).
// ============================================================================

const { isMonth, isDate, ym } = require('./managersEngine');

let xlsx = null;
try { xlsx = require('xlsx'); } catch { /* bancs d'essai sans xlsx */ }

const MAX_AMOUNT = 1e10;
const MAX_ROWS = 2000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const has = (b, k) => Object.prototype.hasOwnProperty.call(b, k);

// ---------------------------------------------------------------------------- validation
/** Contrat : création (tous les champs) ou modification (partielle). */
function validateContract(body, settings, partial = false) {
  const b = body || {};
  const out = {};
  const want = (k) => !partial || has(b, k);
  const types = new Set((settings.types || []).map((t) => t.key));
  if (want('customer')) {
    if (typeof b.customer !== 'string' || !b.customer.trim() || b.customer.length > 200) return { error: 'bad_customer' };
    out.customer = b.customer.trim();
  }
  if (want('type')) { if (!types.has(b.type)) return { error: 'bad_type' }; out.type = b.type; }
  if (want('total')) {
    if (!finite(b.total) || b.total <= 0 || b.total >= MAX_AMOUNT) return { error: 'bad_total' };
    out.total = Math.round(b.total * 100) / 100;
  }
  if (want('startMonth')) { if (!isMonth(b.startMonth)) return { error: 'bad_start' }; out.start_month = b.startMonth; }
  if (want('termMonths')) {
    if (!Number.isInteger(b.termMonths) || b.termMonths < 1 || b.termMonths > 600) return { error: 'bad_term' };
    out.term_months = b.termMonths;
  }
  for (const [k, col] of [['billedDate', 'billed_date'], ['receivedDate', 'received_date']]) {
    if (!want(k)) continue;
    if (b[k] == null || b[k] === '') { out[col] = null; continue; }
    if (!isDate(b[k])) return { error: k === 'billedDate' ? 'bad_billed_date' : 'bad_received_date' };
    out[col] = b[k];
  }
  if (want('notes')) {
    if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 1000)) return { error: 'bad_notes' };
    out.notes = b.notes ? b.notes.trim() : null;
  }
  return { fields: out };
}

/** Lot de terminaux : création ou modification (partielle). */
function validateLot(body, settings, partial = false) {
  const b = body || {};
  const out = {};
  const want = (k) => !partial || has(b, k);
  if (want('description')) {
    if (typeof b.description !== 'string' || !b.description.trim() || b.description.length > 200) return { error: 'bad_description' };
    out.description = b.description.trim();
  }
  if (want('quantity')) {
    if (!Number.isInteger(b.quantity) || b.quantity < 1 || b.quantity > 1e6) return { error: 'bad_quantity' };
    out.quantity = b.quantity;
  }
  if (want('unitCost')) {
    if (!finite(b.unitCost) || b.unitCost <= 0 || b.unitCost >= 1e7) return { error: 'bad_unit_cost' };
    out.unit_cost = Math.round(b.unitCost * 100) / 100;
  }
  if (want('inServiceMonth')) { if (!isMonth(b.inServiceMonth)) return { error: 'bad_in_service' }; out.in_service_month = b.inServiceMonth; }
  if (want('usefulLife')) {
    const life = b.usefulLife == null || b.usefulLife === '' ? (settings.defaultLife || 36) : b.usefulLife;
    if (!Number.isInteger(life) || life < 1 || life > 600) return { error: 'bad_life' };
    out.useful_life = life;
  }
  if (want('salvage')) {
    const s = b.salvage == null || b.salvage === '' ? 0 : b.salvage;
    if (!finite(s) || s < 0 || s >= MAX_AMOUNT) return { error: 'bad_salvage' };
    out.salvage = Math.round(s * 100) / 100;
  }
  if (want('notes')) {
    if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 1000)) return { error: 'bad_notes' };
    out.notes = b.notes ? b.notes.trim() : null;
  }
  // Valeur résiduelle ≤ coût (vérifiée ici quand les deux sont connus ; sinon par la route).
  if (out.salvage != null && out.quantity != null && out.unit_cost != null && out.salvage > out.quantity * out.unit_cost) return { error: 'salvage_above_cost' };
  return { fields: out };
}

/** Réglages des revenus reportés : codes de comptes et types de contrat. */
function validateDeferredSettings(d, usedTypes) {
  if (!d || typeof d !== 'object') return { error: 'bad_settings' };
  const code = (v) => typeof v === 'string' && /^[A-Za-z0-9 .\-]{1,20}$/.test(v.trim());
  if (!code(d.deferredAccount)) return { error: 'bad_account' };
  if (!Array.isArray(d.types) || !d.types.length || d.types.length > 30) return { error: 'bad_types' };
  const seen = new Set();
  const types = [];
  for (const t of d.types) {
    if (!t || typeof t.key !== 'string' || !/^[a-z0-9_]{1,30}$/.test(t.key) || seen.has(t.key)) return { error: 'bad_type_key' };
    if (typeof t.labelEn !== 'string' || !t.labelEn.trim() || t.labelEn.length > 80) return { error: 'bad_type_label' };
    if (typeof t.labelFr !== 'string' || !t.labelFr.trim() || t.labelFr.length > 80) return { error: 'bad_type_label' };
    if (!code(t.account)) return { error: 'bad_account' };
    seen.add(t.key);
    types.push({ key: t.key, labelEn: t.labelEn.trim(), labelFr: t.labelFr.trim(), account: t.account.trim() });
  }
  // Un type encore utilisé par un contrat ne disparaît pas (ses revenus n'auraient plus de compte).
  for (const k of usedTypes || []) if (!seen.has(k)) return { error: 'type_in_use', type: k };
  return { data: { deferredAccount: d.deferredAccount.trim(), types } };
}

function validateAmortSettings(d) {
  if (!d || typeof d !== 'object') return { error: 'bad_settings' };
  const code = (v, opt) => typeof v === 'string' && (opt && v.trim() === '' ? true : /^[A-Za-z0-9 .\-]{1,20}$/.test(v.trim()));
  if (!code(d.expenseAccount) || !code(d.accumAccount)) return { error: 'bad_account' };
  if (!code(d.assetAccount || '', true) || !code(d.lossAccount || '', true)) return { error: 'bad_account' };
  if (!['derecognize', 'accelerate'].includes(d.writeOffMode)) return { error: 'bad_mode' };
  if (!Number.isInteger(d.defaultLife) || d.defaultLife < 1 || d.defaultLife > 600) return { error: 'bad_life' };
  return {
    data: {
      expenseAccount: d.expenseAccount.trim(), accumAccount: d.accumAccount.trim(),
      assetAccount: (d.assetAccount || '').trim(), lossAccount: (d.lossAccount || '').trim(),
      writeOffMode: d.writeOffMode, defaultLife: d.defaultLife,
    },
  };
}

// ---------------------------------------------------------------------------- lecture des cellules
const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Cellule → 'AAAA-MM' (date Excel, texte « 2026-09 », « 2026/9 », « 09/2026 ») ; null si vide ; false si illisible. */
function cellMonth(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // Midi : une date Excel lue à minuit local ne glisse pas au mois précédent.
    const d = new Date(v.getTime() + 12 * 3600 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/.exec(s);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${m[2]}-${m[1].padStart(2, '0')}`;
  return false;
}
function cellDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const d = new Date(v.getTime() + 12 * 3600 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) { const out = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`; return isDate(out) ? out : false; }
  return false;
}
/** Nombre : 12000, « 12 000,50 », « $12,000.50 ». null si vide ; NaN si illisible. */
function cellNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[\s$  ]/g, '');
  if (/,\d{1,2}$/.test(s) && s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
  s = s.replace(/,/g, '');
  return /^-?\d*\.?\d+$/.test(s) ? Number(s) : NaN;
}
const cellText = (v) => (v == null ? '' : v instanceof Date ? cellDate(v) || '' : String(v).trim());

// ---------------------------------------------------------------------------- gabarits
// En-têtes bilingues : le même modèle sert la CFO dans les deux langues, et l'import reconnaît
// chaque moitié (et quelques synonymes) sans tenir compte des accents ni de la casse.
const DEFERRED_COLS = [
  { key: 'customer', head: 'Customer / Client', alias: ['customer', 'client', 'customer name', 'nom du client'] },
  { key: 'type', head: 'Type', alias: ['type', 'contract type', 'type de contrat'] },
  { key: 'startMonth', head: 'Start month (YYYY-MM) / Mois de début (AAAA-MM)', alias: ['start', 'start month', 'debut', 'mois de debut', 'start month yyyy mm', 'mois de debut aaaa mm'] },
  { key: 'termMonths', head: 'Term (months) / Durée (mois)', alias: ['term', 'term months', 'duree', 'duree mois', 'months', 'mois'] },
  { key: 'total', head: 'Total amount / Montant total', alias: ['total', 'total amount', 'amount', 'montant', 'montant total', 'invoiced', 'facture'] },
  { key: 'billedDate', head: 'Billed date / Date de facturation', alias: ['billed', 'billed date', 'date de facturation', 'invoice date', 'date facture'] },
  { key: 'receivedDate', head: 'Received date / Date d\'encaissement', alias: ['received', 'received date', 'date d encaissement', 'date de reception', 'paid date'] },
  { key: 'ref', head: 'Reference (optional) / Référence (facultatif)', alias: ['reference', 'ref', 'contract', 'contrat', 'reference optional', 'reference facultatif'] },
  { key: 'notes', head: 'Notes', alias: ['notes', 'note', 'commentaire'] },
];
const LOT_COLS = [
  { key: 'description', head: 'Description (model) / Description (modèle)', alias: ['description', 'model', 'modele', 'description model', 'description modele'] },
  { key: 'quantity', head: 'Quantity / Quantité', alias: ['quantity', 'qty', 'quantite'] },
  { key: 'unitCost', head: 'Unit cost / Coût unitaire', alias: ['unit cost', 'cout unitaire', 'unit', 'cost per unit'] },
  { key: 'inServiceMonth', head: 'In-service month (YYYY-MM) / Mise en service (AAAA-MM)', alias: ['in service', 'in service month', 'mise en service', 'in service month yyyy mm', 'mise en service aaaa mm'] },
  { key: 'usefulLife', head: 'Useful life (months) / Durée de vie (mois)', alias: ['useful life', 'useful life months', 'life', 'duree de vie', 'duree de vie mois'] },
  { key: 'salvage', head: 'Salvage value / Valeur résiduelle', alias: ['salvage', 'salvage value', 'valeur residuelle'] },
  { key: 'ref', head: 'Reference (optional) / Référence (facultatif)', alias: ['reference', 'ref', 'lot', 'reference optional', 'reference facultatif'] },
  { key: 'notes', head: 'Notes', alias: ['notes', 'note', 'commentaire'] },
];

function matchCol(cols, raw) {
  const h = fold(raw);
  if (!h) return null;
  for (const c of cols) {
    if (fold(c.head) === h) return c.key;
    const parts = String(raw).split('/').map(fold);
    if (c.alias.includes(h) || parts.some((p) => c.alias.includes(p))) return c.key;
  }
  return null;
}

function buildWorkbook(sheets) {
  if (!xlsx) throw new Error('xlsx_unavailable');
  const wb = xlsx.utils.book_new();
  for (const { name, rows, widths } of sheets) {
    const ws = xlsx.utils.aoa_to_sheet(rows);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    xlsx.utils.book_append_sheet(wb, ws, name);
  }
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

function deferredTemplate(settings) {
  return buildWorkbook([
    { name: 'Contracts', rows: [DEFERRED_COLS.map((c) => c.head)], widths: DEFERRED_COLS.map((c) => Math.max(14, c.head.length)) },
    {
      name: 'Types',
      rows: [['Type (key / clé)', 'English', 'Français', 'Revenue account / Compte de revenus'],
        ...(settings.types || []).map((t) => [t.key, t.labelEn, t.labelFr, t.account])],
      widths: [18, 32, 32, 22],
    },
  ]);
}
function lotTemplate() {
  return buildWorkbook([{ name: 'Lots', rows: [LOT_COLS.map((c) => c.head)], widths: LOT_COLS.map((c) => Math.max(14, c.head.length)) }]);
}

/**
 * Lit la première feuille qui porte des en-têtes reconnus. Retourne { rows: [{ line, values }] }
 * ou { error }. `values` = objet clé → cellule brute.
 */
function readSheet(workbook, cols, required) {
  if (!workbook) return { error: 'unreadable_file' };
  for (const name of workbook.sheetNames) {
    const aoa = workbook.rows(name);
    for (let h = 0; h < Math.min(aoa.length, 10); h++) {
      const map = (aoa[h] || []).map((v) => matchCol(cols, v));
      if (!required.every((k) => map.includes(k))) continue;
      const rows = [];
      for (let i = h + 1; i < aoa.length; i++) {
        const r = aoa[i] || [];
        if (r.every((v) => v == null || String(v).trim() === '')) continue;
        const values = {};
        map.forEach((k, j) => { if (k && values[k] == null) values[k] = r[j] == null ? null : r[j]; });
        rows.push({ line: i + 1, values });
        if (rows.length > MAX_ROWS) return { error: 'too_many_rows' };
      }
      return { sheet: name, rows };
    }
  }
  return { error: 'headers_not_found' };
}

/** Ligne d'import (cellules) → corps de contrat, puis la validation commune. */
function contractFromCells(v, settings) {
  const errors = [];
  const typeRaw = fold(v.type);
  const t = (settings.types || []).find((x) => fold(x.key) === typeRaw || fold(x.labelEn) === typeRaw || fold(x.labelFr) === typeRaw);
  const start = cellMonth(v.startMonth);
  const term = cellNumber(v.termMonths);
  const total = cellNumber(v.total);
  const billed = cellDate(v.billedDate);
  const received = cellDate(v.receivedDate);
  if (!t) errors.push('bad_type');
  if (start === false || start == null) errors.push('bad_start');
  if (billed === false) errors.push('bad_billed_date');
  if (received === false) errors.push('bad_received_date');
  const body = {
    customer: cellText(v.customer), type: t ? t.key : String(v.type || ''), startMonth: start || '',
    termMonths: term, total, billedDate: billed || null, receivedDate: received || null,
    notes: cellText(v.notes) || null, ref: cellText(v.ref) || null,
  };
  const val = validateContract(body, settings, false);
  if (val.error && !errors.includes(val.error)) errors.push(val.error);
  if (body.ref && !/^[A-Za-z0-9\-_.]{1,40}$/.test(body.ref)) errors.push('bad_ref');
  return { body, errors };
}

function lotFromCells(v, settings) {
  const errors = [];
  const ins = cellMonth(v.inServiceMonth);
  if (ins === false || ins == null) errors.push('bad_in_service');
  const life = cellNumber(v.usefulLife);
  const salvage = cellNumber(v.salvage);
  const body = {
    description: cellText(v.description), quantity: cellNumber(v.quantity), unitCost: cellNumber(v.unitCost),
    inServiceMonth: ins || '', usefulLife: life == null ? (settings.defaultLife || 36) : life,
    salvage: salvage == null ? 0 : salvage, notes: cellText(v.notes) || null, ref: cellText(v.ref) || null,
  };
  const val = validateLot(body, settings, false);
  if (val.error && !errors.includes(val.error)) errors.push(val.error);
  if (body.ref && !/^[A-Za-z0-9\-_.]{1,40}$/.test(body.ref)) errors.push('bad_ref');
  return { body, errors };
}

/** Classeur d'export des lots (une ligne par lot, valeurs au mois choisi). */
function lotsExport(rows, month) {
  return buildWorkbook([{
    name: `Lots ${month}`,
    rows: [
      ['Reference / Référence', ...LOT_COLS.filter((c) => c.key !== 'ref').map((c) => c.head), 'Written off / Radié', 'Cost / Coût', `Accumulated ${month} / Cumulé`, `NBV ${month} / VNC`, `Charge ${month} / Charge`, 'End / Fin', 'Status / Statut'],
      ...rows.map((r) => [r.ref, r.description, r.quantity, r.unitCost, r.inServiceMonth, r.usefulLife, r.salvage, r.notes || '', r.writtenOffMonth || '', r.calc.cost, r.calc.accumulated, r.calc.nbv, r.calc.thisMonth, r.calc.endMonth, r.calc.status]),
    ],
    widths: [16, 28, 10, 12, 14, 12, 12, 24, 12, 14, 16, 14, 14, 10, 14],
  }]);
}
function contractsExport(rows, month) {
  return buildWorkbook([{
    name: `Contracts ${month}`,
    rows: [
      ['Reference / Référence', ...DEFERRED_COLS.filter((c) => c.key !== 'ref').map((c) => c.head), 'Closed / Fermé', `Recognized to date ${month} / Constaté`, `Remaining ${month} / Restant`, `This month / Ce mois`, 'End / Fin', 'Status / Statut'],
      ...rows.map((r) => [r.ref, r.customer, r.type, r.startMonth, r.termMonths, r.total, r.billedDate || '', r.receivedDate || '', r.notes || '', r.closedMonth ? `${r.closedMonth} (${r.closeTreatment})` : '', r.calc.recognizedToDate, r.calc.remaining, r.calc.thisMonth, r.calc.endMonth, r.calc.status]),
    ],
    widths: [16, 28, 14, 14, 10, 14, 14, 14, 24, 16, 16, 14, 14, 10, 14],
  }]);
}

module.exports = {
  validateContract, validateLot, validateDeferredSettings, validateAmortSettings,
  cellMonth, cellDate, cellNumber, readSheet, contractFromCells, lotFromCells,
  deferredTemplate, lotTemplate, lotsExport, contractsExport, DEFERRED_COLS, LOT_COLS, ym,
};
