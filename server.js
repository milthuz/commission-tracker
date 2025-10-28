// ============================================================================
// BACKEND API - Express.js Server with PostgreSQL
// File: server.js
// ============================================================================
// Install: npm install express dotenv axios cors body-parser jsonwebtoken pg
// Run: node server.js

const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

dotenv.config();

const app = express();

// ============================================================================
// DATABASE CONNECTION
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize database tables
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        api_domain VARCHAR(255),
        expires_at BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Initialize on startup
initializeDatabase();

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(bodyParser.json());

// JWT middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ============================================================================
// ZOHO OAUTH CONFIG
// ============================================================================

const ZOHO_CONFIG = {
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  redirect_uri: process.env.ZOHO_REDIRECT_URI || 'http://localhost:5000/api/auth/callback',
  accounts_url: 'https://accounts.zoho.com',
};

// ============================================================================
// AUTH ROUTES
// ============================================================================

// 1. Initiate Zoho OAuth
app.get('/api/auth/zoho', (req, res) => {
  const state = Math.random().toString(36).substring(7);
  
  const authUrl = `${ZOHO_CONFIG.accounts_url}/oauth/v2/auth?` +
    `scope=ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE` +
    `&client_id=${ZOHO_CONFIG.client_id}` +
    `&response_type=code` +
    `&redirect_uri=${ZOHO_CONFIG.redirect_uri}` +
    `&state=${state}` +
    `&access_type=offline` +
    `&prompt=login`;

  res.json({ authUrl, state });
});

// 2. Handle OAuth callback
app.get('/api/auth/callback', async (req, res) => {
  const { code, state, location, accounts_server } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    const accountsUrl = accounts_server || ZOHO_CONFIG.accounts_url;

    console.log('OAuth callback received:');
    console.log('Code:', code.substring(0, 20) + '...');
    console.log('Client ID:', ZOHO_CONFIG.client_id ? 'SET' : 'MISSING');
    console.log('Client Secret:', ZOHO_CONFIG.client_secret ? 'SET' : 'MISSING');

    // Exchange code for tokens
    const tokenResponse = await axios.post(
      `${accountsUrl}/oauth/v2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: ZOHO_CONFIG.client_id,
        client_secret: ZOHO_CONFIG.client_secret,
        redirect_uri: ZOHO_CONFIG.redirect_uri,
        code,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    console.log('Token exchange successful!');

    const {
      access_token,
      refresh_token,
      api_domain,
      expires_in,
    } = tokenResponse.data;

    // Get user info from Zoho to get their actual email
    console.log('Fetching user info from Zoho...');
    const userResponse = await axios.get(
      `${api_domain}/books/v3/users`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${access_token}`,
        },
      }
    );

    const userEmail = userResponse.data.users?.[0]?.email || `zoho-user-${Date.now()}@zoho.com`;
    console.log('User email:', userEmail);

    // Store tokens in database
    await pool.query(
      `INSERT INTO user_tokens (email, access_token, refresh_token, api_domain, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
       access_token = $2, refresh_token = $3, api_domain = $4, expires_at = $5, updated_at = CURRENT_TIMESTAMP`,
      [userEmail, access_token, refresh_token, api_domain, Date.now() + expires_in * 1000]
    );

    console.log('Tokens stored in database');

    // Create JWT token
    const jwtToken = jwt.sign(
      { email: userEmail, isAdmin: true },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    // Redirect to frontend with token
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}?token=${jwtToken}`;
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('OAuth callback error:', error.message);
    console.error('Zoho API response status:', error.response?.status);
    console.error('Zoho API response data:', JSON.stringify(error.response?.data, null, 2));
    
    res.status(500).json({ 
      error: 'Token exchange failed',
      details: error.message,
      status: error.response?.status,
      zohoError: error.response?.data
    });
  }
});

// 3. Get access token
app.get('/api/auth/token', authenticateToken, async (req, res) => {
  const { email } = req.user;

  try {
    const result = await pool.query(
      'SELECT access_token FROM user_tokens WHERE email = $1',
      [email]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'No token found' });
    }

    res.json({ accessToken: result.rows[0].access_token });
  } catch (error) {
    console.error('Token retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve token' });
  }
});

// ============================================================================
// COMMISSION API ROUTES
// ============================================================================

// Get commission data
app.get('/api/commissions', authenticateToken, async (req, res) => {
  const { email, isAdmin } = req.user;
  const { start, end, repName } = req.query;

  try {
    // Get token from database
    const tokenResult = await pool.query(
      'SELECT access_token, refresh_token, api_domain, expires_at FROM user_tokens WHERE email = $1',
      [email]
    );

    if (!tokenResult.rows.length) {
      return res.status(401).json({ error: 'No Zoho token found' });
    }

    let tokenData = tokenResult.rows[0];
    let accessToken = tokenData.access_token;

    // Check if token needs refresh
    if (Date.now() >= tokenData.expires_at) {
      console.log('Refreshing expired token...');
      const refreshResponse = await axios.post(
        `${ZOHO_CONFIG.accounts_url}/oauth/v2/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: ZOHO_CONFIG.client_id,
          client_secret: ZOHO_CONFIG.client_secret,
          refresh_token: tokenData.refresh_token,
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      accessToken = refreshResponse.data.access_token;
      
      // Update token in database
      await pool.query(
        `UPDATE user_tokens SET access_token = $1, expires_at = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE email = $3`,
        [accessToken, Date.now() + refreshResponse.data.expires_in * 1000, email]
      );
    }

    console.log('Fetching invoices from Zoho...');
    console.log('API Domain:', tokenData.api_domain);
    console.log('Organization ID:', process.env.ZOHO_ORG_ID);

    // Fetch invoices from Zoho Books
    const invoicesResponse = await axios.get(
      `${tokenData.api_domain}/books/v3/invoices`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          status: 'paid',
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
        },
      }
    );

    console.log('Invoices fetched successfully!');
    console.log('Number of invoices:', invoicesResponse.data.invoices?.length || 0);

    const invoices = invoicesResponse.data.invoices || [];

    // Calculate commissions
    const commissions = calculateCommissions(
      invoices,
      { email, isAdmin, repName },
      start,
      end
    );

    res.json({ commissions });
  } catch (error) {
    console.error('Commission API error:', error.message);
    console.error('Zoho API response status:', error.response?.status);
    console.error('Zoho API response data:', JSON.stringify(error.response?.data, null, 2));
    
    res.status(500).json({ 
      error: 'Failed to fetch commissions',
      details: error.message,
    });
  }
});

