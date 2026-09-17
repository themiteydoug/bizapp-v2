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
      // The drawer-by-day call is desktop-only: it feeds the cash panel, which
      // the phone never renders, so the phone makes no extra request.
      const drawerPromise = isDesktop()
        ? SquareAPI.getWeeklyDrawerByDay(weekStart, weekEnd).catch(e => {
            console.warn('Drawer-by-day error:', e.message);
            return null;
          })
        : Promise.resolve(null);

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

      // The cash panel paints once the drawer call lands — it must never hold
      // up the tiles.
      drawerPromise.then(drawer => {
        if (weekStart === currentWeekStart) renderCashPanel(drawer, weekStart, weekEnd);
      });
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

    // Desktop panels — skipped entirely on the phone, where they aren't rendered.
    if (isDesktop()) {
      renderInvoicePanel(weekInvoices, cogs);
      renderTimesheetPanel(timesheets);
    }
    if (netSales > 0) recordWeek(weekStart, netProfit);
    if (isDesktop()) { renderTrend(weekStart); backfillHistory(weekStart); }
  }

  // ═══════════════════════════════════════════════════════════════
  //  DESKTOP PANELS
  //  The front page shows the week's actual working data, not a set of
  //  headline figures. Everything but the cash drawer comes from data
  //  the tiles already fetched or from local storage, so the panels add
  //  exactly one API call to a dashboard load.
  // ═══════════════════════════════════════════════════════════════

  const deskMQ = window.matchMedia('(min-width: 1080px)');
  function isDesktop() { return deskMQ.matches; }

  const money  = n => (n < 0 ? '−$' : '$') + Math.abs(n || 0).toFixed(2);
  const money0 = n => (n < 0 ? '−$' : '$') + Math.abs(Math.round(n || 0)).toLocaleString();
  const esc    = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

  // ── Cash reconciliation ───────────────────────
  // One row per day: who counted it, what Square's drawer expected, the
  // variance, and what went to the bank. A day nobody counted offers Square's
  // own figure, the same as the cash rec page does.
  function renderCashPanel(drawer, weekStart, weekEnd) {
    if (!isDesktop()) return;
    const rows = document.getElementById('dash-cash-rows');
    const foot = document.getElementById('dash-cash-foot');
    if (!rows || !foot) return;

    const recs = Store.getCashRecs().filter(r => r.type === 'daily' && r.date >= weekStart && r.date <= weekEnd);
    const byDate = Object.fromEntries(recs.map(r => [r.date, r]));
    const drawerMap = drawer || {};
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });

    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart + 'T12:00:00');
      d.setDate(d.getDate() + i);
      return d.toISOString().slice(0, 10);
    });

    let counted = 0, drawerTotal = 0;

    const html = days.map(date => {
      const label = new Date(date + 'T12:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
      const sq  = drawerMap[date] ? drawerMap[date].toBank : null;
      if (sq != null) drawerTotal += sq;
      const rec = byDate[date];

      if (rec) {
        const amt = rec.actualCash ?? rec.actual ?? 0;
        counted += amt;
        const who = rec.source === 'square_estimate'
          ? 'Square drawer'
          : (rec.countedBy || '').trim().split(/\s+/)[0] || 'counted';
        const v = (sq != null && rec.source !== 'square_estimate') ? amt - sq : null;
        return `<div class="drow">
          <span class="drow-day">${label} <em>· ${esc(who)}</em></span>
          <span class="drow-right">
            ${sq != null ? `<span class="drow-sq">Sq ${money(sq)}</span>` : ''}
            ${v != null ? `<span class="drow-var ${varClass(v)}">${varText(v)}</span>` : ''}
            <span class="drow-amt">${money(amt)}</span>
          </span>
        </div>`;
      }

      // Not counted. Offer Square's figure for a day that has already finished.
      const canFill = sq != null && date < today;
      return `<div class="drow">
        <span class="drow-day">${label} <em>· not counted</em></span>
        <span class="drow-right">
          ${sq != null ? `<span class="drow-sq">Sq ${money(sq)}</span>` : ''}
          ${canFill
            ? `<button class="drow-fill" data-fill-date="${date}" data-fill-amt="${sq.toFixed(2)}">Use Square ${money(sq)}</button>`
            : '<span class="drow-amt muted">—</span>'}
        </span>
      </div>`;
    }).join('');

    rows.innerHTML = html;
    rows.querySelectorAll('button[data-fill-date]').forEach(b => b.addEventListener('click', () => {
      try {
        CashModule.fillMissedFromSquare(b.dataset.fillDate, parseFloat(b.dataset.fillAmt));
        renderCashPanel(drawer, weekStart, weekEnd);
      } catch (e) { App.toast('Could not save that day: ' + e.message, 'error'); }
    }));

    // Petty cash taken from the banking never reaches Square, so it has to be
    // added back before the week can tie out.
    const petty = Store.getInvoices()
      .filter(i => i.source === 'petty_cash' && i.date >= weekStart && i.date <= weekEnd)
      .filter(i => (i.pettySource || 'till') === 'banking')
      .reduce((s, i) => s + (i.totalIncGst || i.subtotal || 0), 0);

    const variance = (counted + petty) - drawerTotal;
    const balanced = Math.abs(variance) < 0.05;

    foot.innerHTML = `
      ${petty > 0 ? `<div class="dfoot-row">
        <span>Plus petty cash (from banking)</span><span class="pos">+${money(petty)}</span>
      </div>` : ''}
      <div class="dfoot-row">
        <span>Square cash drawer (7-day sum)</span><span>${drawerTotal ? money(drawerTotal) : '—'}</span>
      </div>
      <div class="dfoot-row total">
        <span>Total vs Square</span>
        <span class="${balanced ? 'ok' : varClass(variance)}">${
          drawerTotal ? `${varText(variance)}${balanced ? ' · Balanced ✓' : ''}` : money(counted + petty)}</span>
      </div>`;
  }

  function varClass(v) {
    const a = Math.abs(v);
    if (a < 0.05) return 'ok';
    if (a <= 5)   return 'near';
    return 'off';
  }
  function varText(v) {
    if (Math.abs(v) < 0.05) return '+$0.00';
    return (v > 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2);
  }

  // ── Recent invoices ───────────────────────────
  function renderInvoicePanel(weekInvoices, cogs) {
    const rows = document.getElementById('dash-inv-rows');
    const foot = document.getElementById('dash-inv-foot');
    if (!rows || !foot) return;

    const list = [...weekInvoices].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    rows.innerHTML = list.length
      ? list.map(inv => {
          const d = new Date(inv.date + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
          const petty = inv.source === 'petty_cash';
          // Same three states the invoices list uses: synced / local / pending.
          const badge = inv.status === 'synced' ? '<span class="dbadge ok">In Xero</span>'
            : inv.status === 'local' ? '<span class="dbadge local">Saved</span>'
            : '<span class="dbadge">Pending</span>';
          const ref = petty ? `from ${esc(inv.pettySource || 'till')}` : esc(inv.invoiceNo || '—');
          return `<div class="drow">
            <span class="drow-day">${esc(inv.supplier || 'Unnamed')}<em>${d} · ${ref}</em></span>
            <span class="drow-right">${badge}<span class="drow-amt">${money(inv.totalIncGst ?? inv.subtotal ?? 0)}</span></span>
          </div>`;
        }).join('')
      : '<div class="dpanel-empty">No invoices entered for this week yet.</div>';

    foot.innerHTML = `<div class="dfoot-row total"><span>Total COGS</span><span>${money(cogs)}</span></div>`;
  }

  // ── Timesheets ────────────────────────────────
  function renderTimesheetPanel(timesheets) {
    const rows = document.getElementById('dash-ts-rows');
    const foot = document.getElementById('dash-ts-foot');
    if (!rows || !foot) return;

    const list = [...timesheets].sort((a, b) => (b.totalHours || 0) - (a.totalHours || 0));
    rows.innerHTML = list.length
      ? list.map(t => {
          const rate = t.hourlyRate ? `$${t.hourlyRate.toFixed(2)}/h` : '';
          const type = t.salaried ? 'Salaried' : 'Casual';
          return `<div class="drow">
            <span class="drow-day">${esc(t.name)}<em>${type}${rate ? ' · ' + rate : ''}</em></span>
            <span class="drow-right">
              <span class="drow-sq">${(t.totalHours || 0).toFixed(1)} h</span>
              <span class="drow-amt">${money0(t.estimatedCost || 0)}</span>
            </span>
          </div>`;
        }).join('')
      : '<div class="dpanel-empty">No hours recorded for this week.</div>';

    const hours = timesheets.reduce((s, t) => s + (t.totalHours || 0), 0);
    const cost  = timesheets.reduce((s, t) => s + (t.estimatedCost || 0), 0);
    foot.innerHTML = `
      <div class="dfoot-row"><span>Total hours</span><span>${hours.toFixed(1)} h</span></div>
      <div class="dfoot-row total"><span>Wage cost</span><span>${money0(cost)}</span></div>`;
  }

  // ── Net profit trend ──────────────────────────
  // Every week viewed is remembered, and any of the last six that has never been
  // seen is fetched once, quietly, after the page has painted. A closed week's
  // figure never changes, so it is computed once and read from storage forever
  // after — the chart costs nothing on later loads.
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

  // The six weeks ending with the one on screen — the window the chart draws,
  // and the window the backfill fills.
  function trendWindow(currentWeek) {
    const out = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(currentWeek + 'T12:00:00');
      d.setDate(d.getDate() - i * 7);
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function renderTrend(currentWeek) {
    const el = document.getElementById('trend-bars');
    if (!el) return;
    const h = readHistory();
    const window6 = trendWindow(currentWeek);
    const weeks = window6.filter(w => h[w] != null);
    const hint  = document.getElementById('trend-hint');
    const stats = document.getElementById('dash-trend-stats');

    if (!weeks.length) {
      el.innerHTML = '<div class="trend-empty">Working out the last six weeks…</div>';
      if (hint)  hint.textContent = '';
      if (stats) stats.innerHTML = '';
      return;
    }

    const vals = weeks.map(w => h[w]);
    const peak = Math.max(...vals.map(Math.abs), 1);
    if (hint) hint.textContent = weeks.length < 6 ? `${weeks.length} of 6 weeks` : 'weekly';

    el.innerHTML = weeks.map(w => {
      const v = h[w];
      const pctH = Math.max(3, Math.round(Math.abs(v) / peak * 100));
      const cap = new Date(w + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
      const cls = (v < 0 ? ' neg' : '') + (w === currentWeek ? ' now' : '');
      const fig = (v < 0 ? '−$' : '$') + Math.abs(Math.round(v / 100) / 10).toFixed(1) + 'k';
      return `<div class="trend-col${cls}">
        <div class="fig">${fig}</div>
        <div class="bar" style="height:${pctH}%"></div>
        <div class="cap">${cap}</div>
      </div>`;
    }).join('');

    if (!stats) return;
    const best = Math.max(...vals);
    const avg  = vals.reduce((a, b) => a + b, 0) / vals.length;
    const idx  = window6.indexOf(currentWeek);
    const prev = idx > 0 ? h[window6[idx - 1]] : null;
    const now  = h[currentWeek];

    let trend = '<span class="muted">—</span>';
    if (prev != null && now != null && prev !== 0) {
      const chg = (now - prev) / Math.abs(prev) * 100;
      trend = `<span class="${chg >= 0 ? 'pos' : 'off'}">${chg >= 0 ? '▲ +' : '▼ '}${Math.round(chg)}%</span>`;
    }

    stats.innerHTML = `
      <div class="dfoot-row"><span>Best week</span><span>${money0(best)}</span></div>
      <div class="dfoot-row"><span>${weeks.length}-week average</span><span>${money0(avg)}</span></div>
      <div class="dfoot-row total"><span>Trend vs prior week</span><span>${trend}</span></div>`;
  }

  // ── History backfill ──────────────────────────
  // Fills in any of the six weeks on the chart that have never been viewed, one
  // at a time in the background. Each week is attempted once per session, so a
  // week with no trading (or a failed fetch) can't put the app in a loop.
  let backfilling = false;
  const attempted = new Set();

  function backfillHistory(currentWeek) {
    if (backfilling || !Auth.isManager()) return;
    const h = readHistory();
    const missing = trendWindow(currentWeek)
      .filter(w => w < currentWeek && h[w] == null && !attempted.has(w));
    if (!missing.length) return;

    backfilling = true;
    (async () => {
      for (const w of missing) {
        attempted.add(w);
        try {
          await fetchWeekProfit(w);
          renderTrend(currentWeekStart);
        } catch (e) {
          console.warn('[trend] backfill', w, e.message);
        }
        // Spread the requests out — this is background work behind a page the
        // user is already reading.
        await new Promise(r => setTimeout(r, 1500));
      }
      backfilling = false;
    })();
  }

  async function fetchWeekProfit(weekStart) {
    const weekEnd = Holidays.getWeekEnd(weekStart);
    const [totals, rawTs, overhead] = await Promise.all([
      SquareAPI.getWeeklyTotals(weekStart, weekEnd),
      SquareAPI.getWeekTimesheets(weekStart).catch(() => []),
      XeroAPI.isConnected() ? XeroAPI.getOverheadAverage(weekStart).catch(() => null) : Promise.resolve(null),
    ]);
    const netSales = (totals.total || 0) - (totals.gst || 0);
    if (netSales <= 0) return;   // closed or no data — leave the week off the chart

    let ts = rawTs;
    try { ts = await XeroAPI.applyAwardRates(rawTs, weekStart); } catch {}

    const staffCost = ts.reduce((s, e) => s + (e.estimatedCost || 0), 0);
    const cogs = Store.getInvoices()
      .filter(i => i.date >= weekStart && i.date <= weekEnd)
      .reduce((s, i) => s + (i.subtotal || 0), 0);
    recordWeek(weekStart, netSales - staffCost - cogs - (overhead?.weeklyAverage || 0));
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
