/**
 * BizOps Store
 * Local state management + localStorage persistence
 */

const Store = (() => {

  const KEYS = {
    STAFF:       'bizops_staff',
    INVOICES:    'bizops_invoices',
    CASH_RECS:   'bizops_cash_recs',
    TS_PUSHES:   'bizops_ts_pushes',
    TS_ADJUST:   'bizops_ts_adjustments',
    XERO_TOKENS: 'bizops_xero_tokens',
    SETTINGS:    'bizops_settings',
    SUPPLIER_FP: 'bizops_supplier_fp',
    TOMBSTONES:  'bizops_tombstones',
  };

  // ── Staff ──────────────────────────────────────

  // Sort staff alphabetically by name (case-insensitive) for consistent display
  function sortByName(list) {
    return list.slice().sort((a, b) =>
      (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  }

  function getStaff() {
    const saved = localStorage.getItem(KEYS.STAFF);
    if (saved) return sortByName(JSON.parse(saved));
    // Default demo staff
    return sortByName([
      {
        id: 'staff_1',
        squareId: 'sq_emp_1',
        initials: 'JM',
        name: 'Jamie Mitchell',
        employmentType: 'casual',    // 'casual' | 'part_time'
        awardLevel: 1,               // 1, 2, 3 etc
        xeroEmployeeId: 'xero_emp_1',
        payRates: {
          weekday:   'Casual Level 1 - Weekday',
          weekend:   'Weekend Penalty Rate Casual',  // Level 1: sat+sun same
          saturday:  null,                            // null = use weekend for both
          sunday:    null,
          publicHol: 'Public Holiday Rate Casual',
        },
        notes: 'Casual Level 1. Available Mon–Sun. Check hours before pushing.',
        startDate: '2023-01-15',
        active: true,
      },
      {
        id: 'staff_2',
        squareId: 'sq_emp_2',
        initials: 'SC',
        name: 'Sarah Chen',
        employmentType: 'part_time',
        awardLevel: 1,
        xeroEmployeeId: 'xero_emp_2',
        payRates: {
          weekday:   'Level 1 Adult - Weekday',
          weekend:   'Weekend Penalty Rate Part-Time',
          saturday:  null,
          sunday:    null,
          publicHol: 'Public Holiday Rate Part-Time',
        },
        notes: 'Part-time. Works Tue, Wed, Sat only. Uses Level 1 Adult not Casual — she has guaranteed hours.',
        startDate: '2024-03-01',
        active: true,
      },
      {
        id: 'staff_3',
        squareId: 'sq_emp_3',
        initials: 'RP',
        name: 'Ryan Patel',
        employmentType: 'casual',
        awardLevel: 1,
        xeroEmployeeId: 'xero_emp_3',
        payRates: {
          weekday:   'Casual Level 1 - Weekday',
          weekend:   'Weekend Penalty Rate Casual',
          saturday:  null,
          sunday:    null,
          publicHol: 'Public Holiday Rate Casual',
        },
        notes: 'New staff member. Double-check hours each week.',
        startDate: '2024-06-01',
        active: true,
      },
      {
        id: 'staff_4',
        squareId: 'sq_emp_4',
        initials: 'AL',
        name: 'Amy Liu',
        employmentType: 'part_time',
        awardLevel: 2,
        xeroEmployeeId: 'xero_emp_4',
        payRates: {
          weekday:   'Level 2 Adult - Weekday',
          weekend:   null,                            // Level 2: sat/sun split
          saturday:  'Weekend Penalty Rate L2',
          sunday:    'Sunday Penalty Rate L2',
          publicHol: 'Public Holiday Rate L2',
        },
        notes: 'Shift leader, Level 2 classification. Saturday and Sunday have different rates.',
        startDate: '2022-08-10',
        active: true,
      },
      {
        id: 'staff_5',
        squareId: 'sq_emp_5',
        initials: 'TB',
        name: 'Tom Burke',
        employmentType: 'casual',
        awardLevel: 1,
        xeroEmployeeId: 'xero_emp_5',
        payRates: {
          weekday:   'Junior Level 1 - Weekday',
          weekend:   'Junior Weekend Penalty Rate',
          saturday:  null,
          sunday:    null,
          publicHol: 'Junior Public Holiday Rate',
        },
        notes: 'Under 21 — junior rates apply. Next birthday review: Feb 2026.',
        startDate: '2025-02-01',
        active: true,
      },
    ]);
  }

  // Small helper to mirror a write to the shared store when Sync is present.
  function mirrorItem(coll, item) { try { window.Sync && Sync.pushItem(coll, item); } catch {} }
  function mirrorKey(key, value)  { try { window.Sync && Sync.pushKey(key, value); } catch {} }

  // Collision-resistant ids (shared across devices now).
  function uid(prefix) { return prefix + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }

  function saveStaff(staff) {
    localStorage.setItem(KEYS.STAFF, JSON.stringify(staff));
    mirrorKey('staff', staff);
  }

  function updateStaffMember(id, updates) {
    const staff = getStaff();
    const idx = staff.findIndex(s => s.id === id);
    if (idx >= 0) {
      staff[idx] = { ...staff[idx], ...updates };
      saveStaff(staff);
      return staff[idx];
    }
  }

  // ── Invoices ───────────────────────────────────

  function getInvoices(dateStr) {
    const all = JSON.parse(localStorage.getItem(KEYS.INVOICES) || '[]');
    if (dateStr) return all.filter(i => i.date === dateStr);
    return all;
  }

  function saveInvoice(invoice) {
    const all = JSON.parse(localStorage.getItem(KEYS.INVOICES) || '[]');
    const inv = {
      id: uid('inv_'),
      createdAt: new Date().toISOString(),
      status: 'draft',
      ...invoice,
    };
    all.unshift(inv);
    localStorage.setItem(KEYS.INVOICES, JSON.stringify(all));
    mirrorItem('invoices', inv);
    return inv;
  }

  function updateInvoice(id, updates) {
    const all = JSON.parse(localStorage.getItem(KEYS.INVOICES) || '[]');
    const idx = all.findIndex(i => i.id === id);
    if (idx >= 0) {
      all[idx] = { ...all[idx], ...updates };
      localStorage.setItem(KEYS.INVOICES, JSON.stringify(all));
      mirrorItem('invoices', all[idx]);
    }
  }

  function deleteInvoice(id) {
    const all = JSON.parse(localStorage.getItem(KEYS.INVOICES) || '[]');
    localStorage.setItem(KEYS.INVOICES, JSON.stringify(all.filter(i => i.id !== id)));
    addTombstone(id);                                   // stops other devices resurrecting it
    try { window.Sync && Sync.delItem('invoices', id); } catch {}
    try { window.Sync && Sync.delPhoto(id); } catch {}
  }

  // ── Tombstones (deleted ids, synced so deletes propagate) ──

  function getTombstones() {
    return JSON.parse(localStorage.getItem(KEYS.TOMBSTONES) || '[]');
  }

  function addTombstone(id) {
    const t = getTombstones();
    if (!t.includes(id)) { t.push(id); localStorage.setItem(KEYS.TOMBSTONES, JSON.stringify(t)); mirrorKey('tombstones', t); }
  }

  // ── Supplier fingerprints (learned name ↔ identifiers) ──

  function getSupplierFingerprints() {
    return JSON.parse(localStorage.getItem(KEYS.SUPPLIER_FP) || '[]');
  }

  function saveSupplierFingerprints(list) {
    localStorage.setItem(KEYS.SUPPLIER_FP, JSON.stringify(list));
    mirrorKey('supplierFingerprints', list);
  }

  // ── Cash reconciliations ───────────────────────

  function getCashRecs() {
    return JSON.parse(localStorage.getItem(KEYS.CASH_RECS) || '[]');
  }

  function saveCashRec(rec) {
    const all = getCashRecs();
    const r = {
      id: uid('cash_'),
      createdAt: new Date().toISOString(),
      ...rec,
    };
    all.unshift(r);
    localStorage.setItem(KEYS.CASH_RECS, JSON.stringify(all));
    mirrorItem('cashRecs', r);
    return r;
  }

  // Weekly banking rec — one per week. Upsert by weekStart so re-saving updates
  // the same record (and syncs) instead of piling up duplicates.
  function getWeeklyRec(weekStart) {
    return getCashRecs().find(r => r.type === 'weekly' && r.weekStart === weekStart) || null;
  }

  function saveWeeklyRec(rec) {
    const all = getCashRecs();
    const idx = all.findIndex(r => r.type === 'weekly' && r.weekStart === rec.weekStart);
    if (idx >= 0) {
      all[idx] = { ...all[idx], ...rec, id: all[idx].id, updatedAt: new Date().toISOString() };
      localStorage.setItem(KEYS.CASH_RECS, JSON.stringify(all));
      mirrorItem('cashRecs', all[idx]);
      return all[idx];
    }
    return saveCashRec({ ...rec, updatedAt: new Date().toISOString() });
  }

  // ── Timesheet push log ─────────────────────────

  function getTsPushes() {
    return JSON.parse(localStorage.getItem(KEYS.TS_PUSHES) || '[]');
  }

  function logTsPush(weekStart, weekEnd, result) {
    const all = getTsPushes();
    const rec = {
      id: uid('ts_'),
      weekStart,
      weekEnd,
      pushedAt: new Date().toISOString(),
      result,
    };
    all.unshift(rec);
    localStorage.setItem(KEYS.TS_PUSHES, JSON.stringify(all));
    mirrorItem('tsPushes', rec);
  }

  function getLastPushForWeek(weekStart) {
    return getTsPushes().find(p => p.weekStart === weekStart) || null;
  }

  // ── Timesheet hour adjustments ─────────────────
  // Manager overrides of Square hours, keyed by `${squareId}|${shiftStartTime}`.

  function getTsAdjustments() {
    return JSON.parse(localStorage.getItem(KEYS.TS_ADJUST) || '{}');
  }

  function saveTsAdjustment(key, hours) {
    const all = getTsAdjustments();
    if (hours == null || isNaN(hours)) delete all[key];   // clear override
    else all[key] = Math.round(hours * 100) / 100;
    localStorage.setItem(KEYS.TS_ADJUST, JSON.stringify(all));
    mirrorKey('tsAdjustments', all);
  }

  // ── Xero tokens ────────────────────────────────

  function getXeroTokens() {
    return JSON.parse(localStorage.getItem(KEYS.XERO_TOKENS) || 'null');
  }

  function saveXeroTokens(tokens) {
    localStorage.setItem(KEYS.XERO_TOKENS, JSON.stringify({
      ...tokens,
      savedAt: Date.now(),
    }));
  }

  function clearXeroTokens() {
    localStorage.removeItem(KEYS.XERO_TOKENS);
  }

  // ── Settings ───────────────────────────────────

  function getSettings() {
    const saved = JSON.parse(localStorage.getItem(KEYS.SETTINGS) || '{}');
    return {
      businessName: CONFIG.BUSINESS.NAME,
      ekkaBrisbane: true,   // observe Brisbane Show holiday
      floatDefault: CONFIG.BUSINESS.FLOAT_DEFAULT,
      ...saved,
    };
  }

  function saveSetting(key, value) {
    const s = getSettings();
    s[key] = value;
    localStorage.setItem(KEYS.SETTINGS, JSON.stringify(s));
    mirrorKey('settings', s);
  }

  return {
    getStaff, saveStaff, updateStaffMember,
    getInvoices, saveInvoice, updateInvoice, deleteInvoice,
    getTombstones,
    getSupplierFingerprints, saveSupplierFingerprints,
    getCashRecs, saveCashRec, getWeeklyRec, saveWeeklyRec,
    getTsPushes, logTsPush, getLastPushForWeek,
    getTsAdjustments, saveTsAdjustment,
    getXeroTokens, saveXeroTokens, clearXeroTokens,
    getSettings, saveSetting,
  };

})();
