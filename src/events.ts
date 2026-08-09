export type RsvpStatus = "yes" | "maybe" | "no";
export type EventDeliveryKind = "reminder" | "start";

export function dueDeliveries(startsAt: Date, status: RsvpStatus, now: Date): EventDeliveryKind[] {
  if (status === "no") return [];
  const deliveries: EventDeliveryKind[] = [];
  if (startsAt.getTime() - 3_600_000 <= now.getTime() && now < startsAt) deliveries.push("reminder");
  if (status === "yes" && startsAt <= now) deliveries.push("start");
  return deliveries;
}

export async function fireRsvpTrigger(db: D1Database, eventId: string, now = new Date()): Promise<boolean> {
  const trigger = await db.prepare("SELECT type, threshold, fired_at FROM event_triggers WHERE event_id = ?").bind(eventId)
    .first<{ type: string; threshold: number; fired_at?: string }>();
  if (!trigger || trigger.fired_at || !["yes_rsvps", "yes-or-maybe_rsvps"].includes(trigger.type)) return false;
  const statuses = trigger.type === "yes_rsvps" ? ["yes"] : ["yes", "maybe"];
  const count = await db.prepare(`SELECT COUNT(*) AS count FROM rsvps WHERE event_id = ? AND status IN (${statuses.map(() => "?").join(",")})`)
    .bind(eventId, ...statuses).first<{ count: number }>();
  if ((count?.count ?? 0) < trigger.threshold) return false;
  const firedAt = now.toISOString();
  const result = await db.prepare("UPDATE event_triggers SET fired_at = ? WHERE event_id = ? AND fired_at IS NULL")
    .bind(firedAt, eventId).run();
  if (!result.meta.changes) return false;
  await db.prepare("INSERT OR IGNORE INTO event_activations (event_id, activated_at) VALUES (?, ?)").bind(eventId, firedAt).run();
  return true;
}
