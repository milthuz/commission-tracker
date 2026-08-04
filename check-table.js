// check-table.js
const { Client } = require('pg');

// Connexion depuis l'EXTÉRIEUR de Railway : il faut l'URL publique (proxy), l'hôte
// interne `postgres.railway.internal` n'étant joignable que depuis les conteneurs.
// À lancer via `railway run --service Postgres node check-table.js`, qui injecte
// les variables du service.
const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Aucune URL de base. Lancer via: railway run --service Postgres node check-table.js');
  process.exit(1);
}

async function checkTable() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    await client.connect();
    console.log('Connected successfully!\n');

    // Check invoices table columns
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'invoices'
      ORDER BY ordinal_position;
    `);

    console.log('Current invoices table structure:');
    console.log('=====================================');
    result.rows.forEach(row => {
      console.log(`${row.column_name} - ${row.data_type} (nullable: ${row.is_nullable})`);
    });

    await client.end();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkTable();
