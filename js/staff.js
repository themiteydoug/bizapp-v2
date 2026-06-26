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
      const active = members.filter(m => m.status === 'ACTIVE');

      if (!active.length) {
        App.toast('No active team members found in Square', 'warning');
        return;
      }

      // Preserve any existing pay rate mappings by squareId
      const existing = Store.getStaff();
      const existingById = Object.fromEntries(existing.map(s => [s.squareId, s]));

      const imported = active.map(m => {
        const prev = existingById[m.id] || {};
        const name = [m.given_name, m.family_name].filter(Boolean).join(' ') || m.display_name || m.id;
        const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        return {
          id:             prev.id        || 'staff_' + m.id,
          squareId:       m.id,
          name,
          initials,
          employmentType: prev.employmentType || 'casual',
          awardLevel:     prev.awardLevel     || 1,
          xeroEmployeeId: prev.xeroEmployeeId || '',
          payRates:       prev.payRates       || { weekday: '', weekend: '', saturday: null, sunday: null, publicHol: '' },
          notes:          prev.notes          || '',
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

  function renderList() {
    const list = document.getElementById('staff-list');
    if (!list) return;
    const staff = Store.getStaff().filter(s => s.active);
    if (!staff.length) {
      list.innerHTML = '<div class="empty-state">No staff configured</div>';
      return;
    }
    list.innerHTML = staff.map(s => {
      const hasWeekend = s.awardLevel <= 1 ? !!s.payRates.weekend : !!s.payRates.saturday && !!s.payRates.sunday;
      const allMapped = !!s.payRates.weekday && hasWeekend && !!s.payRates.publicHol;
      const levelLabel = `Level ${s.awardLevel} · ${s.employmentType === 'casual' ? 'Casual' : 'Part-time'}`;
      return `
        <div class="staff-card" onclick="StaffModule.openProfile('${s.id}')">
          <div class="staff-card-inner">
            <div class="staff-avatar">${s.initials}</div>
            <div class="staff-card-info">
              <div class="staff-card-name">${s.name}</div>
              <div class="staff-card-meta">${levelLabel} · ${s.payRates.weekday || 'Weekday not set'}</div>
            </div>
            <div class="staff-card-right">
              <span class="badge ${allMapped ? 'badge-ok' : 'badge-warn'}">
                ${allMapped ? 'Mapped' : 'Incomplete'}
              </span>
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

        <div class="section-label">Classification</div>
        <div class="field-row-2" style="margin-bottom:12px">
          <div class="field-group">
            <label class="field-label">Employment type</label>
            <select class="field-input" onchange="StaffModule.updateField('${staffId}','employmentType',this.value)">
              <option value="casual" ${s.employmentType==='casual'?'selected':''}>Casual</option>
              <option value="part_time" ${s.employmentType==='part_time'?'selected':''}>Part-time</option>
            </select>
          </div>
          <div class="field-group">
            <label class="field-label">Award level</label>
            <select class="field-input" onchange="StaffModule.updateField('${staffId}','awardLevel',parseInt(this.value))">
              <option value="1" ${s.awardLevel===1?'selected':''}>Level 1</option>
              <option value="2" ${s.awardLevel===2?'selected':''}>Level 2</option>
              <option value="3" ${s.awardLevel===3?'selected':''}>Level 3</option>
            </select>
          </div>
        </div>

        <div class="section-label">Xero payroll mapping</div>

        <div class="field-group">
          <label class="field-label">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--green-400);margin-right:5px;vertical-align:middle"></span>
            Mon–Fri · Ordinary rate
          </label>
          ${makeSelect('payRates.weekday', s.payRates.weekday)}
        </div>

        ${isLevel1 ? `
        <div class="field-group">
          <label class="field-label">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--amber-500);margin-right:5px;vertical-align:middle"></span>
            Saturday &amp; Sunday · Same penalty rate (Level 1)
          </label>
          ${makeSelect('payRates.weekend', s.payRates.weekend)}
          <div style="font-size:11px;color:var(--text-3);margin-top:4px">Fast Food Award: Level 1 Sat &amp; Sun use the same rate</div>
        </div>
        ` : `
        <div class="field-group">
          <label class="field-label">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--amber-500);margin-right:5px;vertical-align:middle"></span>
            Saturday penalty rate
          </label>
          ${makeSelect('payRates.saturday', s.payRates.saturday)}
        </div>
        <div class="field-group">
          <label class="field-label">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--coral-500);margin-right:5px;vertical-align:middle"></span>
            Sunday penalty rate (Level 2+)
          </label>
          ${makeSelect('payRates.sunday', s.payRates.sunday)}
        </div>
        `}

        <div class="field-group">
          <label class="field-label">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--red-500);margin-right:5px;vertical-align:middle"></span>
            QLD Public holiday rate
          </label>
          ${makeSelect('payRates.publicHol', s.payRates.publicHol)}
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
  }

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
