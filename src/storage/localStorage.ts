const STORAGE_PREFIX = "doc-explorer-reader:";

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // ignore persistence failures (private browsing, quota exceeded, etc.)
  }
}

export function readEnumPreference<T extends string>(
  key: string,
  options: readonly T[],
  fallback: T,
): T {
  const stored = readStorage<string | null>(key, null);
  return stored !== null && (options as readonly string[]).includes(stored)
    ? (stored as T)
    : fallback;
}
