// ============================================================================
// Proposition de chaîne — le pont entre le modélisateur de revenus et le générateur de
// propositions (/api/proposals/*).
//
// Une proposition de chaîne, c'est la présentation habituelle (couverture co-marquée + pages
// Cluster) suivie d'une page de TARIFICATION générée depuis un scénario du modélisateur, à la
// place du devis Zoho. Ce module fournit les deux morceaux dont server.js a besoin :
//   • loadChainScenario(pool, id) — le scénario (bibliothèque d'équipe : tout scénario est
//     utilisable, comme dans le modélisateur) ;
//   • renderChainPricingPdf(inputs, { lang, startPage }) — la page de tarification en PDF, rendue
//     par le MÊME service Chromium que la présentation (/render-html), pour qu'elle s'y fonde.
//
// ⚠️ Le document part chez le CLIENT : seul proposalHtml.js décide de ce qui y figure, par sa
// liste blanche PRICE_KEYS. Rien ici ne doit ajouter un champ du scénario au document.
// ============================================================================

const axios = require('axios');
const { renderPricingHtml } = require('./proposalHtml');
const { upgradeInputs } = require('./defaults');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadChainScenario(pool, id) {
  if (!UUID_RE.test(String(id || ''))) return null;
  const { rows } = await pool.query('SELECT id, name, inputs FROM revenue_model_scenarios WHERE id = $1', [id]);
  if (!rows.length) return null;
  return { id: rows[0].id, name: rows[0].name, inputs: upgradeInputs(rows[0].inputs) };
}

// Le service de rendu expose /render (la présentation) et /render-html (du HTML autonome) : on
// dérive la seconde adresse de PROPOSAL_RENDER_URL, déjà configurée pour la première.
function renderHtmlUrl() {
  const base = process.env.PROPOSAL_RENDER_URL || '';
  if (!base) return '';
  return base.replace(/\/render\/?$/, '') + '/render-html';
}

// Rend la page de tarification. Lève une erreur plutôt que de rendre un PDF vide : une
// proposition de chaîne SANS sa tarification ne doit jamais partir en silence.
async function renderChainPricingPdf(inputs, { lang = 'fr', startPage = 1 } = {}) {
  const url = renderHtmlUrl();
  if (!url) throw new Error('chain_render_not_configured');
  const html = renderPricingHtml(inputs, { lang, startPage });
  const r = await axios.post(url, { html, token: process.env.PROPOSAL_RENDER_TOKEN || '' }, {
    responseType: 'arraybuffer', timeout: 60000, validateStatus: () => true,
  });
  if (r.status !== 200 || !r.data || r.data.byteLength < 1000) {
    throw new Error(`chain_render_failed_${r.status}`);
  }
  return Buffer.from(r.data);
}

// Liste des scénarios utilisables pour une proposition — le strict nécessaire pour les choisir.
async function listChainScenarios(pool) {
  const { rows } = await pool.query(
    `SELECT id, name, inputs->>'merchantName' AS merchant, inputs->>'numLocs' AS locs, updated_at
       FROM revenue_model_scenarios ORDER BY updated_at DESC LIMIT 500`);
  return rows.map((r) => ({ id: r.id, name: r.name, merchantName: r.merchant || '', numLocs: Number(r.locs) || 0, updatedAt: r.updated_at }));
}

module.exports = { loadChainScenario, renderChainPricingPdf, listChainScenarios, renderHtmlUrl };
