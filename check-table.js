// check-table.js
const { Client } = require('pg');

const DATABASE_URL = 'postgresql://postgres:0frhwDjuCMrkVqnGaCicYvjxTLBvSHFt@maglev.proxy.rlwy.net:38230/railway';

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
