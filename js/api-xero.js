/**
 * BizOps · Xero API
 * All Xero calls go through the Netlify proxy (no secrets in browser).
 *
 * Bug fixes applied:
 *  1. All API calls route to CONFIG.API.XERO proxy (not direct Xero URLs)
 *  2. getHeaders() sends X-Access-Token (proxy expectation), not Authorization
 *  3. Tenant ID read from sessionStorage (set during OAuth callback)
 *  4. startOAuthFlow() fetches CLIENT_ID from server, opens popup (not redirect)
 *  5. postMessage listener stores tokens in localStorage via Store
 *     (fixes broken token storage — callback popup → main app)
 */

const XeroAPI = (() => {

  const delay = ms => new Promise(r => setTimeout(r, ms));

  // Cache for pay item ID lookups (avoid repeated API calls per session)
  let _payItemsCache = null;

  // ── Token helpers ─────────────────────────────

  function getAccessToken() {
    return Store.getXeroTokens()?.access_token || null;
  }

  function getRefreshToken() {
    return Store.getXeroTokens()?.refresh_token || null;
  }

  function isTokenExpired() {
    const tokens = Store.getXeroTokens();
    if (!tokens) return true;
    return Date.now() > (tokens.savedAt + tokens.expires_in * 1000) - 60_000; // 1 min buffer
  }

  async function ensureFreshToken() {
    if (!isTokenExpired()) return;
    const rt = getRefreshToken();
    if (!rt) throw new Error('Xero session expired — please reconnect in Settings');
    try {
      const res = await fetch(CONFIG.API.XERO_AUTH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh', refresh_token: rt }),
      });
      if (!res.ok) throw new Error('Token refresh failed');
      const data = await res.json();
      Store.saveXeroTokens(data);
    } catch (e) {
      Store.clearXeroTokens();
      throw new Error('Xero reconnection required — go to Settings → Connect Xero');
    }
  }

  // ── Proxy fetch ───────────────────────────────

  /**
   * Make a Xero API call through the Netlify proxy.
   * @param {string} endpoint  e.g. '/Invoices'
   * @param {object} options   fetch options (method, body, etc.)
   * @param {boolean} payroll  true for payroll.xro endpoints
   * @param {object} queryParams  additional URL params for Xero
   */
  async function proxyFetch(endpoint, options = {}, payroll = false, queryParams = {}) {
    await ensureFreshToken();

    const token = getAccessToken();
    if (!token) throw new Error('Not connected to Xero — go to Settings → Connect Xero');

    const qs = new URLSearchParams({
      endpoint,
      ...(payroll ? { payroll: 'true' } : {}),
      ...queryParams,
    });

    const res = await fetch(`${CONFIG.API.XERO}?${qs}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type':    'application/json',
        'X-Access-Token':  token,
        'X-Refresh-Token': getRefreshToken() || '',
      },
      body: options.body || undefined,
    });

    // Handle token auto-refresh from proxy response headers
    const newAccessToken  = res.headers.get('X-New-Access-Token');
    const newRefreshToken = res.headers.get('X-New-Refresh-Token');
    const newExpiresIn    = res.headers.get('X-New-Expires-In');
    if (newAccessToken) {
      Store.saveXeroTokens({
        access_token:  newAccessToken,
        refresh_token: newRefreshToken || getRefreshToken(),
        expires_in:    parseInt(newExpiresIn || '1800'),
      });
    }

    if (!res.ok) {
      let msg = `Xero API error ${res.status}`;
      try { const e = await res.json(); msg = e.error || e.message || msg; } catch {}
      throw new Error(msg);
    }

    return res.json();
  }

  // ── OAuth flow ────────────────────────────────

  /**
   * Redirects the whole page to Xero OAuth.
   * Using full-page redirect (not a popup) so that iOS PWA localStorage
   * is shared between the auth callback page and the main app.
   */
  async function startOAuthFlow() {
    try {
      const r = await fetch(CONFIG.API.XERO_CLIENT_ID);
      if (!r.ok) throw new Error('Could not fetch Xero client ID — check XERO_CLIENT_ID env var');
      const { client_id } = await r.json();

      const state = crypto.randomUUID();
      localStorage.setItem('bizops_xero_state', state);

      // Back up the PIN session to localStorage so it survives the redirect
      // (sessionStorage is cleared on navigation; localStorage persists)
      const sessionBackup = {
        token:  sessionStorage.getItem('bizops_session_token'),
        expiry: sessionStorage.getItem('bizops_session_expiry'),
        role:   sessionStorage.getItem('bizops_session_role'),
      };
      if (sessionBackup.token) {
        localStorage.setItem('bizops_session_backup', JSON.stringify(sessionBackup));
      }

      const params = new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri:  CONFIG.XERO.REDIRECT_URI,
        scope:         CONFIG.XERO.SCOPES,
        state,
      });

      window.location.href =
        `https://login.xero.com/identity/connect/authorize?${params}`;
    } catch (e) {
      if (window.App) App.toast('Xero: ' + e.message, 'error');
    }
  }

  /**
   * Called on app boot — checks if we just returned from Xero OAuth.
   * xero-callback.html writes tokens directly to localStorage then
   * redirects here with ?xero_connected=1.
   */
  function checkOAuthReturn() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('xero_connected') !== '1') return;

    // Restore the PIN session that was backed up before the Xero redirect
    try {
      const backup = localStorage.getItem('bizops_session_backup');
      if (backup) {
        const { token, expiry, role } = JSON.parse(backup);
        if (token) {
          sessionStorage.setItem('bizops_session_token', token);
          sessionStorage.setItem('bizops_session_expiry', expiry);
          sessionStorage.setItem('bizops_session_role',   role);
        }
        localStorage.removeItem('bizops_session_backup');
      }
    } catch (_) {}

    // Tokens were already written to localStorage by xero-callback.html
    const org = params.get('org') ? decodeURIComponent(params.get('org')) : '';
    history.replaceState({}, '', '/');

    // Show toast + refresh settings after App is fully booted (called at end of boot)
    setTimeout(() => {
      if (window.App) {
        App.toast(`Xero connected${org ? ' · ' + org : ''}`, 'success');
        App.refreshSettings?.();
      }
      if (window.Dashboard) Dashboard.refresh();
    }, 500);
  }

  // Keep for backward compatibility — no-op now that we use redirect flow
  function setupCallbackListener() {}

  function isConnected() {
    if (CONFIG.FEATURES.DEMO_MODE) return true;
    const tokens = Store.getXeroTokens();
    if (!tokens) return false;
    return !isTokenExpired();
  }

  // ── Demo data ─────────────────────────────────

  function demoBills() {
    return [
      { id: 'bill_1', supplier: 'Metro Meats Pty Ltd',  amount: 528.00, gst: 48.00, dueDate: '2025-06-15', status: 'DRAFT',      invoiceNo: 'MM-2024-601', category: 'Food & Beverage' },
      { id: 'bill_2', supplier: 'Coastal Produce Co',   amount: 312.50, gst: 28.40, dueDate: '2025-06-12', status: 'AUTHORISED', invoiceNo: 'CP-8842',     category: 'Food & Beverage' },
      { id: 'bill_3', supplier: 'Clean Co Linen',       amount: 195.00, gst: 17.72, dueDate: '2025-06-08', status: 'DRAFT',      invoiceNo: 'CCL-0419',    category: 'Supplies'        },
      { id: 'bill_4', supplier: 'Brisbane Gas Co',      amount: 420.00, gst: 38.18, dueDate: '2025-06-20', status: 'DRAFT',      invoiceNo: 'BGC-115522',  category: 'Overhead'       },
    ];
  }

  function demoPayItems() {
    return [
      { id: 'rate_01', name: 'Casual Level 1 - Weekday' },
      { id: 'rate_02', name: 'Level 1 Adult - Weekday' },
      { id: 'rate_03', name: 'Junior Level 1 - Weekday' },
      { id: 'rate_04', name: 'Level 2 Adult - Weekday' },
      { id: 'rate_05', name: 'Weekend Penalty Rate Casual' },
      { id: 'rate_06', name: 'Weekend Penalty Rate Part-Time' },
      { id: 'rate_07', name: 'Junior Weekend Penalty Rate' },
      { id: 'rate_08', name: 'Sunday Penalty Rate L2' },
      { id: 'rate_09', name: 'Weekend Penalty Rate L2' },
      { id: 'rate_10', name: 'Public Holiday Rate Casual' },
      { id: 'rate_11', name: 'Public Holiday Rate Part-Time' },
      { id: 'rate_12', name: 'Junior Public Holiday Rate' },
      { id: 'rate_13', name: 'Public Holiday Rate L2' },
    ];
  }

  function demoOverhead() {
    // Simulated 12-week average overhead breakdown (ex wages, ex super)
    return {
      weeklyAverage: 1842.50,
      total12Weeks:  22110.00,
      breakdown: [
        { name: 'Rent',               weekly: 750.00  },
        { name: 'Utilities',          weekly: 312.50  },
        { name: 'Packaging',          weekly: 285.00  },
        { name: 'Cleaning Supplies',  weekly: 145.00  },
        { name: 'Licences & Permits', weekly: 95.00   },
        { name: 'Insurance',          weekly: 115.00  },
        { name: 'Repairs & Maint.',   weekly: 80.00   },
        { name: 'Other',              weekly: 60.00   },
      ],
      fromDate: '2025-03-03',
      toDate:   '2025-05-25',
      note:     'Demo data — connect Xero to see real figures',
    };
  }

  // ── Bills ─────────────────────────────────────

  async function getDraftBills() {
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(700); return demoBills(); }

    const data = await proxyFetch('/Invoices', {}, false, {
      Type:     'ACCPAY',
      Statuses: 'DRAFT,AUTHORISED',
      order:    'DueDate',
    });

    return (data.Invoices || []).map(inv => ({
      id:        inv.InvoiceID,
      supplier:  inv.Contact?.Name,
      amount:    inv.Total,
      gst:       inv.TotalTax,
      dueDate:   xeroDateToISO(inv.DueDate),
      status:    inv.Status,
      invoiceNo: inv.InvoiceNumber,
    }));
  }

  async function createDraftBill(invoiceData) {
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(1000); return { id: 'demo_' + Date.now(), status: 'DRAFT', ...invoiceData }; }

    const payload = {
      Type: 'ACCPAY',
      Status: 'DRAFT',
      Contact:       { Name: invoiceData.supplier },
      InvoiceNumber: invoiceData.invoiceNo,
      Date:          invoiceData.invoiceDate,
      LineItems: [{
        Description: invoiceData.description || 'Supplier invoice',
        Quantity:    1,
        UnitAmount:  invoiceData.subtotal,
        TaxType:     'INPUT',
        AccountCode: '310', // default COGS — manager codes in Xero
      }],
      Reference: invoiceData.invoiceNo,
    };

    const data = await proxyFetch('/Invoices', {
      method: 'PUT',
      body:   JSON.stringify({ Invoices: [payload] }),
    });

    return data.Invoices?.[0];
  }

  // ── Pay items ─────────────────────────────────

  /** Returns [{ id, name }] — IDs are Xero EarningsRateIDs (UUIDs). */
  async function getPayItemsWithIds() {
    if (_payItemsCache) return _payItemsCache;
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(500); _payItemsCache = demoPayItems(); return _payItemsCache; }

    const data  = await proxyFetch('/PayItems', {}, true); // payroll endpoint
    const rates = data.PayItems?.EarningsRates || [];
    _payItemsCache = rates.map(r => ({ id: r.EarningsRateID, name: r.Name }));
    return _payItemsCache;
  }

  /** Returns just the names (for staff mapping UI). */
  async function getPayRates() {
    const items = await getPayItemsWithIds();
    return items.map(i => i.name);
  }

  // ── Timesheets ────────────────────────────────

  /**
   * Push a complete week of timesheets to Xero.
   * Splits each employee's hours by day type and routes to the correct
   * Xero payroll category (Weekday / Weekend / Sunday / Public holiday).
   *
   * @param {string}   weekStart      ISO date, e.g. '2025-06-16'
   * @param {Array}    timesheetData  output of SquareAPI.getWeekTimesheets()
   * @param {Function} onProgress     (name, 'sending'|'done'|'error') callback
   */
  async function pushTimesheets(weekStart, timesheetData, onProgress) {
    const weekEnd = Holidays.getWeekEnd(weekStart);
    const settings = Store.getSettings();

    // Build name → EarningsRateID map once per push
    let nameToId = {};
    if (!CONFIG.FEATURES.DEMO_MODE) {
      const items = await getPayItemsWithIds();
      nameToId = Object.fromEntries(items.map(i => [i.name, i.id]));
    }

    const results = [];

    for (const ts of timesheetData) {
      const staffMember = Store.getStaff().find(s => s.id === ts.staffId);
      if (!staffMember) continue;

      if (onProgress) onProgress(staffMember.name, 'sending');

      if (CONFIG.FEATURES.DEMO_MODE) {
        await delay(400);
        results.push({ staffId: ts.staffId, name: ts.name, status: 'ok' });
        if (onProgress) onProgress(staffMember.name, 'done');
        continue;
      }

      // Group hours by pay category
      const categoryHours = {};
      for (const shift of ts.shifts) {
        const { category } = Holidays.getXeroCategoryForShift(
          shift.date, staffMember, settings.ekkaBrisbane
        );
        if (!categoryHours[category]) categoryHours[category] = 0;
        categoryHours[category] += shift.hours;
      }

      // Look up EarningsRateIDs
      const lines = [];
      for (const [rateName, hours] of Object.entries(categoryHours)) {
        const rateId = nameToId[rateName];
        if (!rateId) {
          results.push({
            staffId: ts.staffId,
            name:    ts.name,
            status:  'error',
            error:   `Pay rate not found in Xero: "${rateName}" — check Staff mapping`,
          });
          if (onProgress) onProgress(staffMember.name, 'error');
          continue;
        }
        lines.push({
          EarningsRateID: rateId,
          NumberOfUnits:  parseFloat(hours.toFixed(2)),
        });
      }

      if (!lines.length) continue;

      const payload = {
        Timesheets: [{
          EmployeeID:     staffMember.xeroEmployeeId,
          StartDate:      weekStart,
          EndDate:        weekEnd,
          Status:         'DRAFT',
          TimesheetLines: lines,
        }],
      };

      try {
        await proxyFetch('/Timesheets', {
          method: 'POST',
          body:   JSON.stringify(payload),
        }, true); // payroll endpoint

        results.push({ staffId: ts.staffId, name: ts.name, status: 'ok' });
        if (onProgress) onProgress(staffMember.name, 'done');
      } catch (err) {
        results.push({ staffId: ts.staffId, name: ts.name, status: 'error', error: err.message });
        if (onProgress) onProgress(staffMember.name, 'error');
      }
    }

    return results;
  }

  // ── 12-week overhead average ──────────────────

  // Account name fragments to exclude (wages + super)
  const WAGE_SUPER_KEYWORDS = [
    'wage', 'salary', 'salaries', 'superannuation', 'super annuation',
    'super ', 'payroll', 'leave loading', 'annual leave', 'sick leave',
    'long service', 'workers comp', 'workcover',
  ];

  function isWageOrSuper(accountName) {
    const lower = (accountName || '').toLowerCase();
    return WAGE_SUPER_KEYWORDS.some(kw => lower.includes(kw));
  }

  /**
   * Fetches the Xero P&L for the 12 weeks prior to the current week
   * and returns a summary excluding wages and superannuation accounts.
   *
   * @param {string} currentWeekStart  ISO date of Monday this week
   * @returns {{ weeklyAverage, total12Weeks, breakdown, fromDate, toDate }}
   */
  async function getOverheadAverage(currentWeekStart) {
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(900); return demoOverhead(); }

    // Date range: 12 weeks ending the day before current week
    const toDate = new Date(currentWeekStart + 'T12:00:00');
    toDate.setDate(toDate.getDate() - 1);
    const fromDate = new Date(toDate);
    fromDate.setDate(fromDate.getDate() - 83); // 84 days = 12 weeks

    const from = fromDate.toISOString().slice(0, 10);
    const to   = toDate.toISOString().slice(0, 10);

    const data = await proxyFetch('/Reports/ProfitAndLoss', {}, false, {
      fromDate: from,
      toDate:   to,
    });

    const report = data?.Reports?.[0];
    if (!report) throw new Error('No P&L data returned from Xero');

    // Extract expense rows
    const expenseSection = report.Rows?.find(
      r => r.RowType === 'Section' && /expense/i.test(r.Title || '')
    );
    if (!expenseSection) return { weeklyAverage: 0, total12Weeks: 0, breakdown: [], from, to };

    const breakdown = [];
    let total12Weeks = 0;

    for (const row of expenseSection.Rows || []) {
      if (row.RowType !== 'Row') continue;
      const name   = row.Cells?.[0]?.Value || '';
      const amount = parseFloat(row.Cells?.[1]?.Value || '0');
      if (isWageOrSuper(name)) continue;
      if (!amount) continue;
      breakdown.push({ name, total: amount, weekly: parseFloat((amount / 12).toFixed(2)) });
      total12Weeks += amount;
    }

    breakdown.sort((a, b) => b.total - a.total);

    return {
      weeklyAverage: parseFloat((total12Weeks / 12).toFixed(2)),
      total12Weeks:  parseFloat(total12Weeks.toFixed(2)),
      breakdown,
      fromDate: from,
      toDate:   to,
    };
  }

  // ── Helpers ───────────────────────────────────

  /** Convert Xero /Date(ms)/ or ISO string to YYYY-MM-DD */
  function xeroDateToISO(xeroDate) {
    if (!xeroDate) return null;
    if (xeroDate.startsWith('/Date(')) {
      const ms = parseInt(xeroDate.replace(/\/Date\((-?\d+)[\+\-]?\d*\)\//, '$1'));
      return new Date(ms).toISOString().slice(0, 10);
    }
    return xeroDate.slice(0, 10);
  }

  return {
    setupCallbackListener,
    startOAuthFlow,
    checkOAuthReturn,
    isConnected,
    getDraftBills,
    createDraftBill,
    getPayRates,
    getPayItemsWithIds,
    pushTimesheets,
    getOverheadAverage,
  };

})();
