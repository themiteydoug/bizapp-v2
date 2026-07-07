/**
 * BizOps · Square API
 * All real API calls go through the Netlify square-proxy function.
 * No secrets (tokens, location IDs) ever touch the browser.
 */

const SquareAPI = (() => {

  // ── Proxy helper ──────────────────────────────

  async function proxyFetch(endpoint, method = 'GET', body = null, extraParams = {}) {
    // Financial data must always be live. A unique cache-buster (_cb) per call
    // makes every request URL distinct, and cache:'no-store' bypasses the HTTP
    // cache — otherwise a GET like /payments can be served stale, which made one
    // week's sales total show up under a different week. (_cb is stripped by the
    // proxy before the call reaches Square.)
    const qs = new URLSearchParams({ endpoint, ...extraParams, _cb: Date.now().toString() });
    const res = await fetch(`${CONFIG.API.SQUARE}?${qs}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[Square proxy] ${endpoint} → ${res.status}`, errText);
      throw new Error(`Square proxy error: ${res.status} ${errText}`);
    }
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
    const data = await proxyFetch('/orders/search', 'POST', {
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
        },
      },
      limit: 500,
    });
    // Square "Total Sales"/"Total payments collected" excludes CANCELLED orders
    // (voided payments) but DOES include paid OPEN orders (e.g. delivery via
    // "Other"). Refunds are netted at the weekly level, not here.
    const orders = (data.orders || []).filter(o => o.tenders?.length > 0 && o.state !== 'CANCELED');
    let total = 0, cash = 0, card = 0, gst = 0;
    orders.forEach(o => {
      const net      = o.net_amounts || {};
      const netTotal = (net.total_money?.amount ?? o.total_money?.amount ?? 0) / 100; // after refunds/returns
      const tip      = (net.tip_money?.amount  ?? o.total_tip_money?.amount ?? 0) / 100;
      // GST-inclusive sales, net of refunds, excluding tips. (The weekly cash/card
      // totals come from the Payments API; this 'total' is the per-day fallback.)
      total += netTotal - tip;
      // GST: use net_amounts.tax_money (net of returns) so it matches Square's
      // "Taxes" line; fall back to total_tax_money when net isn't present.
      gst += (net.tax_money?.amount ?? o.total_tax_money?.amount ?? 0) / 100;
      (o.tenders || []).forEach(t => {
        if (t.type === 'CASH') cash += (t.amount_money?.amount || 0) / 100;
        else                   card += (t.amount_money?.amount || 0) / 100;
      });
    });
    return { date: dateStr, total, cash, card, gst, transactions: orders.length };
  }

  // Fetch cash refunds for the week from Square's /v2/refunds endpoint.
  // PaymentRefund.destination_type === 'CASH' identifies cash-back refunds directly.
  async function fetchWeeklyRefunds(weekStart, weekEnd) {
    const data = await proxyFetch('/refunds', 'GET', null, {
      begin_time: weekStart + 'T00:00:00+10:00',
      end_time:   weekEnd   + 'T23:59:59+10:00',
      limit: 100,
    });
    const refunds = (data.refunds || []).filter(r => r.status === 'COMPLETED');
    const sum = list => list.reduce((s, r) => s + (r.amount_money?.amount || 0) / 100, 0);
    const total = sum(refunds);
    const cash  = sum(refunds.filter(r => r.destination_type === 'CASH'));
    return { total, cash };
  }

  // Sum COMPLETED payments for the week from Square's Payments API — this is the
  // authoritative "money captured" basis (a payment carries a real status, so
  // voided/cancelled tenders are excluded but captured ones on otherwise-cancelled
  // orders are kept). source_type CASH → cash; everything else (CARD, EXTERNAL/
  // "Other" delivery, WALLET…) → card. Refunds are netted separately.
  async function fetchWeeklyPayments(weekStart, weekEnd) {
    let cursor = null, cash = 0, card = 0, completed = 0, seen = 0, guard = 0;
    do {
      const params = {
        begin_time: weekStart + 'T00:00:00+10:00',
        end_time:   weekEnd   + 'T23:59:59+10:00',
        sort_order: 'ASC',
        limit: 100,
      };
      if (cursor) params.cursor = cursor;
      const data = await proxyFetch('/payments', 'GET', null, params);
      (data.payments || []).forEach(p => {
        seen++;
        if (p.status !== 'COMPLETED') return;
        completed++;
        const amt = (p.amount_money?.amount || 0) / 100;
        if (p.source_type === 'CASH') cash += amt; else card += amt;
      });
      cursor = data.cursor || null;
    } while (cursor && ++guard < 25);
    return { cash, card, completed, seen };
  }

  async function fetchTimesheetsReal(weekStart, weekEnd) {
    // Square Team Plus Legacy: POST /labor/timecards/search
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
    const adjustments = Store.getTsAdjustments();   // manager hour overrides
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
      const squareHours = Math.round((rawHours - breakMins / 60) * 100) / 100;
      // Apply a manager adjustment if one exists for this shift
      const adjKey = `${eid}|${tc.start_at}`;
      const adjusted = adjustments[adjKey] != null;
      const hours = adjusted ? adjustments[adjKey] : squareHours;
      const date = new Date(tc.start_at).toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });
      // Use rate from timecard wage (actual rate applied at clock-in)
      const hourlyRate = (tc.wage?.hourly_rate?.amount || 0) / 100;
      const shiftCost  = Math.round(hours * hourlyRate * 100) / 100;
      byEmployee[eid].shifts.push({ date, hours, squareHours, adjusted, startTime: tc.start_at, endTime: tc.end_at, hourlyRate, shiftCost });
      byEmployee[eid].totalCost = (byEmployee[eid].totalCost || 0) + shiftCost;
      if (hourlyRate) byEmployee[eid].hourlyRate = hourlyRate;
    });

    const round2 = n => Math.round(n * 100) / 100;
    const staff = Store.getStaff().filter(s => s.active);
    if (!staff.length) {
      return Object.entries(byEmployee).map(([eid, emp]) => ({
        staffId: eid, squareId: eid, name: eid,
        shifts: emp.shifts,
        totalHours: round2(emp.shifts.reduce((a, sh) => a + sh.hours, 0)),
        hourlyRate: emp.hourlyRate,
        estimatedCost: Math.round(emp.shifts.reduce((a, sh) => a + sh.hours, 0) * emp.hourlyRate),
      }));
    }
    return staff.map(s => {
      const emp = byEmployee[s.squareId] || { shifts: [], hourlyRate: 0 };
      const totalHours = round2(emp.shifts.reduce((a, sh) => a + sh.hours, 0));
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
      return { cashSales: 850.40, cardSales: 18290.00, total: 19140.40, gst: 1740.04, transactions: 412, refunds: 45.00, paidIn: 0, paidOut: 0 };
    }
    // Build the Mon→Sun day list using UTC-anchored arithmetic (Brisbane = UTC+10, no DST)
    const start = new Date(weekStart + 'T12:00:00Z');
    const end   = new Date(weekEnd   + 'T12:00:00Z');
    const days  = [];
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }
    const [orderResults, refunds, payments] = await Promise.all([
      Promise.all(days.map(ds => fetchTakingsReal(ds).catch(() => ({ total: 0, cash: 0, card: 0, gst: 0, transactions: 0, canceledTotal: 0, canceledCount: 0 })))),
      fetchWeeklyRefunds(weekStart, weekEnd).catch(() => ({ total: 0, cash: 0 })),
      fetchWeeklyPayments(weekStart, weekEnd).catch(() => null),
    ]);
    const agg = orderResults.reduce(
      (acc, r) => ({
        cashGross:    acc.cashGross    + (r.cash  || 0),
        cardGross:    acc.cardGross    + (r.card  || 0),
        gst:          acc.gst          + (r.gst   || 0),
        transactions: acc.transactions + (r.transactions || 0),
      }),
      { cashGross: 0, cardGross: 0, gst: 0, transactions: 0 }
    );
    // Weekly sales = Square "Total payments collected": COMPLETED payments
    // (cash vs card/Other) netted by refunds. Use the Payments API when available
    // (captured-money basis); fall back to order tenders if it fails.
    const cashGross = payments ? payments.cash : agg.cashGross;
    const cardGross = payments ? payments.card : agg.cardGross;
    const cashRefunds  = refunds.cash  || 0;
    const totalRefunds = refunds.total || 0;
    const cardRefunds  = Math.max(0, totalRefunds - cashRefunds);
    const cashSales = cashGross - cashRefunds;
    const cardSales = cardGross - cardRefunds;
    const total     = cashSales + cardSales;
    const gst = agg.gst, transactions = agg.transactions;
    return {
      cashGross, cashRefunds, cashSales, cardSales, total, gst, transactions, paidIn: 0, paidOut: 0,
      // Temporary diagnostic — surfaces the raw per-week inputs on-screen so we
      // can see whether the Payments API is returning different data per week.
      _dbg: {
        ws: weekStart, we: weekEnd,
        src: payments ? 'PAY' : 'ORD',
        cG: Math.round(cashGross), kG: Math.round(cardGross),
        n:  payments ? payments.completed : null,
        seen: payments ? payments.seen : null,
        ref: Math.round(totalRefunds),
      },
    };
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
      return { cash: 1072.20, card: 5991.85, refunds: 0, payoutCount: 1, entryCount: 0 };
    }
    // Brisbane week boundaries as ISO 8601 with offset
    const beginTime = weekStart + 'T00:00:00+10:00';
    const endTime   = weekEnd   + 'T23:59:59+10:00';

    // List payouts for the week — pass date params via extraParams so they're not double-encoded
    const listData = await proxyFetch('/payouts', 'GET', null, {
      begin_time: beginTime,
      end_time:   endTime,
      limit:      250,
    });
    const payouts = listData.payouts || [];
    if (!payouts.length) return { cash: 0, card: 0, refunds: 0, payoutCount: 0, entryCount: 0 };

    // Fetch entries for all payouts in parallel
    const entryResults = await Promise.all(
      payouts.map(p =>
        proxyFetch(`/payouts/${p.id}/payout-entries`, 'GET', null, { limit: 250 })
          .then(d => d.payout_entries || [])
          .catch(() => [])
      )
    );

    const allEntries = entryResults.flat();

    // Tally by type — log raw types on first run so we can verify the mapping
    const typeSeen = {};
    let cash = 0, card = 0, refunds = 0;
    allEntries.forEach(e => {
      const amt = (e.amount_money?.amount || 0) / 100;
      typeSeen[e.type] = (typeSeen[e.type] || 0) + 1;
      switch (e.type) {
        case 'CHARGE':     card    += amt; break;
        case 'WITHDRAWAL': cash    += Math.abs(amt); break;
        case 'REFUND':     refunds += Math.abs(amt); break;
      }
    });
    console.log('[Square payouts] entry types seen:', typeSeen, '| cash:', cash, 'card:', card, 'refunds:', refunds);

    return { cash, card, refunds, payoutCount: payouts.length, entryCount: allEntries.length };
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  return { getTakings, getWeekTimesheets, getWeeklyTotals, getWeeklyPayouts, getStaffList, getDrawerReport };

})();
