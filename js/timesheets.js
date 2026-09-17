/**
 * BizOps · Timesheets Module
 * Review Square hours and push to Xero with penalty rate splitting
 */

const TimesheetsModule = (() => {

  let currentWeekStart = Holidays.getWeekStart();
  let currentTimesheets = [];

  // Desktop only — the right-hand column that compares the roster with what
  // was actually clocked. The phone view never builds any of this.
  const tsDeskMQ = window.matchMedia('(min-width: 1080px)');
  let rosterByMember = new Map();   // squareId → [{ date, startMin, endMin, hours }]
  let selectedStaff  = null;        // squareId shown in the detail column
  const rosteredForKey = new Map(); // shift key → rostered hours, for live diffs

  function init() {
    bindEvents();
    loadWeek(App.getWeek());   // shared across tabs
  }

  function bindEvents() {
    document.getElementById('ts-prev-week')?.addEventListener('click', () => {
      const d = new Date(currentWeekStart + 'T12:00:00');
      d.setDate(d.getDate() - 7);
      loadWeek(d.toISOString().slice(0, 10));
    });
    document.getElementById('ts-next-week')?.addEventListener('click', () => {
      const d = new Date(currentWeekStart + 'T12:00:00');
      d.setDate(d.getDate() + 7);
      const next = d.toISOString().slice(0, 10);
      if (next > new Date().toISOString().slice(0, 10)) return; // Don't go future
      loadWeek(next);
    });
    document.getElementById('push-xero-btn')?.addEventListener('click', pushToXero);

    // Manager hour edits — delegated so it survives re-renders (bind once)
    const list = document.getElementById('ts-staff-list');
    if (list && !list.dataset.editBound) {
      list.dataset.editBound = '1';
      list.addEventListener('change', onHoursEdit);
      // On desktop a card opens in the detail column instead of expanding
      list.addEventListener('click', e => {
        if (!tsDeskMQ.matches) return;
        const card = e.target.closest('.staff-card');
        if (!card || !card.dataset.sq) return;
        selectStaff(card.dataset.sq);
      });
    }
    const detail = document.getElementById('ts-detail');
    if (detail && !detail.dataset.editBound) {
      detail.dataset.editBound = '1';
      detail.addEventListener('change', onHoursEdit);
      // An iPad turned on its side crosses into the desktop layout — fill the
      // detail column in rather than waiting for the next week change.
      tsDeskMQ.addEventListener('change', () => {
        if (tsDeskMQ.matches && currentTimesheets.length) loadRosterComparison(currentWeekStart);
      });
    }
  }

  function onHoursEdit(e) {
    const input = e.target;
    if (!input.classList || !input.classList.contains('ts-hours-input')) return;
    let val = input.value.trim() === '' ? null : parseFloat(input.value);
    if (val != null && (isNaN(val) || val < 0)) val = 0;
    Store.saveTsAdjustment(input.dataset.key, val);   // persist (or clear if null)
    applyAdjustmentInMemory(input.dataset.key, val);
    // Update totals + this row IN PLACE so the expanded card stays open and
    // the manager can keep editing down the list without reopening it.
    updateRowInPlace(input);
    updateWeekTotals();
    updateDiffCell(input.dataset.key);
  }

  // Refresh the edited row's input value, its "was Xh" marker and the staff
  // card's hours badge — without re-rendering (which would collapse the card).
  function updateRowInPlace(input) {
    const sep = input.dataset.key.indexOf('|');
    const squareId  = input.dataset.key.slice(0, sep);
    const startTime = input.dataset.key.slice(sep + 1);
    const ts = currentTimesheets.find(t => String(t.squareId) === squareId);
    if (!ts) return;
    const shift = ts.shifts.find(s => s.startTime === startTime);
    if (!shift) return;

    input.value = shift.hours;   // normalise (e.g. blank → reverted Square hours)

    const row = input.closest('.ts-day-row');
    let mark = row?.querySelector('.ts-adj-mark');
    if (shift.adjusted) {
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'ts-adj-mark';
        mark.style.cssText = 'font-size:10px;color:var(--amber-800)';
        input.insertAdjacentElement('afterend', mark);
      }
      mark.textContent = `✎ was ${shift.squareHours}h`;
      mark.title = `Adjusted from Square ${shift.squareHours}h`;
    } else if (mark) {
      mark.remove();
    }

    // The edit can come from the card itself or from the desktop detail column,
    // so update the card's badge by id rather than by walking up from the input.
    const badge = document.querySelector(`.staff-card[data-sq="${squareId}"] .staff-hours-badge`)
      || input.closest('.staff-card')?.querySelector('.staff-hours-badge');
    if (badge) badge.textContent = ts.totalHours + 'h';
    const deskTotal = document.getElementById('ts-detail-total');
    if (deskTotal && selectedStaff === squareId) deskTotal.textContent = ts.totalHours + 'h';
  }

  function updateWeekTotals() {
    const totalHours = currentTimesheets.reduce((a, t) => a + (t.totalHours || 0), 0);
    const totalCost  = currentTimesheets.reduce((a, t) => a + (t.estimatedCost || 0), 0);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('ts-total-hours', totalHours.toFixed(1) + 'h');
    set('ts-labour-cost', '$' + totalCost.toLocaleString());
    set('ts-avg-rate', 'avg $' + (totalHours ? (totalCost / totalHours).toFixed(2) : '—') + '/hr');
  }

  // Update the in-memory timesheets so totals + push reflect the edit immediately
  function applyAdjustmentInMemory(key, val) {
    const sep = key.indexOf('|');
    const squareId = key.slice(0, sep);
    const startTime = key.slice(sep + 1);
    const ts = currentTimesheets.find(t => String(t.squareId) === squareId);
    if (!ts) return;
    const shift = ts.shifts.find(s => s.startTime === startTime);
    if (!shift) return;
    shift.hours    = (val == null ? shift.squareHours : val);
    shift.adjusted = val != null;
    shift.shiftCost = Math.round(shift.hours * (shift.hourlyRate || 0) * 100) / 100;
    ts.totalHours    = Math.round(ts.shifts.reduce((a, s) => a + s.hours, 0) * 100) / 100;
    ts.estimatedCost = Math.round(ts.shifts.reduce((a, s) => a + (s.shiftCost || 0), 0));
  }

  async function loadWeek(weekStart) {
    currentWeekStart = weekStart;
    App.setWeek(weekStart, 'timesheets');
    document.getElementById('ts-week-label').textContent = Holidays.formatWeekLabel(weekStart);
    document.getElementById('ts-staff-list').innerHTML = '<div class="empty-state">Loading from Square…</div>';
    document.getElementById('ts-total-hours').textContent = '—';
    document.getElementById('ts-staff-count').textContent = '—';
    document.getElementById('ts-labour-cost').textContent = '$—';

    try {
      const data = await SquareAPI.getWeekTimesheets(weekStart);
      // Recompute pay from Xero award rates (base × penalty multiplier per day);
      // no-ops if Xero isn't connected, keeping the Square-derived figures.
      currentTimesheets = await XeroAPI.applyAwardRates(data, weekStart);
      renderTimesheets(currentTimesheets, weekStart);
      renderPushStatus(weekStart);
      renderHolidayAlert(weekStart);
      if (tsDeskMQ.matches) loadRosterComparison(weekStart);
    } catch (e) {
      document.getElementById('ts-staff-list').innerHTML =
        `<div class="empty-state">Error loading timesheets: ${e.message}</div>`;
    }
  }

  function renderTimesheets(data, weekStart) {
    const settings = Store.getSettings();
    const canEdit = Auth.isManager();
    let totalHours = 0;
    let totalCost = 0;

    const list = document.getElementById('ts-staff-list');
    if (!data.length) {
      list.innerHTML = '<div class="empty-state">No shifts found for this week</div>';
      return;
    }

    list.innerHTML = data.map(ts => {
      const staffMember = Store.getStaff().find(s => s.id === ts.staffId);
      totalHours += ts.totalHours;
      totalCost += ts.estimatedCost || 0;

      // Overtime is a >38 hrs/week heuristic for hourly staff only — salaried
      // managers don't accrue OT, so never flag them.
      const hasOT = !ts.salaried && ts.totalHours > 38;
      const initials = staffMember?.initials || ts.name.split(' ').map(n=>n[0]).join('').slice(0,2);

      // Day rows with category tags — prefer the Xero award rate applied
      // (shift.rateName/dayType), falling back to the staff payRates mapping.
      // Sort ascending so days read Mon → Sun down the page.
      const dayRows = [...ts.shifts]
        .sort((a, b) => (a.date || '').localeCompare(b.date || '')
          || (a.startTime || '').localeCompare(b.startTime || ''))
        .map(shift => {
        let category, dayType;
        if (shift.rateName) {
          category = shift.rateName; dayType = shift.dayType || 'weekday';
        } else if (staffMember && staffMember.payRates) {
          ({ category, dayType } = Holidays.getXeroCategoryForShift(shift.date, staffMember, settings.ekkaBrisbane));
        } else {
          dayType = Holidays.getDayType(shift.date, settings.ekkaBrisbane);
          category = dayType.replace('_', ' ');
        }
        const catClass = dayType === 'weekday' ? 'cat-weekday'
          : dayType === 'saturday' ? 'cat-saturday'
          : dayType.includes('sunday') ? 'cat-sunday'
          : 'cat-pubhol';
        const dayLabel = Holidays.formatDateLabel(shift.date).split(' ')[0]; // "Mon"
        const key = `${ts.squareId}|${shift.startTime}`;
        const hoursCell = canEdit
          ? `<input class="ts-hours-input" type="number" inputmode="decimal" step="0.25" min="0"
                value="${shift.hours}" data-key="${key}" title="Square recorded ${shift.squareHours}h"
                onclick="event.stopPropagation()"
                style="width:64px;text-align:right;font-size:13px;font-weight:600;padding:4px 6px;border:1.5px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text-1)">`
          : `<span class="ts-hours">${shift.hours}h</span>`;
        const adjMark = shift.adjusted
          ? `<span class="ts-adj-mark" style="font-size:10px;color:var(--amber-800)" title="Adjusted from Square ${shift.squareHours}h">✎ was ${shift.squareHours}h</span>`
          : '';
        return `
          <div class="ts-day-row">
            <span class="ts-day">${dayLabel}</span>
            ${hoursCell}
            ${adjMark}
            <span class="ts-category ${catClass}">${category || dayType}</span>
          </div>
        `;
      }).join('');

      return `
        <div class="staff-card" data-sq="${ts.squareId}">
          <div class="staff-card-inner" onclick="this.closest('.staff-card').querySelector('.ts-days').classList.toggle('hidden')">
            <div class="staff-avatar">${initials}</div>
            <div class="staff-card-info">
              <div class="staff-card-name">${ts.name}</div>
              <div class="staff-card-meta">${ts.shifts.length} shifts${ts.salaried ? ' · salaried' : hasOT ? ' · ⚠ OT' : ''}</div>
            </div>
            <div class="staff-card-right">
              <div class="staff-hours-badge">${Math.round((ts.totalHours || 0) * 100) / 100}h</div>
              ${ts.salaried ? '<span class="badge badge-ok">Salaried</span>'
                : hasOT ? '<span class="badge badge-warn">OT</span>' : '<span class="badge badge-ok">OK</span>'}
            </div>
          </div>
          <div class="ts-days hidden" style="padding:0 14px 12px">
            ${dayRows}
          </div>
        </div>
      `;
    }).join('');

    // Add .hidden style
    if (!document.getElementById('ts-hidden-style')) {
      const s = document.createElement('style');
      s.id = 'ts-hidden-style';
      s.textContent = '.hidden { display: none !important; }';
      document.head.appendChild(s);
    }

    document.getElementById('ts-total-hours').textContent = totalHours.toFixed(1) + 'h';
    document.getElementById('ts-staff-count').textContent = data.length + ' staff';
    document.getElementById('ts-labour-cost').textContent = '$' + totalCost.toLocaleString();
    document.getElementById('ts-avg-rate').textContent = 'avg $' + (totalHours ? (totalCost/totalHours).toFixed(2) : '—') + '/hr';
  }

  function renderHolidayAlert(weekStart) {
    const alertEl = document.getElementById('ph-alert');
    if (!alertEl) return;
    const holidays = Holidays.getHolidaysInWeek(weekStart);
    if (!holidays.length) {
      alertEl.style.display = 'none';
      return;
    }
    alertEl.style.display = 'block';
    alertEl.innerHTML = `
      🏖 <strong>Public holiday${holidays.length > 1 ? 's' : ''} this week:</strong>
      ${holidays.map(h => `${Holidays.formatDateLabel(h.date)} — ${h.name}`).join(', ')}.
      Hours on these days are automatically tagged with public holiday rates.
    `;
  }

  function renderPushStatus(weekStart) {
    const lastPush = Store.getLastPushForWeek(weekStart);
    const el = document.getElementById('push-status');
    if (!el) return;
    if (lastPush) {
      const when = new Date(lastPush.pushedAt).toLocaleDateString('en-AU', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
      });
      el.textContent = `✓ Pushed to Xero · ${when}`;
      el.style.color = 'var(--green-600)';
    } else {
      el.textContent = 'Not yet sent to Xero this week';
      el.style.color = 'var(--text-3)';
    }
  }

  async function pushToXero() {
    if (!currentTimesheets.length) {
      App.toast('No timesheet data to push', 'warning');
      return;
    }
    const btn = document.getElementById('push-xero-btn');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner-ring" style="width:18px;height:18px;border-width:2px"></div> Sending…';

    try {
      const results = await XeroAPI.pushTimesheets(
        currentWeekStart,
        currentTimesheets,
        (name, status) => {
          const el = document.getElementById('push-status');
          if (el) el.textContent = status === 'sending' ? `Sending ${name}…` : `✓ ${name}`;
        }
      );
      Store.logTsPush(currentWeekStart, Holidays.getWeekEnd(currentWeekStart), results);
      renderPushStatus(currentWeekStart);

      const ok      = results.filter(r => r.status === 'ok').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      const errs    = results.filter(r => r.status === 'error');
      if (errs.length) {
        console.warn('[Xero push] failures:', errs);
        App.toast(`Pushed ${ok} · ${errs.length} failed — ${errs[0].name}: ${errs[0].error}`, 'error');
      } else {
        App.toast(`Pushed ${ok} to Xero${skipped ? ` · ${skipped} salaried skipped` : ''}`);
      }
    } catch (e) {
      App.toast('Error pushing timesheets: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        Push timesheets to Xero
      `;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  ROSTERED vs ACTUAL (desktop detail column)
  //  Left column stays the staff list; clicking a name fills this one
  //  with their shifts, the roster they were given, and the gap between
  //  the two. Hours stay editable here, same as on the card.
  // ═══════════════════════════════════════════════════════════════

  const DIFF_TOLERANCE = 0.25;   // 15 minutes — below this nothing is flagged

  function clockOf(iso) {
    // '2026-09-15T09:30:00+10:00' — read the wall clock off the string so the
    // browser's own timezone can never shift it.
    const m = /T(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return '—';
    return minsToClock(+m[1] * 60 + +m[2]);
  }

  function minsToClock(min) {
    let h = Math.floor(min / 60) % 24;
    const mm = min % 60;
    const ap = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    return mm ? `${h}:${String(mm).padStart(2, '0')}${ap}` : `${h}${ap}`;
  }

  function hrs(n) {
    return (Math.round(n * 100) / 100).toFixed(n % 1 === 0 ? 0 : 2).replace(/0$/, '').replace(/\.$/, '') + 'h';
  }

  async function loadRosterComparison(weekStart) {
    rosterByMember = new Map();
    renderDetail();                       // draw now; the roster fills in after
    try {
      const weekEnd = Holidays.getWeekEnd(weekStart);
      const { shifts } = await SquareAPI.getRosterWeek(weekStart, weekEnd);
      shifts.forEach(s => {
        const startMin = rosterMins(s.startAt);
        let endMin = rosterMins(s.endAt);
        if (endMin <= startMin) endMin += 1440;
        const list = rosterByMember.get(s.teamMemberId) || [];
        list.push({ date: s.startAt.slice(0, 10), startMin, endMin, hours: (endMin - startMin) / 60 });
        rosterByMember.set(s.teamMemberId, list);
      });
    } catch (e) {
      console.warn('[timesheets] roster unavailable:', e.message);
    }
    renderDetail();
  }

  function rosterMins(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? (+m[1] * 60 + +m[2]) : 0;
  }

  function selectStaff(squareId) {
    selectedStaff = String(squareId);
    document.querySelectorAll('#ts-staff-list .staff-card').forEach(c => {
      c.classList.toggle('selected', c.dataset.sq === selectedStaff);
    });
    renderDetail();
  }

  // Pair each day's clocked shifts against that day's rostered ones in start
  // order. A leftover on either side is a shift that was worked but never
  // rostered, or rostered but never clocked into.
  function pairShifts(ts) {
    const rostered = rosterByMember.get(ts.squareId) || [];
    const dates = [...new Set([...ts.shifts.map(s => s.date), ...rostered.map(r => r.date)])].sort();
    const rows = [];
    dates.forEach(date => {
      const actual = ts.shifts.filter(s => s.date === date)
        .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
      const plan = rostered.filter(r => r.date === date).sort((a, b) => a.startMin - b.startMin);
      const n = Math.max(actual.length, plan.length);
      for (let i = 0; i < n; i++) rows.push({ date, actual: actual[i] || null, plan: plan[i] || null });
    });
    return rows;
  }

  function renderDetail() {
    const panel = document.getElementById('ts-detail');
    if (!panel || !tsDeskMQ.matches) return;

    if (!currentTimesheets.length) {
      panel.innerHTML = '<div class="empty-state">No shifts to compare this week.</div>';
      return;
    }
    if (!selectedStaff || !currentTimesheets.some(t => String(t.squareId) === selectedStaff)) {
      selectedStaff = String(currentTimesheets[0].squareId);
      document.querySelectorAll('#ts-staff-list .staff-card').forEach(c => {
        c.classList.toggle('selected', c.dataset.sq === selectedStaff);
      });
    }
    const ts = currentTimesheets.find(t => String(t.squareId) === selectedStaff);
    const canEdit = Auth.isManager();
    const rows = pairShifts(ts);
    const haveRoster = rosterByMember.size > 0;
    rosteredForKey.clear();   // only the panel on screen needs live diffs

    let planTotal = 0, actualTotal = 0, flags = 0;

    const body = rows.map(r => {
      const planHours = r.plan ? r.plan.hours : 0;
      const actHours  = r.actual ? r.actual.hours : 0;
      planTotal   += planHours;
      actualTotal += actHours;

      const key = r.actual ? `${ts.squareId}|${r.actual.startTime}` : '';
      if (key) rosteredForKey.set(key, r.plan ? planHours : null);

      const planCell = r.plan
        ? `<span class="td-time">${minsToClock(r.plan.startMin)}–${minsToClock(r.plan.endMin)}</span><span class="td-sub">${hrs(planHours)}</span>`
        : `<span class="td-flag">Not rostered</span>`;

      const actCell = r.actual
        ? `<span class="td-time">${clockOf(r.actual.startTime)}–${r.actual.endTime ? clockOf(r.actual.endTime) : 'on now'}</span>
           <span class="td-sub">Square ${hrs(r.actual.squareHours)}</span>`
        : `<span class="td-flag">No clock-in</span>`;

      const hoursCell = !r.actual ? '<span class="td-sub">—</span>'
        : canEdit
          ? `<input class="ts-hours-input" type="number" inputmode="decimal" step="0.25" min="0"
               value="${r.actual.hours}" data-key="${key}" title="Square recorded ${r.actual.squareHours}h">`
          : `<span class="ts-hours">${r.actual.hours}h</span>`;

      // No roster loaded yet → no verdict to give, so nothing is flagged.
      const diff = r.plan && r.actual ? actHours - planHours : null;
      if (haveRoster && (!r.plan || !r.actual || Math.abs(diff) >= DIFF_TOLERANCE)) flags++;

      return `
        <tr class="${r.plan && r.actual ? '' : 'row-flag'}">
          <th scope="row">${Holidays.formatDateLabel(r.date)}</th>
          <td>${haveRoster ? planCell : '<span class="td-sub">—</span>'}</td>
          <td>${actCell}</td>
          <td class="td-hours">${hoursCell}</td>
          <td class="td-diff" data-diff-key="${key}">${diffMarkup(diff, haveRoster)}</td>
        </tr>`;
    }).join('');

    panel.innerHTML = `
      <div class="ts-detail-head">
        <div>
          <div class="ts-detail-name">${ts.name}</div>
          <div class="ts-detail-sub">${ts.shifts.length} shift${ts.shifts.length === 1 ? '' : 's'}${ts.salaried ? ' · salaried' : ''}${
            haveRoster && flags ? ` · <span class="td-flag">${flags} to check</span>` : haveRoster ? ' · matches the roster' : ''}</div>
        </div>
        <div class="ts-detail-total" id="ts-detail-total">${ts.totalHours}h</div>
      </div>
      <table class="ts-detail-table">
        <thead>
          <tr><th>Day</th><th>Rostered</th><th>Clocked</th><th class="td-hours">Hours</th><th class="td-diff">Diff</th></tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot>
          <tr>
            <th>Week</th>
            <td>${haveRoster ? hrs(planTotal) : '—'}</td>
            <td>${hrs(actualTotal)}</td>
            <td class="td-hours">${ts.totalHours}h</td>
            <td class="td-diff">${diffMarkup(haveRoster ? actualTotal - planTotal : null, haveRoster)}</td>
          </tr>
        </tfoot>
      </table>
      ${haveRoster ? '' : '<div class="ts-detail-note">No published roster for this week, so there is nothing to compare against.</div>'}`;
  }

  function diffMarkup(diff, haveRoster) {
    if (!haveRoster || diff == null) return '<span class="td-sub">—</span>';
    const rounded = Math.round(diff * 100) / 100;
    if (Math.abs(rounded) < DIFF_TOLERANCE) return '<span class="diff-ok">on plan</span>';
    const sign = rounded > 0 ? '+' : '−';
    return `<span class="${rounded > 0 ? 'diff-over' : 'diff-under'}">${sign}${hrs(Math.abs(rounded))}</span>`;
  }

  // Keep the diff honest after a manager edits the hours, without re-rendering
  // the panel and stealing focus from the next field.
  function updateDiffCell(key) {
    const cell = document.querySelector(`[data-diff-key="${key}"]`);
    if (!cell) return;
    const planHours = rosteredForKey.get(key);
    if (planHours == null) return;
    const sep = key.indexOf('|');
    const ts = currentTimesheets.find(t => String(t.squareId) === key.slice(0, sep));
    const shift = ts?.shifts.find(s => s.startTime === key.slice(sep + 1));
    if (!shift) return;
    cell.innerHTML = diffMarkup(shift.hours - planHours, true);
  }

  return { init, loadWeek };

})();
