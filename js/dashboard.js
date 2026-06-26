/**
 * BizOps · Dashboard Module
 * Staff view: takings + hours only.
 * Manager view: full cost breakdown + 12-week overhead average from Xero.
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
      const [weekTotals, timesheets] = await Promise.all([
        SquareAPI.getWeeklyTotals(currentWeekStart, weekEnd),
        SquareAPI.getWeekTimesheets(currentWeekStart),
      ]);

      renderWeeklyHero(weekTotals, timesheets);

      if (Auth.isManager()) {
        renderCosts(weekTotals, timesheets, currentWeekStart, weekEnd);

        if (XeroAPI.isConnected()) {
          XeroAPI.getDraftBills()
            .then(bills => { if (bills) renderInvoicesDue(bills); })
            .catch(e => {
              console.warn('Xero bills error:', e.message);
              if (!e.message.includes('session expired') && !e.message.includes('Not connected')) {
                App.toast('Xero: ' + e.message, 'error');
              }
            });
          loadOverhead();
        }
      }
    } catch (e) {
      console.error('Dashboard refresh error:', e);
      App.toast('Sync error: ' + e.message, 'error');
    } finally {
      if (syncBtn) syncBtn.classList.remove('spinning');
      updateSyncTime();
    }
  }

  function renderWeeklyHero(weekTotals, timesheets) {
    const fmt = n => '$' + Math.round(n).toLocaleString();
    const revenue = weekTotals.total || 0;

    const totalHours = timesheets.reduce((s, emp) => s + emp.totalHours, 0);
    const staffCost  = timesheets.reduce((s, emp) => s + (emp.estimatedCost || 0), 0);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('dash-takings',      fmt(revenue));
    set('dash-takings-delta', weekTotals.transactions ? weekTotals.transactions + ' transactions' : '');
    set('dash-staff-cost',   staffCost > 0 ? fmt(staffCost) : '—');
    set('dash-staff-pct',    revenue > 0 && staffCost > 0 ? (staffCost / revenue * 100).toFixed(1) + '% of sales' : timesheets.length + ' staff');
    set('dash-labour-pct',   revenue > 0 && staffCost > 0 ? (staffCost / revenue * 100).toFixed(1) + '%' : '—%');
    set('dash-labour-amt',   staffCost > 0 ? fmt(staffCost) : '$—');

    // COGS from week invoices
    const weekEnd = Holidays.getWeekEnd(currentWeekStart);
    const weekInvoices = Store.getInvoices().filter(inv => inv.date >= currentWeekStart && inv.date <= weekEnd);
    const cogs = Math.round(weekInvoices.reduce((s, inv) => s + (inv.subtotal || 0), 0));
    set('dash-cogs-pct', revenue > 0 && cogs > 0 ? (cogs / revenue * 100).toFixed(1) + '%' : '—%');
    set('dash-cogs-amt', cogs > 0 ? fmt(cogs) : '$—');
  }

  /**
   * renderCosts — real data only, no hardcoded percentages.
   *  Labour: Square timesheet hours × $28/hr blended estimate (Fast Food Award L1 casual weekday)
   *  COGS:   sum of today's scanned invoices from local store
   *  Overhead row removed from daily view — see 12-week Xero section below
   */
  function renderCosts(weekTotals, timesheets, weekStart, weekEnd) {
    const revenue = weekTotals.total || 0;

    const totalHours = timesheets.reduce((s, emp) => s + emp.totalHours, 0);
    const labour = timesheets.reduce((s, emp) => s + (emp.estimatedCost || 0), 0);

    const weekInvoices = Store.getInvoices().filter(inv => inv.date >= weekStart && inv.date <= weekEnd);
    const cogs = Math.round(weekInvoices.reduce((sum, inv) => sum + (inv.subtotal || 0), 0));

    const net = revenue - labour - cogs;

    const fmt = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString();
    const pct = n => revenue > 0 ? (n / revenue * 100).toFixed(1) + '%' : '—';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    const labourSub = totalHours > 0
      ? `${totalHours.toFixed(1)}h · actual Square rates`
      : 'No Square timecards this week';
    const cogsSub = weekInvoices.length > 0
      ? `${weekInvoices.length} invoice${weekInvoices.length > 1 ? 's' : ''} this week`
      : 'Scan invoices to track COGS';

    set('cost-labour',     fmt(labour));
    set('cost-labour-pct', pct(labour));
    set('cost-labour-sub', labourSub);
    set('cost-cogs',       fmt(cogs));
    set('cost-cogs-pct',   pct(cogs));
    set('cost-cogs-sub',   cogsSub);
    const ohRow = document.getElementById('cost-oh-row');
    const ohBar = document.getElementById('bar-oh-wrap');
    if (ohRow) ohRow.style.display = 'none';
    if (ohBar) ohBar.style.display = 'none';
    set('cost-net',     fmt(net));
    set('cost-net-pct', pct(net));

    setTimeout(() => {
      const setBar = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.style.width = revenue > 0 ? Math.min(Math.max(val, 0) / revenue * 100, 100) + '%' : '0%';
      };
      setBar('bar-labour', labour);
      setBar('bar-cogs',   cogs);
    }, 80);
  }

  function renderInvoicesDue(bills) {
    const list  = document.getElementById('invoices-due-list');
    if (!list) return;

    const today = new Date();
    const inWeek = bills.filter(b => {
      if (!b.dueDate) return false;
      const diff = (new Date(b.dueDate) - today) / 86400000;
      return diff >= -1 && diff <= 7;
    });

    if (!inWeek.length) {
      list.innerHTML = '<div class="empty-state">No invoices due this week</div>';
      return;
    }

    list.innerHTML = inWeek.map(b => {
      const due      = b.dueDate ? new Date(b.dueDate + 'T12:00:00') : null;
      const dueLabel = due ? due.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '—';
      const isOverdue = due && due < today;
      const statusClass = isOverdue ? 'status-overdue' : b.status === 'DRAFT' ? 'status-draft' : 'status-synced';
      const statusLabel = isOverdue ? 'Overdue' : b.status === 'DRAFT' ? 'Draft' : 'Approved';
      return `
        <div class="invoice-item">
          <div class="invoice-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          </div>
          <div class="invoice-info">
            <div class="invoice-supplier">${b.supplier || 'Unknown supplier'}</div>
            <div class="invoice-meta">Due ${dueLabel} · ${b.invoiceNo || '—'}</div>
          </div>
          <div class="invoice-right">
            <div class="invoice-amount">$${(b.amount || 0).toFixed(2)}</div>
            <span class="invoice-status ${statusClass}">${statusLabel}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // ── 12-week overhead average (manager only) ───

  async function loadOverhead() {
    const card = document.getElementById('overhead-card');
    if (!card) return;

    card.innerHTML = '<div class="empty-state">Loading from Xero…</div>';

    try {
      const weekStart = Holidays.getWeekStart();
      const data = await XeroAPI.getOverheadAverage(weekStart);
      renderOverhead(data);
    } catch (e) {
      card.innerHTML = `<div class="empty-state" style="color:var(--red-500)">Could not load overhead data: ${e.message}</div>`;
    }
  }

  function renderOverhead(data) {
    const card = document.getElementById('overhead-card');
    if (!card) return;

    const fmt = n => '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

    const rows = (data.breakdown || []).map(item => `
      <div class="cost-row" style="padding:8px 0">
        <div class="cost-info">
          <div class="cost-name" style="font-size:13px">${item.name}</div>
        </div>
        <div class="cost-right">
          <div class="cost-amount" style="font-size:13px">${fmt(item.weekly)}<span style="color:var(--text-3);font-size:11px">/wk</span></div>
        </div>
      </div>
    `).join('<div style="height:1px;background:var(--border);margin:0 -16px"></div>');

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">
        <div>
          <div style="font-size:24px;font-weight:700;color:var(--text-1)">${fmt(data.weeklyAverage)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px">avg per week (ex wages &amp; super)</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:13px;font-weight:500;color:var(--text-2)">${fmt(data.total12Weeks)}</div>
          <div style="font-size:11px;color:var(--text-3)">12-week total</div>
        </div>
      </div>

      <div style="font-size:11px;color:var(--text-3);margin-bottom:10px">
        ${fmtDate(data.fromDate)} – ${fmtDate(data.toDate)}
        ${data.note ? `· <em>${data.note}</em>` : ''}
      </div>

      ${rows ? `
        <div style="border-top:1px solid var(--border);padding-top:4px">
          ${rows}
        </div>
      ` : '<div class="empty-state">No overhead data found</div>'}
    `;
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
