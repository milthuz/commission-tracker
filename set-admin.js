const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres:OfrhwDjuCMrkVqnGaCicYvjxTLBvSHFt@maglev.proxy.rlwy.net:38230/railway'
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
