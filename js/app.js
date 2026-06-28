/**
 * BizOps · Main App Controller
 * Navigation, toasts, settings, role-based UI, init
 */

const App = (() => {

  const pages = ['dashboard', 'invoices', 'cash', 'timesheets', 'staff'];
  let activePage = 'dashboard';

  // Shared selected week (Monday ISO date) so the chosen week persists across
  // tabs for like-for-like comparisons. Defaults to the current week.
  let selectedWeek = null;
  function getWeek() { return selectedWeek || Holidays.getWeekStart(); }
  function setWeek(weekStart) { if (weekStart) selectedWeek = weekStart; }

  // ── Navigation ────────────────────────────────

  function nav(page) {
    if (!pages.includes(page)) return;
    activePage = page;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById('page-' + page);
    if (target) target.classList.add('active');

    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === page);
    });

    if (page === 'dashboard')  Dashboard.show();
    if (page === 'cash')       CashModule.init();
    if (page === 'timesheets') TimesheetsModule.init();
    if (page === 'staff')      StaffModule.init();
    if (page === 'invoices')   InvoiceModule.init();
  }

  // ── Toast notifications ───────────────────────

  function toast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const t = document.createElement('div');
    t.className = `toast ${type !== 'success' ? type : ''}`;
    const icon = type === 'error' ? '✕' : type === 'warning' ? '⚠' : '✓';
    t.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    container.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ── Role-based UI ─────────────────────────────

  /**
   * Show/hide elements based on current role.
   * Elements with class 'manager-only' are hidden for staff.
   * Elements with class 'staff-only' are hidden for managers.
   * Also applies 'role-manager' or 'role-staff' class to <body>
   * so CSS can handle additional hiding via selectors.
   */
  function applyRoleUI() {
    const isManager = Auth.isManager();
    document.body.classList.toggle('role-manager', isManager);
    document.body.classList.toggle('role-staff',   !isManager);

    // Visibility is driven entirely by the body.role-* classes above + the
    // CSS rules in index.html, so element display types (grid/block) are
    // preserved. No per-element inline display manipulation needed.

    // Show role badge in header
    const roleBadge = document.getElementById('role-badge');
    if (roleBadge) {
      roleBadge.textContent = isManager ? 'Manager' : 'Staff';
      roleBadge.style.display = 'inline';
    }
  }

  // Called by Sync to reflect live-sync connectivity in the header badge.
  function onSyncStatus(isConnected) {
    const wrap = document.getElementById('sync-status');
    const dot  = wrap?.querySelector('.sync-dot');
    const txt  = document.getElementById('sync-status-text');
    if (!wrap || !dot || !txt) return;
    wrap.style.display = 'flex';
    dot.classList.toggle('connected', !!isConnected);
    dot.classList.toggle('offline', !isConnected);
    txt.textContent = isConnected ? 'Synced' : 'Offline';
  }

  // Called by Sync when the shared data changed — re-render the current view
  // from the freshly-merged local cache so updates from other devices show.
  function onDataChanged() {
    try {
      if (activePage === 'invoices')  InvoiceModule.reloadList?.();
      if (activePage === 'dashboard') Dashboard.refresh?.();
    } catch (e) { console.warn('onDataChanged', e); }
  }

  // ── Settings modal ────────────────────────────

  function refreshSettings() {
    const modal = document.getElementById('modal-settings');
    if (modal?.classList.contains('open')) openSettings();
  }

  function openSettings() {
    const modal = document.getElementById('modal-settings');
    const body  = document.getElementById('settings-modal-body');
    const s     = Store.getSettings();
    const isDemo = CONFIG.FEATURES.DEMO_MODE;
    const isManager = Auth.isManager();

    const xeroConnected = XeroAPI.isConnected();

    body.innerHTML = `
      <div class="settings-group">
        <div class="settings-group-label">Connection status</div>
        <div class="settings-item">
          <span class="settings-item-label">Square</span>
          <span class="settings-item-value" style="color:${isDemo?'var(--amber-800)':'var(--green-600)'}">
            ${isDemo ? 'Demo mode' : 'Connected'}
          </span>
        </div>
        <div class="settings-item">
          <span class="settings-item-label">Xero</span>
          <span class="settings-item-value" style="color:${isDemo?'var(--amber-800)': xeroConnected?'var(--green-600)':'var(--red-800)'}">
            ${isDemo ? 'Demo mode' : xeroConnected ? 'Connected' : 'Not connected'}
          </span>
        </div>
        ${!isDemo && !xeroConnected ? `
          <div class="settings-item">
            <button class="primary-btn" style="height:38px;font-size:13px" data-action="xero-connect">Connect Xero</button>
          </div>
        ` : ''}
        ${!isDemo && xeroConnected ? `
          <div class="settings-item">
            <button class="secondary-btn" style="height:38px;font-size:13px" data-action="xero-connect">Re-connect Xero</button>
          </div>
        ` : ''}
      </div>

      ${isManager && !isDemo && xeroConnected ? `
        <div class="settings-group">
          <div class="settings-group-label">Xero payroll data (discovery)</div>
          <div class="settings-item">
            <button class="secondary-btn" style="height:38px;font-size:13px" data-action="inspect-xero">Inspect pay items &amp; base rates</button>
          </div>
          <div id="xero-inspect-out" style="font-size:12px;color:var(--text-2);line-height:1.5"></div>
        </div>
      ` : ''}

      <div class="settings-group">
        <div class="settings-group-label">Business</div>
        <div class="settings-item">
          <span class="settings-item-label">Business name</span>
          <span class="settings-item-value">${s.businessName}</span>
        </div>
        <div class="settings-item">
          <span class="settings-item-label">Award</span>
          <span class="settings-item-value">Fast Food Award · MA000003</span>
        </div>
        <div class="settings-item">
          <span class="settings-item-label">State</span>
          <span class="settings-item-value">QLD</span>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-label">Public holidays</div>
        <div class="settings-item">
          <span class="settings-item-label">Royal Queensland Show (Ekka)</span>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="ekka-toggle" ${s.ekkaBrisbane ? 'checked' : ''}>
            <span class="settings-item-value">${s.ekkaBrisbane ? 'Observed' : 'Not observed'}</span>
          </label>
        </div>
        <div class="settings-item">
          <span class="settings-item-label">Holiday calendar</span>
          <span class="settings-item-value">QLD 2024–2026</span>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-label">Cash reconciliation</div>
        <div class="settings-item">
          <span class="settings-item-label">Default float</span>
          <span class="settings-item-value">$${s.floatDefault}</span>
        </div>
      </div>

      ${isManager ? `
      <div class="settings-group">
        <div class="settings-group-label">Invoices</div>
        <div class="settings-item">
          <span class="settings-item-label">Send invoices to Xero</span>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="send-xero-toggle" ${s.sendToXero !== false ? 'checked' : ''}>
            <span class="settings-item-value">${s.sendToXero !== false ? 'On' : 'Off'}</span>
          </label>
        </div>
        <div class="settings-item" style="font-size:11px;color:var(--text-3);line-height:1.5">
          Turn off if your bills already reach Xero another way (e.g. email forwarding) so the app doesn't create duplicate drafts. Invoices are still recorded here for cost reporting.
        </div>
        <div class="settings-item">
          <span class="settings-item-label">Auto-read invoice details</span>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="auto-ocr-toggle" ${s.autoOcr !== false ? 'checked' : ''}>
            <span class="settings-item-value">${s.autoOcr !== false ? 'On' : 'Off'}</span>
          </label>
        </div>
        <div class="settings-item" style="font-size:11px;color:var(--text-3);line-height:1.5">
          Reads supplier, total and GST from a photo automatically. Uses a paid AI service (a fraction of a cent per scan). Turn off to type details in manually.
        </div>
      </div>` : ''}

      <div class="settings-group">
        <div class="settings-group-label">Session</div>
        <div class="settings-item">
          <span class="settings-item-label">Role</span>
          <span class="settings-item-value" style="color:${isManager?'var(--green-600)':'var(--text-2)'}">
            ${isManager ? 'Manager' : 'Staff'}
          </span>
        </div>
        <div class="settings-item">
          <span class="settings-item-label">Log out</span>
          <button data-action="logout"
            style="background:none;border:none;color:var(--red-500);font-size:13px;font-weight:500;cursor:pointer">
            Log out
          </button>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-label">About</div>
        <div class="settings-item">
          <span class="settings-item-label">Version</span>
          <span class="settings-item-value">v${CONFIG.VERSION} · build ${CONFIG.BUILD}</span>
        </div>
        <div class="settings-item">
          <span class="settings-item-label">Mode</span>
          <span class="settings-item-value">${isDemo ? '⚠ Demo (no real data)' : 'Live'}</span>
        </div>
        ${isDemo ? `
          <div style="background:var(--amber-100);border-radius:var(--r-md);padding:12px;font-size:12px;color:var(--amber-800);line-height:1.5;margin-top:8px">
            Demo mode active. Set Netlify environment variables and set <code>DEMO_MODE: false</code> in js/config.js to go live.
          </div>
        ` : ''}
      </div>
    `;

    // Bind settings actions (CSP-safe — no inline onclick)
    body.querySelector('[data-action="xero-connect"]')
      ?.addEventListener('click', () => XeroAPI.startOAuthFlow());
    body.querySelector('[data-action="logout"]')
      ?.addEventListener('click', () => {
        modal.classList.remove('open');
        Auth.logout();
      });
    body.querySelector('#ekka-toggle')
      ?.addEventListener('change', function () {
        Store.saveSetting('ekkaBrisbane', this.checked);
        App.toast('Ekka holiday ' + (this.checked ? 'enabled' : 'disabled'));
      });
    body.querySelector('#send-xero-toggle')
      ?.addEventListener('change', function () {
        Store.saveSetting('sendToXero', this.checked);
        App.toast('Send invoices to Xero ' + (this.checked ? 'on' : 'off'));
        InvoiceModule.updateSaveButtonLabel?.();   // reflect on the invoice form's button
        refreshSettings();
      });
    body.querySelector('#auto-ocr-toggle')
      ?.addEventListener('change', function () {
        Store.saveSetting('autoOcr', this.checked);
        App.toast('Auto-read invoices ' + (this.checked ? 'on' : 'off'));
        refreshSettings();
      });
    body.querySelector('[data-action="inspect-xero"]')
      ?.addEventListener('click', inspectXero);

    modal.classList.add('open');
  }

  // ── Xero payroll discovery ────────────────────

  async function inspectXero() {
    const out = document.getElementById('xero-inspect-out');
    if (!out) return;
    out.innerHTML = '<div style="padding:8px 0">Loading from Xero…</div>';
    try {
      const d = await XeroAPI.inspectPayroll();
      const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const row = (l, r) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-bottom:1px solid var(--border)"><span>${l}</span><span style="color:var(--text-3);white-space:nowrap;text-align:right">${r}</span></div>`;

      const rateDetail = r => {
        const rt = String(r.rateType || '').toUpperCase();
        if (rt.includes('MULTIPLE')) return r.multiplier != null ? `× ${r.multiplier}` : '× ?';
        if (rt.includes('RATEPERUNIT')) return r.ratePerUnit != null ? '$' + r.ratePerUnit + '/hr' : 'per-employee';
        if (rt.includes('FIXED')) return r.ratePerUnit != null ? '$' + r.ratePerUnit : 'fixed';
        return r.rateType || '—';
      };

      const rates = d.earningsRates.map(r => row(esc(r.name), esc(rateDetail(r)))).join('') || '<em>none</em>';
      const emps  = d.employees.map(e => {
        const meta = [e.payType, e.basis, e.level != null ? 'L' + e.level : null].filter(Boolean).join(' · ');
        const right = e.weeklyCost != null ? '$' + e.weeklyCost + '/wk (salary)'
          : (e.baseRate != null ? '$' + e.baseRate + '/hr' : '—');
        return row(`${esc(e.name)} <em style="color:var(--text-3)">${esc(meta)}</em>`, esc(right));
      }).join('') || '<em>none</em>';

      const rawJson = esc(JSON.stringify(d.raw, null, 2));

      out.innerHTML = `
        <div style="margin-top:8px;font-weight:600;color:var(--text-1)">Earnings rates (${d.earningsRates.length})</div>
        ${rates}
        <div style="margin-top:14px;font-weight:600;color:var(--text-1)">Employees — base rate (${d.employees.length})</div>
        ${emps}
        <div style="margin-top:14px;font-weight:600;color:var(--text-1)">Raw sample (for mapping)</div>
        <pre style="white-space:pre-wrap;word-break:break-word;font-size:10px;background:var(--surface-2);padding:8px;border-radius:6px;margin-top:6px">${rawJson}</pre>
        <div style="margin-top:10px;color:var(--text-3)">Full detail also logged to the browser console.</div>
      `;
    } catch (err) {
      out.innerHTML = `<div style="padding:8px 0;color:var(--red-500)">Error: ${err.message}</div>`;
    }
  }

  // ── Sync button ───────────────────────────────

  function bindSync() {
    document.getElementById('sync-btn')?.addEventListener('click', () => {
      if (activePage === 'dashboard') Dashboard.refresh();
      else toast('Syncing…');
    });
  }

  // ── Bottom nav ────────────────────────────────

  function bindNav() {
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.addEventListener('click', () => nav(btn.dataset.page));
    });
  }

  // ── Settings ──────────────────────────────────

  function bindSettings() {
    document.getElementById('settings-btn')?.addEventListener('click', openSettings);
    document.getElementById('close-settings-modal')?.addEventListener('click', () => {
      document.getElementById('modal-settings').classList.remove('open');
    });
    document.getElementById('modal-settings')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) e.target.classList.remove('open');
    });
  }

  // ── PWA ───────────────────────────────────────

  function initPWA() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // ── Boot ──────────────────────────────────────

  async function boot() {
    await Auth.init();

    applyRoleUI();
    bindNav();
    bindSync();
    bindSettings();
    initPWA();

    await Dashboard.init();

    // Start live cross-device sync (no-op if KV isn't configured).
    Sync.init();

    setTimeout(() => Dashboard.checkUpcomingHolidays(), 2000);

    if (CONFIG.FEATURES.DEMO_MODE) {
      setTimeout(() => toast('Demo mode — add API credentials to go live', 'warning'), 1000);
    }

    // Must run after everything is initialised so toast/settings/dashboard are ready.
    // Also restores the PIN session if we just returned from a Xero OAuth redirect.
    XeroAPI.checkOAuthReturn();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return { nav, toast, openSettings, refreshSettings, applyRoleUI, getWeek, setWeek, onDataChanged, onSyncStatus };

})();
