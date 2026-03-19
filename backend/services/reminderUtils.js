function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseTimeOfDay(text = "") {
  const src = String(text || "").toLowerCase();
  const match12h = src.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (match12h) {
    let hour = Number(match12h[1]);
    const minute = Number(match12h[2] || "0");
    if (match12h[3] === "pm" && hour < 12) hour += 12;
    if (match12h[3] === "am" && hour === 12) hour = 0;
    return `${pad2(Math.min(Math.max(hour, 0), 23))}:${pad2(Math.min(Math.max(minute, 0), 59))}`;
  }

  const match24h = src.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (match24h) {
    return `${pad2(Number(match24h[1]))}:${pad2(Number(match24h[2]))}`;
  }

  if (src.includes("morning")) return "08:00";
  if (src.includes("afternoon")) return "14:00";
  if (src.includes("evening")) return "18:00";
  if (src.includes("night")) return "20:00";
  return "08:00";
}

function hasExplicitTime(text = "") {
  const src = String(text || "").toLowerCase();
  return /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/.test(src)
    || /\b([01]?\d|2[0-3]):([0-5]\d)\b/.test(src)
    || /\b(morning|afternoon|evening|night)\b/.test(src);
}

function parseReminderTextToRule(text = "", now = new Date()) {
  const src = String(text || "").trim();
  const lower = src.toLowerCase();
  const timeOfDay = parseTimeOfDay(lower);
  const startAt = new Date(now);
  const schedule = {
    type: "daily",
    startAt,
    timeOfDay,
    daysOfWeek: [],
    dayOfMonth: null,
    intervalDays: null,
    active: true,
  };

  if (/\bone[- ]?time\b|\bonce\b|\btomorrow\b|\btoday\b/.test(lower)) {
    schedule.type = "once";
    if (lower.includes("tomorrow")) {
      startAt.setDate(startAt.getDate() + 1);
      schedule.startAt = startAt;
    }
  } else if (/\bweekdays?\b/.test(lower)) {
    schedule.type = "weekdays";
    schedule.daysOfWeek = [1, 2, 3, 4, 5];
  } else if (/\bevery\s+(\d+)\s+days?\b/.test(lower)) {
    schedule.type = "interval";
    const intervalMatch = lower.match(/\bevery\s+(\d+)\s+days?\b/);
    schedule.intervalDays = Math.max(1, Number(intervalMatch?.[1] || 1));
  } else if (/\bevery\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?\b/.test(lower)) {
    schedule.type = "weekly";
    const dayMap = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    const dayTokens = lower.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/g) || [];
    schedule.daysOfWeek = [...new Set(dayTokens.map((d) => dayMap[d]))];
  } else if (/\bmonthly\b|\bevery month\b/.test(lower)) {
    schedule.type = "monthly";
    schedule.dayOfMonth = startAt.getDate();
  }

  return schedule;
}

function makeLocalDate(baseDate, timeOfDay) {
  const [hh, mm] = String(timeOfDay || "08:00").split(":").map((n) => Number(n));
  const next = new Date(baseDate);
  next.setHours(Number.isFinite(hh) ? hh : 8, Number.isFinite(mm) ? mm : 0, 0, 0);
  return next;
}

function nextDateForRule(rule = {}, fromDate = new Date()) {
  const cursor = new Date(fromDate);
  const startAt = new Date(rule.startAt || fromDate);
  const t = rule.timeOfDay || "08:00";

  if (rule.type === "once") {
    const candidate = makeLocalDate(startAt, t);
    if (candidate > cursor) return candidate;
    return null;
  }

  let candidate = makeLocalDate(cursor, t);
  if (candidate <= cursor) {
    candidate.setDate(candidate.getDate() + 1);
  }

  if (rule.type === "daily") return candidate;

  if (rule.type === "weekdays") {
    while (candidate.getDay() === 0 || candidate.getDay() === 6) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  if (rule.type === "weekly") {
    const allowed = Array.isArray(rule.daysOfWeek) && rule.daysOfWeek.length > 0
      ? new Set(rule.daysOfWeek)
      : new Set([candidate.getDay()]);
    while (!allowed.has(candidate.getDay())) {
      candidate.setDate(candidate.getDate() + 1);
    }
    return candidate;
  }

  if (rule.type === "monthly") {
    const day = Math.min(Math.max(Number(rule.dayOfMonth || startAt.getDate()), 1), 28);
    candidate = makeLocalDate(cursor, t);
    candidate.setDate(day);
    if (candidate <= cursor) {
      candidate.setMonth(candidate.getMonth() + 1);
      candidate.setDate(day);
    }
    return candidate;
  }

  if (rule.type === "interval") {
    const interval = Math.max(1, Number(rule.intervalDays || 1));
    candidate = makeLocalDate(startAt, t);
    while (candidate <= cursor) {
      candidate.setDate(candidate.getDate() + interval);
    }
    return candidate;
  }

  return candidate;
}

module.exports = {
  parseTimeOfDay,
  hasExplicitTime,
  parseReminderTextToRule,
  nextDateForRule,
};
