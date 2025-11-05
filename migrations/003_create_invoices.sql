-- Migration: Create invoices table
-- File: migrations/003_create_invoices.sql

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
  status VARCHAR(50) NOT NULL, -- 'paid', 'overdue', 'pending', 'draft', 'void'
  payment_status VARCHAR(50), -- Additional payment details
  
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

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to auto-update updated_at
CREATE TRIGGER update_invoices_updated_at 
  BEFORE UPDATE ON invoices 
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

-- Add commission_rate column to users table if not exists
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS commission_rate DECIMAL(5, 2) DEFAULT 0.00;

-- Add role column to users table if not exists
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'sales_rep';

COMMENT ON TABLE invoices IS 'Stores synced invoices from Zoho Books';
COMMENT ON COLUMN invoices.status IS 'Invoice status: paid, overdue, pending, draft, void';
COMMENT ON COLUMN invoices.sales_rep_id IS 'Links invoice to sales representative';
