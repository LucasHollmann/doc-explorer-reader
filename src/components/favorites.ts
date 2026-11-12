export type FavoriteFolder = {
  id: string;
  type: "folder";
  path: string;
};

export type FavoriteGroup = {
  id: string;
  type: "group";
  name: string;
  items: FavoriteFolder[];
};

export type FavoriteEntry = FavoriteFolder | FavoriteGroup;

function makeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

export function sanitizeFavorites(raw: unknown): FavoriteEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is FavoriteEntry => {
    if (typeof entry !== "object" || entry === null) return false;
    const record = entry as Record<string, unknown>;
    if (record.type === "folder") return typeof record.path === "string";
    if (record.type === "group") {
      return typeof record.name === "string" && Array.isArray(record.items);
    }
    return false;
  });
}

export function isPathFavorited(favorites: FavoriteEntry[], path: string): boolean {
  return favorites.some((entry) =>
    entry.type === "folder" ? entry.path === path : entry.items.some((i) => i.path === path),
  );
}

export function addFavoriteFolder(favorites: FavoriteEntry[], path: string): FavoriteEntry[] {
  if (isPathFavorited(favorites, path)) return favorites;
  return [...favorites, { id: makeId(), type: "folder", path }];
}

export function removeFavoritePath(favorites: FavoriteEntry[], path: string): FavoriteEntry[] {
  return favorites
    .map((entry) =>
      entry.type === "group"
        ? { ...entry, items: entry.items.filter((item) => item.path !== path) }
        : entry,
    )
    .filter((entry) => entry.type !== "folder" || entry.path !== path);
}

export function createFavoriteGroup(favorites: FavoriteEntry[], name: string): FavoriteEntry[] {
  return [...favorites, { id: makeId(), type: "group", name, items: [] }];
}

export function renameFavoriteGroup(
  favorites: FavoriteEntry[],
  groupId: string,
  name: string,
): FavoriteEntry[] {
  return favorites.map((entry) =>
    entry.type === "group" && entry.id === groupId ? { ...entry, name } : entry,
  );
}

export function deleteFavoriteGroup(favorites: FavoriteEntry[], groupId: string): FavoriteEntry[] {
  const result: FavoriteEntry[] = [];
  for (const entry of favorites) {
    if (entry.type === "group" && entry.id === groupId) {
      result.push(...entry.items);
    } else {
      result.push(entry);
    }
  }
  return result;
}

export function moveFavoriteToGroup(
  favorites: FavoriteEntry[],
  path: string,
  groupId: string | null,
): FavoriteEntry[] {
  const withoutPath = removeFavoritePath(favorites, path);
  if (groupId === null) {
    return [...withoutPath, { id: makeId(), type: "folder", path }];
  }
  return withoutPath.map((entry) =>
    entry.type === "group" && entry.id === groupId
      ? { ...entry, items: [...entry.items, { id: makeId(), type: "folder", path }] }
      : entry,
  );
}
