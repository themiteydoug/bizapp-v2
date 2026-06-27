/**
 * BizOps · Staff Mapping Module
 */

const StaffModule = (() => {

  let xeroRates = [];

  async function init() {
    renderList();
    renderImportButton();
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

  async function importFromSquare() {
    const btn = document.getElementById('btn-import-square');
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
    } catch (e) {
      App.toast('Import failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px"><polyline points="8 17 12 21 16 17"></polyline><line x1="12" y1="3" x2="12" y2="21"></line></svg> Import staff from Square'; }
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

  return { init, openProfile, closeProfile, updateRate, updateField };

})();
