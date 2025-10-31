const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const crypto = require('crypto');
const ZohoService = require('./zoho-service');

const app = express();
app.use(express.json());

// ============================================================================
// CONFIG
// ============================================================================

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const ZOHO_CONFIG = {
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  redirect_uri: process.env.REDIRECT_URI,
  organizationId: process.env.ZOHO_ORG_ID,
};

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Initialize Zoho Service
const zohoService = new ZohoService(pool);

// ============================================================================
// CORS MIDDLEWARE
// ============================================================================

app.use((req, res, next) => {
  const frontendUrl = process.env.FRONTEND_URL || 'https://sparkly-kulfi-c7641a.netlify.app';
  res.header('Access-Control-Allow-Origin', frontendUrl);
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Max-Age', '3600');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});

// ============================================================================
// AUTHENTICATION MIDDLEWARE
// ============================================================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
}

// ============================================================================
// ZOHO OAUTH ENDPOINTS
// ============================================================================

app.get('/api/auth/zoho', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = `https://accounts.zoho.com/oauth/v2/auth?scope=ZohoBooks.invoices.READ,ZohoBooks.settings.READ&client_id=${ZOHO_CONFIG.client_id}&response_type=code&redirect_uri=${ZOHO_CONFIG.redirect_uri}&state=${state}`;
  res.json({ authUrl, state });
});

