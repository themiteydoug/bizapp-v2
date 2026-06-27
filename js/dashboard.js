/**
 * BizOps · Dashboard Module
 * Staff view: takings + hours only.
 * Manager view: full cost breakdown + weekly overhead average from Xero.
 */

const Dashboard = (() => {

  let refreshTimer = null;
  let currentWeekStart = Holidays.getWeekStart();

  async function init() {
    setHeaderDate();
    bindWeekNav();
    await refresh();
    refreshTimer = setInterval(refresh, 5 * 60 * 1000);
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
      updateWeekLabel();
      refresh();
    });
    updateWeekLabel();
  }

  function updateWeekLabel() {
    const el = document.getElementById('dash-week-label');
    if (el) el.textContent = Holidays.formatWeekLabel(currentWeekStart);
  }

  async function refresh() {
    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) syncBtn.classList.add('spinning');

    const weekEnd = Holidays.getWeekEnd(currentWeekStart);

    try {
      const isManager = Auth.isManager();

      const [weekTotals, timesheets, overhead] = await Promise.all([
        SquareAPI.getWeeklyTotals(currentWeekStart, weekEnd),
        SquareAPI.getWeekTimesheets(currentWeekStart),
        (isManager && XeroAPI.isConnected())
          ? XeroAPI.getOverheadAverage(currentWeekStart).catch(e => {
              console.warn('Xero overhead error:', e.message);
              return null;
            })
          : Promise.resolve(null),
      ]);

      renderMetrics(weekTotals, timesheets, overhead, currentWeekStart, weekEnd);
    } catch (e) {
      console.error('Dashboard refresh error:', e);
      App.toast('Sync error: ' + e.message, 'error');
    } finally {
      if (syncBtn) syncBtn.classList.remove('spinning');
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

    const gross    = weekTotals.total || 0;
    const gst      = weekTotals.gst || 0;
    const netSales = gross - gst;                  // ex-GST — denominator for all %
    const pct      = n => netSales > 0 ? (n / netSales * 100).toFixed(1) + '% of net sales' : '—';

    const staffCost = timesheets.reduce((s, emp) => s + (emp.estimatedCost || 0), 0);

    const weekInvoices = Store.getInvoices().filter(inv => inv.date >= weekStart && inv.date <= weekEnd);
    const cogs = weekInvoices.reduce((s, inv) => s + (inv.subtotal || 0), 0);   // ex-GST

    const overheadWk = overhead?.weeklyAverage || 0;
    const netProfit  = netSales - staffCost - cogs - overheadWk;

    // Tile 1 — Weekly sales (display gross; show GST + transactions underneath)
    set('dash-takings',       fmt(gross));
    set('dash-takings-delta', weekTotals.transactions ? weekTotals.transactions + ' transactions' : '');
    set('dash-gst',           gst > 0 ? 'incl. ' + fmtAud(gst) + ' GST' : '');

    // Tile 2 — Total staff cost
    set('dash-staff-cost', staffCost > 0 ? fmt(staffCost) : '—');
    set('dash-staff-pct',  staffCost > 0 ? pct(staffCost) : timesheets.length + ' staff');

    // Tile 3 — Invoices (COGS, ex-GST)
    set('dash-cogs-amt', cogs > 0 ? fmt(cogs) : '$—');
    set('dash-cogs-pct', cogs > 0 ? pct(cogs)
      : (weekInvoices.length ? '—' : 'No invoices this week'));

    // Tile 4 — Overheads (weekly average from Xero)
    if (overhead) {
      set('dash-oh-amt', fmtAud(overheadWk));
      set('dash-oh-sub', overhead.note ? overhead.note : `avg/wk · ${overhead.weeks || '—'} wks`);
    } else {
      set('dash-oh-amt', '$—');
      set('dash-oh-sub', XeroAPI.isConnected() ? 'avg per week' : 'Connect Xero');
    }

    // Net profit
    set('dash-net',     netSales > 0 ? fmt(netProfit) : '$—');
    set('dash-net-pct', netSales > 0 ? pct(netProfit) : '— of net sales');
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

  return { init, refresh, checkUpcomingHolidays };

})();
