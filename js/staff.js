/**
 * BizOps · Staff Mapping Module
 */

const StaffModule = (() => {

  let xeroRates = [];

  async function init() {
    renderList();
    renderImportButton();
    initRoster();
    // Pre-load Xero pay rates for dropdowns
    try {
      xeroRates = await XeroAPI.getPayRates();
    } catch (e) {
      console.warn('Could not load Xero rates:', e);
    }
    bindCloseModal();
  }

  function renderImportButton() {
    const container = document.getElementById('staff-import-container');
    if (!container) return;
    container.innerHTML = `
      <button class="secondary-btn" id="btn-import-square" style="width:100%;margin-bottom:16px">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px"><polyline points="8 17 12 21 16 17"></polyline><line x1="12" y1="3" x2="12" y2="21"></line></svg>
        Import staff from Square
      </button>
    `;
    document.getElementById('btn-import-square').addEventListener('click', importFromSquare);
  }

  async function importFromSquare(btnId = 'btn-import-square') {
    const btn = document.getElementById(btnId);
    const original = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

    try {
      const members = await SquareAPI.getStaffList();
      const active = members.filter(m => m.status === 'ACTIVE' && !m.is_owner);

      if (!active.length) {
        App.toast('No active team members found in Square', 'warning');
        return;
      }

      // Preserve any existing pay rate mappings by squareId
      const existing = Store.getStaff();
      const existingById = Object.fromEntries(existing.map(s => [s.squareId, s]));

      const imported = active.map(m => {
        const prev = existingById[m.id] || {};
        const name = [m.given_name || m.first_name, m.family_name || m.last_name].filter(Boolean).join(' ') || m.display_name || m.id;
        const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);

        // Extract pay rates from Square wage_setting if available
        const jobs = m.wage_setting?.job_assignments || [];
        const weekdayJob  = jobs.find(j => /weekday|team member$/i.test(j.job_title) && !/weekend|saturday|sunday/i.test(j.job_title));
        const weekendJob  = jobs.find(j => /weekend/i.test(j.job_title));
        const saturdayJob = jobs.find(j => /saturday/i.test(j.job_title));
        const sundayJob   = jobs.find(j => /sunday/i.test(j.job_title));
        const holJob      = jobs.find(j => /holiday|public/i.test(j.job_title));

        const squareRates = {
          weekday:   weekdayJob  ? (weekdayJob.hourly_rate.amount  / 100).toFixed(2) : '',
          weekend:   weekendJob  ? (weekendJob.hourly_rate.amount  / 100).toFixed(2) : '',
          saturday:  saturdayJob ? (saturdayJob.hourly_rate.amount / 100).toFixed(2) : null,
          sunday:    sundayJob   ? (sundayJob.hourly_rate.amount   / 100).toFixed(2) : null,
          publicHol: holJob      ? (holJob.hourly_rate.amount      / 100).toFixed(2) : '',
        };

        // Square job IDs for matching timecards to rates
        const jobRateMap = {};
        jobs.forEach(j => { jobRateMap[j.job_id] = j.hourly_rate.amount / 100; });

        return {
          id:             prev.id        || 'staff_' + m.id,
          squareId:       m.id,
          name,
          initials,
          employmentType: prev.employmentType || 'casual',
          awardLevel:     prev.awardLevel     || 1,
          xeroEmployeeId: prev.xeroEmployeeId || '',
          payRates:       Object.values(squareRates).some(Boolean) ? squareRates : (prev.payRates || { weekday: '', weekend: '', saturday: null, sunday: null, publicHol: '' }),
          jobRateMap,
          notes:          prev.notes     || '',
          startDate:      m.created_at?.slice(0, 10) || new Date().toISOString().slice(0, 10),
          active:         true,
        };
      });

      Store.saveStaff(imported);
      App.toast(`Imported ${imported.length} staff from Square`, 'success');
      renderList();
      seedSupervisors();
      if (rosterMQ.matches) loadRoster();
    } catch (e) {
      App.toast('Import failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = original; }
    }
  }

  async function renderList() {
    const list = document.getElementById('staff-list');
    if (!list) return;
    const staff = Store.getStaff().filter(s => s.active);
    if (!staff.length) {
      list.innerHTML = '<div class="empty-state">No staff configured</div>';
      return;
    }
    // Classification comes from Xero (cached) — type, level, rate.
    const classes = await Promise.all(
      staff.map(s => XeroAPI.getStaffClassification(s.name, s.email).catch(() => null))
    );
    list.innerHTML = staff.map((s, i) => {
      const c = classes[i];
      let meta, badge, badgeClass;
      if (!c) {
        meta = XeroAPI.isConnected() ? 'Not matched in Xero' : 'Connect Xero';
        badge = '—'; badgeClass = 'badge-warn';
      } else if (c.salaried) {
        meta = `Salaried · $${(c.weeklyCost || 0).toFixed(0)}/wk`;
        badge = 'Salaried'; badgeClass = 'badge-ok';
      } else {
        meta = `Casual · Level ${c.level} · $${(c.baseRate || 0).toFixed(2)}/hr`;
        badge = 'Casual'; badgeClass = 'badge-ok';
      }
      return `
        <div class="staff-card" onclick="StaffModule.openProfile('${s.id}')">
          <div class="staff-card-inner">
            <div class="staff-avatar">${s.initials}</div>
            <div class="staff-card-info">
              <div class="staff-card-name">${s.name}</div>
              <div class="staff-card-meta">${meta}</div>
            </div>
            <div class="staff-card-right">
              <span class="badge ${badgeClass}">${badge}</span>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  function openProfile(staffId) {
    const s = Store.getStaff().find(m => m.id === staffId);
    if (!s) return;
    const modal = document.getElementById('modal-staff-profile');
    const body = document.getElementById('staff-modal-body');
    const title = document.getElementById('staff-modal-title');
    title.textContent = s.name;
    const isLevel1 = s.awardLevel <= 1;
    const rateOptions = xeroRates.length
      ? xeroRates.map(r => `<option value="${r}" ${r === '{VAL}' ? 'selected' : ''}>${r}</option>`).join('')
      : '<option>Loading from Xero…</option>';
    const makeSelect = (fieldName, currentVal) => {
      const opts = xeroRates.length
        ? xeroRates.map(r => `<option value="${r}" ${r === currentVal ? 'selected' : ''}>${r}</option>`).join('')
        : `<option value="${currentVal || ''}">${currentVal || 'Loading…'}</option>`;
      return `<select class="field-input" data-field="${fieldName}" onchange="StaffModule.updateRate('${staffId}','${fieldName}',this.value)">${opts}</select>`;
    };
    body.innerHTML = `
      <div style="margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:12px;padding-bottom:14px;border-bottom:1px solid var(--border);margin-bottom:14px">
          <div class="staff-avatar" style="width:48px;height:48px;font-size:15px">${s.initials}</div>
          <div>
            <div style="font-size:14px;font-weight:600;color:var(--text-1)">${s.name}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:2px">Since ${new Date(s.startDate).toLocaleDateString('en-AU', {month:'long',year:'numeric'})}</div>
          </div>
        </div>

        <div class="section-label">Classification &amp; Xero mapping</div>
        <div id="staff-xero-classification">
          <div class="empty-state">Loading from Xero…</div>
        </div>

        <div class="section-label">Roster</div>
        <label class="sup-toggle">
          <input type="checkbox" ${s.supervisor ? 'checked' : ''}
            onchange="StaffModule.toggleSupervisor('${staffId}', this.checked)">
          <span>
            <strong>Supervisor / manager</strong>
            <em>Colours their shifts as a supervising shift on the printed roster. Independent of their Square job title.</em>
          </span>
        </label>

        <div class="section-label">Notes</div>
        <div class="field-group">
          <textarea class="field-textarea" rows="4"
            placeholder="Classification notes, reminders, special conditions…"
            onchange="StaffModule.updateField('${staffId}','notes',this.value)"
          >${s.notes || ''}</textarea>
        </div>

        <button class="primary-btn full-btn" onclick="StaffModule.closeProfile()">Save &amp; close</button>
      </div>
    `;
    modal.classList.add('open');
    loadClassification(s);
  }

  // Populate the classification + Xero mapping straight from Xero (no manual entry)
  async function loadClassification(s) {
    const el = document.getElementById('staff-xero-classification');
    if (!el) return;
    let c = null;
    try { c = await XeroAPI.getStaffClassification(s.name, s.email); }
    catch (e) { /* fall through to not-matched */ }

    if (!c) {
      el.innerHTML = `<div class="empty-state">
        ${XeroAPI.isConnected()
          ? 'No Xero match for this name. Check the spelling matches Xero.'
          : 'Connect Xero in Settings to auto-fill classification.'}
      </div>`;
      return;
    }

    const dot = col => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${col};margin-right:6px;vertical-align:middle"></span>`;
    const rowMap = (label, col, rate) => `
      <div class="drawer-row">
        <span class="drawer-label">${dot(col)}${label}</span>
        <span class="drawer-val" style="font-weight:600">${rate}</span>
      </div>`;

    if (c.salaried) {
      el.innerHTML = `
        <div class="drawer-row"><span class="drawer-label">Employment type</span><span class="drawer-val" style="font-weight:600">Salaried</span></div>
        <div class="drawer-row"><span class="drawer-label">Weekly cost</span><span class="drawer-val">$${(c.weeklyCost||0).toFixed(2)}</span></div>
        <div style="font-size:12px;color:var(--text-3);margin-top:8px">Salaried — pay is finalised directly in Xero, so timesheets are not pushed from here.</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px">Derived automatically from Xero · ${esc(c.xeroName)}</div>`;
      return;
    }

    el.innerHTML = `
      <div class="field-row-2" style="margin-bottom:10px">
        <div class="drawer-row"><span class="drawer-label">Type</span><span class="drawer-val" style="font-weight:600">Casual</span></div>
        <div class="drawer-row"><span class="drawer-label">Award level</span><span class="drawer-val" style="font-weight:600">Level ${c.level}</span></div>
      </div>
      <div class="drawer-row"><span class="drawer-label">Base rate</span><span class="drawer-val">$${(c.baseRate||0).toFixed(2)}/hr</span></div>
      <div class="cost-divider"></div>
      ${rowMap('Mon–Fri', 'var(--green-400)', c.rates.weekday)}
      ${c.level <= 1
        ? rowMap('Sat &amp; Sun', 'var(--amber-500)', c.rates.saturday)
        : rowMap('Saturday', 'var(--amber-500)', c.rates.saturday) + rowMap('Sunday', 'var(--coral-500)', c.rates.sunday)}
      ${rowMap('Public holiday', 'var(--red-500)', c.rates.publicHoliday)}
      <div style="font-size:11px;color:var(--text-3);margin-top:8px">Derived automatically from Xero · ${esc(c.xeroName)} · no manual mapping needed</div>`;
  }

  function esc(s) { return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  function updateRate(staffId, dotPath, value) {
    const s = Store.getStaff().find(m => m.id === staffId);
    if (!s) return;
    // dotPath like 'payRates.weekday'
    const parts = dotPath.split('.');
    const updates = {};
    if (parts.length === 2 && parts[0] === 'payRates') {
      const newRates = { ...s.payRates, [parts[1]]: value };
      updates.payRates = newRates;
    }
    Store.updateStaffMember(staffId, updates);
  }

  function updateField(staffId, field, value) {
    Store.updateStaffMember(staffId, { [field]: value });
  }

  function closeProfile() {
    document.getElementById('modal-staff-profile').classList.remove('open');
    renderList();
  }

  function bindCloseModal() {
    document.getElementById('close-staff-modal')?.addEventListener('click', closeProfile);
    document.getElementById('modal-staff-profile')?.addEventListener('click', e => {
      if (e.target === e.currentTarget) closeProfile();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  WEEKLY ROSTER (desktop only)
  //  Reads Square's PUBLISHED scheduled shifts and lays them out for
  //  A4 landscape printing — hours only, never pay. Square's API does
  //  not expose the roster colours, so they're derived from the shift
  //  times plus who is supervising (see supervisingIds).
  // ═══════════════════════════════════════════════════════════════

  const rosterMQ = window.matchMedia('(min-width: 1080px)');
  const DEFAULT_SUPERVISORS = ['lia', 'jonah', 'ashlee'];
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const EVENING = 17 * 60;          // 5pm — the changeover the colour rules hinge on
  const OPEN_WEEKDAY = 9 * 60 + 30; // 9:30am Mon–Fri
  const OPEN_WEEKEND = 10 * 60 + 30;// 10:30am Sat & Sun

  let rosterWeek = null;
  let rosterLoading = false;
  let rosterBound = false;
  let rosterWatching = false;

  function initRoster() {
    if (!document.getElementById('roster-grid')) return;

    // Phone view never builds the roster — but an iPad turned on its side
    // crosses into the desktop layout, so pick it up when that happens.
    if (!rosterMQ.matches) {
      if (!rosterWatching) {
        rosterWatching = true;
        rosterMQ.addEventListener('change', () => initRoster(), { once: true });
      }
      return;
    }
    if (rosterBound) { loadRoster(); return; }
    rosterBound = true;

    rosterWeek = Holidays.getWeekStart();
    seedSupervisors();

    document.getElementById('roster-prev-week')?.addEventListener('click', () => stepRoster(-7));
    document.getElementById('roster-next-week')?.addEventListener('click', () => stepRoster(7));
    document.getElementById('btn-roster-print')?.addEventListener('click', printRoster);
    document.getElementById('btn-roster-import')?.addEventListener('click', () => importFromSquare('btn-roster-import'));

    loadRoster();
  }

  // Lia, Jonah and Ashlee supervise by default. Only seeded once — after that
  // every record carries an explicit true/false and the tick-boxes rule.
  function seedSupervisors() {
    const staff = Store.getStaff();
    if (!staff.length || staff.some(s => s.supervisor !== undefined)) return;
    staff.forEach(s => {
      const first = (s.name || '').trim().split(/\s+/)[0].toLowerCase();
      Store.updateStaffMember(s.id, { supervisor: DEFAULT_SUPERVISORS.includes(first) });
    });
  }

  function stepRoster(days) {
    const d = new Date(rosterWeek + 'T12:00:00');
    d.setDate(d.getDate() + days);
    rosterWeek = d.toISOString().slice(0, 10);
    loadRoster();
  }

  function addDaysISO(iso, n) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Shift times arrive as '2026-09-15T09:30:00+10:00' — read the wall clock
  // straight off the string so no browser timezone can shift it.
  function minsOf(iso) {
    const m = /T(\d{2}):(\d{2})/.exec(iso || '');
    return m ? (+m[1] * 60 + +m[2]) : 0;
  }

  function fmtClock(min) {
    let h = Math.floor(min / 60) % 24;
    const m = min % 60;
    const ap = h >= 12 ? 'p' : 'a';
    h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
  }

  function fmtHours(h) {
    return (Math.round(h * 100) / 100).toFixed(h % 1 === 0 ? 0 : 1) + 'h';
  }

  function dayLabel(iso) {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  }

  function weekRangeLabel(start) {
    const a = new Date(start + 'T12:00:00');
    const b = new Date(addDaysISO(start, 6) + 'T12:00:00');
    const sameMonth = a.getMonth() === b.getMonth();
    const fmtA = a.toLocaleDateString('en-AU', sameMonth ? { day: 'numeric' } : { day: 'numeric', month: 'short' });
    const fmtB = b.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${fmtA} – ${fmtB}`;
  }

  async function loadRoster() {
    const grid = document.getElementById('roster-grid');
    if (!grid || rosterLoading) return;
    rosterLoading = true;

    const thisWeek = Holidays.getWeekStart();
    const offset = Math.round((new Date(rosterWeek) - new Date(thisWeek)) / 604800000);
    const rel = offset === 0 ? 'This week' : offset === 1 ? 'Next week' : offset === -1 ? 'Last week' : null;
    const label = document.getElementById('roster-week-label');
    if (label) label.textContent = rel ? `${rel} · ${weekRangeLabel(rosterWeek)}` : weekRangeLabel(rosterWeek);
    const printWeek = document.getElementById('roster-print-week');
    if (printWeek) printWeek.textContent = weekRangeLabel(rosterWeek);

    grid.innerHTML = '<div class="empty-state">Loading roster…</div>';
    setRosterStatus('');

    try {
      const weekEnd = addDaysISO(rosterWeek, 6);
      const [roster, members] = await Promise.all([
        SquareAPI.getRosterWeek(rosterWeek, weekEnd),
        SquareAPI.getStaffList().catch(() => []),
      ]);

      updateImportBadge(members);
      renderRoster(roster, members);
    } catch (e) {
      grid.innerHTML = `<div class="empty-state">Could not load the roster from Square.<br><span style="font-size:11px">${esc(e.message)}</span></div>`;
      document.getElementById('roster-legend').innerHTML = '';
    } finally {
      rosterLoading = false;
    }
  }

  function setRosterStatus(text, tone) {
    const el = document.getElementById('roster-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'roster-status' + (tone ? ' ' + tone : '');
  }

  // Square staff the app doesn't know about yet → badge on the import button.
  function updateImportBadge(members) {
    const badge = document.getElementById('roster-import-badge');
    if (!badge) return;
    const known = new Set(Store.getStaff().map(s => s.squareId));
    const missing = (members || []).filter(m => m.status === 'ACTIVE' && !m.is_owner && !known.has(m.id)).length;
    badge.hidden = !missing;
    badge.textContent = missing ? String(missing) : '';
  }

  function nameFor(id, members, staff) {
    const m = (members || []).find(x => x.id === id);
    if (m) {
      const n = [m.given_name, m.family_name].filter(Boolean).join(' ');
      if (n) return n;
    }
    const s = (staff || []).find(x => x.squareId === id);
    return s ? s.name : 'Unknown';
  }

  // Who is running the shift. Three sources, in order:
  //   • ticked as a supervisor on the staff card (Lia, Jonah, Ashlee by default)
  //   • Rule A — opens the shop and is on their own
  //   • Rule B — no supervisor on past 5pm, so the earliest starter still
  //     working after 5pm is covering it
  function supervisingIds(dayShifts, dayIso, flagged) {
    const sup = new Set();
    dayShifts.forEach(s => { if (flagged.has(s.teamMemberId)) sup.add(s.id); });

    const dow = new Date(dayIso + 'T12:00:00').getDay();     // 0 = Sun, 6 = Sat
    const openMin = (dow === 0 || dow === 6) ? OPEN_WEEKEND : OPEN_WEEKDAY;

    dayShifts.forEach(s => {
      if (s.startMin > openMin + 15) return;
      const alone = !dayShifts.some(o => o.id !== s.id && o.startMin <= s.startMin && o.endMin > s.startMin);
      if (alone) sup.add(s.id);
    });

    const coveredLate = dayShifts.some(s => sup.has(s.id) && s.endMin > EVENING);
    if (!coveredLate) {
      const candidates = dayShifts
        .filter(s => s.startMin < EVENING && s.endMin > EVENING)
        .sort((a, b) => a.startMin - b.startMin);
      if (candidates.length) sup.add(candidates[0].id);
    }
    return sup;
  }

  // Blue   — open to close
  // Orange — supervisor, morning/lunch     Yellow — casual, morning/lunch
  // Pink   — supervisor, evening           Green  — casual, evening
  function shiftColour(s, isSup) {
    const hours = (s.endMin - s.startMin) / 60;
    if (hours >= 8 && s.endMin >= 20 * 60) return 'blue';
    if (s.startMin >= 15 * 60) return isSup ? 'pink' : 'green';
    return isSup ? 'orange' : 'yellow';
  }

  const LEGEND = [
    ['blue',   'Open to close'],
    ['orange', 'Supervisor · day'],
    ['pink',   'Supervisor · evening'],
    ['yellow', 'Casual · lunch'],
    ['green',  'Casual · evening'],
  ];

  function renderRoster(roster, members) {
    const grid = document.getElementById('roster-grid');
    const staff = Store.getStaff();
    const flagged = new Set(staff.filter(s => s.supervisor).map(s => s.squareId));

    const days = Array.from({ length: 7 }, (_, i) => addDaysISO(rosterWeek, i));

    const shifts = roster.shifts.map(s => ({
      ...s,
      day: s.startAt.slice(0, 10),
      startMin: minsOf(s.startAt),
      endMin: (() => { const e = minsOf(s.endAt); return e <= minsOf(s.startAt) ? e + 1440 : e; })(),
    })).filter(s => days.includes(s.day));

    if (!shifts.length) {
      const msg = roster.draftCount
        ? `This week's roster is drafted but not published yet — ${roster.draftCount} shift${roster.draftCount === 1 ? '' : 's'} waiting in Square.`
        : 'No published roster for this week.';
      grid.innerHTML = `<div class="empty-state">${msg}</div>`;
      document.getElementById('roster-legend').innerHTML = '';
      setRosterStatus(roster.draftCount ? 'Draft only' : '', roster.draftCount ? 'warn' : '');
      return;
    }

    setRosterStatus(roster.draftCount ? `${roster.draftCount} unpublished` : 'Published', roster.draftCount ? 'warn' : 'ok');

    // Work out who's supervising, day by day
    const supAll = new Set();
    days.forEach(d => {
      const dayShifts = shifts.filter(s => s.day === d);
      supervisingIds(dayShifts, d, flagged).forEach(id => supAll.add(id));
    });

    // Group by person
    const byMember = new Map();
    shifts.forEach(s => {
      if (!byMember.has(s.teamMemberId)) byMember.set(s.teamMemberId, []);
      byMember.get(s.teamMemberId).push(s);
    });

    const rows = [...byMember.entries()]
      .map(([id, list]) => ({ id, name: nameFor(id, members, staff), list }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const dayTotals = days.map(() => 0);
    let weekTotal = 0;

    const body = rows.map(r => {
      let rowTotal = 0;
      const cells = days.map((d, i) => {
        const inDay = r.list.filter(s => s.day === d).sort((a, b) => a.startMin - b.startMin);
        if (!inDay.length) return '<td class="rc-empty"></td>';
        return '<td>' + inDay.map(s => {
          const hours = (s.endMin - s.startMin) / 60;
          rowTotal += hours;
          dayTotals[i] += hours;
          weekTotal += hours;
          return `<div class="shift-box sh-${shiftColour(s, supAll.has(s.id))}">
              <span class="sh-time">${fmtClock(s.startMin)}–${fmtClock(s.endMin)}</span>
              <span class="sh-hrs">${fmtHours(hours)}</span>
            </div>`;
        }).join('') + '</td>';
      }).join('');
      return `<tr><th scope="row" class="rc-name">${esc(r.name)}</th>${cells}<td class="rc-total">${fmtHours(rowTotal)}</td></tr>`;
    }).join('');

    grid.innerHTML = `
      <table class="roster-table">
        <thead>
          <tr>
            <th class="rc-name">Staff</th>
            ${days.map((d, i) => `<th><span class="rc-dow">${DAY_NAMES[i]}</span><span class="rc-date">${dayLabel(d)}</span></th>`).join('')}
            <th class="rc-total">Hours</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot>
          <tr>
            <th class="rc-name">Daily hours</th>
            ${dayTotals.map(t => `<td>${t ? fmtHours(t) : '—'}</td>`).join('')}
            <td class="rc-total">${fmtHours(weekTotal)}</td>
          </tr>
        </tfoot>
      </table>`;

    document.getElementById('roster-legend').innerHTML =
      LEGEND.map(([c, t]) => `<span class="lg-item"><i class="lg-chip sh-${c}"></i>${t}</span>`).join('');
  }

  function printRoster() {
    document.body.classList.add('print-roster');
    const clear = () => document.body.classList.remove('print-roster');
    window.addEventListener('afterprint', clear, { once: true });
    setTimeout(() => window.print(), 30);
    // Safety net for browsers that never fire afterprint
    setTimeout(clear, 4000);
  }

  function toggleSupervisor(staffId, checked) {
    Store.updateStaffMember(staffId, { supervisor: !!checked });
    if (rosterMQ.matches) loadRoster();
  }

  return { init, openProfile, closeProfile, updateRate, updateField, toggleSupervisor };

})();
