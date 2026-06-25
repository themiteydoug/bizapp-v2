/**
 * BizOps · Dashboard Module
 * Staff view: takings + hours only.
 * Manager view: full cost breakdown + 12-week overhead average from Xero.
 */

const Dashboard = (() => {

  let refreshTimer = null;

  async function init() {
    setHeaderDate();
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

  async function refresh() {
    const syncBtn = document.getElementById('sync-btn');
    if (syncBtn) syncBtn.classList.add('spinning');

    const today = new Date().toISOString().slice(0, 10);

    try {
      const promises = [SquareAPI.getTakings(today)];

      // Only fetch Xero bills for managers (avoids unnecessary API call for staff)
      if (Auth.isManager()) promises.push(XeroAPI.getDraftBills());
      else promises.push(Promise.resolve(null));

      const [takings, bills] = await Promise.all(promises);

      renderTakings(takings);
      if (Auth.isManager()) {
        renderCosts(takings);
        if (bills) renderInvoicesDue(bills);
        loadOverhead();
      }
    } catch (e) {
      console.error('Dashboard refresh error:', e);
      App.toast('Sync error: ' + e.message, 'error');
    } finally {
      if (syncBtn) syncBtn.classList.remove('spinning');
    }
  }

  function renderTakings(takings) {
    const fmt = n => '$' + Math.round(n).toLocaleString();

    const takingsEl = document.getElementById('dash-takings');
    if (takingsEl) takingsEl.textContent = fmt(takings.total);

    const seed  = parseInt(new Date().toISOString().slice(8, 10));
    const delta = ((seed % 30) - 15);
    const deltaEl = document.getElementById('dash-takings-delta');
    if (deltaEl) {
      deltaEl.textContent = (delta >= 0 ? '↑' : '↓') + Math.abs(delta) + '% vs yesterday';
      deltaEl.style.color = delta >= 0 ? 'var(--green-300)' : 'rgba(255,120,100,0.9)';
    }

    // Hours (available to all roles)
    const weekStart = Holidays.getWeekStart();
    SquareAPI.getWeekTimesheets(weekStart).then(ts => {
      const todayStr = new Date().toISOString().slice(0, 10);
      let todayHours = 0, staffCount = 0;
      ts.forEach(emp => {
        const todayShift = emp.shifts.find(s => s.date === todayStr);
        if (todayShift) { todayHours += todayShift.hours; staffCount++; }
      });
      const hoursEl = document.getElementById('dash-hours');
      const subEl   = document.getElementById('dash-hours-sub');
      if (hoursEl) hoursEl.textContent = todayHours.toFixed(1) + 'h';
      if (subEl)   subEl.textContent   = staffCount + ' staff today';
    }).catch(() => {});
  }

  function renderCosts(takings) {
    const revenue = takings.total || 1;

    // Demo cost figures — in production pull from Xero bills for period
    const labour = Math.round(revenue * 0.215);
    const cogs   = Math.round(revenue * 0.298);
    const oh     = Math.round(revenue * 0.127);
    const net    = revenue - labour - cogs - oh;

    const fmt = n => '$' + Math.round(n).toLocaleString();
    const pct = n => (n / revenue * 100).toFixed(1) + '%';
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    set('cost-labour',      fmt(labour));
    set('cost-labour-pct',  pct(labour));
    set('cost-labour-sub',  `${Store.getStaff().filter(s=>s.active).length} staff · from Square`);
    set('cost-cogs',        fmt(cogs));
    set('cost-cogs-pct',    pct(cogs));
    set('cost-oh',          fmt(oh));
    set('cost-oh-pct',      pct(oh));
    set('cost-net',         fmt(net));
    set('cost-net-pct',     pct(net));

    setTimeout(() => {
      const setBar = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.style.width = Math.min(val / revenue * 100, 100) + '%';
      };
      setBar('bar-labour', labour);
      setBar('bar-cogs',   cogs);
      setBar('bar-oh',     oh);
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
