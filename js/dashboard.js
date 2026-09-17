/**
 * BizOps · Dashboard Module
 * Staff view: takings + hours only.
 * Manager view: full cost breakdown + weekly overhead average from Xero.
 */

const Dashboard = (() => {

  let refreshTimer = null;
  let currentWeekStart = Holidays.getWeekStart();
  let lastRenderedWeek = null;   // the week whose numbers are currently painted on the tiles
  let visBound = false;          // visibilitychange listener attached only once

  // Auto-refresh cadence. Kept generous (and paused while the app is in the
  // background) so an app left open in someone's pocket doesn't keep pulling
  // Square data every few minutes — that idle polling was burning through the
  // Vercel data allowance.
  const REFRESH_MS = 15 * 60 * 1000;

  async function init() {
    currentWeekStart = App.getWeek();   // shared across tabs
    setHeaderDate();
    bindWeekNav();
    await refresh();

    // Tick only when the app is actually on-screen.
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, REFRESH_MS);

    // Catch up straight away when the user brings the app back to the foreground.
    if (!visBound) {
      visBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && App.getActivePage?.() === 'dashboard') refresh();
      });
    }
  }

  function setHeaderDate() {
    const el = document.getElementById('header-date');
    if (el) {
      el.textContent = new Date().toLocaleDateString('en-AU', {
        weekday: 'long', day: 'numeric', month: 'long'
      });
    }
  }

  function bindWeekNav() {
    document.getElementById('dash-prev-week')?.addEventListener('click', () => {
      const d = new Date(currentWeekStart + 'T12:00:00');
      d.setDate(d.getDate() - 7);
      currentWeekStart = d.toISOString().slice(0, 10);
      App.setWeek(currentWeekStart, 'dashboard');
      updateWeekLabel();
      refresh();
    });
    document.getElementById('dash-next-week')?.addEventListener('click', () => {
      const d = new Date(currentWeekStart + 'T12:00:00');
      d.setDate(d.getDate() + 7);
      const next = d.toISOString().slice(0, 10);
      const thisWeek = Holidays.getWeekStart();
      if (next > thisWeek) return;
      currentWeekStart = next;
      App.setWeek(currentWeekStart, 'dashboard');
      updateWeekLabel();
      refresh();
    });
    updateWeekLabel();
  }

  function updateWeekLabel() {
    const el = document.getElementById('dash-week-label');
    if (el) el.textContent = Holidays.formatWeekLabel(currentWeekStart);
  }

  // Adopt a week chosen elsewhere. On desktop every panel is on screen at once,
  // so the single selector at the top drives them all through App.setWeek.
  // No-op when it's already the week showing, which also stops the broadcast
  // bouncing back to whichever panel started it.
  function setWeek(w) {
    if (!w || w === currentWeekStart) return;
    currentWeekStart = w;
    updateWeekLabel();
    blankMetrics();
    refresh();
  }

  // Called when navigating back to the dashboard. Unlike the other views,
  // the dashboard is only init()'d once, so it must re-sync the shared week
  // here or a week chosen on another tab wouldn't carry over.
  function show() {
    const w = App.getWeek();
    if (w && w !== currentWeekStart) {
      currentWeekStart = w;
      updateWeekLabel();
    }
    refresh();
  }

  // Reset the metric tiles to a loading placeholder. Called whenever the viewed
  // week changes so a slow/failed refresh can never leave the PREVIOUS week's
  // numbers on screen — that stale-DOM carry-over is what made adjacent weeks
  // show identical figures.
  function blankMetrics() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    ['dash-takings', 'dash-staff-cost', 'dash-cogs-amt', 'dash-oh-amt', 'dash-net'].forEach(id => set(id, '…'));
    ['dash-gst', 'dash-staff-pct', 'dash-cogs-pct', 'dash-oh-sub', 'dash-net-pct'].forEach(id => set(id, ''));
    ['dash-staff-tile', 'dash-cogs-tile', 'dash-net-tile'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('tile-alert');
    });
  }

  async function refresh() {
    // Snapshot the week at kick-off. Many things trigger refresh() — week nav,
    // the 5-min timer, the sync button, live-sync data changes — so several can
    // overlap. We paint a result only while the user is still on that week.
    const weekStart = currentWeekStart;
    const weekEnd   = Holidays.getWeekEnd(weekStart);

    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) syncBtn.classList.add('spinning');

    // Changing weeks: clear the tiles so the old week's numbers don't linger
    // while the new week loads.
    if (weekStart !== lastRenderedWeek) blankMetrics();

    try {
      const isManager = Auth.isManager();

      // Each source resolves independently — a failure in one (e.g. a Square
      // labour hiccup) must not blank the others.
      const [weekTotals, rawTimesheets, overhead] = await Promise.all([
        SquareAPI.getWeeklyTotals(weekStart, weekEnd).catch(e => {
          console.warn('Weekly totals error:', e.message);
          return { total: 0, gst: 0, transactions: 0 };
        }),
        SquareAPI.getWeekTimesheets(weekStart).catch(e => {
          console.warn('Timesheets error:', e.message);
          return [];
        }),
        (isManager && XeroAPI.isConnected())
          ? XeroAPI.getOverheadAverage(weekStart).catch(e => {
              console.warn('Xero overhead error:', e.message);
              return null;
            })
          : Promise.resolve(null),
      ]);

      // Recost timesheets from Xero award rates (casual penalties). Salaried
      // managers are excluded from the variable labour metric (Square's labour
      // figure is hourly staff only).
      let timesheets = rawTimesheets;
      try { timesheets = await XeroAPI.applyAwardRates(rawTimesheets, weekStart); }
      catch (e) { console.warn('Award rates error:', e.message); }

      // The user navigated to a different week while this was in flight — drop
      // it rather than paint one week's numbers under another week's label.
      if (weekStart !== currentWeekStart) return;

      renderMetrics(weekTotals, timesheets, overhead, weekStart, weekEnd);
      lastRenderedWeek = weekStart;
    } catch (e) {
      if (weekStart !== currentWeekStart) return;
      console.error('Dashboard refresh error:', e);
      App.toast('Sync error: ' + e.message, 'error');
    } finally {
      if (weekStart === currentWeekStart && syncBtn) syncBtn.classList.remove('spinning');
      updateSyncTime();
    }
  }

  /**
   * renderMetrics — populates the 2x2 tile grid + net profit tile.
   * All percentages are computed against NET (ex-GST) sales:
   *   net sales = gross takings − GST collected
   *   COGS uses inv.subtotal (already ex-GST per invoice)
   *   net profit = net sales − staff cost − COGS − overhead avg
   */
  function renderMetrics(weekTotals, timesheets, overhead, weekStart, weekEnd) {
    const fmt    = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
    const fmtAud = n => '$' + (n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const set    = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    const alert  = (id, on) => { const el = document.getElementById(id); if (el) el.classList.toggle('tile-alert', !!on); };

    const gross    = weekTotals.total || 0;
    const gst      = weekTotals.gst || 0;
    const netSales = gross - gst;                  // ex-GST — denominator for ALL %
    const pctNum   = n => netSales > 0 ? (n / netSales * 100) : 0;
    const pct      = n => netSales > 0 ? pctNum(n).toFixed(1) + '% of net sales' : '—';

    const staffCost = timesheets.reduce((s, emp) => s + (emp.estimatedCost || 0), 0);

    const weekInvoices = Store.getInvoices().filter(inv => inv.date >= weekStart && inv.date <= weekEnd);
    const cogs = weekInvoices.reduce((s, inv) => s + (inv.subtotal || 0), 0);   // ex-GST

    const overheadWk = overhead?.weeklyAverage || 0;
    const netProfit  = netSales - staffCost - cogs - overheadWk;

    // Tile 1 — Weekly sales: GST-INCLUSIVE total as the headline, ex-GST below.
    // Percentages still use netSales (ex-GST), never the gross headline.
    set('dash-takings', fmt(gross));
    set('dash-gst',     gst > 0 ? `${fmt(netSales)} ex GST` : '');

    // Tile 2 — Total staff cost (red if wages > 32% of net sales)
    set('dash-staff-cost', staffCost > 0 ? fmt(staffCost) : '—');
    set('dash-staff-pct',  staffCost > 0 ? pct(staffCost) : timesheets.length + ' staff');
    alert('dash-staff-tile', staffCost > 0 && pctNum(staffCost) > 32);

    // Tile 3 — Invoices (COGS, ex-GST) (red if food cost > 35% of net sales)
    set('dash-cogs-amt', cogs > 0 ? fmt(cogs) : '$—');
    set('dash-cogs-pct', cogs > 0 ? pct(cogs)
      : (weekInvoices.length ? '—' : 'No invoices this week'));
    alert('dash-cogs-tile', cogs > 0 && pctNum(cogs) > 35);

    // Tile 4 — Overheads (weekly average from Xero)
    if (overhead) {
      set('dash-oh-amt', fmtAud(overheadWk));
      set('dash-oh-sub', overhead.note ? overhead.note : `avg/wk · ${overhead.weeks || '—'} wks`);
    } else {
      set('dash-oh-amt', '$—');
      set('dash-oh-sub', XeroAPI.isConnected() ? 'avg per week' : 'Connect Xero');
    }

    // Net profit (red if negative)
    set('dash-net',     netSales > 0 ? fmt(netProfit) : '$—');
    set('dash-net-pct', netSales > 0 ? pct(netProfit) : '— of net sales');
    alert('dash-net-tile', netSales > 0 && netProfit < 0);

    // Desktop extras — no-ops on the phone, where these elements are hidden.
    renderSummaries(weekStart, weekEnd, timesheets, weekInvoices, cogs);
    if (netSales > 0) recordWeek(weekStart, netProfit);
    renderTrend(weekStart);
  }

  // ── Desktop summary cards ─────────────────────
  // Deliberately built from data already on hand — the timesheets and invoices
  // the tiles just used, plus local cash records — so the front page costs no
  // extra API calls.
  function renderSummaries(weekStart, weekEnd, timesheets, weekInvoices, cogs) {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const money = n => '$' + Math.round(n || 0).toLocaleString();

    // Cash rec — how much is counted, and how much of the week is done.
    const recs = Store.getCashRecs().filter(r => r.type === 'daily' && r.date >= weekStart && r.date <= weekEnd);
    const banked = recs.reduce((s, r) => s + (r.actualCash ?? r.actual ?? 0), 0);
    set('sum-cash', recs.length ? money(banked) : '—');
    set('sum-cash-sub', `${recs.length} of 7 days counted`);

    // Invoices — this week's bills and what they add to COGS.
    set('sum-inv', weekInvoices.length ? money(cogs) : '—');
    set('sum-inv-sub', `${weekInvoices.length} bill${weekInvoices.length === 1 ? '' : 's'} this week`);

    // Timesheets — hours and cost, straight off the staff-cost tile's data.
    const hours = timesheets.reduce((s, e) => s + (e.totalHours || 0), 0);
    const cost  = timesheets.reduce((s, e) => s + (e.estimatedCost || 0), 0);
    set('sum-ts', hours ? hours.toFixed(1) + ' h' : '—');
    set('sum-ts-sub', hours ? `${money(cost)} · ${timesheets.length} staff` : 'no hours yet');
  }

  // ── Net profit trend ──────────────────────────
  // Each week's net profit is remembered as it's viewed, and the chart draws the
  // last few. That keeps it free — no back-fetching six weeks of Square and Xero
  // every time the dashboard loads.
  const HIST_KEY = 'bizops_week_history';

  function readHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '{}'); } catch { return {}; }
  }

  function recordWeek(weekStart, netProfit) {
    try {
      const h = readHistory();
      h[weekStart] = Math.round(netProfit);
      // Keep it small — a year of weeks is plenty.
      const keys = Object.keys(h).sort();
      while (keys.length > 52) delete h[keys.shift()];
      localStorage.setItem(HIST_KEY, JSON.stringify(h));
    } catch {}
  }

  function renderTrend(currentWeek) {
    const el = document.getElementById('trend-bars');
    if (!el) return;
    const h = readHistory();
    const weeks = Object.keys(h).sort().slice(-6);
    const hint = document.getElementById('trend-hint');

    if (weeks.length < 2) {
      el.innerHTML = '<div class="trend-empty">Browse a few weeks and the trend builds here.</div>';
      if (hint) hint.textContent = '';
      return;
    }
    const vals = weeks.map(w => h[w]);
    const peak = Math.max(...vals.map(Math.abs), 1);
    if (hint) hint.textContent = `last ${weeks.length} weeks viewed`;

    el.innerHTML = weeks.map(w => {
      const v = h[w];
      const pctH = Math.max(3, Math.round(Math.abs(v) / peak * 100));
      const d = new Date(w + 'T12:00:00');
      const cap = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      const cls = (v < 0 ? ' neg' : '') + (w === currentWeek ? ' now' : '');
      const fig = (v < 0 ? '-$' : '$') + Math.abs(Math.round(v / 100) / 10).toFixed(1) + 'k';
      return `<div class="trend-col${cls}">
        <div class="fig">${fig}</div>
        <div class="bar" style="height:${pctH}%"></div>
        <div class="cap">${cap}</div>
      </div>`;
    }).join('');
  }

  function updateSyncTime() {
    const el = document.getElementById('last-sync-time');
    if (el) {
      el.textContent = 'Updated ' + new Date().toLocaleTimeString('en-AU', {
        hour: '2-digit', minute: '2-digit'
      });
    }
  }

  function checkUpcomingHolidays() {
    const upcoming = Holidays.getUpcomingHolidays(7);
    if (upcoming.length) {
      const ph = upcoming[0];
      const label = ph.daysAway === 0 ? 'today' : ph.daysAway === 1 ? 'tomorrow' : `in ${ph.daysAway} days`;
      App.toast(`📅 ${ph.name} ${label} — public holiday rates apply`, 'warning');
    }
  }

  return { init, show, refresh, setWeek, checkUpcomingHolidays };

})();
