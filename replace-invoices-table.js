// replace-invoices-table.js
const { Client } = require('pg');

async function replaceTable() {
  // Railway sets DATABASE_URL when using 'railway run'
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL not found. Make sure to run with: railway run node replace-invoices-table.js');
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });

  try {
    await client.connect();
    console.log('Connected to database\n');

    // Drop old table
    console.log('Dropping old invoices table...');
    await client.query('DROP TABLE IF EXISTS invoices CASCADE;');
    console.log('✅ Old table dropped\n');

    // Create new table
    console.log('Creating new invoices table...');
    const sql = `
      CREATE TABLE invoices (
        id SERIAL PRIMARY KEY,
        
        -- Zoho Books data
        zoho_invoice_id VARCHAR(255) UNIQUE NOT NULL,
        invoice_number VARCHAR(100) NOT NULL,
        customer_id VARCHAR(255),
        customer_name VARCHAR(255) NOT NULL,
        
        -- Sales rep association
        sales_rep_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sales_rep_name VARCHAR(255),
        
        -- Invoice details
        invoice_date DATE NOT NULL,
        due_date DATE NOT NULL,
        total DECIMAL(10, 2) NOT NULL,
        balance DECIMAL(10, 2) NOT NULL,
        
        -- Status
        status VARCHAR(50) NOT NULL,
        payment_status VARCHAR(50),
        
        -- Metadata
        currency_code VARCHAR(10) DEFAULT 'CAD',
        notes TEXT,
        zoho_url TEXT,
        
        -- Timestamps
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for performance
      CREATE INDEX idx_invoices_sales_rep ON invoices(sales_rep_id);
      CREATE INDEX idx_invoices_status ON invoices(status);
      CREATE INDEX idx_invoices_date ON invoices(invoice_date);
      CREATE INDEX idx_invoices_zoho_id ON invoices(zoho_invoice_id);

      -- Trigger to auto-update updated_at
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
          NEW.updated_at = CURRENT_TIMESTAMP;
          RETURN NEW;
      END;
      $$ language 'plpgsql';

      CREATE TRIGGER update_invoices_updated_at 
        BEFORE UPDATE ON invoices 
        FOR EACH ROW 
        EXECUTE FUNCTION update_updated_at_column();

      -- Add columns to users table if not exists
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5, 2) DEFAULT 0.00;

      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'sales_rep';
    `;

    await client.query(sql);
    console.log('✅ New table created with all indexes and triggers\n');

    console.log('🎉 Migration completed successfully!');
    await client.end();
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  }
}

replaceTable();
