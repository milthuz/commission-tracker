// test-connection.js
const { Client } = require('pg');

const DATABASE_URL = 'postgresql://postgres:0frhwDjuCMrkVqnGaCicYvjxTLBvSHFt@maglev.proxy.rlwy.net:38230/railway';

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
