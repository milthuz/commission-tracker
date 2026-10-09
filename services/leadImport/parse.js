// ============================================================================
// Lecture d'une liste de pistes de SALON (XLSX) — pur, sans base ni réseau, donc testable seul.
//
// Construit le 2026-10-09 pour le salon GFS (application « Event Explorer » de Gordon Food
// Service), mais ouvert à toute liste : les colonnes connues de GFS sont rapprochées par leur nom
// EXACT, les autres passent par l'heuristique FR/EN des formulaires du site (guessTarget).
//
// 🔑 UNE PERSONNE = UNE PISTE. Le scanner de GFS écrit une ligne « Fast Lead » au scan du badge,
// puis une SECONDE ligne « Lead with Comment » quand le kiosque ajoute une note : 21 lignes pour
// 11 visiteurs dans le premier fichier. On regroupe par identifiant de visiteur (Attendee ID),
// sinon par courriel, sinon par commerce + nom ; les commentaires sont cumulés, jamais perdus.
// ============================================================================

const xlsx = require('xlsx');
const { guessTarget } = require('../webflowLeads');

// Colonnes de l'export GFS « Leads Report » — rapprochement par nom exact (normalisé).
// `null` = colonne connue, volontairement ignorée (le kiosque, le produit, la division GFS…).
const KNOWN = {
  customername: 'businessName',
  attendeename: 'contactName',
  attendeeemail: 'contactEmail',
  attendeephonenumber: 'contactPhone',
  address: 'address',
  city: 'city',
  state: 'province',
  zip: 'postalCode',
  segment: 'businessType',
  comment: 'notes',
  attendeeid: 'key',
  customerid: 'gfsCustomerId',
  salesrepname: 'gfsRepName',
  salesrepemail: 'gfsRepEmail',
  lead: null, boothid: null, boothname: null, vendorid: null, vendorname: null, division: null,
  region: null, district: null, productnumber: null, productdescription: null, pack: null,
  size: null, brand: null, category: null, contentdescription: null, contenttype: null,
  leadquestion: null, leadlocation: null,
};

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// « , Payman Charkhgary », « Yvenna  Xian » : virgule orpheline et espaces doubles du scanner.
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').replace(/^[\s,;]+|[\s,;]+$/g, '').trim();

function targetFor(header) {
  const n = norm(header);
  if (!n) return null;
  if (Object.prototype.hasOwnProperty.call(KNOWN, n)) return KNOWN[n];
  return guessTarget(header) || undefined;   // undefined = inconnue : la valeur part dans le message
}

// La ligne d'en-tête est la première qui a au moins 3 cellules remplies ET au moins une colonne
// reconnue — un titre de rapport en ligne 1 ne doit pas être pris pour l'en-tête.
function findHeader(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(clean);
    if (cells.filter(Boolean).length >= 3 && cells.some((c) => targetFor(c))) return i;
  }
  return -1;
}

function splitName(full) {
  const parts = clean(full).split(' ').filter(Boolean);
  if (!parts.length) return { firstName: null, lastName: null };
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function parseLeadWorkbook(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { error: 'empty_workbook' };
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false });
  const h = findHeader(rows);
  if (h < 0) return { error: 'no_header' };

  const headers = rows[h].map(clean);
  const columns = headers.map((name) => ({ name, target: name ? targetFor(name) : null }));
  const unmapped = columns.filter((c) => c.name && c.target === undefined).map((c) => c.name);

  const groups = new Map();
  let lineCount = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.some((c) => clean(c))) continue;
    lineCount++;
    const rec = { notes: [], extras: [] };
    columns.forEach((col, j) => {
      const v = clean(cells[j]);
      if (!v || !col.name) return;
      if (col.target === 'notes') rec.notes.push(v);
      else if (col.target && col.target !== 'ignore') { if (!rec[col.target]) rec[col.target] = v; }
      else if (col.target === undefined) rec.extras.push(`${col.name} : ${v}`);   // jamais perdu
    });
    const email = String(rec.contactEmail || '').toLowerCase();
    const key = rec.key ? `id:${rec.key}`
      : email ? `email:${email}`
      : `nom:${norm(rec.businessName)}|${norm(rec.contactName || `${rec.contactFirstName || ''}${rec.contactLastName || ''}`)}`;
    if (key === 'nom:|') continue;   // ni identifiant, ni courriel, ni nom : rien à appeler
    const g = groups.get(key) || { key, lines: [], fields: {}, notes: [], extras: [] };
    g.lines.push(i + 1);   // numéro de ligne Excel, pour l'écran
    for (const [k, v] of Object.entries(rec)) {
      if (k === 'notes' || k === 'extras') continue;
      if (!g.fields[k]) g.fields[k] = v;
    }
    for (const n of rec.notes) if (!g.notes.includes(n)) g.notes.push(n);
    for (const x of rec.extras) if (!g.extras.includes(x)) g.extras.push(x);
    groups.set(key, g);
  }

  const leads = [...groups.values()].map((g) => {
    const f = g.fields;
    const named = f.contactName ? splitName(f.contactName) : { firstName: clean(f.contactFirstName) || null, lastName: clean(f.contactLastName) || null };
    const warnings = [];
    if (!f.contactEmail) warnings.push('no_email');
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.contactEmail)) warnings.push('bad_email');
    if (!f.businessName) warnings.push('no_business');
    return {
      key: g.key,
      lines: g.lines,
      businessName: f.businessName || [named.firstName, named.lastName].filter(Boolean).join(' ') || null,
      firstName: named.firstName,
      lastName: named.lastName,
      email: f.contactEmail ? String(f.contactEmail).toLowerCase() : null,
      phone: f.contactPhone || null,
      city: f.city ? f.city.replace(/\b([a-z])([a-z]*)/gi, (m, a, b) => a.toUpperCase() + b.toLowerCase()) : null,
      province: f.province ? String(f.province).toUpperCase().slice(0, 10) : null,
      postalCode: f.postalCode || null,
      businessType: f.businessType || null,
      website: f.website || null,
      address: f.address || null,
      comments: g.notes,
      gfs: (f.gfsRepName || f.gfsCustomerId)
        ? { repName: f.gfsRepName || null, repEmail: f.gfsRepEmail || null, customerId: f.gfsCustomerId || null }
        : null,
      extras: g.extras,
      warnings,
    };
  });

  return { sheetName, headerRow: h + 1, lineCount, columns, unmapped, leads };
}

// Le message de la piste : ce que le kiosque a noté, puis le contexte utile au représentant.
function leadNotes(l, eventName) {
  return [
    l.comments?.length ? `Notes du kiosque${eventName ? ` (${eventName})` : ''} :\n- ${l.comments.join('\n- ')}` : (eventName ? `Visite au kiosque — ${eventName}` : null),
    l.address ? `Adresse : ${[l.address, l.city, l.province, l.postalCode].filter(Boolean).join(', ')}` : null,
    l.gfs?.repName ? `Représentant GFS : ${l.gfs.repName}${l.gfs.repEmail ? ` <${l.gfs.repEmail}>` : ''}` : null,
    l.gfs?.customerId ? `No client GFS : ${l.gfs.customerId}` : null,
    ...(l.extras || []),
  ].filter(Boolean).join('\n').slice(0, 4000);
}

module.exports = { parseLeadWorkbook, leadNotes, splitName, clean };
