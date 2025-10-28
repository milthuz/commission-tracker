// ============================================================================
// BACKEND API - Express.js Server
// File: server.js
// ============================================================================
// Install dependencies: npm install express dotenv axios cors body-parser jsonwebtoken
// Run: node server.js

const express = require('express');
const dotenv = require('dotenv');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(bodyParser.json());

// JWT middleware for protecting routes
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
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// ============================================================================
// CONFIGURATION
// ============================================================================

const ZOHO_CONFIG = {
  accounts_url: process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com',
  api_url: process.env.ZOHO_API_URL || 'https://www.zohoapis.com',
  client_id: process.env.ZOHO_CLIENT_ID,
  client_secret: process.env.ZOHO_CLIENT_SECRET,
  redirect_uri: process.env.ZOHO_REDIRECT_URI || 'http://localhost:5000/api/auth/callback',
};

// Simple in-memory storage (use database in production)
const userTokens = new Map();
const userDatabase = new Map();

// ============================================================================
// AUTH ROUTES
// ============================================================================

// 1. Initiate Zoho OAuth flow
app.get('/api/auth/zoho', (req, res) => {
  const state = Math.random().toString(36).substring(7);
  
  const authUrl = `${ZOHO_CONFIG.accounts_url}/oauth/v2/auth?` +
    `scope=ZohoBooks.invoices.READ,ZohoBooks.invoices.CREATE,ZohoBooks.invoices.UPDATE` +
    `&client_id=${ZOHO_CONFIG.client_id}` +
    `&response_type=code` +
    `&redirect_uri=${ZOHO_CONFIG.redirect_uri}` +
    `&state=${state}` +
    `&access_type=offline` +
    `&prompt=consent`;

  // Store state for verification
  res.json({ authUrl, state });
});

