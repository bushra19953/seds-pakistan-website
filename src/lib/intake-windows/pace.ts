/**
 * Intake pace projection (Grove planning, item 11).
 *
 * Pure, no Firebase imports: the admin pace route feeds it the resolved
 * window bounds and every application's created_at as epoch ms, and
 * tests can drive it with synthetic timestamps.
 *
 * Method (linearity): the pool collected so far is divided by the
 * elapsed fraction of the window. That is the straight-line pace from
 * window open to now, extended to the close: if 40 applications arrived
 * in the first half of the window, the projected final pool is 80.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PaceProjection {
  /** Applications with created_at inside [opensAt, min(now, closesAt)]. */
  pool: number;
  /** Elapsed fraction of the window at nowMs, clamped to [0, 1]. */
  elapsedFraction: number;
  /**
   * Projected final pool at the current pace. Equals the pool when the
   * window has not started (no pace signal yet) and once it has closed.
   */
  projectedFinalPool: number;
  /** Pool arrivals bucketed per elapsed day, day 0 = the opensAt day. */
  dailyCounts: number[];
}

export function computePaceProjection(input: {
  opensAtMs: number;
  closesAtMs: number;
  nowMs: number;
  createdAtMsList: readonly number[];
}): PaceProjection {
  const { opensAtMs, closesAtMs, nowMs, createdAtMsList } = input;
  const windowMs = closesAtMs - opensAtMs;
  const effectiveNowMs = Math.min(nowMs, closesAtMs);

  const elapsedFraction =
    windowMs > 0
      ? Math.min(1, Math.max(0, (nowMs - opensAtMs) / windowMs))
      : 0;

  let pool = 0;
  const dailyCounts: number[] = [];
  for (const t of createdAtMsList) {
    if (!Number.isFinite(t) || t <= 0) continue;
    if (t < opensAtMs || t > effectiveNowMs) continue;
    pool += 1;
    const dayIndex = Math.floor((t - opensAtMs) / DAY_MS);
    while (dailyCounts.length <= dayIndex) dailyCounts.push(0);
    dailyCounts[dayIndex] += 1;
  }

  const projectedFinalPool =
    elapsedFraction > 0
      ? Math.max(pool, Math.round(pool / elapsedFraction))
      : pool;

  return { pool, elapsedFraction, projectedFinalPool, dailyCounts };
}

/**
 * Per-day arrival series over a range: one entry per UTC calendar day
 * from the day containing startMs through the day containing endMs,
 * ascending and zero-filled. Only timestamps inside [startMs, endMs]
 * are counted. Consumed by the pace projection and the linearity view
 * (comparison doc items 11 and 21).
 */
export function buildDailyCounts(
  timestampsMs: readonly number[],
  startMs: number,
  endMs: number,
): Array<{ date: string; count: number }> {
  const startDayMs = Math.floor(startMs / DAY_MS) * DAY_MS;
  const endDayMs = Math.floor(endMs / DAY_MS) * DAY_MS;
  const days: Array<{ date: string; count: number }> = [];
  const indexByDay = new Map<number, number>();
  for (let d = startDayMs; d <= endDayMs; d += DAY_MS) {
    indexByDay.set(d, days.length);
    days.push({ date: new Date(d).toISOString().slice(0, 10), count: 0 });
  }
  for (const t of timestampsMs) {
    if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
    const idx = indexByDay.get(Math.floor(t / DAY_MS) * DAY_MS);
    if (idx !== undefined) days[idx].count += 1;
  }
  return days;
}
