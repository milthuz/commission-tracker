// run-migration.js
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Connexion depuis l'EXTÉRIEUR de Railway : il faut l'URL publique (proxy), l'hôte
// interne `postgres.railway.internal` n'étant joignable que depuis les conteneurs.
// À lancer via `railway run --service Postgres node run-migration.js <fichier.sql>`,
// qui injecte les variables du service.
const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Aucune URL de base. Lancer via: railway run --service Postgres node run-migration.js <fichier.sql>');
  process.exit(1);
}

async function runMigration() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('Connecting to database...');
    await client.connect();
    console.log('Connected successfully!');

    // Read the SQL file. The migration name comes from the command line
    // (`node run-migration.js 004_drop_savings_calculator.sql`); without an argument
    // it keeps its original behaviour so nothing that relied on it breaks.
    const name = process.argv[2] || '003_create_invoices.sql';
    const sqlFile = path.join(__dirname, 'migrations', name);
    const sql = fs.readFileSync(sqlFile, 'utf8');

    // Surface the server's RAISE NOTICE output — migrations that report what they are
    // about to destroy are useless if the message never reaches the console.
    client.on('notice', (n) => console.log('   ' + n.message));

    console.log(`Running migration ${name}...`);
    await client.query(sql);

    console.log('✅ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