// ============================================================================
// COMMISSION CALCULATION
// ============================================================================

function calculateCommissions(invoices, user, startDate, endDate) {
  const commissionsMap = new Map();
  const start = new Date(startDate);
  const end = new Date(endDate);

  invoices.forEach((invoice) => {
    const salesRep = invoice.salesperson_name || 'Unassigned';
    
    // Filter by date range
    const invoiceDate = new Date(invoice.date);
    if (invoiceDate < start || invoiceDate > end) {
      return;
    }

    // Get total invoice amount
    const invoiceTotal = parseFloat(invoice.total || 0);
    
    // Calculate 10% commission on total invoice amount
    const commission = invoiceTotal * 0.10;

    console.log(`Invoice: ${invoice.invoice_number}, Rep: ${salesRep}, Total: ${invoiceTotal}, Commission: ${commission}`);

    // Aggregate by sales rep
    if (commissionsMap.has(salesRep)) {
      const existing = commissionsMap.get(salesRep);
      const newTotal = existing.commission + commission;
      commissionsMap.set(salesRep, {
        repName: salesRep,
        invoices: existing.invoices + 1,
        commission: newTotal,
        avgPerInvoice: newTotal / (existing.invoices + 1),
      });
    } else {
      commissionsMap.set(salesRep, {
        repName: salesRep,
        invoices: 1,
        commission: commission,
        avgPerInvoice: commission,
      });
    }
  });

  console.log('Final commissions:', Array.from(commissionsMap.values()));
  return Array.from(commissionsMap.values());
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Commission Tracker API running on http://localhost:${PORT}`);
  console.log(`📚 Zoho Books Organization ID: ${process.env.ZOHO_ORG_ID}`);
  console.log(`🔐 Frontend redirect: ${process.env.FRONTEND_URL}`);
  console.log(`🗄️  Database connected: ${process.env.DATABASE_URL ? 'Yes' : 'No'}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});
