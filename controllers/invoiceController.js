// controllers/invoiceController.js
const pool = require('../config/database');
const ZohoBooksService = require('../services/zohoBooksService');

// Sync invoices from Zoho Books
exports.syncInvoices = async (req, res) => {
  try {
    const userId = req.user.id;

    // Get user's Zoho tokens
    const userResult = await pool.query(
      'SELECT zoho_access_token, zoho_organization_id FROM users WHERE id = $1',
      [userId]
    );

    if (!userResult.rows[0]?.zoho_access_token) {
      return res.status(401).json({ error: 'Zoho authentication required' });
    }

    const { zoho_access_token, zoho_organization_id } = userResult.rows[0];
    const zohoBooksService = new ZohoBooksService(zoho_access_token, zoho_organization_id);

    // Fetch invoices from Zoho Books
    const zohoResponse = await zohoBooksService.getInvoices({
      perPage: 200,
      status: 'All' // Get all statuses
    });

    const invoices = zohoResponse.invoices || [];
    let syncedCount = 0;
    let updatedCount = 0;

    // Sync each invoice to database
    for (const zohoInvoice of invoices) {
      const transformedInvoice = zohoBooksService.transformInvoice(zohoInvoice);

      // Check if invoice exists
      const existingInvoice = await pool.query(
        'SELECT id FROM invoices WHERE zoho_invoice_id = $1',
        [transformedInvoice.zoho_invoice_id]
      );

      if (existingInvoice.rows.length > 0) {
        // Update existing invoice
        await pool.query(
          `UPDATE invoices SET 
            invoice_number = $1,
            customer_name = $2,
            invoice_date = $3,
            due_date = $4,
            total = $5,
            balance = $6,
            status = $7,
            payment_status = $8,
            currency_code = $9,
            notes = $10,
            synced_at = $11
          WHERE zoho_invoice_id = $12`,
          [
            transformedInvoice.invoice_number,
            transformedInvoice.customer_name,
            transformedInvoice.invoice_date,
            transformedInvoice.due_date,
            transformedInvoice.total,
            transformedInvoice.balance,
            transformedInvoice.status,
            transformedInvoice.payment_status,
            transformedInvoice.currency_code,
            transformedInvoice.notes,
            transformedInvoice.synced_at,
            transformedInvoice.zoho_invoice_id
          ]
        );
        updatedCount++;
      } else {
        // Insert new invoice
        await pool.query(
          `INSERT INTO invoices (
            zoho_invoice_id, invoice_number, customer_id, customer_name,
            invoice_date, due_date, total, balance, status, payment_status,
            currency_code, notes, zoho_url, synced_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            transformedInvoice.zoho_invoice_id,
            transformedInvoice.invoice_number,
            transformedInvoice.customer_id,
            transformedInvoice.customer_name,
            transformedInvoice.invoice_date,
            transformedInvoice.due_date,
            transformedInvoice.total,
            transformedInvoice.balance,
            transformedInvoice.status,
            transformedInvoice.payment_status,
            transformedInvoice.currency_code,
            transformedInvoice.notes,
            transformedInvoice.zoho_url,
            transformedInvoice.synced_at
          ]
        );
        syncedCount++;
      }
    }

    res.json({
      success: true,
      message: `Synced ${syncedCount} new invoices, updated ${updatedCount} invoices`,
      total: invoices.length,
      synced: syncedCount,
      updated: updatedCount
    });

  } catch (error) {
    console.error('Error syncing invoices:', error);
    res.status(500).json({ 
      error: 'Failed to sync invoices',
      message: error.message 
    });
  }
};

// Get all invoices with filters
exports.getInvoices = async (req, res) => {
  try {
    const userId = req.user.id;
    const { 
      sales_rep_id, 
      status, 
      start_date, 
      end_date,
      search,
      page = 1,
      per_page = 50
    } = req.query;

    let query = `
      SELECT 
        i.*,
        u.name as sales_rep_name,
        u.email as sales_rep_email
      FROM invoices i
      LEFT JOIN users u ON i.sales_rep_id = u.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    // Filter by sales rep (for sales reps, only show their invoices)
    const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    if (userRole.rows[0]?.role === 'sales_rep') {
      query += ` AND i.sales_rep_id = $${paramCount}`;
      params.push(userId);
      paramCount++;
    } else if (sales_rep_id) {
      query += ` AND i.sales_rep_id = $${paramCount}`;
      params.push(sales_rep_id);
      paramCount++;
    }

    // Filter by status
    if (status) {
      query += ` AND i.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    // Filter by date range
    if (start_date) {
      query += ` AND i.invoice_date >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }

    if (end_date) {
      query += ` AND i.invoice_date <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    // Search by invoice number or customer name
    if (search) {
      query += ` AND (i.invoice_number ILIKE $${paramCount} OR i.customer_name ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    // Add pagination
    query += ` ORDER BY i.invoice_date DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(per_page, (page - 1) * per_page);

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*) FROM invoices i WHERE 1=1';
    const countParams = params.slice(0, -2); // Remove LIMIT and OFFSET params

    const countResult = await pool.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].count);

    res.json({
      invoices: result.rows,
      pagination: {
        page: parseInt(page),
        per_page: parseInt(per_page),
        total: totalCount,
        pages: Math.ceil(totalCount / per_page)
      }
    });

  } catch (error) {
    console.error('Error fetching invoices:', error);
    res.status(500).json({ error: 'Failed to fetch invoices' });
  }
};

// Get invoice statistics
exports.getInvoiceStats = async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Check if user is sales rep
    const userRole = await pool.query('SELECT role FROM users WHERE id = $1', [userId]);
    const isSalesRep = userRole.rows[0]?.role === 'sales_rep';

    let query = `
      SELECT 
        COUNT(*) as total_invoices,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) as overdue_count,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(total) as total_amount,
        SUM(balance) as outstanding_balance
      FROM invoices
      WHERE 1=1
    `;

    const params = [];
    if (isSalesRep) {
      query += ' AND sales_rep_id = $1';
      params.push(userId);
    }

    const result = await pool.query(query, params);

    res.json({
      stats: result.rows[0]
    });

  } catch (error) {
    console.error('Error fetching invoice stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
};

module.exports = exports;
