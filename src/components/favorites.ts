export type FavoriteFolder = {
  id: string;
  type: "folder";
  path: string;
};

export type FavoriteGroup = {
  id: string;
  type: "group";
  name: string;
  items: FavoriteEntry[];
};

export type FavoriteEntry = FavoriteFolder | FavoriteGroup;

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function sanitizeEntry(raw: unknown): FavoriteEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : makeId();

  if (record.type === "folder" && typeof record.path === "string") {
    return { id, type: "folder", path: record.path };
  }
  if (record.type === "group" && typeof record.name === "string" && Array.isArray(record.items)) {
    return {
      id,
      type: "group",
      name: record.name,
      items: record.items.map(sanitizeEntry).filter((entry): entry is FavoriteEntry => entry !== null),
    };
  }
  return null;
}

export function sanitizeFavorites(raw: unknown): FavoriteEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeEntry).filter((entry): entry is FavoriteEntry => entry !== null);
}

export function findFavoriteGroup(
  favorites: FavoriteEntry[],
  groupId: string,
): FavoriteGroup | undefined {
  for (const entry of favorites) {
    if (entry.type !== "group") continue;
    if (entry.id === groupId) return entry;
    const nested = findFavoriteGroup(entry.items, groupId);
    if (nested) return nested;
  }
  return undefined;
}

function containsGroup(group: FavoriteGroup, groupId: string): boolean {
  return group.id === groupId || group.items.some(
    (entry) => entry.type === "group" && containsGroup(entry, groupId),
  );
}

export function isPathFavorited(favorites: FavoriteEntry[], path: string): boolean {
  return favorites.some((entry) =>
    entry.type === "folder"
      ? entry.path === path
      : isPathFavorited(entry.items, path),
  );
}

export function addFavoriteFolder(favorites: FavoriteEntry[], path: string): FavoriteEntry[] {
  if (isPathFavorited(favorites, path)) return favorites;
  return [...favorites, { id: makeId(), type: "folder", path }];
}

export function removeFavoritePath(favorites: FavoriteEntry[], path: string): FavoriteEntry[] {
  return favorites.flatMap<FavoriteEntry>((entry) => {
    if (entry.type === "folder") return entry.path === path ? [] : [entry];
    return [{ ...entry, items: removeFavoritePath(entry.items, path) }];
  });
}

function appendToGroup(
  favorites: FavoriteEntry[],
  groupId: string,
  entryToAdd: FavoriteEntry,
): { entries: FavoriteEntry[]; added: boolean } {
  let added = false;
  const entries = favorites.map((entry) => {
    if (entry.type !== "group") return entry;
    if (entry.id === groupId) {
      added = true;
      return { ...entry, items: [...entry.items, entryToAdd] };
    }
    const nested = appendToGroup(entry.items, groupId, entryToAdd);
    if (nested.added) {
      added = true;
      return { ...entry, items: nested.entries };
    }
    return entry;
  });
  return { entries, added };
}

export function createFavoriteGroup(
  favorites: FavoriteEntry[],
  name: string,
  parentGroupId: string | null = null,
): FavoriteEntry[] {
  const group: FavoriteGroup = { id: makeId(), type: "group", name, items: [] };
  if (parentGroupId === null) return [...favorites, group];
  const result = appendToGroup(favorites, parentGroupId, group);
  return result.added ? result.entries : favorites;
}

export function renameFavoriteGroup(
  favorites: FavoriteEntry[],
  groupId: string,
  name: string,
): FavoriteEntry[] {
  return favorites.map((entry) =>
    entry.type === "group"
      ? entry.id === groupId
        ? { ...entry, name }
        : { ...entry, items: renameFavoriteGroup(entry.items, groupId, name) }
      : entry,
  );
}

export function deleteFavoriteGroup(favorites: FavoriteEntry[], groupId: string): FavoriteEntry[] {
  return favorites.flatMap<FavoriteEntry>((entry) => {
    if (entry.type !== "group") return [entry];
    if (entry.id === groupId) return [];
    return [{ ...entry, items: deleteFavoriteGroup(entry.items, groupId) }];
  });
}

function removeGroup(favorites: FavoriteEntry[], groupId: string): {
  entries: FavoriteEntry[];
  removed: FavoriteGroup | null;
} {
  for (let index = 0; index < favorites.length; index++) {
    const entry = favorites[index];
    if (entry.type !== "group") continue;
    if (entry.id === groupId) {
      return {
        entries: favorites.filter((_, itemIndex) => itemIndex !== index),
        removed: entry,
      };
    }
    const nested = removeGroup(entry.items, groupId);
    if (nested.removed) {
      return {
        entries: favorites.map((item) =>
          item.id === entry.id && item.type === "group"
            ? { ...item, items: nested.entries }
            : item,
        ),
        removed: nested.removed,
      };
    }
  }
  return { entries: favorites, removed: null };
}

export function moveFavoriteGroup(
  favorites: FavoriteEntry[],
  groupId: string,
  targetGroupId: string | null,
): FavoriteEntry[] {
  const group = findFavoriteGroup(favorites, groupId);
  if (!group || (targetGroupId !== null && containsGroup(group, targetGroupId))) return favorites;
  if (targetGroupId !== null && !findFavoriteGroup(favorites, targetGroupId)) return favorites;

  const { entries, removed } = removeGroup(favorites, groupId);
  if (!removed) return favorites;
  if (targetGroupId === null) return [...entries, removed];

  const result = appendToGroup(entries, targetGroupId, removed);
  return result.added ? result.entries : favorites;
}

export function moveFavoriteToGroup(
  favorites: FavoriteEntry[],
  path: string,
  groupId: string | null,
): FavoriteEntry[] {
  if (groupId !== null && !findFavoriteGroup(favorites, groupId)) return favorites;
  const withoutPath = removeFavoritePath(favorites, path);
  const folder: FavoriteFolder = { id: makeId(), type: "folder", path };
  if (groupId === null) return [...withoutPath, folder];

  const result = appendToGroup(withoutPath, groupId, folder);
  return result.added ? result.entries : favorites;
}
