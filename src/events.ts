export type RsvpStatus = "yes" | "maybe" | "no";
export type EventDeliveryKind = "reminder" | "start" | "activation";

export function dueDeliveries(startsAt: Date, status: RsvpStatus, now: Date): EventDeliveryKind[] {
  if (status === "no") return [];
  if (now >= startsAt) return status === "yes" ? ["start"] : [];
  return startsAt.getTime() - 3_600_000 <= now.getTime() ? ["reminder"] : [];
}

export async function eventIsActive(db: D1Database, eventId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS active FROM events WHERE id = ? AND deleted_at IS NULL")
    .bind(eventId).first<{ active: number }>();
  return Boolean(row);
}

export async function claimActiveEventDelivery(
  db: D1Database,
  eventId: string,
  userId: string,
  kind: EventDeliveryKind,
  now = new Date(),
): Promise<boolean> {
  const result = await db.prepare(`
    INSERT OR IGNORE INTO event_deliveries (event_id, user_id, kind, delivered_at)
    SELECT ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM events WHERE id = ? AND deleted_at IS NULL)
  `).bind(eventId, userId, kind, now.toISOString(), eventId).run();
  return Boolean(result.meta.changes);
}

export async function releaseEventDeliveryClaim(
  db: D1Database,
  eventId: string,
  userId: string,
  kind: EventDeliveryKind,
): Promise<void> {
  await db.prepare("DELETE FROM event_deliveries WHERE event_id = ? AND user_id = ? AND kind = ?")
    .bind(eventId, userId, kind).run();
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
  const result = await db.prepare(`
    UPDATE event_triggers SET fired_at = ?
    WHERE event_id = ? AND fired_at IS NULL
      AND EXISTS (
        SELECT 1 FROM events
        WHERE events.id = event_triggers.event_id AND events.deleted_at IS NULL
      )
  `).bind(firedAt, eventId).run();
  if (!result.meta.changes) return false;
  await db.prepare("INSERT OR IGNORE INTO event_activations (event_id, activated_at) VALUES (?, ?)").bind(eventId, firedAt).run();
  return true;
}
