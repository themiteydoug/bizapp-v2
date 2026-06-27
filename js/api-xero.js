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
  let _payInfoCache  = null;   // employee pay info (base rate / level / salary)

  // ── Award rates (Fast Food Award) ─────────────
  // Multiplier × the employee's ordinary base rate, plus the Xero earnings-rate
  // name to push hours against, keyed by employment type → level → day type.
  // Current roster is all Casual Level 1; PT/FT and Level 2+ (which split the
  // weekend into separate Sat/Sun rates) can be added here when needed.
  const AWARD = {
    casual: {
      1: {
        weekday:        { mult: 1.25, rate: 'Casual Level 1' },
        saturday:       { mult: 1.5,  rate: 'Weekend Penalty Rate Casual' },
        sunday:         { mult: 1.5,  rate: 'Weekend Penalty Rate Casual' },
        public_holiday: { mult: 2.5,  rate: 'Public Holiday Casual' },
      },
    },
  };

  function awardRule(employmentType, level, dayType) {
    const byLevel = (AWARD[employmentType] || AWARD.casual);
    const rules   = byLevel[level] || byLevel[1];
    return rules[dayType] || rules.weekday;
  }

  function normalizeName(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

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
      try {
        const e = await res.json();
        // Surface whichever field carries the real cause — our proxy uses
        // lowercase error/detail; Xero's own errors use Detail/Message/Title.
        msg = e.error || e.detail || e.Detail || e.Message || e.Title || msg;
        console.error(`[Xero proxy] ${endpoint} → ${res.status}`, e);
      } catch {}
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
    // Simulated financial-year-to-date weekly average overhead (ex wages, incl super)
    return {
      weeklyAverage: 1842.50,
      total:         93967.50,
      weeks:         51.0,
      fromDate: '2025-07-01',
      toDate:   '2026-06-21',
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

    // Editing an existing bill: include its InvoiceID and POST to update it
    // instead of PUT (which would create a duplicate).
    if (invoiceData.xeroId) payload.InvoiceID = invoiceData.xeroId;

    const data = await proxyFetch('/Invoices', {
      method: invoiceData.xeroId ? 'POST' : 'PUT',
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

  /**
   * DISCOVERY: pull the raw Xero payroll data so we can verify what's there
   * before wiring up wage logic. Returns:
   *   earningsRates: every pay item with its rate type / multiplier / fixed rate
   *   employees:     each employee's employment basis + base (ordinary) hourly rate
   */
  async function inspectPayroll() {
    // 1. Earnings rates (pay items)
    const payData = await proxyFetch('/PayItems', {}, true);
    const earningsRates = (payData.PayItems?.EarningsRates || []).map(r => ({
      name:         r.Name,
      id:           r.EarningsRateID,
      rateType:     r.RateType,          // RatePerUnit | MultipleOfOrdinaryEarningsRate | FixedAmount
      ratePerUnit:  r.RatePerUnit,       // fixed $/unit (when RateType=RatePerUnit)
      multiplier:   r.Multiplier,        // e.g. 1.25, 1.5, 2.5 (when MultipleOfOrdinary…)
      earningsType: r.EarningsType,      // OrdinaryTimeEarnings | OvertimeEarnings | …
      unitType:     r.TypeOfUnits,
    }));

    const rateById = Object.fromEntries(earningsRates.map(r => [r.id, r]));

    // 2. Employees + base rate. The base rate may sit on the employee's pay-
    // template earnings line OR (if not overridden) on the ordinary earnings
    // rate itself — try both. Capture the first raw detail for structure check.
    const empList = (await proxyFetch('/Employees', {}, true)).Employees || [];
    // Capture one full raw detail for an hourly and a salaried employee so we
    // can see the exact field that marks casual/PT/FT and where salary lives.
    let rawHourly = null, rawSalaried = null;
    // Fetch detail SEQUENTIALLY — Xero caps concurrency (~5), and firing all
    // at once silently drops the overflow (leaving base rates blank).
    const employees = [];
    for (const e of empList) {
      let baseRate = null, ordinaryName = null, annualSalary = null, hoursPerWeek = null;
      let basis = e.EmploymentBasis || e.EmploymentType || null;
      try {
        const detail = (await proxyFetch(`/Employees/${e.EmployeeID}`, {}, true)).Employees?.[0] || null;
        if (detail) {
          basis = detail.EmploymentBasis || basis;
          const ordId = detail.OrdinaryEarningsRateID;
          const lines = detail.PayTemplate?.EarningsLines || [];
          const ordLine = lines.find(l => l.EarningsRateID === ordId) || lines[0];
          baseRate     = ordLine?.RatePerUnit ?? rateById[ordId]?.ratePerUnit ?? null;
          annualSalary = ordLine?.AnnualSalary ?? null;          // salaried staff
          hoursPerWeek = ordLine?.NumberOfUnitsPerWeek ?? null;
          ordinaryName = rateById[ordId]?.name
            ?? (ordLine && rateById[ordLine.EarningsRateID]?.name) ?? null;
          if (baseRate != null && !rawHourly)   rawHourly   = detail;
          if ((annualSalary || 0) > 0 && !rawSalaried) rawSalaried = detail;
        }
      } catch (err) {
        console.warn('[Xero payroll] detail failed for', e.EmployeeID, err.message);
      }
      // Salaried (annual salary set) → no push; hourly (base rate) → push.
      const salaried   = (annualSalary || 0) > 0;
      const weeklyCost = salaried ? Math.round((annualSalary / 52) * 100) / 100 : null;
      const lvl        = (ordinaryName || '').match(/level\s*([0-9]+)/i);
      const level      = lvl ? parseInt(lvl[1], 10) : null;
      const payType    = salaried ? 'Salaried · no push'
        : (baseRate != null ? 'Hourly · push' : 'Unknown');
      employees.push({
        name:  `${e.FirstName || ''} ${e.LastName || ''}`.trim() || e.EmployeeID,
        id:    e.EmployeeID,
        basis, baseRate, ordinaryName, payType, annualSalary, weeklyCost, level,
      });
    }

    const rawRate = (payData.PayItems?.EarningsRates || [])[0] || null;
    const rawEmp  = { hourly: rawHourly, salaried: rawSalaried };

    console.log('[Xero payroll] earnings rates:', earningsRates);
    console.log('[Xero payroll] employees:', employees);
    console.log('[Xero payroll] RAW sample rate:', rawRate);
    console.log('[Xero payroll] RAW hourly employee:', rawHourly);
    console.log('[Xero payroll] RAW salaried employee:', rawSalaried);
    return { earningsRates, employees, raw: { rate: rawRate, employee: rawEmp } };
  }

  // ── Employee pay info (for wage calc) ─────────

  /**
   * Cached map of employee → { baseRate, level, salaried, weeklyCost, … }
   * keyed by normalized name, plus the earnings-rate name→id map for pushing.
   */
  async function getEmployeePayInfo(force) {
    if (_payInfoCache && !force) return _payInfoCache;
    if (CONFIG.FEATURES.DEMO_MODE) { _payInfoCache = { byName: {}, nameToId: {} }; return _payInfoCache; }

    const payData = await proxyFetch('/PayItems', {}, true);
    const rates = (payData.PayItems?.EarningsRates || []);
    const rateById  = Object.fromEntries(rates.map(r => [r.EarningsRateID, r]));
    const nameToId  = Object.fromEntries(rates.map(r => [r.Name, r.EarningsRateID]));

    const empList = (await proxyFetch('/Employees', {}, true)).Employees || [];
    const byName = {};
    for (const e of empList) {   // sequential — Xero concurrency cap
      try {
        const detail = (await proxyFetch(`/Employees/${e.EmployeeID}`, {}, true)).Employees?.[0];
        if (!detail) continue;
        const ordId   = detail.OrdinaryEarningsRateID;
        const lines   = detail.PayTemplate?.EarningsLines || [];
        const ordLine = lines.find(l => l.EarningsRateID === ordId) || lines[0];
        const baseRate     = ordLine?.RatePerUnit ?? rateById[ordId]?.RatePerUnit ?? null;
        const annualSalary = ordLine?.AnnualSalary ?? null;
        const ordName = rateById[ordId]?.Name || '';
        const lvl     = ordName.match(/level\s*([0-9]+)/i);
        const salaried = (annualSalary || 0) > 0;
        const name = `${e.FirstName || ''} ${e.LastName || ''}`.trim();
        byName[normalizeName(name)] = {
          name, xeroEmployeeId: e.EmployeeID,
          baseRate, level: lvl ? parseInt(lvl[1], 10) : 1, salaried,
          weeklyCost: salaried ? Math.round((annualSalary / 52) * 100) / 100 : null,
          ordinaryEarningsRateID: ordId,
        };
      } catch (err) {
        console.warn('[Xero payinfo] failed for', e.EmployeeID, err.message);
      }
    }
    _payInfoCache = { byName, nameToId };
    return _payInfoCache;
  }

  /**
   * Recompute each timesheet's cost from Xero base rates × Fast Food Award
   * multipliers (per shift day type). Salaried staff are flagged and costed at
   * their fixed weekly salary. Falls back to the Square-derived cost for anyone
   * not matched in Xero, and no-ops if Xero isn't connected.
   */
  async function applyAwardRates(timesheets, weekStart) {
    if (CONFIG.FEATURES.DEMO_MODE || !isConnected()) return timesheets;
    let info;
    try { info = await getEmployeePayInfo(); }
    catch (e) { console.warn('[Xero award] pay info failed:', e.message); return timesheets; }

    const settings = Store.getSettings();
    return timesheets.map(ts => {
      const pi = info.byName[normalizeName(ts.name)];
      if (!pi) return ts;                       // unmatched → keep Square cost

      if (pi.salaried) {
        // Salaried managers are a fixed cost outside the variable labour metric
        // (Square's labour figure is hourly staff only), so don't add them to
        // the labour total. Keep the salary for reference / future use.
        return { ...ts, salaried: true, baseRate: null, xeroEmployeeId: pi.xeroEmployeeId,
                 estimatedCost: 0, weeklySalary: pi.weeklyCost, awardSource: 'salary' };
      }
      if (pi.baseRate == null) return ts;

      const shifts = (ts.shifts || []).map(sh => {
        const dayType = Holidays.getDayType(sh.date, settings.ekkaBrisbane);
        const rule    = awardRule('casual', pi.level || 1, dayType);
        const rate    = Math.round(pi.baseRate * rule.mult * 100) / 100;
        return { ...sh, baseRate: pi.baseRate, hourlyRate: rate, multiplier: rule.mult,
                 rateName: rule.rate, dayType, shiftCost: Math.round(sh.hours * rate * 100) / 100 };
      });
      const estimatedCost = Math.round(shifts.reduce((a, s) => a + (s.shiftCost || 0), 0));
      return { ...ts, shifts, baseRate: pi.baseRate, level: pi.level,
               estimatedCost, awardSource: 'xero', xeroEmployeeId: pi.xeroEmployeeId };
    });
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

  // ── Overhead weekly average (since 1 July of previous year) ──

  // Account-name fragments to exclude from overheads:
  //  - base WAGES (incl. paid leave): already counted via the Square timesheet
  //    line, so including them here would double-count. Super & WorkCover are
  //    NOT excluded (Square gives wages only, so they must land in overheads).
  //  - COGS items (packaging, freight, courier): captured in the invoice/COGS
  //    cycle, so excluded here to avoid double-counting them too.
  const OVERHEAD_EXCLUDE_KEYWORDS = [
    'wage', 'salary', 'salaries', 'payroll',
    'leave loading', 'annual leave', 'sick leave', 'long service',
    'packaging', 'freight', 'courier',
  ];

  function isExcludedFromOverhead(accountName) {
    const lower = (accountName || '').toLowerCase();
    return OVERHEAD_EXCLUDE_KEYWORDS.some(kw => lower.includes(kw));
  }

  /**
   * Fetches the Xero P&L from 1 July of the previous calendar year up to the
   * end of the previous week, and returns the weekly average of operating
   * expenses excluding wages and superannuation.
   *
   * The 1 July anchor only moves when the calendar year rolls over, so every
   * week in a given year uses the same start date — e.g. all of 2026 reaches
   * back to 1 Jul 2025 — giving a long, stable ~12–18 month average.
   *
   * Example: week of Mon 22 Jun 2026 → 1 Jul 2025 – 21 Jun 2026.
   *
   * @param {string} currentWeekStart  ISO date (YYYY-MM-DD) of Monday this week
   * @returns {{ weeklyAverage, total, weeks, fromDate, toDate }}
   */
  async function getOverheadAverage(currentWeekStart) {
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(900); return demoOverhead(); }

    // End date = the day before the current week starts (end of previous week).
    // UTC-anchored arithmetic (Brisbane = UTC+10, no DST) so dates never slip.
    const toD = new Date(currentWeekStart + 'T12:00:00Z');
    toD.setUTCDate(toD.getUTCDate() - 1);

    // Start date = 1 July of the previous calendar year, anchored to the year
    // of the current week so it only resets on 1 January.
    const anchorYear  = parseInt(currentWeekStart.slice(0, 4), 10);
    const fromD = new Date(Date.UTC(anchorYear - 1, 6, 1)); // month 6 = July

    const from = fromD.toISOString().slice(0, 10);
    const to   = toD.toISOString().slice(0, 10);

    // Number of weeks across the (inclusive) range
    const days  = Math.round((toD - fromD) / 86400000) + 1;
    const weeks = days / 7;

    const data = await proxyFetch('/Reports/ProfitAndLoss', {}, false, {
      fromDate: from,
      toDate:   to,
    });

    const report = data?.Reports?.[0];
    if (!report) throw new Error('No P&L data returned from Xero');

    // Sum the operating-expense section, excluding wages/super.
    // "Cost of Sales" is a separate section (title doesn't match /expense/i),
    // so COGS is not included here — it's tracked separately from invoices.
    const expenseSection = report.Rows?.find(
      r => r.RowType === 'Section' && /expense/i.test(r.Title || '')
    );
    let total = 0;
    if (expenseSection) {
      for (const row of expenseSection.Rows || []) {
        if (row.RowType !== 'Row') continue;
        const name   = row.Cells?.[0]?.Value || '';
        const amount = parseFloat(row.Cells?.[1]?.Value || '0');
        if (isExcludedFromOverhead(name)) continue;   // wages/leave + COGS items
        if (!amount) continue;
        total += amount;
      }
    }

    return {
      weeklyAverage: parseFloat((total / weeks).toFixed(2)),
      total:         parseFloat(total.toFixed(2)),
      weeks:         parseFloat(weeks.toFixed(1)),
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
    inspectPayroll,
    getEmployeePayInfo,
    applyAwardRates,
    pushTimesheets,
    getOverheadAverage,
  };

})();
