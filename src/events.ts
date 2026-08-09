export type RsvpStatus = "yes" | "maybe" | "no";
export type EventDeliveryKind = "reminder" | "start" | "activation";
export type RsvpTriggerType = "yes_rsvps" | "yes-or-maybe_rsvps";

export function dueDeliveries(startsAt: Date, status: RsvpStatus, now: Date): EventDeliveryKind[] {
  if (status === "no") return [];
  if (now >= startsAt) return status === "yes" ? ["start"] : [];
  return startsAt.getTime() - 3_600_000 <= now.getTime() ? ["reminder"] : [];
}

export function minimumPlayersCheckDue(startsAt: Date, now: Date): boolean {
  const remaining = startsAt.getTime() - now.getTime();
  return remaining > 0 && remaining <= 30 * 60_000;
}

export function parseRsvpTrigger(value: string): { type: RsvpTriggerType; threshold: number } | undefined {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  const match = /^(\d+)\s+(.+)$/.exec(normalized);
  if (!match) return undefined;
  const threshold = Number(match[1]);
  if (!Number.isInteger(threshold) || threshold < 1) return undefined;

  const phrase = match[2]!
    .replace(/\brsvps?\b/g, "")
    .trim()
    .replace(/\s*-\s*/g, "-");
  if (["yes", "players", "player", "people", "person"].includes(phrase)) {
    return { type: "yes_rsvps", threshold };
  }
  if (["yes-or-maybe", "yes or maybe", "yes/maybe"].includes(phrase)) {
    return { type: "yes-or-maybe_rsvps", threshold };
  }
  return undefined;
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

export async function claimMinimumPlayerCheck(
  db: D1Database,
  eventId: string,
  now = new Date(),
): Promise<number | undefined> {
  const nowIso = now.toISOString();
  await db.prepare(`
    INSERT OR IGNORE INTO event_min_player_checks (event_id, checked_at, yes_count)
    SELECT events.id, ?, (
      SELECT COUNT(*) FROM rsvps WHERE rsvps.event_id = events.id AND rsvps.status = 'yes'
    )
    FROM events
    WHERE events.id = ?
      AND events.deleted_at IS NULL
      AND events.starts_at IS NOT NULL
      AND events.min_players IS NOT NULL
      AND julianday(events.starts_at) > julianday(?)
      AND julianday(events.starts_at) <= julianday(?, '+30 minutes')
  `).bind(nowIso, eventId, nowIso, nowIso).run();

  const claim = await db.prepare(`
    UPDATE event_min_player_checks
    SET delivery_claimed_at = ?
    WHERE event_id = ?
      AND alerted_at IS NULL
      AND (
        delivery_claimed_at IS NULL
        OR julianday(delivery_claimed_at) <= julianday(?, '-4 minutes')
      )
  `).bind(nowIso, eventId, nowIso).run();
  if (!claim.meta.changes) return undefined;

  const check = await db.prepare(`
    SELECT event_min_player_checks.yes_count AS yesCount
    FROM event_min_player_checks
    JOIN events ON events.id = event_min_player_checks.event_id
    WHERE event_min_player_checks.event_id = ?
      AND events.deleted_at IS NULL
      AND events.starts_at IS NOT NULL
      AND julianday(events.starts_at) > julianday(?)
  `).bind(eventId, nowIso).first<{ yesCount: number }>();
  if (check) return check.yesCount;
  await releaseMinimumPlayerCheck(db, eventId);
  return undefined;
}

export async function markMinimumPlayerAlerted(db: D1Database, eventId: string, now = new Date()): Promise<void> {
  await db.prepare(`
    UPDATE event_min_player_checks
    SET alerted_at = ?, delivery_claimed_at = NULL
    WHERE event_id = ? AND alerted_at IS NULL
  `).bind(now.toISOString(), eventId).run();
}

export async function releaseMinimumPlayerCheck(db: D1Database, eventId: string): Promise<void> {
  await db.prepare(`
    UPDATE event_min_player_checks
    SET delivery_claimed_at = NULL
    WHERE event_id = ? AND alerted_at IS NULL
  `).bind(eventId).run();
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
