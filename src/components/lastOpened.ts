import { readStorage, writeStorage } from "../storage/localStorage";

const KEY = "lastOpened";

function readAll(): Record<string, number> {
  return readStorage<Record<string, number>>(KEY, {});
}

export function getLastOpened(filePath: string): number | null {
  return readAll()[filePath] ?? null;
}

export function recordLastOpened(filePath: string): void {
  const all = readAll();
  all[filePath] = Math.floor(Date.now() / 1000);
  writeStorage(KEY, all);
}
