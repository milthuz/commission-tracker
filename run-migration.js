// run-migration.js
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// Use the public URL for external connections
const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || 
  'postgresql://postgres:0frhwDjuCMrkVqnGaCicYvjxTLBvSHFt@maglev.proxy.rlwy.net:38230/railway';

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

    // Read the SQL file
    const sqlFile = path.join(__dirname, 'migrations', '003_create_invoices.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    console.log('Running migration...');
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
