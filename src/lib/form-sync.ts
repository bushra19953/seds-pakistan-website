/**
 * Dirty-wins field sync for assignee form surfaces (typing-lag fix,
 * 2026-10-26; see ~/workspace/known_issues/typing_lag_ahmed_2026-10-26.md).
 *
 * The board card and the task detail dialog used to re-seed their text
 * fields from the task object whenever the object's identity changed —
 * which happens on every Firestore snapshot event and every wholesale
 * list refetch — with no dirty check. Any refresh silently replaced
 * the report being typed with the last saved text.
 *
 * The rule every re-seed now goes through:
 *
 *   syncedFieldValue(local, lastSynced, incoming)
 *     = incoming  when local === lastSynced (the user has not diverged
 *                 from the last sync point, so fresh server data may land)
 *     = local     when local !== lastSynced (the user is mid-edit;
 *                 their text wins, unconditionally)
 *
 * Callers keep a ref of the last synced value per field and advance it
 * at each sync point: initial seed, task switch, and after a successful
 * save of that field (the saved text becomes the new baseline).
 */
export function syncedFieldValue<T>(local: T, lastSynced: T, incoming: T): T {
  return local === lastSynced ? incoming : local;
}
