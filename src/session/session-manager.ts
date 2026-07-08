import * as crypto from 'node:crypto';
import type { SessionMap } from '../types/index.js';
import { deleteSessionMap, listSessions, readSessionMap, writeSessionMap } from './storage.js';

export class SessionManager {
  private sessionId: string | undefined;
  private map: SessionMap;
  private valueToPlaceholder: Record<string, string>;
  // Keeps track of the next index to use for each category to generate placeholders like "«Email_1»"
  private categoryCounts: Record<string, number>;
  private diskEnabled: boolean;

  constructor(sessionId?: string, initialMap?: SessionMap) {
    if (initialMap) {
      this.diskEnabled = false;
      this.sessionId = sessionId;
      this.map = initialMap;
    } else if (sessionId) {
      this.diskEnabled = true;
      this.sessionId = sessionId;
      this.map = readSessionMap(this.sessionId);
    } else {
      this.diskEnabled = true;
      this.sessionId = crypto.randomUUID();
      this.map = {};
    }

    this.categoryCounts = this.rebuildCategoryCounts(this.map);
    this.valueToPlaceholder = this.buildReverseLookup(this.map);
  }

  private buildReverseLookup(map: SessionMap): Record<string, string> {
    const reverse: Record<string, string> = {};
    for (const [placeholder, value] of Object.entries(map)) {
      reverse[value] = placeholder;
    }
    return reverse;
  }

  /**
   * Rebuilds the internal counters by inspecting the loaded session map.
   */
  private rebuildCategoryCounts(map: SessionMap): Record<string, number> {
    const counts: Record<string, number> = {};

    for (const placeholder of Object.keys(map)) {
      // Placeholder format: "«Category_Index»"
      const match = placeholder.match(/^«([A-Za-z]+)_(\d+)»$/);
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
  public getSessionId(): string | undefined {
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
    return this.valueToPlaceholder[originalValue];
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

    const newPlaceholder = `«${category}_${count}»`;
    this.map[newPlaceholder] = originalValue;
    this.valueToPlaceholder[originalValue] = newPlaceholder;

    return newPlaceholder;
  }

  /**
   * Persists the current state of the map to disk (if disk is enabled).
   */
  public save(): void {
    if (this.diskEnabled && this.sessionId) {
      writeSessionMap(this.sessionId, this.map);
    }
  }

  /**
   * Drops the current session from disk (if disk is enabled).
   */
  public destroy(): void {
    if (this.diskEnabled && this.sessionId) {
      deleteSessionMap(this.sessionId);
    }
    this.map = {};
    this.valueToPlaceholder = {};
    this.categoryCounts = {};
  }

  /**
   * Utility to list all existing session IDs.
   */
  public static listAll(): Array<{ id: string; sizeBytes: number }> {
    return listSessions();
  }
}
