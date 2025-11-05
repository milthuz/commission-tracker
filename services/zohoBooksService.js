// services/zohoBooksService.js
const axios = require('axios');

class ZohoBooksService {
  constructor(accessToken, organizationId) {
    this.accessToken = accessToken;
    this.organizationId = organizationId;
    this.baseURL = 'https://books.zoho.com/api/v3';
  }

  // Get all invoices from Zoho Books
  async getInvoices(params = {}) {
    try {
      const response = await axios.get(`${this.baseURL}/invoices`, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${this.accessToken}`,
        },
        params: {
          organization_id: this.organizationId,
          per_page: params.perPage || 200,
          page: params.page || 1,
          sort_column: params.sortColumn || 'invoice_date',
          sort_order: params.sortOrder || 'D', // D = Descending
          ...params
        }
      });

      return response.data;
    } catch (error) {
      console.error('Error fetching invoices from Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }

  // Get single invoice details
  async getInvoice(invoiceId) {
    try {
      const response = await axios.get(`${this.baseURL}/invoices/${invoiceId}`, {
        headers: {
          'Authorization': `Zoho-oauthtoken ${this.accessToken}`,
        },
        params: {
          organization_id: this.organizationId
        }
      });

      return response.data.invoice;
    } catch (error) {
      console.error('Error fetching invoice from Zoho Books:', error.response?.data || error.message);
      throw error;
    }
  }

  // Determine invoice status based on Zoho data
  determineStatus(invoice) {
    // If invoice is paid
    if (invoice.status === 'paid') {
      return 'paid';
    }

    // If invoice is void or draft
    if (invoice.status === 'void') {
      return 'void';
    }

    if (invoice.status === 'draft') {
      return 'draft';
    }

    // Check if overdue
    const today = new Date();
    const dueDate = new Date(invoice.due_date);
    
    if (dueDate < today && invoice.balance > 0) {
      return 'overdue';
    }

    // Otherwise pending
    return 'pending';
  }

  // Transform Zoho invoice to our database format
  transformInvoice(zohoInvoice) {
    return {
      zoho_invoice_id: zohoInvoice.invoice_id,
      invoice_number: zohoInvoice.invoice_number,
      customer_id: zohoInvoice.customer_id,
      customer_name: zohoInvoice.customer_name,
      invoice_date: zohoInvoice.date,
      due_date: zohoInvoice.due_date,
      total: parseFloat(zohoInvoice.total),
      balance: parseFloat(zohoInvoice.balance),
      status: this.determineStatus(zohoInvoice),
      payment_status: zohoInvoice.payment_made > 0 ? 'partial' : 'unpaid',
      currency_code: zohoInvoice.currency_code,
      notes: zohoInvoice.notes,
      zoho_url: `https://books.zoho.com/app#/invoices/${zohoInvoice.invoice_id}`,
      synced_at: new Date()
    };
  }

  // Get custom fields to find sales rep
  async getCustomFields(invoiceId) {
    try {
      const invoice = await this.getInvoice(invoiceId);
      return invoice.custom_fields || [];
    } catch (error) {
      console.error('Error fetching custom fields:', error.message);
      return [];
    }
  }
}

module.exports = ZohoBooksService;
