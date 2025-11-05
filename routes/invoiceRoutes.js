// routes/invoiceRoutes.js
const express = require('express');
const router = express.Router();
const invoiceController = require('../controllers/invoiceController');
const { authenticateToken } = require('../middleware/auth');

// All routes require authentication
router.use(authenticateToken);

// Sync invoices from Zoho Books
router.post('/sync', invoiceController.syncInvoices);

// Get all invoices with filters
router.get('/', invoiceController.getInvoices);

// Get invoice statistics
router.get('/stats', invoiceController.getInvoiceStats);

module.exports = router;
