/**
 * BizOps · Cash Reconciliation
 * Daily: count denominations → actual cash to bank (total minus $300 float)
 * Weekly: sum of daily actuals vs Square weekly cash sales
 */

const CashModule = (() => {

  const FLOAT = CONFIG.BUSINESS.FLOAT_DEFAULT || 300;

  const NOTES = [
    { label: '$100', value: 100 },
    { label: '$50',  value: 50  },
    { label: '$20',  value: 20  },
    { label: '$10',  value: 10  },
    { label: '$5',   value: 5   },
  ];

  const COINS = [
    { label: '$2',   value: 2    },
    { label: '$1',   value: 1    },
    { label: '50c',  value: 0.5  },
    { label: '20c',  value: 0.2  },
    { label: '10c',  value: 0.1  },
    { label: '5c',   value: 0.05 },
  ];

  let activeTab = 'daily';

  function init() {
    renderTabs();
    renderDailyPage();
    renderWeeklyPage();
    updateDateLabel();
  }

  // ── Tabs ──────────────────────────────────────

  function renderTabs() {
    const container = document.getElementById('cash-tabs');
    if (!container) return;
    container.innerHTML = `
      <div class="tab-bar">
        <button class="tab-btn active" id="tab-daily">Daily rec</button>
        <button class="tab-btn"        id="tab-weekly">Weekly banking</button>
      </div>
    `;
    container.querySelector('#tab-daily').addEventListener('click',  () => switchTab('daily'));
    container.querySelector('#tab-weekly').addEventListener('click', () => switchTab('weekly'));
  }

  function switchTab(tab) {
    activeTab = tab;
    document.getElementById('tab-daily').classList.toggle('active',  tab === 'daily');
    document.getElementById('tab-weekly').classList.toggle('active', tab === 'weekly');
    document.getElementById('cash-daily-section').style.display  = tab === 'daily'  ? 'block' : 'none';
    document.getElementById('cash-weekly-section').style.display = tab === 'weekly' ? 'block' : 'none';
    if (tab === 'weekly') loadWeeklyData();
  }

  function updateDateLabel() {
    const el = document.getElementById('cash-date-label');
    if (el) el.textContent = new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ── Daily page ────────────────────────────────

  function renderDailyPage() {
    const section = document.getElementById('cash-daily-section');
    if (!section) return;
    section.innerHTML = `
      <!-- Notes -->
      <div class="section-label">Notes counted</div>
      <div class="card">
        <div class="denom-section-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/></svg>
          Notes ($5 and above)
        </div>
        <div class="denom-grid" id="notes-grid"></div>
        <div class="denom-subtotal">Notes subtotal: <span id="notes-subtotal">$0.00</span></div>
      </div>

      <!-- Coins -->
      <div class="section-label">Coins counted</div>
      <div class="card">
        <div class="denom-section-head">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>
          Coins ($2 and below)
        </div>
        <div class="denom-grid coins-grid" id="coins-grid"></div>
        <div class="denom-subtotal">Coins subtotal: <span id="coins-subtotal">$0.00</span></div>
      </div>

      <!-- Totals -->
      <div class="card">
        <div class="drawer-row">
          <span class="drawer-label">Total cash in drawer</span>
          <span class="drawer-val" id="actual-total">$0.00</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Less float</span>
          <span class="drawer-val" style="color:var(--text-3)">−$${FLOAT.toFixed(2)}</span>
        </div>
        <div class="cost-divider"></div>
        <div class="drawer-row">
          <span class="drawer-label" style="font-weight:700;font-size:15px">Actual cash (to bank)</span>
          <span class="drawer-val" id="cash-to-bank" style="font-size:15px;font-weight:700;color:var(--green-600)">$0.00</span>
        </div>
      </div>

      <!-- Notes field -->
      <div class="section-label">Notes</div>
      <div class="card">
        <textarea class="field-textarea" id="cash-notes" rows="3"
          placeholder="Any discrepancies or notes…"></textarea>
      </div>

      <button class="primary-btn full-btn" id="save-cash-btn">Save daily cash count</button>

      <div class="section-label">Recent daily counts</div>
      <div id="cash-history"></div>
    `;

    buildDenomGrid('notes-grid', NOTES, 'notes');
    buildDenomGrid('coins-grid', COINS, 'coins');
    document.getElementById('save-cash-btn')?.addEventListener('click', saveDaily);
    loadHistory();
  }

  function buildDenomGrid(containerId, denoms, type) {
    const grid = document.getElementById(containerId);
    if (!grid) return;
    grid.innerHTML = denoms.map(d => `
      <div class="denom-item">
        <div class="denom-label">${d.label}</div>
        <div class="denom-row">
          <button class="denom-btn" data-delta="-1" data-type="${type}">−</button>
          <input class="denom-input" type="number" min="0" step="1"
            data-value="${d.value}" data-type="${type}"
            placeholder="0" inputmode="numeric" value="0">
          <button class="denom-btn" data-delta="1" data-type="${type}">+</button>
          <div class="denom-value" data-val="${d.value}" data-type="${type}">$0.00</div>
        </div>
      </div>
    `).join('');
    grid.addEventListener('click', e => {
      const btn = e.target.closest('.denom-btn[data-delta]');
      if (!btn) return;
      adjustDenom(btn, parseInt(btn.dataset.delta), btn.dataset.type);
    });
    grid.addEventListener('input', e => {
      const input = e.target.closest('.denom-input');
      if (!input) return;
      onDenomInput(input, input.dataset.type);
    });
  }

  function adjustDenom(btn, delta, type) {
    const input = btn.closest('.denom-row').querySelector('.denom-input');
    input.value = Math.max(0, (parseInt(input.value) || 0) + delta);
    onDenomInput(input, type);
  }

  function onDenomInput(input, type) {
    const qty  = parseFloat(input.value) || 0;
    const val  = parseFloat(input.dataset.value);
    const disp = input.closest('.denom-row').querySelector('.denom-value');
    if (disp) disp.textContent = '$' + (qty * val).toFixed(2);
    recalc();
  }

  function recalc() {
    let notes = 0, coins = 0;
    document.querySelectorAll('.denom-input[data-type="notes"]').forEach(i => {
      notes += (parseFloat(i.value) || 0) * parseFloat(i.dataset.value);
    });
    document.querySelectorAll('.denom-input[data-type="coins"]').forEach(i => {
      coins += (parseFloat(i.value) || 0) * parseFloat(i.dataset.value);
    });
    const total  = notes + coins;
    const toBank = Math.max(0, total - FLOAT);
    setEl('notes-subtotal', '$' + notes.toFixed(2));
    setEl('coins-subtotal', '$' + coins.toFixed(2));
    setEl('actual-total',   '$' + total.toFixed(2));
    setEl('cash-to-bank',   '$' + toBank.toFixed(2));
  }

  function saveDaily() {
    let notes = 0, coins = 0;
    const counts = {};
    document.querySelectorAll('.denom-input').forEach(i => {
      const qty = parseFloat(i.value) || 0;
      const val = parseFloat(i.dataset.value);
      counts[i.dataset.value] = qty;
      if (i.dataset.type === 'notes') notes += qty * val;
      else coins += qty * val;
    });
    const total      = notes + coins;
    const actualCash = Math.max(0, total - FLOAT);
    Store.saveCashRec({
      type:        'daily',
      date:        new Date().toISOString().slice(0, 10),
      total,
      float:       FLOAT,
      actualCash,
      notesTotal:  notes,
      coinsTotal:  coins,
      denomCounts: counts,
      notes:       document.getElementById('cash-notes')?.value || '',
    });
    App.toast(`Daily cash saved — $${actualCash.toFixed(2)} to bank`);
    loadHistory();
  }

  function loadHistory() {
    const list = document.getElementById('cash-history');
    if (!list) return;
    const recs = Store.getCashRecs().filter(r => r.type === 'daily').slice(0, 7);
    if (!recs.length) { list.innerHTML = '<div class="empty-state">No previous records</div>'; return; }
    list.innerHTML = recs.map(r => {
      const d   = new Date(r.date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      const amt = (r.actualCash ?? r.actual ?? 0);
      return `<div class="card" style="margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;font-weight:500">${d}</span>
          <span style="font-size:14px;font-weight:600;color:var(--green-600)">$${amt.toFixed(2)}</span>
        </div>
        <div style="font-size:12px;color:var(--text-3);margin-top:4px">
          Total in drawer $${(r.total ?? (amt + (r.float ?? FLOAT))).toFixed(2)} · Float $${(r.float ?? FLOAT).toFixed(2)}
          ${r.notes ? ` · ${r.notes}` : ''}
        </div>
      </div>`;
    }).join('');
  }

  // ── Weekly banking ─────────────────────────────

  let weeklyWeekStart = Holidays.getWeekStart();

  function renderWeeklyPage() {
    const section = document.getElementById('cash-weekly-section');
    if (!section) return;
    section.style.display = 'none';
    section.innerHTML = `
      <div class="week-selector" style="margin-bottom:14px">
        <button class="week-nav-btn" id="wk-prev-week" aria-label="Previous week">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <div class="week-info" id="weekly-week-label">Loading…</div>
        <button class="week-nav-btn" id="wk-next-week" aria-label="Next week">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>

      <!-- Daily cash breakdown -->
      <div class="section-label">Daily cash counts</div>
      <div class="card" id="wk-daily-breakdown">
        <div class="empty-state">Loading…</div>
      </div>

      <!-- Square cash total -->
      <div class="section-label">Square cash report</div>
      <div class="card">
        <div class="drawer-row">
          <span class="drawer-label">Cash sales (gross)</span>
          <span class="drawer-val" id="wk-sq-cash-gross">$—</span>
        </div>
        <div class="drawer-row" id="wk-sq-refunds-row" style="display:none">
          <span class="drawer-label">Cash refunds</span>
          <span class="drawer-val" id="wk-sq-cash-refunds" style="color:#e53935">$—</span>
        </div>
        <div class="cost-divider" id="wk-sq-net-divider" style="display:none"></div>
        <div class="drawer-row">
          <span class="drawer-label" id="wk-sq-net-label">Net cash</span>
          <span class="drawer-val" id="wk-sq-cash" style="font-weight:600;color:var(--green-600)">$—</span>
        </div>
      </div>

      <!-- Weekly recount -->
      <div class="section-label">Weekly cash recount</div>
      <div class="card">
        <div style="font-size:12px;color:var(--text-3);margin-bottom:10px">
          Recount the total cash banked this week to confirm against Square.
        </div>
        <div class="drawer-row" style="align-items:center">
          <span class="drawer-label" style="font-weight:600">Recounted total</span>
          <div style="display:flex;align-items:center;gap:6px">
            <span style="color:var(--text-3);font-weight:600">$</span>
            <input id="wk-recount-input" type="number" min="0" step="0.01"
              inputmode="decimal" placeholder="0.00"
              style="width:110px;text-align:right;font-size:15px;font-weight:600;padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface-2);color:var(--text-1)">
          </div>
        </div>
      </div>

      <!-- Final weekly check -->
      <div class="section-label">Final weekly check</div>
      <div class="card">
        <div class="drawer-row">
          <span class="drawer-label">Daily totals (sum)</span>
          <span class="drawer-val" id="wk-total-banked">$0.00</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Recounted total</span>
          <span class="drawer-val" id="wk-recount-display" style="font-weight:600">—</span>
        </div>
        <div class="drawer-row">
          <span class="drawer-label">Square cash report</span>
          <span class="drawer-val" id="wk-sq-cash-mirror">$—</span>
        </div>
        <div class="cost-divider"></div>
        <div class="drawer-row">
          <span class="drawer-label" style="font-weight:700;font-size:15px">Recount vs Square</span>
          <span class="read-field drawer-val" id="wk-variance" data-state="neutral" style="font-size:15px;font-weight:700">—</span>
        </div>
      </div>

      <div class="section-label">Notes</div>
      <div class="card">
        <textarea class="field-textarea" id="wk-notes" rows="3" placeholder="Banking notes…"></textarea>
      </div>
      <button class="primary-btn full-btn" id="save-weekly-btn">Save weekly banking rec</button>
    `;

    section.querySelector('#wk-prev-week').addEventListener('click', () => weeklyNav(-1));
    section.querySelector('#wk-next-week').addEventListener('click', () => weeklyNav(1));
    section.querySelector('#wk-recount-input').addEventListener('input', onRecountInput);
    document.getElementById('save-weekly-btn')?.addEventListener('click', saveWeekly);
  }

  async function loadWeeklyData() {
    const weekEnd = Holidays.getWeekEnd(weeklyWeekStart);
    setEl('weekly-week-label', Holidays.formatWeekLabel(weeklyWeekStart));

    const allRecs  = Store.getCashRecs().filter(r => r.type === 'daily');
    const weekRecs = allRecs.filter(r => r.date >= weeklyWeekStart && r.date <= weekEnd);
    renderWeeklyBreakdown(weekRecs, weeklyWeekStart, weekEnd);

    try {
      const totals = await SquareAPI.getWeeklyTotals(weeklyWeekStart, weekEnd);
      const cashGross   = totals.cashGross   || totals.cashSales || 0;
      const cashRefunds = totals.cashRefunds || 0;
      const cashNet     = totals.cashSales   || 0;

      setEl('wk-sq-cash-gross', '$' + cashGross.toFixed(2));

      const refundsRow    = document.getElementById('wk-sq-refunds-row');
      const netDivider    = document.getElementById('wk-sq-net-divider');
      const netLabel      = document.getElementById('wk-sq-net-label');
      if (cashRefunds > 0) {
        setEl('wk-sq-cash-refunds', '−$' + cashRefunds.toFixed(2));
        if (refundsRow)  refundsRow.style.display  = '';
        if (netDivider)  netDivider.style.display  = '';
        if (netLabel)    netLabel.textContent = 'Net cash';
      } else {
        if (refundsRow)  refundsRow.style.display  = 'none';
        if (netDivider)  netDivider.style.display  = 'none';
        if (netLabel)    netLabel.textContent = 'Net cash';
      }

      setEl('wk-sq-cash',        '$' + cashNet.toFixed(2));
      setEl('wk-sq-cash-mirror', '$' + cashNet.toFixed(2));
      recalcWeeklyVariance(weekRecs, cashNet);
    } catch(e) {
      console.error('Weekly totals error:', e);
    }
  }

  function onRecountInput() {
    const val = parseFloat(document.getElementById('wk-recount-input')?.value) || 0;
    setEl('wk-recount-display', '$' + val.toFixed(2));
    const squareCash = parseFloat(document.getElementById('wk-sq-cash')?.textContent?.replace('$', '')) || 0;
    if (squareCash) recalcWeeklyVarianceFromInputs(val, squareCash);
  }

  function recalcWeeklyVarianceFromInputs(recount, squareCash) {
    const variance = recount - squareCash;
    const abs      = Math.abs(variance);
    const el       = document.getElementById('wk-variance');
    if (!el) return;
    if (recount === 0) { el.textContent = '—'; el.dataset.state = 'neutral'; return; }
    if (abs < 0.05) {
      el.textContent = '$0.00 — Balanced ✓'; el.dataset.state = 'ok';
    } else if (abs <= 20) {
      el.textContent = (variance > 0 ? '+' : '−') + '$' + abs.toFixed(2) + ' (minor)'; el.dataset.state = 'warn';
    } else {
      el.textContent = (variance > 0 ? '+' : '−') + '$' + abs.toFixed(2) + ' — Review needed'; el.dataset.state = 'error';
    }
  }

  function renderWeeklyBreakdown(recs, weekStart, weekEnd) {
    const el = document.getElementById('wk-daily-breakdown');
    if (!el) return;

    // Build a map of date → rec
    const recMap = {};
    recs.forEach(r => { recMap[r.date] = r; });

    // Generate all 7 days Mon–Sun
    const days = [];
    const start = new Date(weekStart + 'T12:00:00');
    const end   = new Date(weekEnd   + 'T12:00:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      days.push(d.toISOString().slice(0, 10));
    }

    let totalBanked = 0;
    const rows = days.map(date => {
      const rec   = recMap[date];
      const label = new Date(date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      if (rec) {
        const amt = rec.actualCash ?? rec.actual ?? 0;
        totalBanked += amt;
        return `<div class="drawer-row">
          <span class="drawer-label">${label}</span>
          <span class="drawer-val" style="color:var(--green-600)">$${amt.toFixed(2)}</span>
        </div>`;
      }
      return `<div class="drawer-row">
        <span class="drawer-label">${label}</span>
        <span class="drawer-val" style="color:var(--text-3)">—</span>
      </div>`;
    }).join('');

    el.innerHTML = `
      ${rows}
      <div class="cost-divider"></div>
      <div class="drawer-row">
        <span class="drawer-label" style="font-weight:600">Total banked</span>
        <span class="drawer-val" style="font-weight:600">$${totalBanked.toFixed(2)}</span>
      </div>
    `;

    setEl('wk-total-banked', '$' + totalBanked.toFixed(2));
    return totalBanked;
  }

  function recalcWeeklyVariance(recs, squareCash) {
    // Only auto-fill variance if no recount has been entered yet
    const recountInput = document.getElementById('wk-recount-input');
    if (recountInput && parseFloat(recountInput.value) > 0) return;
    const totalBanked = recs.reduce((s, r) => s + (r.actualCash ?? r.actual ?? 0), 0);
    recalcWeeklyVarianceFromInputs(totalBanked, squareCash);
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
    const dailyTotal  = parseFloat(document.getElementById('wk-total-banked')?.textContent?.replace('$', ''))   || 0;
    const recount     = parseFloat(document.getElementById('wk-recount-input')?.value)                          || 0;
    const squareCash  = parseFloat(document.getElementById('wk-sq-cash')?.textContent?.replace('$', ''))        || 0;
    const finalTotal  = recount || dailyTotal;
    const variance    = finalTotal - squareCash;
    Store.saveCashRec({
      type:         'weekly',
      weekStart:    weeklyWeekStart,
      weekEnd:      Holidays.getWeekEnd(weeklyWeekStart),
      date:         new Date().toISOString().slice(0, 10),
      dailyTotal,
      recount,
      squareCash,
      variance,
      notes:        document.getElementById('wk-notes')?.value || '',
    });
    const abs = Math.abs(variance);
    App.toast(abs < 0.05 ? 'Weekly banking saved — balanced ✓' : `Weekly banking saved — difference $${abs.toFixed(2)}`);
  }

  // ── Helpers ───────────────────────────────────

  function setEl(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

  return { init, switchTab };

})();
