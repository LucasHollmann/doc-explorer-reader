import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import { readEnumPreference, readStorage, writeStorage } from "../storage/localStorage";
import { CATEGORY_ORDER, categoryOf, iconFor, type Category } from "./fileCategories";
import ContextMenu, { type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import {
  addFavoriteFolder,
  createFavoriteGroup,
  deleteFavoriteGroup,
  isPathFavorited,
  moveFavoriteToGroup,
  removeFavoritePath,
  renameFavoriteGroup,
  sanitizeFavorites,
  type FavoriteEntry,
} from "./favorites";
import "./FileExplorer.css";

type DirEntryInfo = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  created: number | null;
  modified: number | null;
};

type ViewMode = "list" | "grid" | "block";
type TypeFilter = "all" | "folders" | "files";
type SortKey = "name" | "size" | "created" | "modified" | "type";
type SortDir = "asc" | "desc";
type GroupBy = "none" | "type";

const VIEW_MODES = ["list", "grid", "block"] as const;
const SORT_KEYS = ["name", "size", "created", "modified", "type"] as const;
const SORT_DIRS = ["asc", "desc"] as const;
const GROUP_BYS = ["none", "type"] as const;

const GROUP_LABEL_KEYS: Record<Category, TranslationKey> = {
  folder: "groupFolders",
  image: "groupImages",
  document: "groupDocuments",
  spreadsheet: "groupSpreadsheets",
  presentation: "groupPresentations",
  audio: "groupAudio",
  video: "groupVideo",
  archive: "groupArchives",
  code: "groupCode",
  text: "groupText",
  other: "groupOther",
};

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "json", "js", "jsx", "ts", "tsx", "css", "html", "xml",
  "yml", "yaml", "toml", "rs", "py", "java", "c", "cpp", "h", "sh", "log",
  "csv",
]);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDate(epochSeconds: number | null): string {
  if (epochSeconds === null) return "-";
  return new Date(epochSeconds * 1000).toLocaleString();
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

function basenameOf(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = trimmed.lastIndexOf(sep);
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function compareEntries(a: DirEntryInfo, b: DirEntryInfo, key: SortKey, dir: SortDir): number {
  if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;

  let cmp: number;
  switch (key) {
    case "name":
      cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      break;
    case "size":
      cmp = a.size - b.size;
      break;
    case "created":
      cmp = (a.created ?? 0) - (b.created ?? 0);
      break;
    case "modified":
      cmp = (a.modified ?? 0) - (b.modified ?? 0);
      break;
    case "type":
      cmp = extensionOf(a.name).localeCompare(extensionOf(b.name));
      break;
  }
  return dir === "asc" ? cmp : -cmp;
}

function FileExplorer() {
  const { t, language, setLanguage } = useLanguage();
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    readEnumPreference("viewMode", VIEW_MODES, "list"),
  );
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<DirEntryInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<DirEntryInfo | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>(() =>
    readEnumPreference("sortKey", SORT_KEYS, "name"),
  );
  const [sortDir, setSortDir] = useState<SortDir>(() =>
    readEnumPreference("sortDir", SORT_DIRS, "asc"),
  );
  const [groupBy, setGroupBy] = useState<GroupBy>(() =>
    readEnumPreference("groupBy", GROUP_BYS, "none"),
  );
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() =>
    sanitizeFavorites(readStorage<unknown>("favorites", [])),
  );
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [openGroupId, setOpenGroupId] = useState<string | null>(null);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => writeStorage("viewMode", viewMode), [viewMode]);
  useEffect(() => writeStorage("sortKey", sortKey), [sortKey]);
  useEffect(() => writeStorage("sortDir", sortDir), [sortDir]);
  useEffect(() => writeStorage("groupBy", groupBy), [groupBy]);
  useEffect(() => writeStorage("favorites", favorites), [favorites]);

  function openContextMenu(e: ReactMouseEvent, items: ContextMenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  function favoriteMenuFor(path: string): ContextMenuItem[] {
    const groups = favorites.filter((entry) => entry.type === "group");
    const items: ContextMenuItem[] = [
      isPathFavorited(favorites, path)
        ? {
            label: t("removeFavorite"),
            danger: true,
            onClick: () => setFavorites((prev) => removeFavoritePath(prev, path)),
          }
        : {
            label: t("addFavorite"),
            onClick: () => setFavorites((prev) => addFavoriteFolder(prev, path)),
          },
    ];
    if (isPathFavorited(favorites, path)) {
      for (const group of groups) {
        items.push({
          label: t("moveToGroupPrefix") + group.name,
          onClick: () => setFavorites((prev) => moveFavoriteToGroup(prev, path, group.id)),
        });
      }
    }
    return items;
  }

  function groupItemMenuFor(path: string): ContextMenuItem[] {
    return [
      {
        label: t("removeFromGroup"),
        onClick: () => setFavorites((prev) => moveFavoriteToGroup(prev, path, null)),
      },
      {
        label: t("removeFavorite"),
        danger: true,
        onClick: () => setFavorites((prev) => removeFavoritePath(prev, path)),
      },
    ];
  }

  function groupMenuFor(groupId: string): ContextMenuItem[] {
    return [
      {
        label: t("renameGroup"),
        onClick: () => {
          const group = favorites.find((e) => e.id === groupId);
          if (group?.type === "group") {
            setRenamingGroupId(groupId);
            setRenameValue(group.name);
          }
        },
      },
      {
        label: t("deleteGroup"),
        danger: true,
        onClick: () => setFavorites((prev) => deleteFavoriteGroup(prev, groupId)),
      },
    ];
  }

  function commitNewGroup() {
    const trimmed = newGroupName.trim();
    if (trimmed) {
      setFavorites((prev) => createFavoriteGroup(prev, trimmed));
    }
    setCreatingGroup(false);
    setNewGroupName("");
  }

  function commitGroupRename() {
    const trimmed = renameValue.trim();
    if (renamingGroupId && trimmed) {
      setFavorites((prev) => renameFavoriteGroup(prev, renamingGroupId, trimmed));
    }
    setRenamingGroupId(null);
    setRenameValue("");
  }

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 3000);
    return () => clearTimeout(timer);
  }, [error]);

  async function loadDirectory(path: string, options?: { silent?: boolean }) {
    setLoading(true);
    if (!options?.silent) setError(null);
    setSelectedFile(null);
    setFileContent(null);
    try {
      const result = await invoke<DirEntryInfo[]>("read_directory", { path });
      setEntries(result);
      setCurrentPath(path);
      setPathInput(path);
    } catch {
      if (!options?.silent) {
        setError(t("pathNotFoundError").replace("{path}", path));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDirectory("C:\\", { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function pickFolder() {
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      await loadDirectory(selected);
    }
  }

  function commitPathInput() {
    const trimmed = pathInput.trim();
    if (trimmed && trimmed !== currentPath) {
      loadDirectory(trimmed);
    }
  }

  async function openEntry(entry: DirEntryInfo) {
    if (entry.is_dir) {
      await loadDirectory(entry.path);
      return;
    }

    setSelectedFile(entry);
    setFileContent(null);
    setError(null);

    const ext = extensionOf(entry.name);
    if (!TEXT_EXTENSIONS.has(ext)) {
      setFileContent(null);
      return;
    }

    try {
      const content = await readTextFile(entry.path);
      setFileContent(content);
    } catch (e) {
      setError(String(e));
    }
  }

  function goUp() {
    if (!currentPath) return;
    const sep = currentPath.includes("\\") ? "\\" : "/";
    const trimmed = currentPath.replace(/[\\/]+$/, "");
    const parentIdx = trimmed.lastIndexOf(sep);
    if (parentIdx <= 0) return;
    const parent = trimmed.slice(0, parentIdx) || sep;
    loadDirectory(parent);
  }

  const processedEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = entries.filter((entry) => {
      if (typeFilter === "folders" && !entry.is_dir) return false;
      if (typeFilter === "files" && entry.is_dir) return false;
      if (query && !entry.name.toLowerCase().includes(query)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => compareEntries(a, b, sortKey, sortDir));
  }, [entries, searchQuery, typeFilter, sortKey, sortDir]);

  const groupedEntries = useMemo(() => {
    if (groupBy !== "type") return [];
    const buckets = new Map<Category, DirEntryInfo[]>();
    for (const entry of processedEntries) {
      const cat = categoryOf(entry.is_dir, extensionOf(entry.name));
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat)!.push(entry);
    }
    return CATEGORY_ORDER.filter((cat) => buckets.has(cat)).map((cat) => ({
      category: cat,
      items: buckets.get(cat)!,
    }));
  }, [processedEntries, groupBy]);

  function renderEntryList(list: DirEntryInfo[]) {
    return (
      <ul>
        {list.map((entry) => (
          <li
            key={entry.path}
            className={selectedFile?.path === entry.path ? "selected" : ""}
            onClick={() => openEntry(entry)}
            onContextMenu={(e) => {
              if (entry.is_dir) openContextMenu(e, favoriteMenuFor(entry.path));
            }}
            title={entry.name}
          >
            <span className="icon">{iconFor(entry.is_dir, extensionOf(entry.name))}</span>
            <span className="name">{entry.name}</span>
            {viewMode === "list" && (
              <>
                {!entry.is_dir && (
                  <span className="meta">{formatSize(entry.size)}</span>
                )}
                <span className="meta">{formatDate(entry.modified)}</span>
              </>
            )}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <main className="explorer">
      <header className="toolbar">
        <div className="path-bar">
          <button
            className="icon-btn"
            title={t("exitFolder")}
            onClick={goUp}
            disabled={!currentPath}
          >
            ⬆
          </button>
          <input
            type="text"
            className="path-input"
            value={pathInput}
            placeholder={t("noFolderSelected")}
            onChange={(e) => setPathInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitPathInput();
            }}
            onBlur={commitPathInput}
            onContextMenu={(e) => {
              if (currentPath) openContextMenu(e, favoriteMenuFor(currentPath));
            }}
          />
          <button
            className="icon-btn"
            title={
              currentPath && isPathFavorited(favorites, currentPath)
                ? t("removeFavorite")
                : t("addFavorite")
            }
            onClick={() => {
              if (!currentPath) return;
              setFavorites((prev) =>
                isPathFavorited(prev, currentPath)
                  ? removeFavoritePath(prev, currentPath)
                  : addFavoriteFolder(prev, currentPath),
              );
            }}
            disabled={!currentPath}
          >
            {currentPath && isPathFavorited(favorites, currentPath) ? "★" : "☆"}
          </button>
          <button className="icon-btn" title={t("chooseFolder")} onClick={pickFolder}>
            📂
          </button>
        </div>

        <div className="view-switch">
          <button
            className={viewMode === "list" ? "active" : ""}
            title={t("viewList")}
            onClick={() => setViewMode("list")}
          >
            ☰
          </button>
          <button
            className={viewMode === "grid" ? "active" : ""}
            title={t("viewGrid")}
            onClick={() => setViewMode("grid")}
          >
            ▦
          </button>
          <button
            className={viewMode === "block" ? "active" : ""}
            title={t("viewBlock")}
            onClick={() => setViewMode("block")}
          >
            ▣
          </button>
        </div>

        <div className="lang-switch">
          <button
            className={language === "pt" ? "active" : ""}
            onClick={() => setLanguage("pt")}
          >
            PT
          </button>
          <button
            className={language === "en" ? "active" : ""}
            onClick={() => setLanguage("en")}
          >
            EN
          </button>
        </div>
      </header>

      <div className="favorites-bar">
        {favorites.map((entry) =>
          entry.type === "folder" ? (
            <button
              key={entry.id}
              className="favorite-chip"
              title={entry.path}
              onClick={() => loadDirectory(entry.path)}
              onContextMenu={(e) => openContextMenu(e, favoriteMenuFor(entry.path))}
            >
              <span className="favorite-name">{basenameOf(entry.path)}</span>
            </button>
          ) : (
            <div className="favorite-group" key={entry.id}>
              {renamingGroupId === entry.id ? (
                <input
                  autoFocus
                  className="group-name-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitGroupRename();
                    if (e.key === "Escape") {
                      setRenamingGroupId(null);
                      setRenameValue("");
                    }
                  }}
                  onBlur={commitGroupRename}
                />
              ) : (
                <button
                  className="favorite-chip group-chip"
                  onClick={() => setOpenGroupId(openGroupId === entry.id ? null : entry.id)}
                  onContextMenu={(e) => openContextMenu(e, groupMenuFor(entry.id))}
                >
                  📁 {entry.name}
                </button>
              )}

              {openGroupId === entry.id && (
                <>
                  <div className="favorite-dropdown-overlay" onClick={() => setOpenGroupId(null)} />
                  <div className="favorite-dropdown">
                    {entry.items.length === 0 && <p className="hint">{t("emptyGroup")}</p>}
                    {entry.items.map((item) => (
                      <button
                        key={item.id}
                        className="favorite-dropdown-item"
                        title={item.path}
                        onClick={() => {
                          loadDirectory(item.path);
                          setOpenGroupId(null);
                        }}
                        onContextMenu={(e) => openContextMenu(e, groupItemMenuFor(item.path))}
                      >
                        {basenameOf(item.path)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ),
        )}

        {creatingGroup ? (
          <input
            autoFocus
            className="group-name-input"
            placeholder={t("newGroup")}
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNewGroup();
              if (e.key === "Escape") {
                setCreatingGroup(false);
                setNewGroupName("");
              }
            }}
            onBlur={commitNewGroup}
          />
        ) : (
          <button className="icon-btn" title={t("newGroup")} onClick={() => setCreatingGroup(true)}>
            +
          </button>
        )}
      </div>

      {currentPath && (
        <div className="controls">
          <input
            type="text"
            className="search-input"
            placeholder={t("searchPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.currentTarget.value)}
          />

          <label className="control">
            <span className="control-label">{t("filterLabel")}</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.currentTarget.value as TypeFilter)}
            >
              <option value="all">{t("filterAll")}</option>
              <option value="folders">{t("filterFolders")}</option>
              <option value="files">{t("filterFiles")}</option>
            </select>
          </label>

          <label className="control">
            <span className="control-label">{t("sortLabel")}</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.currentTarget.value as SortKey)}
            >
              <option value="name">{t("sortName")}</option>
              <option value="size">{t("sortSize")}</option>
              <option value="created">{t("sortCreated")}</option>
              <option value="modified">{t("sortModified")}</option>
              <option value="type">{t("sortType")}</option>
            </select>
            <button
              className="sort-dir"
              title={sortDir === "asc" ? t("sortAscending") : t("sortDescending")}
              onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
            >
              {sortDir === "asc" ? "↑" : "↓"}
            </button>
          </label>

          <label className="control">
            <span className="control-label">{t("groupLabel")}</span>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.currentTarget.value as GroupBy)}
            >
              <option value="none">{t("groupNone")}</option>
              <option value="type">{t("groupByType")}</option>
            </select>
          </label>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panes">
        <div className={`file-list view-${viewMode}`}>
          {loading && <p className="hint">{t("loading")}</p>}
          {!loading && currentPath && entries.length > 0 && processedEntries.length === 0 && (
            <p className="hint">{t("noResults")}</p>
          )}
          {!loading && currentPath && entries.length === 0 && (
            <p className="hint">{t("emptyFolder")}</p>
          )}

          {groupBy === "none"
            ? renderEntryList(processedEntries)
            : groupedEntries.map(({ category, items }) => (
                <div className="group" key={category}>
                  <h4 className="group-header">
                    {t(GROUP_LABEL_KEYS[category])} ({items.length})
                  </h4>
                  {renderEntryList(items)}
                </div>
              ))}
        </div>

        {viewMode === "list" && (
          <div className="preview">
            {!selectedFile && <p className="hint">{t("selectFileHint")}</p>}
            {selectedFile && (
              <>
                <h3>{selectedFile.name}</h3>
                {fileContent !== null ? (
                  <pre>{fileContent}</pre>
                ) : (
                  <p className="hint">{t("noPreviewHint")}</p>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {viewMode !== "list" && selectedFile && (
        <div className="preview-overlay">
          <button
            className="overlay-close"
            onClick={() => setSelectedFile(null)}
            aria-label="Close preview"
          >
            ×
          </button>
          <h3>{selectedFile.name}</h3>
          {fileContent !== null ? (
            <pre>{fileContent}</pre>
          ) : (
            <p className="hint">{t("noPreviewHint")}</p>
          )}
        </div>
      )}

      <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
    </main>
  );
}

export default FileExplorer;
