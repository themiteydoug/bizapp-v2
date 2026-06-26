/**
 * BizOps · Square API
 * All real API calls go through the Netlify square-proxy function.
 * No secrets (tokens, location IDs) ever touch the browser.
 */

const SquareAPI = (() => {

  // ── Proxy helper ──────────────────────────────

  async function proxyFetch(endpoint, method = 'GET', body = null, extraParams = {}) {
    const qs = new URLSearchParams({ endpoint, ...extraParams });
    const res = await fetch(`${CONFIG.API.SQUARE}?${qs}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Square proxy error: ${res.status}`);
    return res.json();
  }

  // ── Demo data ─────────────────────────────────

  function demoTakings(dateStr) {
    const seed = dateStr.replace(/-/g, '').slice(-4);
    const base = 3200 + (parseInt(seed) % 2000);
    const cashPct = 0.12 + (parseInt(seed[0]) * 0.01);
    const cash = Math.round(base * cashPct);
    const card = base - cash;
    return {
      date: dateStr,
      total: base,
      card,
      cash,
      transactions: 87 + (parseInt(seed[1]) % 40),
      averageTransaction: Math.round(base / (87 + parseInt(seed[1]) % 40)),
    };
  }

  function demoStaffHours(weekStart) {
    const staff = Store.getStaff().filter(s => s.active);
    const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
    return staff.map((s, si) => {
      const shifts = [];
      const workDays = s.employmentType === 'part_time' ? [0,1,5] : [0,1,3,4,5];
      workDays.forEach((d, di) => {
        const date = new Date(weekStart + 'T12:00:00');
        date.setDate(date.getDate() + d);
        const dateStr = date.toISOString().slice(0, 10);
        const hours = 7 + (si + di) % 3;
        shifts.push({
          date: dateStr,
          dayName: days[d],
          startTime: '08:00',
          endTime: `${8 + hours}:00`,
          hours,
          breakMins: 30,
        });
      });
      const totalHours = shifts.reduce((a, s) => a + s.hours, 0);
      return {
        staffId: s.id,
        squareId: s.squareId,
        name: s.name,
        shifts,
        totalHours,
        estimatedCost: Math.round(totalHours * 26.40),
      };
    });
  }

  // ── Real Square API calls (via proxy) ─────────

  async function fetchTakingsReal(dateStr) {
    const startAt = dateStr + 'T00:00:00+10:00';
    const endAt   = dateStr + 'T23:59:59+10:00';
    // location_ids injected server-side by square-proxy
    const data = await proxyFetch('/orders/search', 'POST', {
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          state_filter: { states: ['COMPLETED'] }
        }
      }
    });
    const orders = data.orders || [];
    let total = 0, cash = 0, card = 0;
    orders.forEach(o => {
      const amt = (o.total_money?.amount || 0) / 100;
      total += amt;
      (o.tenders || []).forEach(t => {
        if (t.type === 'CASH') cash += (t.amount_money?.amount || 0) / 100;
        else card += (t.amount_money?.amount || 0) / 100;
      });
    });
    return {
      date: dateStr,
      total: Math.round(total),
      card: Math.round(card),
      cash: Math.round(cash),
      transactions: orders.length,
    };
  }

  async function fetchTimesheetsReal(weekStart, weekEnd) {
    // Square API uses start_at_min / start_at_max for date range filtering on GET /labor/shifts
    // location_id is injected server-side by square-proxy
    const data = await proxyFetch('/labor/shifts', 'GET', null, {
      start_at_min: weekStart + 'T00:00:00+10:00',
      start_at_max: weekEnd   + 'T23:59:59+10:00',
      limit: 200,
    });
    const shifts = data.shifts || [];
    const byEmployee = {};
    shifts.forEach(shift => {
      // Square API v2: team_member_id is current; employee_id is deprecated but may still appear
      const eid = shift.team_member_id || shift.employee_id;
      if (!eid) return;
      if (!byEmployee[eid]) byEmployee[eid] = [];
      const startMs = new Date(shift.start_at).getTime();
      const endMs   = shift.end_at ? new Date(shift.end_at).getTime() : startMs;
      const rawHours = (endMs - startMs) / 3600000;
      // Subtract unpaid breaks
      const breakMins = (shift.breaks || []).reduce((a, b) => {
        // breaks have start_at/end_at when clocked, otherwise expected_duration
        if (b.start_at && b.end_at) {
          return a + (new Date(b.end_at) - new Date(b.start_at)) / 60000;
        }
        return a + (b.expected_duration?.minutes || 0);
      }, 0);
      const hours = Math.round((rawHours - breakMins / 60) * 100) / 100;
      // Shift date in Brisbane time
      const date = new Date(shift.start_at).toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });
      byEmployee[eid].push({ date, hours, startTime: shift.start_at, endTime: shift.end_at, breakMins });
    });

    const staff = Store.getStaff().filter(s => s.active);
    return staff.map(s => {
      const empShifts = byEmployee[s.squareId] || [];
      const totalHours = empShifts.reduce((a, sh) => a + sh.hours, 0);
      return { staffId: s.id, squareId: s.squareId, name: s.name, shifts: empShifts, totalHours };
    }).filter(s => s.shifts.length > 0);
  }

  // ── Public API ────────────────────────────────

  // Returns today's date in Brisbane time (AEST/AEDT = UTC+10/+11)
  // Using toISOString() returns UTC which can be yesterday in QLD until 10am
  function getTodayBrisbane() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });
  }

  async function getTakings(dateStr = getTodayBrisbane()) {
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(600); return demoTakings(dateStr); }
    return fetchTakingsReal(dateStr);
  }

  async function getWeekTimesheets(weekStart) {
    const weekEnd = Holidays.getWeekEnd(weekStart);
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(800); return demoStaffHours(weekStart); }
    return fetchTimesheetsReal(weekStart, weekEnd);
  }

  async function getWeeklyTotals(weekStart, weekEnd) {
    if (CONFIG.FEATURES.DEMO_MODE) {
      await delay(600);
      return { cashSales: 850.40, cardSales: 18290.00, total: 19140.40, refunds: 45.00, paidIn: 0, paidOut: 0 };
    }
    const start = new Date(weekStart + 'T12:00:00');
    const end   = new Date(weekEnd   + 'T12:00:00');
    const days  = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    const results = await Promise.all(days.map(ds => fetchTakingsReal(ds).catch(() => ({ total: 0, cash: 0, card: 0 }))));
    return results.reduce(
      (acc, r) => ({ ...acc, cashSales: acc.cashSales + (r.cash || 0), cardSales: acc.cardSales + (r.card || 0), total: acc.total + (r.total || 0) }),
      { cashSales: 0, cardSales: 0, total: 0, refunds: 0, paidIn: 0, paidOut: 0 }
    );
  }

  async function getStaffList() {
    if (CONFIG.FEATURES.DEMO_MODE) { await delay(400); return Store.getStaff(); }
    const data = await proxyFetch('/team-members');
    return data.team_members || [];
  }

  // ── Drawer report ─────────────────────────────

  async function getDrawerReport(dateStr = getTodayBrisbane()) {
    if (CONFIG.FEATURES.DEMO_MODE) {
      await delay(600);
      return {
        startingCash: 300.00, cashSales: 158.30, cashRefunds: 0.00,
        paidIn: 0.00, paidOut: 0.00, expected: 458.30, paidInOutItems: [],
      };
    }
    // location_id injected server-side by square-proxy
    const data = await proxyFetch('/cash-drawers/shifts');
    const shifts = data.cash_drawer_shifts || [];
    const todayShift = shifts.find(s => s.opened_at?.slice(0,10) === dateStr);
    if (!todayShift) return { startingCash:0, cashSales:0, cashRefunds:0, paidIn:0, paidOut:0, expected:0, paidInOutItems:[] };

    const detailData = await proxyFetch(`/cash-drawers/shifts/${todayShift.id}/events`);
    const events = detailData.cash_drawer_shift_events || [];
    const paidInOutItems = events
      .filter(e => e.event_type === 'PAID_IN' || e.event_type === 'PAID_OUT')
      .map(e => ({
        type: e.event_type === 'PAID_IN' ? 'in' : 'out',
        amount: Math.abs((e.event_money?.amount || 0) / 100),
        description: e.description || '',
      }));
    const paidIn  = paidInOutItems.filter(e => e.type === 'in').reduce((a, e) => a + e.amount, 0);
    const paidOut = paidInOutItems.filter(e => e.type === 'out').reduce((a, e) => a + e.amount, 0);
    const startingCash = (todayShift.opened_cash_money?.amount || 0) / 100;
    const cashSales    = (todayShift.cash_payment_money?.amount || 0) / 100;
    const cashRefunds  = (todayShift.cash_refunds_money?.amount || 0) / 100;
    const expected     = startingCash + cashSales - cashRefunds + paidIn - paidOut;
    return { startingCash, cashSales, cashRefunds, paidIn, paidOut, expected, paidInOutItems };
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { getTakings, getWeekTimesheets, getWeeklyTotals, getStaffList, getDrawerReport };

})();
