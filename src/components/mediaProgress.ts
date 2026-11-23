import { readStorage, writeStorage } from "../storage/localStorage";

const KEY = "mediaProgress";

function readAll(): Record<string, number> {
  return readStorage<Record<string, number>>(KEY, {});
}

export function getMediaProgress(filePath: string): number {
  return readAll()[filePath] ?? 0;
}

export function setMediaProgress(filePath: string, seconds: number): void {
  const all = readAll();
  all[filePath] = seconds;
  writeStorage(KEY, all);
}
