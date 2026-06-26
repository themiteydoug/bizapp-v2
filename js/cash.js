/**
 * BizOps · Cash Reconciliation v2
 * Daily: pulls Square drawer report (starting cash, cash sales, paid in/out)
 * Weekly: Mon–Sun banking count vs Square weekly totals
 * Denomination grid split: Notes ($5+) and Coins ($2 and below)
 * GST excluded from all figures
 */

const CashModule = (() => {

  const NOTES = [
    { label: '$100', value: 100 },
    { label: '$50',  value: 50  },
    { label: '$20',  value: 20  },
    { label: '$10',  value: 10  },
    { label: '$5',   value: 5   },
  ];

  const COINS = [
    { label: '$2',   value: 2   },
    { label: '$1',   value: 1   },
    { label: '50c',  value: 0.5 },
    { label: '20c',  value: 0.2 },
    { label: '10c',  value: 0.1 },
    { label: '5c',   value: 0.05},
  ];

  let squareDrawer = { startingCash: 0, cashSales: 0, cashRefunds: 0, paidIn: 0, paidOut: 0, expectedInDrawer: 0 };
  let activeTab = 'daily';

  function init() {
    renderTabs();
    renderDailyPage();
    renderWeeklyPage();
    loadSquareDrawer();
    loadHistory();
    updateDateLabel();
  }

  // ── Tabs ──────────────────────────────────────

  function renderTabs() {
    const container = document.getElementById('cash-tabs');
    if (!container) return;
    container.innerHTML = `
      <div class="tab-bar">
        <button class="tab-btn active" id="tab-daily" onclick="CashModule.switchTab('daily')">Daily rec</button>
        <button class="tab-btn" id="tab-weekly" onclick="CashModule.switchTab('weekly')">Weekly banking</button>
      </div>
    `;
  }

  function switchTab(tab) {
    activeTab = tab;
    document.getElementById('tab-daily').classList.toggle('active', tab === 'daily');
    document.getElementById('tab-weekly').classList.toggle('active', tab === 'weekly');
    document.getElementById('cash-daily-section').style.display = tab === 'daily' ? 'block' : 'none';
    document.getElementById('cash-weekly-section').style.display = tab === 'weekly' ? 'block' : 'none';
    if (tab === 'weekly') loadWeeklyData();
  }

  function updateDateLabel() {
    const today = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
    const el = document.getElementById('cash-date-label');
    if (el) el.textContent = today;
  }

  // ── Square drawer data ────────────────────────

  async function loadSquareDrawer() {
    const syncEl = document.getElementById('sq-sync-status');
    if (syncEl) syncEl.textContent = 'Syncing…';
    try {
      const drawer = await SquareAPI.getDrawerReport();
      squareDrawer = drawer;
      renderSquarePanel();
      updateExpected();
      if (syncEl) syncEl.textContent = '';
    } catch (e) {
      console.error('Drawer load error:', e);
      if (syncEl) syncEl.textContent = 'Sync failed: ' + e.message;
    }
  }

  function renderSquarePanel() {
    const d = squareDrawer;
    const fmt = n => '$' + Math.abs(n).toFixed(2);
    setEl('sq-starting-cash', fmt(d.startingCash));
    setEl('sq-cash-sales', fmt(d.cashSales));
    setEl('sq-cash-refunds', fmt(d.cashRefunds));
    setEl('sq-paid-in',  fmt(d.paidIn));
    setEl('sq-paid-out', fmt(d.paidOut));
    setEl('sq-expected', '$' + d.expectedInDrawer.toFixed(2));
  }

  function updateExpected() {
    // Expected in drawer = Starting Cash + Cash Sales - Cash Refunds + Paid In - Paid Out
    const d = squareDrawer;
    d.expectedInDrawer = d.startingCash + d.cashSales - d.cashRefunds + d.paidIn - d.paidOut;
    setEl('sq-expected', '$' + d.expectedInDrawer.toFixed(2));
    updateVariance();
  }

  // ── Daily page ────────────────────────────────

  function renderDailyPage() {
    const section = document.getElementById('cash-daily-section');
    if (!section) return;
    section.innerHTML = `
      <!-- Square drawer panel -->
      <div class="section-label">From Square drawer report</div>
      <div class="card">
        <div class="drawer-row">
          <span class="drawer-label">Starting cash (float)</span>
          <span class="drawer-val" id="sq-starting-cash">$—</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Cash sales (ex GST)</span>
          <span class="drawer-val" id="sq-cash-sales">$—</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Cash refunds</span>
          <span class="drawer-val" id="sq-cash-refunds">$—</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Paid in</span>
          <span class="drawer-val" id="sq-paid-in">$—</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Paid out</span>
          <span class="drawer-val" id="sq-paid-out">$—</span>
        </div>
        <div class="cost-divider"></div>
        <div class="drawer-row">
          <span class="drawer-label" style="font-weight:600">Expected in drawer</span>
          <span class="drawer-val" id="sq-expected" style="font-weight:600;color:var(--green-600)">$—</span>
        </div>
      </div>

      <!-- Notes section -->
      <div class="section-label">Notes counted</div>
      <div class="card">
        <div class="denom-section-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/></svg>
          Notes ($5 and above)
        </div>
        <div class="denom-grid" id="notes-grid"></div>
        <div class="denom-subtotal">
          Notes subtotal: <span id="notes-subtotal">$0.00</span>
        </div>
      </div>

      <!-- Coins section -->
      <div class="section-label">Coins counted</div>
      <div class="card">
        <div class="denom-section-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
          Coins ($2 and below)
        </div>
        <div class="denom-grid coins-grid" id="coins-grid"></div>
        <div class="denom-subtotal">
          Coins subtotal: <span id="coins-subtotal">$0.00</span>
        </div>
      </div>

      <!-- Totals -->
      <div class="card">
        <div class="drawer-row">
          <span class="drawer-label">Notes total</span>
          <span class="drawer-val" id="total-notes">$0.00</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Coins total</span>
          <span class="drawer-val" id="total-coins">$0.00</span>
        </div>
        <div class="cost-divider"></div>
        <div class="drawer-row">
          <span class="drawer-label" style="font-weight:600">Actual in drawer</span>
          <span class="drawer-val" id="actual-total" style="font-weight:600">$0.00</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label" style="font-weight:600">Expected in drawer</span>
          <span class="drawer-val" id="expected-mirror" style="font-weight:600">$—</span>
        </div>
        <div class="cost-divider"></div>
        <div class="drawer-row">
          <span class="drawer-label" style="font-weight:700;font-size:15px">Difference</span>
          <span class="drawer-val read-field" id="cash-variance" data-state="neutral" style="font-size:15px;font-weight:700">—</span>
        </div>
      </div>

      <!-- Notes -->
      <div class="section-label">Notes</div>
      <div class="card">
        <textarea class="field-textarea" id="cash-notes" rows="3"
          placeholder="Any discrepancies, notes for the manager…"></textarea>
      </div>

      <button class="primary-btn full-btn" id="save-cash-btn">Save daily reconciliation</button>

      <div class="section-label">Recent daily recs</div>
      <div id="cash-history"></div>
    `;

    buildDenomGrid('notes-grid', NOTES, 'notes');
    buildDenomGrid('coins-grid', COINS, 'coins');
    document.getElementById('save-cash-btn')?.addEventListener('click', saveDaily);
  }

  function buildDenomGrid(containerId, denoms, type) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.innerHTML = denoms.map(d => `
      <div class="denom-item">
        <div class="denom-label">${d.label}</div>
        <div class="denom-row">
          <button class="denom-btn" onclick="CashModule.adjustDenom(this, ${d.value}, -1, '${type}')">−</button>
          <input class="denom-input" type="number" min="0" step="1"
            data-value="${d.value}" data-type="${type}"
            placeholder="0" inputmode="numeric" value="0"
            oninput="CashModule.onDenomInput(this, '${type}')">
          <button class="denom-btn" onclick="CashModule.adjustDenom(this, ${d.value}, 1, '${type}')">+</button>
          <div class="denom-value" data-val="${d.value}" data-type="${type}">$0.00</div>
        </div>
      </div>
    `).join('');
  }

  function adjustDenom(btn, val, delta, type) {
    const row = btn.closest('.denom-row');
    const input = row.querySelector('.denom-input');
    const current = parseInt(input.value) || 0;
    input.value = Math.max(0, current + delta);
    onDenomInput(input, type);
  }

  function onDenomInput(input, type) {
    const qty = parseFloat(input.value) || 0;
    const val = parseFloat(input.dataset.value);
    const subtotal = qty * val;
    const display = input.closest('.denom-row').querySelector('.denom-value');
    if (display) display.textContent = '$' + subtotal.toFixed(2);
    recalc();
  }

  function recalc() {
    let notesTotal = 0, coinsTotal = 0;
    document.querySelectorAll('.denom-input[data-type="notes"]').forEach(i => {
      notesTotal += (parseFloat(i.value) || 0) * parseFloat(i.dataset.value);
    });
    document.querySelectorAll('.denom-input[data-type="coins"]').forEach(i => {
      coinsTotal += (parseFloat(i.value) || 0) * parseFloat(i.dataset.value);
    });
    const actual = notesTotal + coinsTotal;
    setEl('notes-subtotal', '$' + notesTotal.toFixed(2));
    setEl('coins-subtotal', '$' + coinsTotal.toFixed(2));
    setEl('total-notes',    '$' + notesTotal.toFixed(2));
    setEl('total-coins',    '$' + coinsTotal.toFixed(2));
    setEl('actual-total',   '$' + actual.toFixed(2));
    setEl('expected-mirror', '$' + squareDrawer.expectedInDrawer.toFixed(2));
    renderVariance(actual, squareDrawer.expectedInDrawer);
  }

  function renderVariance(actual, expected) {
    const variance = actual - expected;
    const abs = Math.abs(variance);
    const el = document.getElementById('cash-variance');
    if (!el) return;
    if (expected === 0) { el.textContent = '—'; el.dataset.state = 'neutral'; return; }
    if (abs < 0.05) {
      el.textContent = '$0.00 — Balanced ✓';
      el.dataset.state = 'ok';
    } else if (abs <= 5) {
      el.textContent = (variance > 0 ? '+' : '−') + '$' + abs.toFixed(2) + ' (minor)';
      el.dataset.state = 'warn';
    } else {
      el.textContent = (variance > 0 ? '+' : '−') + '$' + abs.toFixed(2) + ' — Review needed';
      el.dataset.state = 'error';
    }
  }

  function updateVariance() {
    const notesEl = document.getElementById('total-notes');
    const coinsEl = document.getElementById('total-coins');
    if (!notesEl) return;
    const actual = parseFloat(notesEl.textContent.replace('$','')) + parseFloat(coinsEl?.textContent.replace('$','') || 0);
    renderVariance(actual, squareDrawer.expectedInDrawer);
    setEl('expected-mirror', '$' + squareDrawer.expectedInDrawer.toFixed(2));
  }

  function saveDaily() {
    let notesTotal = 0, coinsTotal = 0;
    const counts = {};
    document.querySelectorAll('.denom-input').forEach(i => {
      const qty = parseFloat(i.value) || 0;
      const val = parseFloat(i.dataset.value);
      counts[i.dataset.value] = qty;
      if (i.dataset.type === 'notes') notesTotal += qty * val;
      else coinsTotal += qty * val;
    });
    const actual = notesTotal + coinsTotal;
    const variance = actual - squareDrawer.expectedInDrawer;
    const notes = document.getElementById('cash-notes')?.value || '';
    Store.saveCashRec({
      type: 'daily',
      date: new Date().toISOString().slice(0, 10),
      squareDrawer: { ...squareDrawer },
      actual,
      notesTotal,
      coinsTotal,
      variance,
      denomCounts: counts,
      notes,
    });
    App.toast(Math.abs(variance) < 0.05 ? 'Daily rec saved — balanced ✓' : `Daily rec saved — difference $${Math.abs(variance).toFixed(2)}`);
    loadHistory();
  }

  // ── Weekly banking rec ────────────────────────

  let weeklyWeekStart = Holidays.getWeekStart();

  async function loadWeeklyData() {
    const weekEnd = Holidays.getWeekEnd(weeklyWeekStart);
    setEl('weekly-week-label', Holidays.formatWeekLabel(weeklyWeekStart));

    // Load Square totals for the week
    try {
      const weeklyTotals = await SquareAPI.getWeeklyTotals(weeklyWeekStart, weekEnd);
      renderWeeklySquare(weeklyTotals);
    } catch(e) {
      console.error('Weekly totals error:', e);
    }
  }

  function renderWeeklySquare(totals) {
    setEl('wk-sq-cash-sales',  '$' + totals.cashSales.toFixed(2));
    setEl('wk-sq-card-sales',  '$' + totals.cardSales.toFixed(2));
    setEl('wk-sq-total',       '$' + totals.total.toFixed(2));
    setEl('wk-sq-refunds',     '$' + totals.refunds.toFixed(2));
    setEl('wk-sq-paid-in',     '$' + totals.paidIn.toFixed(2));
    setEl('wk-sq-paid-out',    '$' + totals.paidOut.toFixed(2));
    setEl('wk-sq-net-cash',    '$' + (totals.cashSales + totals.paidIn - totals.paidOut - totals.refunds).toFixed(2));
    recalcWeekly(totals);
  }

  function recalcWeekly(squareTotals) {
    let notesTotal = 0, coinsTotal = 0;
    document.querySelectorAll('.wk-denom-input[data-type="notes"]').forEach(i => {
      notesTotal += (parseFloat(i.value) || 0) * parseFloat(i.dataset.value);
    });
    document.querySelectorAll('.wk-denom-input[data-type="coins"]').forEach(i => {
      coinsTotal += (parseFloat(i.value) || 0) * parseFloat(i.dataset.value);
    });
    const banked = notesTotal + coinsTotal;
    const netCash = squareTotals
      ? squareTotals.cashSales + squareTotals.paidIn - squareTotals.paidOut - squareTotals.refunds
      : parseFloat(document.getElementById('wk-sq-net-cash')?.textContent?.replace('$','')) || 0;
    const variance = banked - netCash;
    const abs = Math.abs(variance);

    setEl('wk-notes-total', '$' + notesTotal.toFixed(2));
    setEl('wk-coins-total', '$' + coinsTotal.toFixed(2));
    setEl('wk-banked-total', '$' + banked.toFixed(2));

    const el = document.getElementById('wk-variance');
    if (el) {
      if (abs < 0.05) { el.textContent = '$0.00 — Balanced ✓'; el.dataset.state = 'ok'; }
      else if (abs <= 20) { el.textContent = (variance > 0 ? '+' : '−') + '$' + abs.toFixed(2) + ' (minor)'; el.dataset.state = 'warn'; }
      else { el.textContent = (variance > 0 ? '+' : '−') + '$' + abs.toFixed(2) + ' — Review needed'; el.dataset.state = 'error'; }
    }
  }

  function renderWeeklyPage() {
    const section = document.getElementById('cash-weekly-section');
    if (!section) return;
    section.style.display = 'none';
    section.innerHTML = `
      <!-- Week selector -->
      <div class="week-selector" style="margin-bottom:14px">
        <button class="week-nav-btn" onclick="CashModule.weeklyNav(-1)" aria-label="Previous week">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <div class="week-info" id="weekly-week-label">Loading…</div>
        <button class="week-nav-btn" onclick="CashModule.weeklyNav(1)" aria-label="Next week">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>

      <!-- Square weekly totals -->
      <div class="section-label">Square weekly totals (ex GST)</div>
      <div class="card">
        <div class="drawer-row"><span class="drawer-label">Cash sales</span><span class="drawer-val" id="wk-sq-cash-sales">$—</span></div>
        <div class="drawer-row"><span class="drawer-label">Card sales</span><span class="drawer-val" id="wk-sq-card-sales">$—</span></div>
        <div class="drawer-row"><span class="drawer-label">Cash refunds</span><span class="drawer-val" id="wk-sq-refunds">$—</span></div>
        <div class="drawer-row"><span class="drawer-label">Paid in</span><span class="drawer-val" id="wk-sq-paid-in">$—</span></div>
        <div class="drawer-row"><span class="drawer-label">Paid out</span><span class="drawer-val" id="wk-sq-paid-out">$—</span></div>
        <div class="cost-divider"></div>
        <div class="drawer-row"><span class="drawer-label" style="font-weight:600">Total takings</span><span class="drawer-val" id="wk-sq-total" style="color:var(--green-600);font-weight:600">$—</span></div>
        <div class="drawer-row"><span class="drawer-label" style="font-weight:600">Net cash to bank</span><span class="drawer-val" id="wk-sq-net-cash" style="color:var(--green-600);font-weight:600">$—</span></div>
      </div>

      <!-- Banking count: Notes -->
      <div class="section-label">Cash banked — notes</div>
      <div class="card">
        <div class="denom-section-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/></svg>
          Notes ($5 and above)
        </div>
        <div class="denom-grid" id="wk-notes-grid"></div>
        <div class="denom-subtotal">Notes subtotal: <span id="wk-notes-total">$0.00</span></div>
      </div>

      <!-- Banking count: Coins -->
      <div class="section-label">Cash banked — coins</div>
      <div class="card">
        <div class="denom-section-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>
          Coins ($2 and below)
        </div>
        <div class="denom-grid coins-grid" id="wk-coins-grid"></div>
        <div class="denom-subtotal">Coins subtotal: <span id="wk-coins-total">$0.00</span></div>
      </div>

      <!-- Weekly variance -->
      <div class="card">
        <div class="drawer-row"><span class="drawer-label" style="font-weight:600">Total banked</span><span class="drawer-val" id="wk-banked-total" style="font-weight:600">$0.00</span></div>
        <div class="drawer-row"><span class="drawer-label" style="font-weight:600">Expected (net cash)</span><span class="drawer-val" id="wk-sq-net-cash-mirror" style="font-weight:600">$—</span></div>
        <div class="cost-divider"></div>
        <div class="drawer-row">
          <span class="drawer-label" style="font-weight:700;font-size:15px">Difference</span>
          <span class="read-field drawer-val" id="wk-variance" data-state="neutral" style="font-size:15px;font-weight:700">—</span>
        </div>
      </div>

      <div class="section-label">Notes</div>
      <div class="card">
        <textarea class="field-textarea" id="wk-notes" rows="3"
          placeholder="Banking notes, discrepancies…"></textarea>
      </div>

      <button class="primary-btn full-btn" id="save-weekly-btn">Save weekly banking rec</button>
    `;

    buildWeeklyDenomGrid('wk-notes-grid', NOTES, 'notes');
    buildWeeklyDenomGrid('wk-coins-grid', COINS, 'coins');
    document.getElementById('save-weekly-btn')?.addEventListener('click', saveWeekly);
  }

  function buildWeeklyDenomGrid(containerId, denoms, type) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.innerHTML = denoms.map(d => `
      <div class="denom-item">
        <div class="denom-label">${d.label}</div>
        <div class="denom-row">
          <button class="denom-btn" onclick="CashModule.adjustWeeklyDenom(this, ${d.value}, -1, '${type}')">−</button>
          <input class="wk-denom-input denom-input" type="number" min="0" step="1"
            data-value="${d.value}" data-type="${type}"
            placeholder="0" inputmode="numeric" value="0"
            oninput="CashModule.onWeeklyDenomInput(this)">
          <button class="denom-btn" onclick="CashModule.adjustWeeklyDenom(this, ${d.value}, 1, '${type}')">+</button>
          <div class="denom-value" data-val="${d.value}">$0.00</div>
        </div>
      </div>
    `).join('');
  }

  function adjustWeeklyDenom(btn, val, delta, type) {
    const row = btn.closest('.denom-row');
    const input = row.querySelector('.wk-denom-input');
    input.value = Math.max(0, (parseInt(input.value) || 0) + delta);
    onWeeklyDenomInput(input);
  }

  function onWeeklyDenomInput(input) {
    const qty = parseFloat(input.value) || 0;
    const val = parseFloat(input.dataset.value);
    const display = input.closest('.denom-row').querySelector('.denom-value');
    if (display) display.textContent = '$' + (qty * val).toFixed(2);
    recalcWeekly(null);
    // sync mirror
    const mirror = document.getElementById('wk-sq-net-cash-mirror');
    const src = document.getElementById('wk-sq-net-cash');
    if (mirror && src) mirror.textContent = src.textContent;
  }

  function weeklyNav(dir) {
    const d = new Date(weeklyWeekStart + 'T12:00:00');
    d.setDate(d.getDate() + dir * 7);
    const next = d.toISOString().slice(0, 10);
    if (next > new Date().toISOString().slice(0, 10)) return;
    weeklyWeekStart = next;
    loadWeeklyData();
  }

  function saveWeekly() {
    let notesTotal = 0, coinsTotal = 0;
    const counts = {};
    document.querySelectorAll('.wk-denom-input').forEach(i => {
      const qty = parseFloat(i.value) || 0;
      const val = parseFloat(i.dataset.value);
      counts[i.dataset.value] = qty;
      if (i.dataset.type === 'notes') notesTotal += qty * val;
      else coinsTotal += qty * val;
    });
    const banked = notesTotal + coinsTotal;
    const netCash = parseFloat(document.getElementById('wk-sq-net-cash')?.textContent?.replace('$','')) || 0;
    const variance = banked - netCash;
    Store.saveCashRec({
      type: 'weekly',
      weekStart: weeklyWeekStart,
      weekEnd: Holidays.getWeekEnd(weeklyWeekStart),
      date: new Date().toISOString().slice(0, 10),
      banked,
      notesTotal,
      coinsTotal,
      netCashExpected: netCash,
      variance,
      denomCounts: counts,
      notes: document.getElementById('wk-notes')?.value || '',
    });
    App.toast(Math.abs(variance) < 0.05 ? 'Weekly banking saved — balanced ✓' : `Weekly banking saved — difference $${Math.abs(variance).toFixed(2)}`);
  }

  // ── History ────────────────────────────────────

  function loadHistory() {
    const list = document.getElementById('cash-history');
    if (!list) return;
    const recs = Store.getCashRecs().filter(r => r.type === 'daily').slice(0, 5);
    if (!recs.length) { list.innerHTML = '<div class="empty-state">No previous records</div>'; return; }
    list.innerHTML = recs.map(r => {
      const d = new Date(r.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      const abs = Math.abs(r.variance || 0);
      const cls = abs < 0.05 ? 'badge-ok' : abs <= 5 ? 'badge-warn' : 'badge-error';
      const txt = abs < 0.05 ? 'Balanced' : (r.variance > 0 ? '+' : '−') + '$' + abs.toFixed(2);
      return `<div class="card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;font-weight:500">${d}</span>
          <span class="badge ${cls}">${txt}</span>
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-top:5px">
          Expected $${(r.squareDrawer?.expectedInDrawer||0).toFixed(2)} · Actual $${(r.actual||0).toFixed(2)}
        </div>
      </div>`;
    }).join('');
  }

  // ── Helpers ───────────────────────────────────

  function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  return { init, switchTab, adjustDenom, onDenomInput, adjustWeeklyDenom, onWeeklyDenomInput, weeklyNav };

})();
