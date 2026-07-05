import * as crypto from 'node:crypto';
import type { SessionMap } from '../types/index.js';
import { deleteSessionMap, listSessions, readSessionMap, writeSessionMap } from './storage.js';

export class SessionManager {
  private sessionId: string;
  private map: SessionMap;
  // Keeps track of the next index to use for each category to generate placeholders like "Email_1"
  private categoryCounts: Record<string, number>;

  constructor(sessionId?: string) {
    if (sessionId) {
      this.sessionId = sessionId;
      this.map = readSessionMap(this.sessionId);
    } else {
      this.sessionId = crypto.randomUUID();
      this.map = {};
    }

    this.categoryCounts = this.rebuildCategoryCounts(this.map);
  }

  /**
   * Rebuilds the internal counters by inspecting the loaded session map.
   * E.g., if "Email_2" exists, the next count for "Email" should be at least 3.
   */
  private rebuildCategoryCounts(map: SessionMap): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const placeholder of Object.keys(map)) {
      // Placeholder format: "Category_Index"
      const match = placeholder.match(/^([A-Za-z]+)_(\d+)$/);
      if (match && match[1] && match[2]) {
        const category = match[1];
        const index = parseInt(match[2], 10);

        if (!counts[category] || index >= counts[category]) {
          counts[category] = index + 1;
        }
      }
    }

    return counts;
  }

  /**
   * Returns the session ID.
   */
  public getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Returns the current session map.
   */
  public getMap(): SessionMap {
    return this.map;
  }

  /**
   * Finds the existing placeholder for a given original string, if any.
   */
  public getExistingPlaceholder(originalValue: string): string | undefined {
    // Reverse lookup (this is fast enough for typical prompt sizes)
    for (const [placeholder, value] of Object.entries(this.map)) {
      if (value === originalValue) {
        return placeholder;
      }
    }
    return undefined;
  }

  /**
   * Generates a new placeholder for the given category, stores the mapping, and returns the placeholder.
   */
  public createPlaceholder(category: string, originalValue: string): string {
    const existing = this.getExistingPlaceholder(originalValue);
    if (existing) {
      return existing;
    }

    const count = this.categoryCounts[category] || 1;
    this.categoryCounts[category] = count + 1;

    const newPlaceholder = `${category}_${count}`;
    this.map[newPlaceholder] = originalValue;

    return newPlaceholder;
  }

  /**
   * Persists the current state of the map to disk.
   */
  public save(): void {
    writeSessionMap(this.sessionId, this.map);
  }

  /**
   * Drops the current session from disk.
   */
  public destroy(): void {
    deleteSessionMap(this.sessionId);
    this.map = {};
    this.categoryCounts = {};
  }

  /**
   * Utility to list all existing session IDs.
   */
  public static listAll(): Array<{ id: string; sizeBytes: number }> {
    return listSessions();
  }
}
