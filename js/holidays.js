/**
 * BizOps · QLD Public Holidays
 * Auto-detects public holiday dates for correct Xero payroll category routing
 */

const Holidays = (() => {

  // ── Static QLD public holidays ─────────────────
  // Format: 'YYYY-MM-DD'
  // Updated annually — add new year's dates each December

  const QLD_HOLIDAYS = {
    2024: [
      { date: '2024-01-01', name: "New Year's Day" },
      { date: '2024-01-29', name: 'Australia Day' },
      { date: '2024-03-29', name: 'Good Friday' },
      { date: '2024-03-30', name: 'Easter Saturday' },
      { date: '2024-04-01', name: 'Easter Monday' },
      { date: '2024-04-25', name: 'Anzac Day' },
      { date: '2024-05-06', name: 'Labour Day' },
      { date: '2024-08-14', name: 'Royal Queensland Show (Brisbane)' },
      { date: '2024-10-07', name: 'Queen\'s Birthday' },
      { date: '2024-12-25', name: 'Christmas Day' },
      { date: '2024-12-26', name: 'Boxing Day' },
    ],
    2025: [
      { date: '2025-01-01', name: "New Year's Day" },
      { date: '2025-01-27', name: 'Australia Day' },
      { date: '2025-04-18', name: 'Good Friday' },
      { date: '2025-04-19', name: 'Easter Saturday' },
      { date: '2025-04-21', name: 'Easter Monday' },
      { date: '2025-04-25', name: 'Anzac Day' },
      { date: '2025-05-05', name: 'Labour Day' },
      { date: '2025-08-13', name: 'Royal Queensland Show (Brisbane)' },
      { date: '2025-10-06', name: "King's Birthday" },
      { date: '2025-12-25', name: 'Christmas Day' },
      { date: '2025-12-26', name: 'Boxing Day' },
    ],
    2026: [
      { date: '2026-01-01', name: "New Year's Day" },
      { date: '2026-01-26', name: 'Australia Day' },
      { date: '2026-04-03', name: 'Good Friday' },
      { date: '2026-04-04', name: 'Easter Saturday' },
      { date: '2026-04-06', name: 'Easter Monday' },
      { date: '2026-04-25', name: 'Anzac Day' },
      { date: '2026-05-04', name: 'Labour Day' },
      { date: '2026-08-12', name: 'Royal Queensland Show (Brisbane)' },
      { date: '2026-10-05', name: "King's Birthday" },
      { date: '2026-12-25', name: 'Christmas Day' },
      { date: '2026-12-28', name: 'Boxing Day (substitute)' },
    ],
  };

  // ── Lookup ─────────────────────────────────────

  function getHolidaysForYear(year) {
    return QLD_HOLIDAYS[year] || [];
  }

  function isPublicHoliday(dateStr, observeEkka = true) {
    const year = parseInt(dateStr.slice(0, 4));
    const holidays = getHolidaysForYear(year);
    const match = holidays.find(h => h.date === dateStr);
    if (!match) return null;
    // Optionally skip Brisbane Show if business doesn't observe it
    if (!observeEkka && match.name.includes('Queensland Show')) return null;
    return match;
  }

  /**
   * Get day type for a given date string (YYYY-MM-DD)
   * Returns: 'weekday' | 'saturday' | 'sunday' | 'public_holiday'
   */
  function getDayType(dateStr, observeEkka = true) {
    // Check public holiday first (overrides weekend)
    if (isPublicHoliday(dateStr, observeEkka)) return 'public_holiday';
    const d = new Date(dateStr + 'T12:00:00'); // noon to avoid timezone edge cases
    const dow = d.getDay(); // 0=Sun, 6=Sat
    if (dow === 6) return 'saturday';
    if (dow === 0) return 'sunday';
    return 'weekday';
  }

  /**
   * Given a week (Mon–Sun), return all public holidays in that range
   */
  function getHolidaysInWeek(weekStartDate) {
    const start = new Date(weekStartDate + 'T12:00:00');
    const holidays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const ph = isPublicHoliday(ds);
      if (ph) holidays.push({ date: ds, ...ph });
    }
    return holidays;
  }

  /**
   * Get the Xero payroll category for a shift on a given date,
   * based on the staff member's mapped rates and Fast Food Award level
   */
  function getXeroCategoryForShift(dateStr, staffMember, observeEkka = true) {
    const dayType = getDayType(dateStr, observeEkka);
    const rates = staffMember.payRates;
    const level = staffMember.awardLevel;

    switch (dayType) {
      case 'public_holiday':
        return { category: rates.publicHol, dayType: 'public_holiday' };
      case 'saturday':
        // Level 1: use weekend rate for sat
        // Level 2+: use saturday-specific rate
        if (level <= 1) {
          return { category: rates.weekend, dayType: 'saturday' };
        } else {
          return { category: rates.saturday, dayType: 'saturday' };
        }
      case 'sunday':
        // Level 1: same rate as saturday (Fast Food Award)
        // Level 2+: separate sunday rate
        if (level <= 1) {
          return { category: rates.weekend, dayType: 'sunday_as_weekend' };
        } else {
          return { category: rates.sunday, dayType: 'sunday' };
        }
      default:
        return { category: rates.weekday, dayType: 'weekday' };
    }
  }

  /**
   * Format a date string to display label: "Mon 2 Jun"
   */
  function formatDateLabel(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  /**
   * Get Monday of the week containing a date
   */
  function getWeekStart(date = new Date()) {
    const d = new Date(date);
    const dow = d.getDay();
    const diff = (dow === 0 ? -6 : 1 - dow); // Monday-based
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Get Sunday of the week containing a date
   */
  function getWeekEnd(weekStart) {
    const d = new Date(weekStart + 'T12:00:00');
    d.setDate(d.getDate() + 6);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Format week range label: "Mon 26 May – Sun 1 Jun 2025"
   */
  function formatWeekLabel(weekStart) {
    const start = new Date(weekStart + 'T12:00:00');
    const end = new Date(weekStart + 'T12:00:00');
    end.setDate(end.getDate() + 6);
    const startLabel = start.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
    const endLabel = end.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    return `${startLabel} – ${endLabel}`;
  }

  /**
   * Upcoming holidays from today (for dashboard warning)
   */
  function getUpcomingHolidays(days = 14) {
    const today = new Date();
    const upcoming = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const ds = d.toISOString().slice(0, 10);
      const ph = isPublicHoliday(ds);
      if (ph) upcoming.push({ date: ds, ...ph, daysAway: i });
    }
    return upcoming;
  }

  return {
    isPublicHoliday,
    getDayType,
    getHolidaysInWeek,
    getXeroCategoryForShift,
    formatDateLabel,
    getWeekStart,
    getWeekEnd,
    formatWeekLabel,
    getUpcomingHolidays,
    getHolidaysForYear,
  };

})();
