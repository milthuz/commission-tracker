// test-connection.js
const { Client } = require('pg');

// Connexion depuis l'EXTÉRIEUR de Railway : il faut l'URL publique (proxy), l'hôte
// interne `postgres.railway.internal` n'étant joignable que depuis les conteneurs.
// À lancer via `railway run --service Postgres node test-connection.js`, qui injecte
// les variables du service.
const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ Aucune URL de base. Lancer via: railway run --service Postgres node test-connection.js');
  process.exit(1);
}

async function testConnection() {
  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    console.log('Attempting to connect...');
    await client.connect();
    console.log('✅ Connected successfully!');
    
    const result = await client.query('SELECT NOW()');
    console.log('Database time:', result.rows[0].now);
    
    await client.end();
    console.log('Connection closed.');
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    console.error('Full error:', error);
  }
}

testConnection();
