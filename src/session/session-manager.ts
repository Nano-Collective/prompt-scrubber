import * as crypto from 'node:crypto';
import type { SessionMap } from '../types/index.js';
import { deleteSessionMap, listSessions, readSessionMap, writeSessionMap } from './storage.js';

/**
 * Placeholder format: "«Prefix_Index»".
 *
 * The prefix is `[^«»\s]+`, not `[A-Za-z]+`: `placeholderPrefix` is a free-form
 * string on the public extension surface (`options.customDetectors`, and rule
 * packs), so a pack using `Ticket2` mints `«Ticket2_1»`. A guard that only
 * recognised alphabetic prefixes would leave exactly the collision this exists
 * to prevent reachable for anyone using the documented extension point.
 *
 * Whitespace is excluded on top of the guillemets: `[^«»]+` alone would also
 * match ordinary quoted text ending in `_<digits>` (e.g. French/Russian
 * guillemets around a sentence), which is not a placeholder we ever minted.
 */
const PLACEHOLDER_TOKEN_REGEX = /«[^«»\s]+_\d+»/g;

/** Every placeholder-shaped token that appears literally in `text`. */
export function placeholderTokensIn(text: string): string[] {
  return Array.from(text.matchAll(PLACEHOLDER_TOKEN_REGEX), (match) => match[0]);
}

export class SessionManager {
  private sessionId: string | undefined;
  private map: SessionMap;
  // Maps, not objects: the keys are text from the document being scrubbed, and a
  // value such as `constructor` or `toString` would read back an inherited function.
  private valueToPlaceholder: Map<string, string>;
  // Keeps track of the next index to use for each category to generate placeholders like "«Email_1»"
  private categoryCounts: Map<string, number>;
  // Placeholder names that already appear literally in the text being scrubbed.
  // They are not ours to hand out: reusing one collapses two different values
  // into a single token that rehydrates wrong in at least one position.
  private reservedNames: Set<string>;
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
    this.reservedNames = new Set();
  }

  /**
   * Records every placeholder-shaped token already present in `text` so a newly
   * minted placeholder can never reuse one the text carries literally - as when
   * already-scrubbed output is scrubbed again.
   */
  public reservePlaceholdersIn(text: string): void {
    for (const token of placeholderTokensIn(text)) {
      this.reservedNames.add(token);
    }
  }

  private buildReverseLookup(map: SessionMap): Map<string, string> {
    const reverse = new Map<string, string>();
    for (const [placeholder, value] of Object.entries(map)) {
      reverse.set(value, placeholder);
    }
    return reverse;
  }

  /**
   * Rebuilds the internal counters by inspecting the loaded session map.
   */
  private rebuildCategoryCounts(map: SessionMap): Map<string, number> {
    const counts = new Map<string, number>();

    for (const placeholder of Object.keys(map)) {
      // Same free-form, whitespace-excluding prefix as PLACEHOLDER_TOKEN_REGEX —
      // a counter that cannot see a rule pack's placeholders would restart at 1
      // and reissue one on the next call against the same session.
      const match = placeholder.match(/^«([^«»\s]+)_(\d+)»$/);
      if (match && match[1] && match[2]) {
        const category = match[1];
        const index = parseInt(match[2], 10);

        const current = counts.get(category);
        if (!current || index >= current) {
          counts.set(category, index + 1);
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
   * Returns the current session map. This is the live internal reference (not a
   * copy) — in stateless mode it is the same object passed in as `initialMap`,
   * mutated in place. Do not return a copy here without updating callers that
   * rely on the in-place mutation contract (see `scrub`).
   */
  public getMap(): SessionMap {
    return this.map;
  }

  /**
   * Finds the existing placeholder for a given original string, if any.
   */
  public getExistingPlaceholder(originalValue: string): string | undefined {
    return this.valueToPlaceholder.get(originalValue);
  }

  /**
   * Generates a new placeholder for the given category, stores the mapping, and returns the placeholder.
   */
  public createPlaceholder(category: string, originalValue: string): string {
    const existing = this.getExistingPlaceholder(originalValue);
    if (existing) {
      return existing;
    }

    let count = this.categoryCounts.get(category) || 1;
    let newPlaceholder = `«${category}_${count}»`;
    while (this.reservedNames.has(newPlaceholder) || Object.hasOwn(this.map, newPlaceholder)) {
      count += 1;
      newPlaceholder = `«${category}_${count}»`;
    }
    this.categoryCounts.set(category, count + 1);

    this.map[newPlaceholder] = originalValue;
    this.valueToPlaceholder.set(originalValue, newPlaceholder);

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
    this.valueToPlaceholder = new Map();
    this.categoryCounts = new Map();
  }

  /**
   * Utility to list all existing session IDs.
   */
  public static listAll(): Array<{ id: string; sizeBytes: number; lastModifiedAt: Date }> {
    return listSessions();
  }
}
