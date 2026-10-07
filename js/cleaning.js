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

  // The list is one ordered run of items. A heading belongs to every job under
  // it until the next heading, which is what lets the manager hand a block of
  // jobs to a role for the night.
  const isHeading = it => it && it.kind === 'heading';

  const newId = () => 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let editing = false;         // manager job-setup mode
  let staffCache = null;       // { date, list } — tonight's names, fetched once
  let pickerFor = null;        // job id whose name picker is open
  let viewDate = null;         // the day on screen; null means today
  let editSelected = null;     // the one job whose description and repeat are open

  // Wide enough for the list and the job's settings side by side.
  const deskMQ = window.matchMedia('(min-width: 1080px)');

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
    if (!job || job.active === false || isHeading(job)) return false;
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
    const items = Store.getCleanJobs();
    const jobs = items.filter(j => isDue(j, date));
    // Newest tick wins — a sync pull can briefly carry an older one alongside it.
    const done = {};
    Store.getCleanLog(date).forEach(r => {
      if (!done[r.jobId] || (r.doneAt || '') > (done[r.jobId].doneAt || '')) done[r.jobId] = r;
    });

    if (editing) { renderEditor(host); return; }

    const doneCount = jobs.filter(j => done[j.id]).length;
    const dayName = new Date(date + 'T12:00:00')
      .toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });

    // Walk the list in order so each heading lands above its own jobs. A heading
    // with nothing due under it today isn't drawn at all.
    const parts = [];
    let pending = null;
    items.forEach(it => {
      if (isHeading(it)) { pending = it; return; }
      if (!isDue(it, date)) return;
      if (pending) { parts.push(`<div class="clean-section">${esc(pending.title)}</div>`); pending = null; }

      const d = done[it.id];
      // Past days are a record of what happened, not something to edit.
      const tick = isToday
        ? `<button class="clean-tick" data-tick="${esc(it.id)}" aria-label="${d ? 'Undo' : 'Mark done'}">${d ? '✓' : ''}</button>`
        : `<span class="clean-tick is-past">${d ? '✓' : ''}</span>`;
      parts.push(`
        <div class="clean-row ${d ? 'is-done' : ''}" data-job="${esc(it.id)}">
          ${tick}
          <div class="clean-main">
            <div class="clean-title">${esc(it.title)}</div>
            ${it.notes ? `<div class="clean-notes">${esc(it.notes)}</div>` : ''}
            <div class="clean-sub">${d
              ? `${esc(d.staffName || 'Done')} · ${timeOf(d.doneAt)}`
              : (isToday ? esc(scheduleLabel(it)) : 'Not done')}</div>
          </div>
        </div>
        <div class="clean-picker" id="pick-${esc(it.id)}" hidden></div>`);
    });
    // Nothing set up at all reads very differently from nothing due today —
    // the first is a job for the manager, the second is just a quiet day.
    const noJobsAtAll = !items.some(it => !isHeading(it));
    const emptyMsg = noJobsAtAll
      ? (Auth.isManager()
          ? `<div class="clean-empty">
               No cleaning jobs set up yet.
               <button class="primary-btn" id="clean-empty-setup" style="width:auto;margin-top:14px;padding:12px 20px">Set up the list</button>
             </div>`
          : '<div class="clean-empty">No cleaning jobs have been set up yet.<br>Ask a manager to add them.</div>')
      : `<div class="clean-empty">No jobs scheduled for ${isToday ? 'today' : 'this day'}.</div>`;
    const rows = parts.length ? parts.join('') : emptyMsg;

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
      ${isToday ? '' : '<div class="clean-note">Kept for this week and last week only.</div>'}
      ${host.id === 'clean-overlay-host' ? '<button class="clean-done-btn">Close</button>' : ''}`;

    host.querySelector('#clean-manage')?.addEventListener('click', () => { editing = true; render(host); });
    host.querySelector('#clean-empty-setup')?.addEventListener('click', () => { editing = true; render(host); });
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
  // Rows collapse to the job name, so the list stays short enough to reorder
  // and a heading reads as a heading. The description and repeat picker open
  // for one job at a time: beside the list on a wide screen, under the row on
  // a phone.

  function detailHtml(j, i) {
    return `
      <div class="clean-detail">
        <label class="clean-detail-label">Description</label>
        <textarea class="clean-notes-input" rows="3" data-notes="${i}"
          placeholder="How to do it (optional)">${esc(j.notes || '')}</textarea>
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
      </div>`;
  }

  function rowHtml(j, i, last, selected) {
    const arrows = `
      <span class="clean-move">
        <button class="clean-arrow" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
        <button class="clean-arrow" data-down="${i}" ${i === last ? 'disabled' : ''} aria-label="Move down">↓</button>
      </span>`;
    const del = `<button class="clean-del" data-del="${i}" aria-label="Remove">×</button>`;

    if (isHeading(j)) {
      return `
        <div class="clean-edit-row is-heading" data-row="${i}">
          ${arrows}
          <input class="clean-input is-heading-input" value="${esc(j.title)}" data-title="${i}"
            placeholder="Heading — e.g. Front counter">
          ${del}
        </div>`;
    }
    return `
      <div class="clean-edit-row ${selected ? 'selected' : ''}" data-row="${i}">
        ${arrows}
        <input class="clean-input" value="${esc(j.title)}" data-title="${i}" placeholder="Job name">
        <span class="clean-when">${esc(scheduleLabel(j))}</span>
        <button class="clean-expand" data-expand="${i}" aria-expanded="${!!selected}" aria-label="Description and repeat">${selected ? '⌄' : '›'}</button>
        ${del}
      </div>`;
  }

  function renderEditor(host) {
    const items = Store.getCleanJobs();
    const wide = deskMQ.matches;
    const selIdx = items.findIndex(j => j.id === editSelected && !isHeading(j));
    const last = items.length - 1;

    const rows = items.map((j, i) => {
      const selected = i === selIdx;
      // On a phone the detail drops in under its own row; on a wide screen it
      // lives in the pane beside the list instead.
      return rowHtml(j, i, last, selected) + (selected && !wide ? detailHtml(j, i) : '');
    }).join('');

    host.innerHTML = `
      <div class="clean-head">
        <div>
          <div class="clean-day">Cleaning jobs</div>
          <div class="clean-count">${items.filter(j => !isHeading(j)).length} jobs · ${items.filter(isHeading).length} headings</div>
        </div>
        <button class="primary-btn clean-manage" id="clean-done">Done</button>
      </div>
      <div class="clean-editor">
        <div class="clean-edit-list">
          ${rows}
          <div class="clean-add-row">
            <button class="secondary-btn" id="clean-add">+ Add a job</button>
            <button class="secondary-btn" id="clean-add-head">+ Add a heading</button>
          </div>
          ${items.length ? '' : '<button class="primary-btn full-btn" id="clean-seed" style="margin-top:10px">Start from the Spotted Cod list</button>'}
        </div>
        ${wide ? `<div class="clean-edit-detail">${
          selIdx >= 0 ? detailHtml(items[selIdx], selIdx)
                      : '<div class="clean-detail-empty">Pick a job on the left to set its description and the days it runs.</div>'
        }</div>` : ''}
      </div>`;

    const jobsNow = () => Store.getCleanJobs();

    host.querySelector('#clean-done')?.addEventListener('click', () => { editing = false; render(host); });

    host.querySelector('#clean-add')?.addEventListener('click', () => {
      const list = jobsNow();
      const job = { id: newId(), kind: 'job', title: '', notes: '', daily: true, days: [], monthly: false, active: true };
      list.push(job);
      Store.saveCleanJobs(list);
      editSelected = job.id;                     // open it straight away to name it
      renderEditor(host);
      host.querySelector(`[data-title="${list.length - 1}"]`)?.focus();
    });

    host.querySelector('#clean-add-head')?.addEventListener('click', () => {
      const list = jobsNow();
      list.push({ id: newId(), kind: 'heading', title: '' });
      Store.saveCleanJobs(list);
      renderEditor(host);
      host.querySelector(`[data-title="${list.length - 1}"]`)?.focus();
    });

    host.querySelector('#clean-seed')?.addEventListener('click', () => {
      if (!confirm('Add the standard Spotted Cod list? You can edit or remove anything afterwards.')) return;
      Store.saveCleanJobs(starterList());
      renderEditor(host);
    });

    // Open one job's detail. Clicking the row does it too, except on the parts
    // that do something else.
    const select = id => {
      editSelected = (editSelected === id) ? null : id;
      renderEditor(host);
    };
    host.querySelectorAll('[data-expand]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      select(items[+b.dataset.expand]?.id);
    }));
    host.querySelectorAll('.clean-edit-row').forEach(row => row.addEventListener('click', e => {
      if (e.target.closest('input, textarea, button')) return;
      const j = items[+row.dataset.row];
      if (j && !isHeading(j)) select(j.id);
    }));

    host.querySelectorAll('[data-title]').forEach(inp => inp.addEventListener('change', () => {
      const list = jobsNow();
      const j = list[+inp.dataset.title];
      if (j) { j.title = inp.value.trim(); Store.saveCleanJobs(list); }
    }));

    host.querySelectorAll('[data-notes]').forEach(inp => inp.addEventListener('change', () => {
      const list = jobsNow();
      const j = list[+inp.dataset.notes];
      if (j) { j.notes = inp.value.trim(); Store.saveCleanJobs(list); }
    }));

    host.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const list = jobsNow();
      const j = list[+b.dataset.del];
      if (!j) return;
      if (!confirm(`Remove "${j.title || (isHeading(j) ? 'this heading' : 'this job')}" from the list?`)) return;
      if (j.id === editSelected) editSelected = null;
      list.splice(+b.dataset.del, 1);
      Store.saveCleanJobs(list);
      renderEditor(host);
    }));

    // Reorder with arrows rather than dragging — this gets used on a phone,
    // where a long-press drag through forty items is a fight.
    const move = (from, to) => {
      const list = jobsNow();
      if (to < 0 || to >= list.length) return;
      list.splice(to, 0, list.splice(from, 1)[0]);
      Store.saveCleanJobs(list);
      renderEditor(host);
    };
    host.querySelectorAll('[data-up]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); move(+b.dataset.up, +b.dataset.up - 1); }));
    host.querySelectorAll('[data-down]').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); move(+b.dataset.down, +b.dataset.down + 1); }));

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

  // ── Starter list ──────────────────────────────
  // Lifted from the Spotted Cod Daily Tasks list in Google Tasks, grouped into
  // roles for the night. Offered once, when the list is empty; everything is
  // editable afterwards, which is the point of the setup page.
  function starterList() {
    const H = title => ({ id: newId(), kind: 'heading', title });
    const J = (title, notes, sched) => ({
      id: newId(), kind: 'job', title, notes: notes || '',
      daily: !sched, days: sched || [], monthly: false, active: true,
    });
    const MON = [1], TUE = [2], SAT = [6], SUN = [0], MON_SAT = [1, 6];

    return [
      H('Close down — kitchen'),
      J('Seafood check', 'Top up all seafood in the crumb section. Older fish go on top.'),
      J('Defrost seafood'),
      J('Empty fish trays', 'Remove seafood from the display trays and put it back into the service fridge. Wash the trays.'),
      J('Empty display fridge', 'Remove all food items and place them into large containers.'),
      J('Empty and clean fish fridge', 'Empty all food items to the cold room. Wipe out food particles and clean.'),
      J('Replenish stock in fish fridge', 'Make sure all fish in the under bench is topped up ready for the next day.'),
      J('Replenish stock in burger fridge', 'Make sure the burger fridge has enough stock for the next day.'),
      J('Fryers'),
      J('Clean grill', 'After closing, switch off the gas and pour cold water on the grill.'),
      J('Clean microwave'),
      J('Clean blender', 'Make sure the blender is clean. Wipe over the outside and check for spills.'),
      J('Cooking equipment', 'Stove — remove all hob tops and burners, scrub them and run them through.'),
      J('Burger station', 'Clean all lids if dirty. Wipe over the inside of the chill well.'),
      J('Clean benches', 'Remove all food items and starch them away where applicable, then wipe off.'),
      J('Wipe over pass shelf', 'Remove all items from the shelf above the packing area and clean with spray.'),
      J('Wipe over shelves above burger station', 'Clean the docket printer. Wipe away crumbs.'),
      J('Clean wall outside cold room'),
      J('Wipe over dry goods shelves out back', 'Make sure the shelves are tidy and wipe up any spills.'),
      J('Dish area', 'Once all dishes are washed and put away, clean down with hot soapy water.'),
      J('Sweep and mop cold room', 'Must be done every day.'),
      J('Sweep and mop floors'),
      J('Rubbish and cardboard'),
      J('Write prep list'),

      H('Close down — front counter'),
      J('Front counter', 'Wipe over the counter with spray and wipe. Clean the display fridge glass.'),
      J('Furniture', 'Wipe over the furniture with a clean cloth using spray and wipe. Bring it in.'),
      J('Fill drinks fridge', 'Remove every crate from the cold room, fill the drinks fridge and tidy.'),
      J('Fill salt shakers', 'Refill all salt shakers, the sugar shaker and so on.'),
      J('Clean salt shaker tray', 'Change the salt shaker tray.'),
      J('Empty bin under front counter', 'Empty the bin and clean up any paper that missed it.'),

      H('Supervisor'),
      J('Supervisor check list', 'Check the cleaning has been done properly and that every item on this list is done.'),
      J('Out of stock and anything the manager should know', 'Have you told the manager about any out of stock items or important matters?'),

      H('Weekly jobs'),
      J('Leave tea towels and mats outside', '', MON),
      J('Clean shelves under packing station', 'Remove all items from both benches under the packing station. Use hot soapy water.', MON),
      J('Water the plants', 'Water the plants, please!', TUE),
      J('Clean shelf under grill', '', SUN),
      J('Dump and scrub fryers', 'Pump the oil from the crumbs fryer into the used oil vat. Drain the batter fryer oil into the filter.', MON_SAT),
      J('Burger fridge', 'Empty food items to the cold room. Wipe out food particles and scrape ice from the sides.', SAT),
      J('Clean under fridges', 'Move the two central benches and thoroughly clean the floor underneath.', SAT),
      J('Empty and clean hot box', 'Remove the trays and put them through the dishwasher. Wipe inside and outside.', SAT),
    ];
  }

  // ── Surfaces ──────────────────────────────────

  function init() {
    editing = false;
    editSelected = null;
    viewDate = null;
    render(document.getElementById('clean-host'));
  }

  // Turning an iPad mid-edit moves the open job's settings between the pane
  // beside the list and the row itself, so the editor has to be redrawn.
  deskMQ.addEventListener('change', () => {
    const host = document.getElementById('clean-host');
    if (editing && host) renderEditor(host);
  });

  function isOverlayOpen() {
    return document.getElementById('clean-overlay')?.style.display === 'flex';
  }

  function closeStandalone() {
    const el = document.getElementById('clean-overlay');
    if (el) el.style.display = 'none';
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
          <span style="width:72px"></span>
        </div>
        <div class="clean-overlay-body" id="clean-overlay-host"></div>`;
      document.body.appendChild(el);
      el.addEventListener('click', e => {
        if (e.target.closest('#clean-close, .clean-done-btn')) closeStandalone();
      });
      // Nothing else on this screen takes a key, so Escape is a free way out.
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && isOverlayOpen()) closeStandalone();
      });
    }
    el.style.display = 'flex';
    editing = false;                                   // never show setup here
    viewDate = null;                                   // staff always get today
    render(document.getElementById('clean-overlay-host'));
  }

  // Re-render in place when a sync pull brings in another device's ticks.
  function refresh() {
    if (isOverlayOpen()) render(document.getElementById('clean-overlay-host'));
    const host = document.getElementById('clean-host');
    if (host && host.innerHTML) render(host);
  }

  return { init, openStandalone, closeStandalone, refresh, isDue, scheduleLabel };

})();
