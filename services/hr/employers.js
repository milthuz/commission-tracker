// ============================================================================
// RH — employeurs. Le même contrat sert à plusieurs entités (Cluster, OSP…) : seuls le nom
// légal, le nom court, le site web et le logo changent (demande de Gabriela via David,
// 2026-09-23 : « same contracts but with OSP logo » → logo ET nom de l'employeur).
//
// Cluster est INTÉGRÉ (non modifiable, non supprimable) : c'est l'employeur de tous les dossiers
// existants et le texte des gabarits est écrit à son nom. Les autres employeurs se gèrent dans
// Admin → RH et sont stockés dans app_settings `hr_employers`.
//
// 🔑 Le texte juridique est écrit avec « Cluster » / « Cluster Systems ». Pour un autre
// employeur, applyEmployer() remplace « Cluster Systems » par le nom LÉGAL puis chaque mot
// « Cluster » restant par le nom COURT. L'employeur est figé dans l'instantané à l'envoi, avec
// son logo : renommer OSP plus tard ne réécrit jamais un contrat déjà envoyé.
// ============================================================================

const KEY = 'hr_employers';
const CLUSTER = Object.freeze({
  key: 'cluster', legalName: 'Cluster Systems', shortName: 'Cluster', website: 'clustersystems.com', logo: null, builtIn: true,
});
const MAX_LOGO_BYTES = 600 * 1024;
const LOGO_RE = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;

async function readCustom(pool) {
  try {
    const r = await pool.query('SELECT value FROM app_settings WHERE key = $1', [KEY]);
    let v = r.rows[0] ? r.rows[0].value : [];
    if (typeof v === 'string') v = JSON.parse(v);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

// Liste complète : Cluster d'abord, puis les employeurs ajoutés.
async function readEmployers(pool) {
  return [CLUSTER, ...(await readCustom(pool))];
}

async function getEmployer(pool, key) {
  if (!key || key === 'cluster') return CLUSTER;
  return (await readCustom(pool)).find((e) => e.key === key) || CLUSTER;
}

// Version « sans logo » pour les réponses de liste (le logo peut peser plusieurs centaines de Ko).
const publicShape = (e) => ({ key: e.key, legalName: e.legalName, shortName: e.shortName, website: e.website, hasLogo: !!e.logo, builtIn: !!e.builtIn });

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

// Valide la liste des employeurs AJOUTÉS reçue du navigateur. `previous` permet de garder un logo
// existant quand le navigateur n'en renvoie pas (il ne recharge pas les logos pour les éditer).
function validateCustom(list, previous) {
  if (!Array.isArray(list) || list.length > 20) return { ok: false, error: 'employers array (max 20) required' };
  const out = [];
  const keys = new Set(['cluster']);
  for (const e of list) {
    const legalName = String(e?.legalName || '').trim().slice(0, 120);
    const shortName = String(e?.shortName || '').trim().slice(0, 60);
    if (!legalName || !shortName) return { ok: false, error: 'legalName and shortName are required' };
    const key = String(e?.key || '').trim() || slug(shortName);
    if (!key || keys.has(key)) return { ok: false, error: `duplicate employer: ${shortName}` };
    keys.add(key);
    let logo = null;
    if (e?.logo === null) logo = null;
    else if (typeof e?.logo === 'string' && e.logo) {
      const m = LOGO_RE.exec(e.logo);
      if (!m) return { ok: false, error: `${shortName}: logo must be PNG or JPEG` };
      if (Buffer.from(m[2], 'base64').length > MAX_LOGO_BYTES) return { ok: false, error: `${shortName}: logo too large (600 KB max)` };
      logo = e.logo;
    } else {
      const prev = (previous || []).find((p) => p.key === key);
      logo = prev ? prev.logo : null;
    }
    out.push({ key, legalName, shortName, website: String(e?.website || '').trim().slice(0, 80), logo });
  }
  return { ok: true, list: out };
}

// Remplace l'employeur dans un texte écrit au nom de Cluster.
function applyEmployer(text, emp) {
  if (!emp || emp.key === 'cluster' || typeof text !== 'string') return text;
  return text.replace(/Cluster Systems/g, emp.legalName).replace(/\bCLUSTER SYSTEMS\b/g, emp.legalName.toUpperCase()).replace(/\bCluster\b/g, emp.shortName);
}

function logoBuffer(emp) {
  const m = emp && emp.logo ? LOGO_RE.exec(emp.logo) : null;
  return m ? { buf: Buffer.from(m[2], 'base64'), type: `image/${m[1]}` } : null;
}

module.exports = { KEY, CLUSTER, readEmployers, readCustom, getEmployer, publicShape, validateCustom, applyEmployer, logoBuffer };
