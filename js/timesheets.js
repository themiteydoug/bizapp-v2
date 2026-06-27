/**
 * BizOps · Timesheets Module
 * Review Square hours and push to Xero with penalty rate splitting
 */

const TimesheetsModule = (() => {

  let currentWeekStart = Holidays.getWeekStart();
  let currentTimesheets = [];

  function init() {
    bindEvents();
    loadWeek(currentWeekStart);
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

    const badge = input.closest('.staff-card')?.querySelector('.staff-hours-badge');
    if (badge) badge.textContent = ts.totalHours + 'h';
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
    document.getElementById('ts-week-label').textContent = Holidays.formatWeekLabel(weekStart);
    document.getElementById('ts-staff-list').innerHTML = '<div class="empty-state">Loading from Square…</div>';
    document.getElementById('ts-total-hours').textContent = '—';
    document.getElementById('ts-staff-count').textContent = '—';
    document.getElementById('ts-labour-cost').textContent = '$—';

    try {
      const data = await SquareAPI.getWeekTimesheets(weekStart);
      currentTimesheets = data;
      renderTimesheets(data, weekStart);
      renderPushStatus(weekStart);
      renderHolidayAlert(weekStart);
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

      const hasOT = ts.totalHours > 38;
      const initials = staffMember?.initials || ts.name.split(' ').map(n=>n[0]).join('').slice(0,2);

      // Day rows with category tags
      const dayRows = ts.shifts.map(shift => {
        const { category, dayType } = staffMember
          ? Holidays.getXeroCategoryForShift(shift.date, staffMember, settings.ekkaBrisbane)
          : { category: 'Weekday', dayType: 'weekday' };
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
        <div class="staff-card">
          <div class="staff-card-inner" onclick="this.closest('.staff-card').querySelector('.ts-days').classList.toggle('hidden')">
            <div class="staff-avatar">${initials}</div>
            <div class="staff-card-info">
              <div class="staff-card-name">${ts.name}</div>
              <div class="staff-card-meta">${ts.shifts.length} shifts${hasOT ? ' · ⚠ OT' : ''}</div>
            </div>
            <div class="staff-card-right">
              <div class="staff-hours-badge">${ts.totalHours}h</div>
              ${hasOT ? '<span class="badge badge-warn">OT</span>' : '<span class="badge badge-ok">OK</span>'}
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
      App.toast(`Timesheets sent to Xero — ${results.length} employees`);
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

  return { init, loadWeek };

})();
