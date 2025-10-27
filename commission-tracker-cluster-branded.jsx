import React, { useState, useEffect } from 'react';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { LogOut, LogIn, TrendingUp, Users, DollarSign, RefreshCw, Menu, X } from 'lucide-react';

// ============================================================================
// CLUSTER POS COMMISSION TRACKER
// Branded for Cluster POS - Restaurant Software Company
// Colors: Cluster Blue (#1E40AF / #2563EB), Cluster Green (#059669 / #10B981)
// ============================================================================

const CommissionTracker = () => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [commissions, setCommissions] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [dateRange, setDateRange] = useState({ start: '2025-01-01', end: '2025-12-31' });
  const [filter, setFilter] = useState('all');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // ========== AUTHENTICATION ==========
  const handleLogin = async (email, password, isAdmin = false) => {
    setLoading(true);
    try {
      const userData = {
        email,
        name: email.split('@')[0],
        isAdmin,
        zohoOrgId: process.env.REACT_APP_ZOHO_ORG_ID,
      };
      localStorage.setItem('user', JSON.stringify(userData));
      setUser(userData);
      await fetchCommissions(userData);
    } catch (error) {
      console.error('Login failed:', error);
      alert('Login failed. Please check credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('user');
    localStorage.removeItem('zoho_access_token');
    setUser(null);
    setCommissions([]);
  };

  // ========== ZOHO BOOKS API ==========
  const fetchInvoices = async (user) => {
    const token = localStorage.getItem('zoho_access_token');
    try {
      const response = await fetch(
        `https://www.zohoapis.com/books/v3/invoices?status=paid&organization_id=${user.zohoOrgId}`,
        {
          headers: {
            'Authorization': `Zoho-oauthtoken ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );
      if (!response.ok) throw new Error(`Zoho API error: ${response.status}`);
      const data = await response.json();
      return data.invoices || [];
    } catch (error) {
      console.error('Failed to fetch invoices:', error);
      return [];
    }
  };

  const fetchCommissions = async (userData) => {
    setRefreshing(true);
    try {
      const invoices = await fetchInvoices(userData);
      const calculated = calculateCommissions(invoices, userData);
      setCommissions(calculated);
    } catch (error) {
      console.error('Error fetching commissions:', error);
    } finally {
      setRefreshing(false);
    }
  };

  // ========== COMMISSION CALCULATION ==========
  const calculateCommissions = (invoices, userData) => {
    const commissionsMap = new Map();

    invoices.forEach((invoice) => {
      const salesRep = invoice.salesperson_name || 'Unassigned';
      if (!userData.isAdmin && salesRep !== userData.name) return;

      const invoiceDate = new Date(invoice.date);
      const startDate = new Date(dateRange.start);
      const endDate = new Date(dateRange.end);
      if (invoiceDate < startDate || invoiceDate > endDate) return;

      let commission = 0;
      const lineItems = invoice.line_items || [];

      lineItems.forEach((item) => {
        const itemName = item.item_name || '';
        const itemAmount = parseFloat(item.item_price || 0) * parseFloat(item.quantity || 1);

        if (itemName.startsWith('SUB')) {
          const isFirstMonth = !invoice.recurring_invoice_id || invoice.date === invoice.first_invoice_date;
          commission += isFirstMonth ? itemAmount : 0;
        } else {
          commission += itemAmount * 0.1;
        }
      });

      if (!commissionsMap.has(salesRep)) {
        commissionsMap.set(salesRep, {
          name: salesRep,
          commission: 0,
          invoiceCount: 0,
          invoices: [],
        });
      }

      const rep = commissionsMap.get(salesRep);
      rep.commission += commission;
      rep.invoiceCount += 1;
      rep.invoices.push({
        id: invoice.invoice_id,
        number: invoice.invoice_number,
        amount: invoice.total,
        commission,
        date: invoice.date,
        customer: invoice.customer_name,
      });
    });

    return Array.from(commissionsMap.values()).sort((a, b) => b.commission - a.commission);
  };

  // ========== CALCULATE DASHBOARD STATS ==========
  const getStats = () => {
    const filteredReps = filter === 'all' ? commissions : commissions.filter(r => r.name === filter);
    return {
      totalCommission: filteredReps.reduce((sum, r) => sum + r.commission, 0),
      topRep: filteredReps[0] || { name: 'N/A', commission: 0 },
      repCount: commissions.length,
      avgCommission: commissions.length ? commissions.reduce((sum, r) => sum + r.commission, 0) / commissions.length : 0,
    };
  };

  // ========== LOGIN SCREEN ==========
  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-slate-100 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl p-8 max-w-md w-full border-t-4 border-blue-600">
          {/* Cluster Logo Area */}
          <div className="flex items-center justify-center mb-8">
            <div className="w-12 h-12 bg-gradient-to-br from-blue-600 to-blue-700 rounded-lg flex items-center justify-center mr-3">
              <TrendingUp className="w-6 h-6 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-900">Cluster Sales</h1>
          </div>
          <p className="text-center text-slate-500 text-sm mb-8 font-medium">Commission Tracker</p>

          <LoginForm onLogin={handleLogin} isLoading={loading} />

          <div className="mt-8 pt-8 border-t border-slate-200">
            <p className="text-xs text-slate-600 text-center mb-4 font-semibold uppercase tracking-wide">Demo Credentials</p>
            <div className="space-y-3 text-sm">
              <button
                onClick={() => handleLogin('demo@example.com', 'pass123', false)}
                className="w-full py-2.5 px-3 bg-gradient-to-r from-blue-50 to-blue-100 text-blue-700 rounded-lg hover:from-blue-100 hover:to-blue-200 text-left font-medium border border-blue-200 transition"
              >
                👤 Sales Rep Demo
              </button>
              <button
                onClick={() => handleLogin('admin@example.com', 'admin123', true)}
                className="w-full py-2.5 px-3 bg-gradient-to-r from-green-50 to-green-100 text-green-700 rounded-lg hover:from-green-100 hover:to-green-200 text-left font-medium border border-green-200 transition"
              >
                👨‍💼 Admin Demo
              </button>
            </div>
          </div>

          <p className="text-xs text-slate-400 text-center mt-6">Powered by Cluster POS</p>
        </div>
      </div>
    );
  }

  // ========== MAIN DASHBOARD ==========
  const stats = getStats();
  const chartData = commissions.map(rep => ({
    name: rep.name.split(' ')[0],
    commission: parseFloat(rep.commission.toFixed(2)),
  }));

  const CLUSTER_BLUE = '#2563EB';
  const CLUSTER_GREEN = '#059669';
  const CHART_COLORS = [CLUSTER_BLUE, CLUSTER_GREEN, '#0EA5E9', '#7C3AED', '#DB2777'];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div className="w-10 h-10 bg-gradient-to-br from-blue-600 to-blue-700 rounded-lg flex items-center justify-center mr-3">
                <TrendingUp className="w-5 h-5 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-900">Cluster Sales Commission</h1>
                <p className="text-xs text-slate-500">
                  {user.isAdmin ? '🏢 Admin Dashboard' : `👤 ${user.name}`}
                </p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="flex items-center px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 font-medium transition"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Controls */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6 mb-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">Start Date</label>
              <input
                type="date"
                value={dateRange.start}
                onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">End Date</label>
              <input
                type="date"
                value={dateRange.end}
                onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
            {user.isAdmin && (
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-2">Filter Rep</label>
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="all">All Reps</option>
                  {commissions.map(rep => (
                    <option key={rep.name} value={rep.name}>{rep.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-end">
              <button
                onClick={() => fetchCommissions(user)}
                disabled={refreshing}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-slate-400 flex items-center justify-center font-medium transition"
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
                {refreshing ? 'Loading...' : 'Refresh'}
              </button>
            </div>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-5 mb-8">
          <StatCard
            title="Total Commission"
            value={`$${stats.totalCommission.toFixed(2)}`}
            icon="💰"
            bgGradient="from-blue-500 to-blue-600"
            bgLight="bg-blue-50"
            textColor="text-blue-600"
          />
          <StatCard
            title="Top Performer"
            value={stats.topRep.name}
            subtitle={`$${stats.topRep.commission.toFixed(2)}`}
            icon="🏆"
            bgGradient="from-green-500 to-green-600"
            bgLight="bg-green-50"
            textColor="text-green-600"
          />
          <StatCard
            title="Active Reps"
            value={stats.repCount}
            icon="👥"
            bgGradient="from-purple-500 to-purple-600"
            bgLight="bg-purple-50"
            textColor="text-purple-600"
          />
          <StatCard
            title="Average Commission"
            value={`$${stats.avgCommission.toFixed(2)}`}
            icon="📊"
            bgGradient="from-cyan-500 to-cyan-600"
            bgLight="bg-cyan-50"
            textColor="text-cyan-600"
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* Bar Chart */}
          <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Commission by Rep</h3>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} style={{ fontSize: '12px' }} />
                <YAxis style={{ fontSize: '12px' }} />
                <Tooltip formatter={(value) => `$${value.toFixed(2)}`} contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0' }} />
                <Bar dataKey="commission" fill={CLUSTER_BLUE} radius={[8, 8, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Line Chart */}
          <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-4">Cumulative Trend</h3>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} style={{ fontSize: '12px' }} />
                <YAxis style={{ fontSize: '12px' }} />
                <Tooltip formatter={(value) => `$${value.toFixed(2)}`} contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0' }} />
                <Line type="monotone" dataKey="commission" stroke={CLUSTER_GREEN} strokeWidth={3} dot={{ fill: CLUSTER_GREEN, r: 4 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Detailed Table */}
        <div className="bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100">
            <h3 className="text-lg font-bold text-slate-900">Commission Details</h3>
            <p className="text-xs text-slate-600 mt-1">{commissions.length} active sales representatives</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Rep Name</th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Invoices</th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Commission</th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Avg/Invoice</th>
                  <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {commissions.map((rep, idx) => (
                  <tr key={rep.name} className="hover:bg-slate-50 transition">
                    <td className="px-6 py-4 text-sm font-semibold text-slate-900">{rep.name}</td>
                    <td className="px-6 py-4 text-sm text-slate-600">{rep.invoiceCount}</td>
                    <td className="px-6 py-4 text-sm font-bold text-blue-600">
                      ${rep.commission.toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-600">
                      ${(rep.commission / rep.invoiceCount).toFixed(2)}
                    </td>
                    <td className="px-6 py-4 text-sm">
                      <details className="cursor-pointer">
                        <summary className="text-blue-600 hover:text-blue-800 font-medium">View</summary>
                        <div className="mt-3 bg-slate-50 p-3 rounded-lg text-xs max-h-48 overflow-y-auto border border-slate-200">
                          {rep.invoices.map(inv => (
                            <div key={inv.id} className="py-2 border-b border-slate-200 last:border-0">
                              <div className="font-semibold text-slate-900">{inv.number} • {inv.customer}</div>
                              <div className="text-slate-600 text-xs mt-1">
                                Amount: ${inv.amount.toFixed(2)} | Commission: ${inv.commission.toFixed(2)}
                              </div>
                              <div className="text-slate-500 text-xs mt-1">{inv.date}</div>
                            </div>
                          ))}
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {commissions.length === 0 && (
              <div className="p-8 text-center text-slate-500">
                <p className="font-medium">No commissions found for the selected period.</p>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mt-8 py-6 border-t border-slate-200 text-center text-xs text-slate-500">
          <p>Cluster POS Commission Tracking • Real-time Zoho Books Integration</p>
        </div>
      </main>
    </div>
  );
};

// ============================================================================
// COMPONENTS
// ============================================================================

const LoginForm = ({ onLogin, isLoading }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onLogin(email, password, false);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-semibold text-slate-700 mb-2">
          Email Address
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-semibold text-slate-700 mb-2">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          className="w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
        />
      </div>
      <button
        type="submit"
        disabled={isLoading}
        className="w-full px-4 py-2.5 bg-gradient-to-r from-blue-600 to-blue-700 text-white rounded-lg hover:from-blue-700 hover:to-blue-800 disabled:from-slate-400 disabled:to-slate-500 font-semibold flex items-center justify-center transition shadow-md hover:shadow-lg"
      >
        <LogIn className="w-4 h-4 mr-2" />
        {isLoading ? 'Signing In...' : 'Sign In'}
      </button>
    </form>
  );
};

const StatCard = ({ title, value, subtitle, icon, bgGradient, bgLight, textColor }) => (
  <div className={`${bgLight} rounded-lg p-6 border border-slate-200 hover:shadow-md transition`}>
    <div className="flex items-center justify-between">
      <div>
        <p className="text-xs font-semibold text-slate-600 mb-1 uppercase tracking-wide">{title}</p>
        <p className={`text-3xl font-bold ${textColor}`}>{value}</p>
        {subtitle && <p className="text-xs text-slate-600 mt-2 font-medium">{subtitle}</p>}
      </div>
      <div className={`w-12 h-12 bg-gradient-to-br ${bgGradient} rounded-lg flex items-center justify-center text-2xl shadow-lg`}>
        {icon}
      </div>
    </div>
  </div>
);

export default CommissionTracker;
