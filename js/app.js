/**
 * BizOps · Main App Controller
 * Navigation, toasts, settings, role-based UI, init
 */

const App = (() => {

  const pages = ['dashboard', 'invoices', 'cash', 'timesheets', 'staff'];
  let activePage = 'dashboard';

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

    document.querySelectorAll('.manager-only').forEach(el => {
      el.style.display = isManager ? '' : 'none';
    });
    document.querySelectorAll('.staff-only').forEach(el => {
      el.style.display = isManager ? 'none' : '';
    });

    // Show role badge in header
    const roleBadge = document.getElementById('role-badge');
    if (roleBadge) {
      roleBadge.textContent = isManager ? 'Manager' : 'Staff';
      roleBadge.style.display = 'inline';
    }
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
          <span class="settings-item-value">2.0.0</span>
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

    modal.classList.add('open');
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
    // Check if we just returned from Xero OAuth redirect
    XeroAPI.checkOAuthReturn();
    XeroAPI.setupCallbackListener(); // no-op now, kept for safety

    await Auth.init();

    applyRoleUI();
    bindNav();
    bindSync();
    bindSettings();
    initPWA();

    await Dashboard.init();

    setTimeout(() => Dashboard.checkUpcomingHolidays(), 2000);

    if (CONFIG.FEATURES.DEMO_MODE) {
      setTimeout(() => toast('Demo mode — add API credentials to go live', 'warning'), 1000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  return { nav, toast, openSettings, refreshSettings, applyRoleUI };

})();
