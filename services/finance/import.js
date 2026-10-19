// ============================================================================
// Module Finance — import PONCTUEL des données de la CFO en base.
//
// Lit le paquet de passation du design (design/finance : prototype + budget_data.js +
// payroll_data.js + opex_data.js) et crée le budget consolidé FY2027 : référence, effectif.
// Les données ne passent JAMAIS par un dépôt git : on lance ce script depuis le poste qui a le
// dossier, contre la base de Railway.
//
//   railway run --service Postgres node services/finance/import.js ../design/finance            (simulation)
//   railway run --service Postgres node services/finance/import.js ../design/finance --apply
//   … --apply --reference-only   remplace la RÉFÉRENCE d'un budget existant ; garde les
//                                ajustements et l'effectif saisis dans l'app
//
// Sans --apply : rien n'est écrit, le script affiche ce qu'il ferait. Refuse d'écraser un
// budget existant (sauf --reference-only) : l'effectif saisi par la CFO ne se perd pas par
// mégarde.
// ============================================================================

const path = require('path');
const { extractHandoff } = require('./handoff');
const { ensureSchema } = require('./routes');

async function importHandoff(pool, dir, { apply = false, referenceOnly = false, actor = 'import' } = {}) {
  const { reference, roster } = extractHandoff(dir);
  const fy = reference.fiscalYear;
  const summary = {
    fiscalYear: fy,
    drivers: Object.keys(reference.drvDefaults).length,
    opexItems: reference.opex.length,
    trips: reference.trips.length,
    employees: roster.employees.length,
    contractors: roster.contractors.length,
    action: null,
  };
  await ensureSchema(pool);
  const cur = await pool.query("SELECT id FROM finance_budgets WHERE fiscal_year = $1 AND entity = 'consolidated'", [fy]);
  const existing = cur.rows[0];
  if (existing && !referenceOnly) {
    summary.action = 'refused_exists';
    return summary;
  }
  if (!existing && referenceOnly) {
    summary.action = 'refused_missing';
    return summary;
  }
  summary.action = existing ? 'replace_reference' : 'create';
  if (!apply) { summary.dryRun = true; return summary; }

  // Une transaction = UNE connexion : avec un vrai Pool, chaque pool.query peut partir sur une
  // connexion différente et le BEGIN ne couvrirait rien.
  const client = pool.connect ? await pool.connect() : null;
  const db = client || pool;
  try {
    await importIn(db, existing, reference, roster, actor, summary);
  } finally {
    if (client) client.release();
  }
  return summary;
}

async function importIn(pool, existing, reference, roster, actor, summary) {
  const fy = reference.fiscalYear;
  await pool.query('BEGIN');
  try {
    if (existing) {
      await pool.query('UPDATE finance_budgets SET reference = $2::jsonb, imported_by = $3, imported_at = NOW(), updated_at = NOW() WHERE id = $1',
        [existing.id, JSON.stringify(reference), actor]);
      summary.budgetId = existing.id;
    } else {
      const b = await pool.query(
        `INSERT INTO finance_budgets (fiscal_year, entity, reference, imported_by) VALUES ($1, 'consolidated', $2::jsonb, $3) RETURNING id`,
        [fy, JSON.stringify(reference), actor]);
      const id = b.rows[0].id;
      summary.budgetId = id;
      let sort = 0;
      for (const e of roster.employees) {
        await pool.query(
          `INSERT INTO finance_employees (budget_id, ent, dept, name, salary, salary_base, alloc, map, sort, created_by)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, $9)`,
          [id, e.ent, e.dept, e.name, e.salary, e.alloc, e.map, ++sort, actor]);
      }
      sort = 0;
      for (const c of roster.contractors) {
        await pool.query(
          `INSERT INTO finance_contractors (budget_id, co, name, svc, rate, hours, amt, amt_base, map, dept, sort, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, $11)`,
          [id, c.co || '', c.name || '', c.svc || '', c.rate || null, c.hours || null, c.amt || 0, c.map, c.dept || '', ++sort, actor]);
      }
    }
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK');
    throw e;
  }
}

module.exports = { importHandoff };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('Usage : node services/finance/import.js <dossier design/finance> [--apply] [--reference-only]'); process.exit(1); }
  const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!url) { console.error('Aucune URL de base. Lancer via : railway run --service Postgres node services/finance/import.js …'); process.exit(1); }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  importHandoff(pool, path.resolve(dir), { apply: args.includes('--apply'), referenceOnly: args.includes('--reference-only'), actor: process.env.FINANCE_IMPORT_ACTOR || 'import' })
    .then((s) => {
      const msg = {
        refused_exists: '⛔ Un budget consolidé existe déjà pour cet exercice. Rien n\'est écrit. (--reference-only pour remplacer seulement la référence.)',
        refused_missing: '⛔ Aucun budget à mettre à jour : lancer d\'abord sans --reference-only.',
        create: s.dryRun ? 'Simulation : le budget serait CRÉÉ (relancer avec --apply).' : `✅ Budget créé (id ${s.budgetId}).`,
        replace_reference: s.dryRun ? 'Simulation : la référence serait REMPLACÉE (relancer avec --apply).' : `✅ Référence remplacée (budget ${s.budgetId}).`,
      }[s.action];
      console.log(JSON.stringify({ ...s }, null, 2));
      console.log(msg);
      process.exit(s.action.startsWith('refused') ? 2 : 0);
    })
    .catch((e) => { console.error('❌ Import échoué :', e.message); process.exit(1); })
    .finally(() => pool.end());
}