app.get('/api/auth/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect(`${process.env.FRONTEND_URL}?error=No authorization code`);
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await axios.post(
      'https://accounts.zoho.com/oauth/v2/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CONFIG.client_id,
        client_secret: ZOHO_CONFIG.client_secret,
        redirect_uri: ZOHO_CONFIG.redirect_uri,
        code: code,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const accessToken = tokenResponse.data.access_token;
    const refreshToken = tokenResponse.data.refresh_token;
    const expiresIn = tokenResponse.data.expires_in;
    const apiDomain = tokenResponse.data.api_domain;

    // Get user info from Zoho
    const userResponse = await axios.get(
      `${apiDomain}/books/v3/organizations`,
      {
        headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` },
      }
    );

    const userEmail = userResponse.data.organizations[0]?.email || `zoho-user-${Date.now()}@zoho.com`;
    const expiresAt = Date.now() + expiresIn * 1000;

    // Store tokens in database
    await pool.query(
      `INSERT INTO user_tokens (email, access_token, refresh_token, api_domain, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
       access_token = $2, refresh_token = $3, api_domain = $4, expires_at = $5, updated_at = CURRENT_TIMESTAMP`,
      [userEmail, accessToken, refreshToken, apiDomain, expiresAt]
    );

    // Create JWT
    const jwtToken = jwt.sign(
      { email: userEmail, isAdmin: false },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.redirect(`${process.env.FRONTEND_URL}?token=${jwtToken}`);
  } catch (error) {
    console.error('❌ Auth error:', error.message);
    res.redirect(`${process.env.FRONTEND_URL}?error=${error.message}`);
  }
});

// ============================================================================
// COMMISSIONS API
// ============================================================================

app.get('/api/commissions', authenticateToken, async (req, res) => {
  const { email, isAdmin } = req.user;
  const { start, end, repName } = req.query;

  try {
    console.log('📊 Fetching commissions from database...');
    console.log(`📅 Date range: ${start} to ${end}`);

    // Query database for PAID invoices only
    let query = `
      SELECT 
        salesperson_name,
        COUNT(*) as invoices,
        SUM(commission) as total_commission
      FROM invoices
      WHERE organization_id = $1
      AND status = 'paid'
      AND date BETWEEN $2 AND $3
    `;
    
    const params = [ZOHO_CONFIG.organizationId, new Date(start), new Date(end)];
    let paramIndex = 4;

    if (!isAdmin) {
      query += ` AND salesperson_name = $${paramIndex}`;
      params.push(repName || email);
      paramIndex++;
    }

    query += ` GROUP BY salesperson_name ORDER BY total_commission DESC`;

    const commResult = await pool.query(query, params);

    const commissions = commResult.rows.map(row => ({
      repName: row.salesperson_name,
      invoices: parseInt(row.invoices),
      commission: parseFloat(row.total_commission) || 0,
      avgPerInvoice: (parseFloat(row.total_commission) / parseInt(row.invoices)) || 0
    }));

    // Get all invoices (for invoices tab)
    let invQuery = `
      SELECT * FROM invoices 
      WHERE organization_id = $1
      AND date BETWEEN $2 AND $3
    `;
    
    const invParams = [ZOHO_CONFIG.organizationId, new Date(start), new Date(end)];
    let invParamIndex = 4;
    
    if (!isAdmin) {
      invQuery += ` AND salesperson_name = $${invParamIndex}`;
      invParams.push(repName || email);
    }
    
    invQuery += ` ORDER BY date DESC`;

    const invResult = await pool.query(invQuery, invParams);

    console.log(`✅ Found ${commissions.length} reps with paid invoices`);
    res.json({ commissions, invoices: invResult.rows });
  } catch (error) {
    console.error('❌ Commission API error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// AUTO-SYNC INVOICES
// ============================================================================

async function autoSyncInvoices() {
  try {
    console.log('🔄 [AUTO-SYNC] Starting automatic invoice sync...');
    
    // Get admin user
    const adminResult = await pool.query(
      'SELECT email FROM user_tokens WHERE is_admin = true ORDER BY updated_at DESC LIMIT 1'
    );

    if (!adminResult.rows[0]) {
      console.log('⚠️ [AUTO-SYNC] No admin user found');
      return;
    }

    const adminEmail = adminResult.rows[0].email;
    console.log(`🔐 [AUTO-SYNC] Using admin: ${adminEmail}`);

    // Sync invoices using ZohoService
    const allInvoices = await zohoService.syncAllInvoices(adminEmail);

    // Insert into database
    let syncedCount = 0;
    let noSalesrepCount = 0;
    
    for (const inv of allInvoices) {
      // If no salesperson assigned, flag with special status
      const salesperson = (inv.salesperson_name && inv.salesperson_name.trim()) 
        ? inv.salesperson_name 
        : 'no_salesrep';
      
      const total = parseFloat(inv.total) || 0;
      const commission = (inv.status === 'paid' && salesperson !== 'no_salesrep') ? (total * 0.1) : 0;
      const invDate = new Date(inv.date || new Date());

      await pool.query(
        `INSERT INTO invoices 
         (invoice_number, salesperson_name, total, status, date, commission, organization_id) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (invoice_number) DO UPDATE SET
         status = $4, total = $3, salesperson_name = $2, commission = $6, updated_at = CURRENT_TIMESTAMP`,
        [inv.invoice_number, salesperson, total, inv.status, invDate, commission, ZOHO_CONFIG.organizationId]
      );
      
      if (salesperson === 'no_salesrep') {
        noSalesrepCount++;
      }
      syncedCount++;
    }

    console.log(`✅ [AUTO-SYNC] Successfully synced ${syncedCount} invoices`);
    console.log(`💰 [AUTO-SYNC] Commission calculated ONLY on paid invoices with salesreps`);
    if (noSalesrepCount > 0) {
      console.log(`⚠️ [AUTO-SYNC] ${noSalesrepCount} invoices flagged as "no_salesrep" (no salesperson assigned)`);
    }
  } catch (error) {
    console.error(`❌ [AUTO-SYNC] Sync failed:`, error.message);
  }
}

// Schedule auto-sync every 4 hours
const AUTO_SYNC_INTERVAL = 4 * 60 * 60 * 1000;
let syncInterval;

function startAutoSync() {
  console.log('⏰ [AUTO-SYNC] Starting automatic sync scheduler (every 4 hours)');
  autoSyncInvoices();
  syncInterval = setInterval(autoSyncInvoices, AUTO_SYNC_INTERVAL);
}

function stopAutoSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    console.log('⏹️ [AUTO-SYNC] Stopped automatic sync scheduler');
  }
}

// ============================================================================
// MANUAL SYNC ENDPOINT
// ============================================================================

app.post('/api/sync/invoices', authenticateToken, async (req, res) => {
  const { email, isAdmin } = req.user;

  if (!isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    console.log('🔄 Manual sync triggered by', email);
    const invoices = await zohoService.syncAllInvoices(email);
    
    res.json({ 
      synced: invoices.length,
      message: 'Invoices synced successfully'
    });
  } catch (error) {
    console.error('❌ Manual sync failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  console.log(`✅ Commission Tracker API running on http://localhost:${PORT}`);
  console.log(`📚 Zoho Books Organization ID: ${ZOHO_CONFIG.organizationId}`);
  console.log(`🔐 Frontend redirect: ${process.env.FRONTEND_URL}`);
  console.log(`🗄️  Database connected: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);
  
  startAutoSync();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  stopAutoSync();
  await pool.end();
  process.exit(0);
});
