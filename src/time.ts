const DEFAULT_TIME_ZONE = "America/New_York";

export function effectiveTimeZone(timeZone?: string | null): string {
  return canonicalTimeZone(timeZone) ?? DEFAULT_TIME_ZONE;
}

export function canonicalTimeZone(timeZone?: string | null): string | undefined {
  if (!timeZone) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function parseDuration(input: string | undefined, timeZone = DEFAULT_TIME_ZONE, now = new Date()): Date | undefined {
  const value = input?.trim().toLowerCase();
  if (!value) return undefined;
  const relative = /^(\d+)\s*(m|h|d)$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    return new Date(now.getTime() + amount * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!]!));
  }
  if (value === "today") return localEndOfDay(now, timeZone);
  if (value === "tonight") {
    const local = localParts(now, timeZone);
    return local.hour < 3
      ? zonedUtc(local.year, local.month, local.day, 3, 0, timeZone)
      : localEndOfDay(now, timeZone);
  }
  if (value === "tomorrow") {
    const local = localParts(now, timeZone);
    return zonedUtc(local.year, local.month, local.day + 1, 23, 59, timeZone, 999);
  }
  if (value === "this weekend") {
    const local = localParts(now, timeZone);
    const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
    const day = localDate.getUTCDay();
    const days = day === 0 ? 0 : day === 6 ? 1 : 7 - day;
    return zonedUtc(local.year, local.month, local.day + days, 23, 59, timeZone, 999);
  }
  return undefined;
}

export function parseWhen(input: string, timeZone: string, now = new Date()): Date | undefined {
  const value = input.trim().toLowerCase();
  if (value.startsWith("until ")) return parseUntil(value.slice(6).trim(), timeZone, now);

  const daypart = /^(today|tomorrow)\s+(morning|afternoon|evening|night)$/.exec(value);
  if (daypart) {
    const local = localParts(now, timeZone);
    const dayOffset = daypart[1] === "tomorrow" ? 1 : 0;
    const hour = { morning: 9, afternoon: 15, evening: 19, night: 20 }[daypart[2]!]!;
    return zonedUtc(local.year, local.month, local.day + dayOffset, hour, 0, timeZone);
  }

  const relativeClock = /^(today|tomorrow)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(value);
  if (relativeClock) {
    const local = localParts(now, timeZone);
    let hour = Number(relativeClock[2]);
    const minute = Number(relativeClock[3] ?? 0);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return undefined;
    if (relativeClock[4] === "pm" && hour < 12) hour += 12;
    if (relativeClock[4] === "am" && hour === 12) hour = 0;
    return zonedUtcChecked(
      local.year,
      local.month,
      local.day + (relativeClock[1] === "tomorrow" ? 1 : 0),
      hour,
      minute,
      timeZone,
    );
  }

  const date = /^\d{4}-\d{2}-\d{2}[ t](\d{1,2})(?::(\d{2}))?$/.exec(value);
  if (date) {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const hour = Number(date[1]);
    const minute = Number(date[2] ?? 0);
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || !isValidCalendarDate(year!, month!, day!)) return undefined;
    return zonedUtcChecked(year!, month!, day!, hour, minute, timeZone);
  }
  return parseDuration(value, timeZone, now);
}

function parseUntil(value: string, timeZone: string, now: Date): Date | undefined {
  const weekday = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(value);
  if (weekday) {
    const target = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(weekday[1]!);
    const local = localParts(now, timeZone);
    const current = new Date(Date.UTC(local.year, local.month - 1, local.day));
    current.setUTCDate(current.getUTCDate() + (target - current.getUTCDay() + 7) % 7);
    return zonedUtc(current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate(), 23, 59, timeZone);
  }
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(value);
  if (!time) return undefined;
  let hour = Number(time[1]);
  const minute = Number(time[2] ?? 0);
  if (minute < 0 || minute > 59) return undefined;
  if (time[3]) {
    if (hour < 1 || hour > 12) return undefined;
    if (time[3] === "pm" && hour < 12) hour += 12;
    if (time[3] === "am" && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return undefined;
  }
  const local = localParts(now, timeZone);
  let result = zonedUtcChecked(local.year, local.month, local.day, hour, minute, timeZone);
  if (!result) return undefined;
  if (result <= now) result = zonedUtcChecked(local.year, local.month, local.day + 1, hour, minute, timeZone);
  return result;
}

function localParts(date: Date, timeZone: string) {
  const { year, month, day, hour } = localDateTimeParts(date, timeZone);
  return { year, month, day, hour };
}

function localDateTimeParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    minute: "numeric",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

function zonedUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string, milliseconds = 0): Date {
  let timestamp = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const parts = localDateTimeParts(new Date(timestamp), timeZone);
    timestamp += Date.UTC(year, month - 1, day, hour, minute) - Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  }
  return new Date(timestamp + (milliseconds ? 59_000 + milliseconds : 0));
}

function zonedUtcChecked(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date | undefined {
  const result = zonedUtc(year, month, day, hour, minute, timeZone);
  const expected = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const actual = localDateTimeParts(result, timeZone);
  return actual.year === expected.getUTCFullYear()
      && actual.month === expected.getUTCMonth() + 1
      && actual.day === expected.getUTCDate()
      && actual.hour === expected.getUTCHours()
      && actual.minute === expected.getUTCMinutes()
    ? result
    : undefined;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function localEndOfDay(value: Date, timeZone: string): Date {
  const local = localParts(value, timeZone);
  return zonedUtc(local.year, local.month, local.day, 23, 59, timeZone, 999);
}

export function discordTimestamp(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:f>`;
}
