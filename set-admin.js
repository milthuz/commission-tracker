// set-admin.js
const { Pool } = require('pg');

// Connexion depuis l'EXTÉRIEUR de Railway : il faut l'URL publique (proxy), l'hôte
// interne `postgres.railway.internal` n'étant joignable que depuis les conteneurs.
// À lancer via `railway run --service Postgres node set-admin.js`, qui injecte
// les variables du service.
const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Aucune URL de base. Lancer via: railway run --service Postgres node set-admin.js');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function setAdminUser() {
  try {
    console.log('🔐 Setting user as admin...');
    const result = await pool.query(
      'UPDATE user_tokens SET is_admin = true WHERE email = $1 RETURNING email, is_admin',
      ['sales@clustersystems.com']
    );
    
    if (result.rowCount > 0) {
      console.log('✅ User set as admin successfully!');
      console.log('Email:', result.rows[0].email);
      console.log('Admin:', result.rows[0].is_admin);
    } else {
      console.log('⚠️ No user found');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await pool.end();
  }
}

setAdminUser();
