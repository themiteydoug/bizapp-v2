/**
 * PCW · Cleaning list
 *
 * A daily job list the staff tick off as they go, putting their name against
 * each one, so the next morning you can see who did what — and whether they
 * were trained for it.
 *
 * Two surfaces, one renderer:
 *   • the Cleaning page inside the app (managers also get the job setup there)
 *   • a full-screen view opened straight from the PIN pad, so staff can tick
 *     jobs off without signing in
 *
 * Scheduling: a job runs daily, or on chosen weekdays, and "monthly" narrows
 * whichever of those to one week in four. The four-week cycle is counted from a
 * fixed Monday rather than stored per job, so every device agrees on which week
 * is which without anything to keep in step.
 */

const CleaningModule = (() => {

  // Monday-first, the way the week reads on a roster. The single letters repeat
  // (T, T and S, S) — that's how the iOS repeat picker does it and position
  // carries the meaning.
  const DAYS = [
    { i: 1, short: 'Mon', letter: 'M' }, { i: 2, short: 'Tue', letter: 'T' },
    { i: 3, short: 'Wed', letter: 'W' }, { i: 4, short: 'Thu', letter: 'T' },
    { i: 5, short: 'Fri', letter: 'F' }, { i: 6, short: 'Sat', letter: 'S' },
    { i: 0, short: 'Sun', letter: 'S' },     // JS getDay(): 0 = Sunday
  ];

  // A Monday. Anchors the every-four-weeks cycle so all devices agree.
  const CYCLE_EPOCH = '2024-01-01';

  let editing = false;         // manager job-setup mode
  let staffCache = null;       // { date, list } — tonight's names, fetched once
  let pickerFor = null;        // job id whose name picker is open
  let viewDate = null;         // the day on screen; null means today

  // ── Dates ─────────────────────────────────────

  function today() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });
  }

  function shiftDate(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function weeksSinceEpoch(dateStr) {
    const a = Date.parse(CYCLE_EPOCH + 'T00:00:00Z');
    const b = Date.parse(dateStr + 'T00:00:00Z');
    return Math.floor((b - a) / 604800000);
  }

  // ── Scheduling ────────────────────────────────

  function isDue(job, dateStr) {
    if (!job || job.active === false) return false;
    const dow = new Date(dateStr + 'T12:00:00').getDay();
    const days = job.days || [];

    // "Monthly" doesn't schedule on its own — it thins out whatever else is
    // chosen to one week in four. On its own it means the Monday of that week.
    const fourthWeek = weeksSinceEpoch(dateStr) % 4 === 0;

    if (job.daily)      return job.monthly ? fourthWeek : true;
    if (days.length)    return days.includes(dow) && (!job.monthly || fourthWeek);
    if (job.monthly)    return fourthWeek && dow === 1;
    return false;       // nothing chosen — never shows up
  }

  function scheduleLabel(job) {
    if (job.daily) return job.monthly ? 'Daily · every 4th week' : 'Daily';
    const days = (job.days || []);
    if (days.length) {
      const names = DAYS.filter(d => days.includes(d.i)).map(d => d.short).join(', ');
      return job.monthly ? `${names} · every 4 weeks` : names;
    }
    if (job.monthly) return 'Every 4 weeks';
    return 'Never';
  }

  // ── Who was on tonight ────────────────────────
  // The published roster for today, falling back to the full staff list when
  // there's no roster (or Square can't be reached) — the list must never become
  // un-tickable just because a name lookup failed.

  async function tonightStaff() {
    const date = today();
    if (staffCache && staffCache.date === date) return staffCache.list;

    const all = Store.getStaff().filter(s => s.active !== false);
    let list = all.map(s => ({ id: s.id, name: s.name }));

    try {
      const weekStart = Holidays.getWeekStart();
      const { shifts } = await SquareAPI.getRosterWeek(weekStart, Holidays.getWeekEnd(weekStart));
      const onTonight = new Set(
        shifts.filter(s => (s.startAt || '').slice(0, 10) === date).map(s => s.teamMemberId)
      );
      const rostered = all.filter(s => onTonight.has(s.squareId));
      if (rostered.length) list = rostered.map(s => ({ id: s.id, name: s.name }));
    } catch (e) {
      console.warn('[cleaning] roster unavailable, showing all staff:', e.message);
    }

    staffCache = { date, list };
    return list;
  }

  // ── Rendering ─────────────────────────────────

  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  function render(host) {
    if (!host) return;
    Store.pruneCleanLog();                       // no-op once it's clean

    const date = viewDate || today();
    const isToday = date === today();
    const floor = Store.cleanRetainFrom();       // only this week and last are kept
    const jobs = Store.getCleanJobs().filter(j => isDue(j, date));
    // Newest tick wins — a sync pull can briefly carry an older one alongside it.
    const done = {};
    Store.getCleanLog(date).forEach(r => {
      if (!done[r.jobId] || (r.doneAt || '') > (done[r.jobId].doneAt || '')) done[r.jobId] = r;
    });

    if (editing) { renderEditor(host); return; }

    const doneCount = jobs.filter(j => done[j.id]).length;
    const dayName = new Date(date + 'T12:00:00')
      .toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });

    const rows = jobs.length ? jobs.map(j => {
      const d = done[j.id];
      // Past days are a record of what happened, not something to edit.
      const tick = isToday
        ? `<button class="clean-tick" data-tick="${esc(j.id)}" aria-label="${d ? 'Undo' : 'Mark done'}">${d ? '✓' : ''}</button>`
        : `<span class="clean-tick is-past">${d ? '✓' : ''}</span>`;
      return `
        <div class="clean-row ${d ? 'is-done' : ''}" data-job="${esc(j.id)}">
          ${tick}
          <div class="clean-main">
            <div class="clean-title">${esc(j.title)}</div>
            <div class="clean-sub">${d
              ? `${esc(d.staffName || 'Done')} · ${timeOf(d.doneAt)}`
              : (isToday ? esc(j.area || scheduleLabel(j)) : 'Not done')}</div>
          </div>
        </div>
        <div class="clean-picker" id="pick-${esc(j.id)}" hidden></div>`;
    }).join('') : `<div class="clean-empty">No jobs scheduled for ${isToday ? 'today' : 'this day'}.</div>`;

    host.innerHTML = `
      <div class="clean-head">
        <div class="clean-daynav">
          <button class="clean-step" id="clean-prev" ${shiftDate(date, -1) < floor ? 'disabled' : ''} aria-label="Previous day">‹</button>
          <div>
            <div class="clean-day">${isToday ? 'Today' : dayName}</div>
            <div class="clean-count">${isToday ? `${doneCount} of ${jobs.length} done` : `${dayName} · ${doneCount} of ${jobs.length} done`}</div>
          </div>
          <button class="clean-step" id="clean-next" ${isToday ? 'disabled' : ''} aria-label="Next day">›</button>
        </div>
        ${Auth.isManager() ? '<button class="secondary-btn clean-manage" id="clean-manage">Manage jobs</button>' : ''}
      </div>
      <div class="clean-progress"><span style="width:${jobs.length ? Math.round(doneCount / jobs.length * 100) : 0}%"></span></div>
      <div class="clean-list">${rows}</div>
      ${isToday ? '' : '<div class="clean-note">Kept for this week and last week only.</div>'}`;

    host.querySelector('#clean-manage')?.addEventListener('click', () => { editing = true; render(host); });
    host.querySelector('#clean-prev')?.addEventListener('click', () => { viewDate = shiftDate(date, -1); render(host); });
    host.querySelector('#clean-next')?.addEventListener('click', () => {
      const next = shiftDate(date, 1);
      viewDate = next >= today() ? null : next;
      render(host);
    });
    host.querySelectorAll('[data-tick]').forEach(b => b.addEventListener('click', () => onTick(host, b.dataset.tick)));
  }

  function timeOf(iso) {
    try {
      return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Brisbane' });
    } catch { return ''; }
  }

  // Ticking an undone job asks who did it; ticking a done one clears it.
  async function onTick(host, jobId) {
    const date = today();
    const already = Store.getCleanLog(date).find(r => r.jobId === jobId);
    if (already) {
      Store.clearCleanJob(date, jobId);
      render(host);
      return;
    }

    const box = host.querySelector('#pick-' + CSS.escape(jobId));
    if (!box) return;

    // A second tap on the same job closes the picker again.
    if (pickerFor === jobId && !box.hidden) { box.hidden = true; pickerFor = null; return; }
    host.querySelectorAll('.clean-picker').forEach(p => { p.hidden = true; });
    pickerFor = jobId;

    box.hidden = false;
    box.innerHTML = '<div class="clean-pick-hint">Loading tonight’s staff…</div>';
    const list = await tonightStaff();
    if (pickerFor !== jobId) return;      // another job was tapped meanwhile

    box.innerHTML = list.length
      ? `<div class="clean-pick-hint">Who did this?</div>
         <div class="clean-pick-names">
           ${list.map(s => `<button class="clean-name" data-staff="${esc(s.id)}">${esc(s.name)}</button>`).join('')}
         </div>`
      : '<div class="clean-pick-hint">No staff set up yet — import them on the Staff page.</div>';

    box.querySelectorAll('[data-staff]').forEach(b => b.addEventListener('click', () => {
      const who = list.find(s => s.id === b.dataset.staff);
      Store.logCleanJob(date, jobId, who);
      pickerFor = null;
      render(host);
    }));
  }

  // ── Manager setup ─────────────────────────────

  function renderEditor(host) {
    const jobs = Store.getCleanJobs();
    host.innerHTML = `
      <div class="clean-head">
        <div>
          <div class="clean-day">Cleaning jobs</div>
          <div class="clean-count">${jobs.length} job${jobs.length === 1 ? '' : 's'} · tap the days each one runs</div>
        </div>
        <button class="primary-btn clean-manage" id="clean-done">Done</button>
      </div>
      <div class="clean-list">
        ${jobs.map((j, i) => `
          <div class="clean-edit" data-idx="${i}">
            <div class="clean-edit-top">
              <input class="clean-input" value="${esc(j.title)}" data-title="${i}" placeholder="Job name">
              <button class="clean-del" data-del="${i}" title="Remove job" aria-label="Remove job">×</button>
            </div>
            <div class="clean-repeat">
              <div class="clean-repeat-head">
                <span>Repeat</span>
                <span class="clean-repeat-val">${esc(scheduleLabel(j))}</span>
              </div>
              <div class="clean-circles">
                ${DAYS.map(d => `
                  <button class="clean-circle ${(j.days || []).includes(d.i) ? 'on' : ''}"
                    data-day="${i}:${d.i}" title="${d.short}" aria-label="${d.short}"
                    aria-pressed="${(j.days || []).includes(d.i)}">${d.letter}</button>`).join('')}
              </div>
              <div class="clean-repeat-opts">
                <button class="clean-chip ${j.daily ? 'on' : ''}" data-daily="${i}" aria-pressed="${!!j.daily}">Daily</button>
                <button class="clean-chip ${j.monthly ? 'on' : ''}" data-monthly="${i}" aria-pressed="${!!j.monthly}">Monthly</button>
              </div>
            </div>
          </div>`).join('')}
      </div>
      <button class="secondary-btn full-btn" id="clean-add">+ Add a job</button>`;

    const jobsNow = () => Store.getCleanJobs();

    host.querySelector('#clean-done')?.addEventListener('click', () => { editing = false; render(host); });

    host.querySelector('#clean-add')?.addEventListener('click', () => {
      const list = jobsNow();
      list.push({ id: 'job_' + Date.now().toString(36), title: '', daily: true, days: [], monthly: false, active: true });
      Store.saveCleanJobs(list);
      renderEditor(host);
    });

    host.querySelectorAll('[data-title]').forEach(inp => inp.addEventListener('change', () => {
      const list = jobsNow();
      const j = list[+inp.dataset.title];
      if (j) { j.title = inp.value.trim(); Store.saveCleanJobs(list); }
    }));

    host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      const list = jobsNow();
      const j = list[+b.dataset.del];
      if (!j) return;
      if (!confirm(`Remove "${j.title || 'this job'}" from the list?`)) return;
      list.splice(+b.dataset.del, 1);
      Store.saveCleanJobs(list);
      renderEditor(host);
    }));

    // Daily and specific days are alternatives — choosing one clears the other,
    // so the schedule can't end up saying two things at once.
    host.querySelectorAll('[data-daily]').forEach(b => b.addEventListener('click', () => {
      const list = jobsNow();
      const j = list[+b.dataset.daily];
      if (!j) return;
      j.daily = !j.daily;
      if (j.daily) j.days = [];
      Store.saveCleanJobs(list);
      renderEditor(host);
    }));

    host.querySelectorAll('[data-day]').forEach(b => b.addEventListener('click', () => {
      const [idx, day] = b.dataset.day.split(':').map(Number);
      const list = jobsNow();
      const j = list[idx];
      if (!j) return;
      const days = new Set(j.days || []);
      days.has(day) ? days.delete(day) : days.add(day);
      j.days = [...days].sort();
      if (j.days.length) j.daily = false;
      Store.saveCleanJobs(list);
      renderEditor(host);
    }));

    host.querySelectorAll('[data-monthly]').forEach(b => b.addEventListener('click', () => {
      const list = jobsNow();
      const j = list[+b.dataset.monthly];
      if (!j) return;
      j.monthly = !j.monthly;
      Store.saveCleanJobs(list);
      renderEditor(host);
    }));
  }

  // ── Surfaces ──────────────────────────────────

  function init() {
    editing = false;
    viewDate = null;
    render(document.getElementById('clean-host'));
  }

  // Opened from the PIN pad: the same list, full screen, no sign-in.
  function openStandalone() {
    let el = document.getElementById('clean-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'clean-overlay';
      el.innerHTML = `
        <div class="clean-overlay-bar">
          <button class="clean-back" id="clean-close">‹ Back</button>
          <span>Cleaning list</span>
          <span style="width:56px"></span>
        </div>
        <div class="clean-overlay-body" id="clean-overlay-host"></div>`;
      document.body.appendChild(el);
      el.querySelector('#clean-close').addEventListener('click', () => { el.style.display = 'none'; });
    }
    el.style.display = 'flex';
    editing = false;                                   // never show setup here
    viewDate = null;                                   // staff always get today
    render(document.getElementById('clean-overlay-host'));
  }

  // Re-render in place when a sync pull brings in another device's ticks.
  function refresh() {
    if (document.getElementById('clean-overlay')?.style.display === 'flex') {
      render(document.getElementById('clean-overlay-host'));
    }
    const host = document.getElementById('clean-host');
    if (host && host.innerHTML) render(host);
  }

  return { init, openStandalone, refresh, isDue, scheduleLabel };

})();
