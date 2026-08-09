const DEFAULT_TIME_ZONE = "America/New_York";

export function effectiveTimeZone(timeZone?: string | null): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function parseDuration(input: string | undefined, now = new Date()): Date | undefined {
  const value = input?.trim().toLowerCase();
  if (!value) return undefined;
  const relative = /^(\d+)\s*(m|h|d)$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    return new Date(now.getTime() + amount * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!]!));
  }
  if (value === "today") return endOfDay(now);
  if (value === "tonight") return localAt(now, 21, 0);
  if (value === "tomorrow") return addDays(endOfDay(now), 1);
  if (value === "this weekend") {
    const result = new Date(now);
    result.setDate(result.getDate() + ((6 - result.getDay() + 7) % 7 || 7));
    result.setHours(23, 59, 59, 999);
    return result;
  }
  return undefined;
}

export function parseWhen(input: string, timeZone: string, now = new Date()): Date | undefined {
  const value = input.trim().toLowerCase();
  if (value.startsWith("until ")) return parseUntil(value.slice(6).trim(), timeZone, now);
  const date = /^\d{4}-\d{2}-\d{2}(?:[ t](\d{1,2})(?::(\d{2}))?)?$/.exec(value);
  if (date) {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    return zonedUtc(year!, month!, day!, Number(date[1] ?? 19), Number(date[2] ?? 0), timeZone);
  }
  return parseDuration(value, now);
}

function parseUntil(value: string, timeZone: string, now: Date): Date | undefined {
  const weekday = /^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/.exec(value);
  if (weekday) {
    const target = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(weekday[1]!);
    const local = localParts(now, timeZone);
    const current = new Date(Date.UTC(local.year, local.month - 1, local.day));
    current.setUTCDate(current.getUTCDate() + ((target - current.getUTCDay() + 7) % 7 || 7));
    return zonedUtc(current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate(), 23, 59, timeZone);
  }
  const time = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(value);
  if (!time) return undefined;
  let hour = Number(time[1]);
  if (time[3] === "pm" && hour < 12) hour += 12;
  if (time[3] === "am" && hour === 12) hour = 0;
  const local = localParts(now, timeZone);
  let result = zonedUtc(local.year, local.month, local.day, hour, Number(time[2] ?? 0), timeZone);
  if (result <= now) result = zonedUtc(local.year, local.month, local.day + 1, hour, Number(time[2] ?? 0), timeZone);
  return result;
}

function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23", minute: "numeric" }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function zonedUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let timestamp = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23", minute: "numeric" }).formatToParts(new Date(timestamp));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    timestamp += Date.UTC(year, month - 1, day, hour, minute) - Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  }
  return new Date(timestamp);
}

function endOfDay(value: Date): Date { const result = new Date(value); result.setHours(23, 59, 59, 999); return result; }
function localAt(value: Date, hour: number, minute: number): Date { const result = new Date(value); result.setHours(hour, minute, 0, 0); return result; }
function addDays(value: Date, days: number): Date { const result = new Date(value); result.setDate(result.getDate() + days); return result; }