// 2. Handle Zoho OAuth callback
app.get('/api/auth/callback', async (req, res) => {
  const { code, state, location, accounts_server } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code' });
  }

  try {
    // Use location-specific accounts server if provided
    const accountsUrl = accounts_server || ZOHO_CONFIG.accounts_url;

    // Debug logging
    console.log('OAuth callback received:');
    console.log('Code:', code.substring(0, 20) + '...');
    console.log('Client ID:', ZOHO_CONFIG.client_id ? 'SET' : 'MISSING');
    console.log('Client Secret:', ZOHO_CONFIG.client_secret ? 'SET' : 'MISSING');
    console.log('Redirect URI:', ZOHO_CONFIG.redirect_uri);
    console.log('Accounts URL:', accountsUrl);

    // Exchange code for tokens - using form-urlencoded format
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
    console.log('Response:', tokenResponse.data);

    const {
      access_token,
      refresh_token,
      api_domain,
      expires_in,
    } = tokenResponse.data;

    // Get user info from Zoho
    const userResponse = await axios.get(
      `${api_domain}/books/v3/users?organization_id=${process.env.ZOHO_ORG_ID}`,
      {
        headers: {
          'Authorization': `Zoho-oauthtoken ${access_token}`,
        },
      }
    );

    const userEmail = userResponse.data.users?.[0]?.email || 'unknown@zoho.com';

    // Store tokens in database
    userTokens.set(userEmail, {
      access_token,
      refresh_token,
      api_domain,
      expires_at: Date.now() + expires_in * 1000,
    });

    // Create JWT for frontend
    const jwtToken = jwt.sign(
      { email: userEmail, isAdmin: false },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '24h' }
    );

    // Redirect to frontend with token
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}?token=${jwtToken}`;
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('OAuth callback error:', error.message);
    if (error.response) {
      console.error('Zoho API Response:', error.response.status, error.response.data);
    }
    res.status(500).json({ 
      error: 'Token exchange failed',
      details: error.message,
      zohoError: error.response?.data
    });
  }
});

// 3. Login endpoint for demo users
app.post('/api/auth/login', (req, res) => {
  const { email, password, isAdmin } = req.body;

  // Simple validation (use proper authentication in production)
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  // Create JWT
  const token = jwt.sign(
    { email, isAdmin: isAdmin || false },
    process.env.JWT_SECRET || 'your-secret-key',
    { expiresIn: '24h' }
  );

  res.json({ token });
});

// 4. Refresh Zoho access token
app.post('/api/zoho/refresh-token', authenticateToken, async (req, res) => {
  const { email } = req.user;
  const tokenData = userTokens.get(email);

  if (!tokenData) {
    return res.status(401).json({ error: 'No token found for user' });
  }

  // Check if token is expired
  if (Date.now() < tokenData.expires_at) {
    return res.json({ accessToken: tokenData.access_token });
  }

  try {
    // Refresh the token
    const refreshResponse = await axios.post(
      `${ZOHO_CONFIG.accounts_url}/oauth/v2/token`,
      {
        grant_type: 'refresh_token',
        client_id: ZOHO_CONFIG.client_id,
        client_secret: ZOHO_CONFIG.client_secret,
        refresh_token: tokenData.refresh_token,
      }
    );

    const { access_token, expires_in } = refreshResponse.data;

    // Update stored token
    userTokens.set(email, {
      ...tokenData,
      access_token,
      expires_at: Date.now() + expires_in * 1000,
    });

    res.json({ accessToken: access_token });
  } catch (error) {
    console.error('Token refresh error:', error.message);
    res.status(500).json({ error: 'Failed to refresh token' });
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
    const tokenData = userTokens.get(email);
    if (!tokenData) {
      return res.status(401).json({ error: 'No Zoho token found' });
    }

    // Ensure access token is fresh
    let accessToken = tokenData.access_token;
    if (Date.now() >= tokenData.expires_at) {
      const refreshResponse = await axios.post(
        `${ZOHO_CONFIG.accounts_url}/oauth/v2/token`,
        {
          grant_type: 'refresh_token',
          client_id: ZOHO_CONFIG.client_id,
          client_secret: ZOHO_CONFIG.client_secret,
          refresh_token: tokenData.refresh_token,
        }
      );
      accessToken = refreshResponse.data.access_token;
      userTokens.set(email, {
        ...tokenData,
        access_token: accessToken,
        expires_at: Date.now() + refreshResponse.data.expires_in * 1000,
      });
    }

    // Fetch paid invoices from Zoho Books
    const invoicesResponse = await axios.get(
      `${tokenData.api_domain}/books/v3/invoices`,
      {
        params: {
          organization_id: process.env.ZOHO_ORG_ID,
          status: 'paid',
          'filter_by': 'InvoiceDate.after',
          'filter_value': start,
        },
        headers: {
          'Authorization': `Zoho-oauthtoken ${accessToken}`,
        },
      }
    );

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
    res.status(500).json({ 
      error: 'Failed to fetch commissions',
      details: error.message 
    });
  }
});

// ============================================================================
// COMMISSION CALCULATION LOGIC
// ============================================================================

function calculateCommissions(invoices, user, startDate, endDate) {
  const commissionsMap = new Map();
  const start = new Date(startDate);
  const end = new Date(endDate);

  invoices.forEach((invoice) => {
    const salesRep = invoice.salesperson_name || 'Unassigned';
    
    // If not admin, only show current user's commissions
    if (!user.isAdmin && salesRep !== user.email.split('@')[0]) {
      return;
    }

    // Filter by date range
    const invoiceDate = new Date(invoice.date);
    if (invoiceDate < start || invoiceDate > end) {
      return;
    }

    // Calculate commission for this invoice
    let totalCommission = 0;
    const lineItems = invoice.line_items || [];

    lineItems.forEach((item) => {
      const itemName = item.item_name || '';
      const unitPrice = parseFloat(item.item_price || 0);
      const quantity = parseFloat(item.quantity || 1);
      const itemTotal = unitPrice * quantity;

      // Check if subscription (starts with SUB)
      if (itemName.startsWith('SUB')) {
        // 100% commission on first month only
        // Determine if first month by checking recurring_invoice_id
        // If the invoice was generated from a recurring template AND
        // it's the first occurrence, apply 100% commission
        const isFirstMonth = !invoice.recurring_invoice_id ||
          (invoice.recurring_invoice_id && isFirstInvoiceOfRecurring(invoice));
        
        if (isFirstMonth) {
          totalCommission += itemTotal;
        }
        // else: 0% on renewals
      } else {
        // 10% commission on regular invoices
        totalCommission += itemTotal * 0.1;
      }
    });

    // Aggregate by sales rep
    if (!commissionsMap.has(salesRep)) {
      commissionsMap.set(salesRep, {
        repName: salesRep,
        totalCommission: 0,
        invoiceCount: 0,
        invoices: [],
      });
    }

    const rep = commissionsMap.get(salesRep);
    rep.totalCommission += totalCommission;
    rep.invoiceCount += 1;
    rep.invoices.push({
      id: invoice.invoice_id,
      number: invoice.invoice_number,
      customer: invoice.customer_name,
      amount: invoice.total,
      commission: totalCommission,
      date: invoice.date,
      status: invoice.status,
    });
  });

  return Array.from(commissionsMap.values())
    .sort((a, b) => b.totalCommission - a.totalCommission);
}

// Helper function to determine if this is the first invoice of a recurring series
// In practice, you'd query Zoho to find when the recurring series started
function isFirstInvoiceOfRecurring(invoice) {
  // This is a simplified check
  // In production, compare invoice date with recurring_invoice creation date
  return invoice.invoice_number && 
    invoice.recurring_invoice_id &&
    !invoice.previous_invoice_id;
}

// ============================================================================
// UTILITY ROUTES
// ============================================================================

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Get current user info
app.get('/api/user', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ============================================================================
// SERVER START
// ============================================================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`✅ Commission Tracker API running on http://localhost:${PORT}`);
  console.log(`📚 Zoho Books Organization ID: ${process.env.ZOHO_ORG_ID}`);
  console.log(`🔐 Frontend redirect: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
});

module.exports = app;
