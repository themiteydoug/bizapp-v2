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
          state_filter: { states: ['COMPLETED'] },
        },
      },
    });
    const orders = data.orders || [];
    let total = 0, cash = 0, card = 0;
    orders.forEach(o => {
      total += (o.total_money?.amount || 0) / 100;
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
    // Square Team Plus Legacy: POST /labor/timecards/search
    const locationId = ''; // injected server-side from SQUARE_LOCATION_ID
    const data = await proxyFetch('/labor/timecards/search', 'POST', {
      query: {
        filter: {
          location_ids: [], // proxy injects location_id via env var — pass empty so proxy adds it
          start: { start_at: weekStart + 'T00:00:00+10:00', end_at: weekEnd + 'T23:59:59+10:00' },
        },
      },
      limit: 200,
    });
    const timecards = (data.timecards || []).filter(t => !t.deleted);
    const byEmployee = {};
    timecards.forEach(tc => {
      const eid = tc.team_member_id;
      if (!eid) return;
      if (!byEmployee[eid]) byEmployee[eid] = { shifts: [], hourlyRate: 0 };
      const startMs = new Date(tc.start_at).getTime();
      const endMs   = tc.end_at ? new Date(tc.end_at).getTime() : Date.now();
      const rawHours = (endMs - startMs) / 3600000;
      const breakMins = (tc.breaks || []).filter(b => !b.is_paid).reduce((a, b) => {
        if (b.start_at && b.end_at) return a + (new Date(b.end_at) - new Date(b.start_at)) / 60000;
        return a;
      }, 0);
      const hours = Math.round((rawHours - breakMins / 60) * 100) / 100;
      const date = new Date(tc.start_at).toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });
      // Use rate from timecard wage (actual rate applied at clock-in)
      const hourlyRate = (tc.wage?.hourly_rate?.amount || 0) / 100;
      const shiftCost  = Math.round(hours * hourlyRate * 100) / 100;
      byEmployee[eid].shifts.push({ date, hours, startTime: tc.start_at, endTime: tc.end_at, hourlyRate, shiftCost });
      byEmployee[eid].totalCost = (byEmployee[eid].totalCost || 0) + shiftCost;
      if (hourlyRate) byEmployee[eid].hourlyRate = hourlyRate;
    });

    const staff = Store.getStaff().filter(s => s.active);
    if (!staff.length) {
      return Object.entries(byEmployee).map(([eid, emp]) => ({
        staffId: eid, squareId: eid, name: eid,
        shifts: emp.shifts,
        totalHours: emp.shifts.reduce((a, sh) => a + sh.hours, 0),
        hourlyRate: emp.hourlyRate,
        estimatedCost: Math.round(emp.shifts.reduce((a, sh) => a + sh.hours, 0) * emp.hourlyRate),
      }));
    }
    return staff.map(s => {
      const emp = byEmployee[s.squareId] || { shifts: [], hourlyRate: 0 };
      const totalHours = emp.shifts.reduce((a, sh) => a + sh.hours, 0);
      const hourlyRate = emp.hourlyRate || 0;
      return {
        staffId: s.id, squareId: s.squareId, name: s.name,
        shifts: emp.shifts, totalHours, hourlyRate,
        estimatedCost: emp.totalCost ? Math.round(emp.totalCost) : Math.round(totalHours * hourlyRate),
      };
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
    const data = await proxyFetch('/team-members/search', 'POST', {
      query: { filter: { location_ids: [], statuses: ['ACTIVE'] } },
      limit: 200,
    });
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
    const listData = await proxyFetch('/cash-drawers/shifts');
    const shifts = listData.cash_drawer_shifts || [];
    const todayShift = shifts.find(s => s.opened_at &&
      new Date(s.opened_at).toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' }) === dateStr);
    if (!todayShift) return { startingCash:0, cashSales:0, cashRefunds:0, paidIn:0, paidOut:0, expected:0, expectedInDrawer:0, paidInOutItems:[] };

    // Fetch full shift detail — list endpoint omits cash_payment_money for open shifts
    const [shiftDetail, eventsData] = await Promise.all([
      proxyFetch(`/cash-drawers/shifts/${todayShift.id}`).catch(() => ({})),
      proxyFetch(`/cash-drawers/shifts/${todayShift.id}/events`).catch(() => ({})),
    ]);
    const shift  = shiftDetail.cash_drawer_shift || todayShift;
    const events = eventsData.cash_drawer_shift_events || [];

    const paidInOutItems = events
      .filter(e => e.event_type === 'PAID_IN' || e.event_type === 'PAID_OUT')
      .map(e => ({
        type: e.event_type === 'PAID_IN' ? 'in' : 'out',
        amount: Math.abs((e.event_money?.amount || 0) / 100),
        description: e.description || '',
      }));
    const paidIn  = paidInOutItems.filter(e => e.type === 'in').reduce((a, e) => a + e.amount, 0);
    const paidOut = paidInOutItems.filter(e => e.type === 'out').reduce((a, e) => a + e.amount, 0);
    const startingCash = (shift.opened_cash_money?.amount  || 0) / 100;
    const cashSales    = (shift.cash_payment_money?.amount  || 0) / 100;
    const cashRefunds  = (shift.cash_refunds_money?.amount  || 0) / 100;
    const expected     = startingCash + cashSales - cashRefunds + paidIn - paidOut;
    return { startingCash, cashSales, cashRefunds, paidIn, paidOut, expected, expectedInDrawer: expected, paidInOutItems };
  }

  // ── Payouts ───────────────────────────────────

  async function getWeeklyPayouts(weekStart, weekEnd) {
    if (CONFIG.FEATURES.DEMO_MODE) {
      await delay(400);
      return { cash: 1072.20, card: 5991.85, refunds: 0, entries: [] };
    }
    // Brisbane week boundaries converted to UTC ISO strings
    const beginTime = weekStart + 'T00:00:00+10:00';
    const endTime   = weekEnd   + 'T23:59:59+10:00';

    const listData = await proxyFetch(
      `/payouts?begin_time=${encodeURIComponent(beginTime)}&end_time=${encodeURIComponent(endTime)}&count=200`
    );
    const payouts = listData.payouts || [];
    if (!payouts.length) return { cash: 0, card: 0, refunds: 0, entries: [] };

    // Fetch entries for all payouts in parallel
    const entryResults = await Promise.all(
      payouts.map(p =>
        proxyFetch(`/payouts/${p.id}/payout-entries?count=200`)
          .then(d => d.payout_entries || [])
          .catch(() => [])
      )
    );

    const allEntries = entryResults.flat();

    // Tally by type — Square entry types: CHARGE (card), REFUND, WITHDRAWAL (cash pickup)
    let cash = 0, card = 0, refunds = 0;
    allEntries.forEach(e => {
      const amt = (e.amount_money?.amount || 0) / 100;
      switch (e.type) {
        case 'CHARGE':     card    += amt; break;
        case 'WITHDRAWAL': cash    += amt; break;
        case 'REFUND':     refunds += Math.abs(amt); break;
      }
    });

    return { cash, card, refunds, payoutCount: payouts.length, entryCount: allEntries.length };
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { getTakings, getWeekTimesheets, getWeeklyTotals, getWeeklyPayouts, getStaffList, getDrawerReport };

})();
