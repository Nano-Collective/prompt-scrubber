import type { IDataObject } from 'n8n-workflow';

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const ARRAY_INDEX = /^(0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSegment(value: unknown, segment: string): unknown {
  if (Array.isArray(value)) {
    if (!ARRAY_INDEX.test(segment)) {
      return undefined;
    }
    return value[Number(segment)];
  }

  return isRecord(value) ? value[segment] : undefined;
}

/** Parses a dot-separated n8n JSON field path and rejects prototype-pollution keys. */
export function parseFieldPath(path: string): string[] {
  const segments = path
    .trim()
    .split('.')
    .map((segment) => segment.trim());

  if (segments.length === 0 || segments.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid JSON field path "${path}".`);
  }

  if (segments.some((segment) => UNSAFE_PATH_SEGMENTS.has(segment))) {
    throw new Error(`JSON field path "${path}" contains a forbidden segment.`);
  }

  return segments;
}

export function parseFieldPaths(value: string): string[][] {
  const paths = value
    .split(/[\n,]/)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  if (paths.length === 0) {
    throw new Error('At least one JSON field path is required.');
  }

  return paths.map(parseFieldPath);
}

export function getValueAtPath(root: unknown, path: string[]): unknown {
  let value = root;
  for (const segment of path) {
    value = readSegment(value, segment);
    if (value === undefined) {
      return undefined;
    }
  }
  return value;
}

/**
 * Sets a string value at an existing JSON path. Missing parent objects are
 * created for output fields, while missing leaf fields are rejected so a typo
 * cannot silently add a field instead of scrubbing the requested one.
 */
export function setValueAtPath(root: IDataObject, path: string[], value: string): void {
  let current: unknown = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index]!;
    const nextSegment = path[index + 1]!;

    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) {
        throw new Error(`Expected an array index at "${path.slice(0, index + 1).join('.')}".`);
      }
      const arrayIndex = Number(segment);
      if (current[arrayIndex] === undefined) {
        current[arrayIndex] = ARRAY_INDEX.test(nextSegment) ? [] : {};
      }
      current = current[arrayIndex];
    } else if (isRecord(current)) {
      if (current[segment] === undefined) {
        current[segment] = ARRAY_INDEX.test(nextSegment) ? [] : {};
      }
      current = current[segment];
    } else {
      throw new Error(
        `Cannot set value at "${path.join('.')}" because its parent is not an object.`,
      );
    }
  }

  const leaf = path[path.length - 1]!;
  if (Array.isArray(current)) {
    if (!ARRAY_INDEX.test(leaf)) {
      throw new Error(`Expected an array index at "${path.join('.')}".`);
    }
    const arrayIndex = Number(leaf);
    if (arrayIndex >= current.length) {
      throw new Error(`JSON field "${path.join('.')}" was not found.`);
    }
    current[arrayIndex] = value;
  } else if (isRecord(current)) {
    current[leaf] = value;
  } else {
    throw new Error(`Cannot set value at "${path.join('.')}" because its parent is not an object.`);
  }
}

export function cloneJson(root: IDataObject): IDataObject {
  return structuredClone(root);
}

export function isMetadata(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}
