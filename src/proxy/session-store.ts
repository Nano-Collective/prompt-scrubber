/** Placeholder maps by session ID, least recently used first. */
export type Sessions = Map<string, Record<string, string>>;

/** How many sessions the proxy keeps before it forgets the least recently used. */
export const DEFAULT_MAX_SESSIONS = 1000;

/**
 * Returns the session's placeholder map, creating it if needed, and marks it as
 * the most recently used. Past `max` sessions the least recently used are dropped,
 * so a client that never reuses a session ID cannot grow the store without bound.
 */
export function openSession(sessions: Sessions, id: string, max: number): Record<string, string> {
  const map = sessions.get(id) ?? {};
  sessions.delete(id);
  sessions.set(id, map);
  while (sessions.size > Math.max(1, max)) {
    const oldest = sessions.keys().next();
    if (oldest.done) break;
    sessions.delete(oldest.value);
  }
  return map;
}

/**
 * Forgets a session that holds no placeholders. There is nothing to rehydrate
 * from it, and a client that sends its ID again simply gets a fresh one.
 */
export function dropIfEmpty(sessions: Sessions, id: string, map: Record<string, string>): void {
  if (Object.keys(map).length === 0 && sessions.get(id) === map) sessions.delete(id);
}
