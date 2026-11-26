import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type Dispatch,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { mkdir, readFile, readTextFile, remove, rename, writeTextFile } from "@tauri-apps/plugin-fs";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { openPath } from "@tauri-apps/plugin-opener";
import dragIconUrl from "../assets/drag-icon.png";
import { useLanguage } from "../i18n/LanguageContext";
import type { TranslationKey } from "../i18n/translations";
import { readEnumPreference, readStorage, writeStorage } from "../storage/localStorage";
import { CATEGORY_ORDER, categoryOf, iconFor, type Category } from "./fileCategories";
import ContextMenu, { type ContextMenuItem, type ContextMenuState } from "./ContextMenu";
import {
  colorHexFor,
  FILE_COLORS,
  removeFileColor,
  setFileColor,
  type FileColorId,
  type FileColors,
} from "./fileColors";
import { getLastOpened, recordLastOpened } from "./lastOpened";
import { getMediaProgress, setMediaProgress } from "./mediaProgress";
import {
  addFavoriteFolder,
  createFavoriteGroup,
  deleteFavoriteGroup,
  findFavoriteGroup,
  isPathFavorited,
  moveFavoriteGroup,
  moveFavoriteToGroup,
  removeFavoritePath,
  renameFavoriteGroup,
  sanitizeFavorites,
  type FavoriteEntry,
  type FavoriteGroup,
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

type DirectorySummary = {
  item_count: number;
  size_bytes: number;
};

type TreeDirectoryState = {
  entries?: DirEntryInfo[];
  loading?: boolean;
  error?: string;
};

type ViewMode = "list" | "block";
type TypeFilter = "all" | "folders" | "files";
type SortKey = "name" | "size" | "created" | "modified" | "type";
type SortDir = "asc" | "desc";
type GroupBy = "none" | "type";

const VIEW_MODES = ["list", "block"] as const;
const SORT_KEYS = ["name", "size", "created", "modified", "type"] as const;
const SORT_DIRS = ["asc", "desc"] as const;
const GROUP_BYS = ["none", "type"] as const;
const FAVORITE_FOLDER_DRAG_TYPE = "application/x-doc-explorer-favorite-folder";
const FAVORITE_GROUP_DRAG_TYPE = "application/x-doc-explorer-favorite-group";
const FILE_MOVE_DRAG_TYPE = "application/x-doc-explorer-move-entry";

const COLOR_LABEL_KEYS: Record<FileColorId, TranslationKey> = {
  red: "colorRed",
  yellow: "colorYellow",
  green: "colorGreen",
  blue: "colorBlue",
  purple: "colorPurple",
};

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

const AUDIO_MIME_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
};

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
};

function favoriteGroups(entries: FavoriteEntry[]): FavoriteGroup[] {
  return entries.flatMap((entry) =>
    entry.type === "group" ? [entry, ...favoriteGroups(entry.items)] : [],
  );
}

function descendantGroupIds(group: FavoriteGroup): string[] {
  return group.items.flatMap((entry) =>
    entry.type === "group" ? [entry.id, ...descendantGroupIds(entry)] : [],
  );
}

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

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

function canPreviewEntry(entry: DirEntryInfo): boolean {
  return !entry.is_dir;
}

function basenameOf(path: string): string {
  const sep = path.includes("\\") ? "\\" : "/";
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = trimmed.lastIndexOf(sep);
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
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

type TabMeta = {
  id: string;
  title: string;
  initialPath: string;
  initialFile?: string;
};

function createTab(initialPath: string, initialFile?: string): TabMeta {
  return { id: crypto.randomUUID(), title: "", initialPath, initialFile };
}

type ClipboardState = { paths: string[]; mode: "copy" | "cut" } | null;

type UndoAction =
  | { type: "rename" | "move"; items: { from: string; to: string }[] }
  | { type: "copy"; paths: string[] };

type ExplorerTabProps = {
  active: boolean;
  initialPath: string;
  initialFile?: string;
  onPathChange: (path: string | null) => void;
  onOpenInNewTab: (path: string, fileToSelect?: string) => void;
  favorites: FavoriteEntry[];
  setFavorites: Dispatch<SetStateAction<FavoriteEntry[]>>;
  fileColors: FileColors;
  setFileColors: Dispatch<SetStateAction<FileColors>>;
  clipboard: ClipboardState;
  setClipboard: Dispatch<SetStateAction<ClipboardState>>;
};

function ExplorerTab({
  active,
  initialPath,
  initialFile,
  onPathChange,
  onOpenInNewTab,
  favorites,
  setFavorites,
  fileColors,
  setFileColors,
  clipboard,
  setClipboard,
}: ExplorerTabProps) {
  const { t, language, setLanguage } = useLanguage();
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    readEnumPreference("viewMode", VIEW_MODES, "list"),
  );
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [entries, setEntries] = useState<DirEntryInfo[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selectionAnchorRef = useRef<string | null>(null);
  const saveTextEditsRef = useRef<() => void>(() => {});
  const [selectedFile, setSelectedFile] = useState<DirEntryInfo | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [savingText, setSavingText] = useState(false);
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);
  const audioPreviewUrlRef = useRef<string | null>(null);
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
  const videoPreviewUrlRef = useRef<string | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const imagePreviewUrlRef = useRef<string | null>(null);
  const mediaElRef = useRef<HTMLMediaElement | null>(null);
  const progressTrackingArmedRef = useRef(false);
  const pendingResumeSecondsRef = useRef<number | null>(null);
  const [resumePrompt, setResumePrompt] = useState<{ filePath: string; seconds: number } | null>(
    null,
  );
  const [fullscreenPanelWidth, setFullscreenPanelWidth] = useState(300);
  const [panelResizing, setPanelResizing] = useState(false);
  const [directorySummary, setDirectorySummary] = useState<DirectorySummary | null>(null);
  const [directorySummaryLoading, setDirectorySummaryLoading] = useState(false);
  const [directorySummaryError, setDirectorySummaryError] = useState<string | null>(null);
  const directorySummaryRequest = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const [treeDirectories, setTreeDirectories] = useState<Record<string, TreeDirectoryState>>({});

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchIgnoreSpecialChars, setSearchIgnoreSpecialChars] = useState(false);
  const [extensionFilter, setExtensionFilter] = useState("");
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [newItemMenuOpen, setNewItemMenuOpen] = useState(false);
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
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [openGroupIds, setOpenGroupIds] = useState<Set<string>>(() => new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [creatingGroupParentId, setCreatingGroupParentId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);
  const [isDraggingFavorite, setIsDraggingFavorite] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [entryRenameValue, setEntryRenameValue] = useState("");
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<{ paths: string[] } | null>(null);
  const [bulkRenameEntries, setBulkRenameEntries] = useState<DirEntryInfo[] | null>(null);
  const [bulkPattern, setBulkPattern] = useState("");
  const [bulkStartNumber, setBulkStartNumber] = useState(1);
  const [bulkOverrides, setBulkOverrides] = useState<Record<string, string>>({});
  const [bulkSaving, setBulkSaving] = useState(false);
  const [undoStack, setUndoStack] = useState<UndoAction[]>([]);

  useEffect(() => writeStorage("viewMode", viewMode), [viewMode]);
  useEffect(() => writeStorage("sortKey", sortKey), [sortKey]);
  useEffect(() => writeStorage("sortDir", sortDir), [sortDir]);
  useEffect(() => writeStorage("groupBy", groupBy), [groupBy]);

  function openContextMenu(e: ReactMouseEvent, items: ContextMenuItem[]) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  function sortBy(key: SortKey) {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function favoriteMenuFor(path: string): ContextMenuItem[] {
    const groups = favoriteGroups(favorites);
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

  function fetchTreeDirectory(path: string) {
    setTreeDirectories((prev) => ({ ...prev, [path]: { loading: true } }));
    void invoke<DirEntryInfo[]>("read_directory", { path })
      .then((children) => {
        setTreeDirectories((prev) => ({
          ...prev,
          [path]: { entries: children },
        }));
      })
      .catch((cause: unknown) => {
        setTreeDirectories((prev) => ({
          ...prev,
          [path]: { error: String(cause) },
        }));
      });
  }

  function toggleDirectoryTree(path: string) {
    if (expandedDirectories.has(path)) {
      setExpandedDirectories((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      return;
    }

    setExpandedDirectories((prev) => new Set(prev).add(path));
    const cached = treeDirectories[path];
    if (cached?.entries || cached?.loading) return;
    fetchTreeDirectory(path);
  }

  function refreshAllVisibleDirectories() {
    if (currentPath) void loadDirectory(currentPath, { silent: true });
    for (const path of Object.keys(treeDirectories)) {
      fetchTreeDirectory(path);
    }
  }

  function colorMenuFor(paths: string[]): ContextMenuItem[] {
    const items: ContextMenuItem[] = FILE_COLORS.map((color) => ({
      label: t(COLOR_LABEL_KEYS[color.id]),
      swatch: color.hex,
      compact: true,
      onClick: () =>
        setFileColors((prev) =>
          paths.reduce((next, path) => setFileColor(next, path, color.id), prev),
        ),
    }));
    if (paths.some((path) => fileColors[path])) {
      items.push({
        label: t("removeColor"),
        swatch: undefined,
        compact: false,
        danger: true,
        onClick: () =>
          setFileColors((prev) => paths.reduce((next, path) => removeFileColor(next, path), prev)),
      });
    }
    return items;
  }

  function directoryMenuFor(
    entry: DirEntryInfo,
    colorPaths: string[],
    parentPath: string | undefined,
  ): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      { label: t("openInNewTab"), onClick: () => onOpenInNewTab(entry.path) },
      ...favoriteMenuFor(entry.path),
      {
        label: t(expandedDirectories.has(entry.path) ? "hideFolderContents" : "showFolderContents"),
        onClick: () => toggleDirectoryTree(entry.path),
      },
    ];
    if (colorPaths.length === 1 && parentPath) {
      items.push({ label: t("rename"), onClick: () => startRenaming(entry) });
    } else if (colorPaths.length > 1) {
      items.push({ label: t("renameMultiple"), onClick: () => startBulkRenaming(colorPaths) });
    }
    items.push(...colorMenuFor(colorPaths));
    items.push({ label: t("delete"), danger: true, onClick: () => requestDelete(colorPaths) });
    return items;
  }

  function fileMenuFor(
    entry: DirEntryInfo,
    colorPaths: string[],
    parentPath: string | undefined,
  ): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (canPreviewEntry(entry)) {
      items.push({ label: t("viewFile"), onClick: () => void openEntryInView(entry) });
    }
    items.push({
      label: t("openInNewTab"),
      onClick: () => onOpenInNewTab(parentPath ?? currentPath ?? "", entry.path),
    });
    items.push({
      label: t("openExternally"),
      onClick: () => void openFilesExternally(colorPaths),
    });
    if (colorPaths.length === 1 && parentPath) {
      items.push({ label: t("rename"), onClick: () => startRenaming(entry) });
    } else if (colorPaths.length > 1) {
      items.push({ label: t("renameMultiple"), onClick: () => startBulkRenaming(colorPaths) });
    }
    items.push(...colorMenuFor(colorPaths));
    items.push({ label: t("delete"), danger: true, onClick: () => requestDelete(colorPaths) });
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
          const group = findFavoriteGroup(favorites, groupId);
          if (group) {
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

  function newGroupMenuItem(parentGroupId: string | null): ContextMenuItem {
    return {
      label: t("newGroup"),
      onClick: () => {
        if (parentGroupId !== null) {
          setOpenGroupIds((prev) => new Set(prev).add(parentGroupId));
        }
        setCreatingGroupParentId(parentGroupId);
        setCreatingGroup(true);
      },
    };
  }

  function commitNewGroup() {
    const trimmed = newGroupName.trim();
    if (trimmed) {
      setFavorites((prev) => createFavoriteGroup(prev, trimmed, creatingGroupParentId));
    }
    setCreatingGroup(false);
    setCreatingGroupParentId(null);
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

  const processedEntries = useMemo(() => {
    const normalizeForSearch = (value: string) => {
      let result = searchCaseSensitive ? value : value.toLowerCase();
      if (searchIgnoreSpecialChars) {
        result = result.replace(/[^a-zA-Z0-9]+/g, "");
      }
      return result;
    };
    const query = normalizeForSearch(searchQuery.trim());
    const extension = extensionFilter.trim().replace(/^\.+/, "").toLowerCase();
    const filtered = entries.filter((entry) => {
      if (typeFilter === "folders" && !entry.is_dir) return false;
      if (typeFilter === "files" && entry.is_dir) return false;
      if (query && !normalizeForSearch(entry.name).includes(query)) return false;
      if (extension && (entry.is_dir || extensionOf(entry.name) !== extension)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => compareEntries(a, b, sortKey, sortDir));
  }, [
    entries,
    searchQuery,
    searchCaseSensitive,
    searchIgnoreSpecialChars,
    extensionFilter,
    typeFilter,
    sortKey,
    sortDir,
  ]);

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

  const flatOrder = useMemo(
    () => (groupBy === "type" ? groupedEntries.flatMap((group) => group.items) : processedEntries),
    [groupBy, groupedEntries, processedEntries],
  );

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 3000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!deleteConfirmation) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        void confirmDelete();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setDeleteConfirmation(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [deleteConfirmation]);

  useEffect(() => {
    if (!bulkRenameEntries) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (isBulkRenameValid()) void confirmBulkRenaming();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelBulkRenaming();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulkRenameEntries, bulkPattern, bulkStartNumber, bulkOverrides]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!active) return;
      const target = e.target as HTMLElement | null;
      const isTextInput =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault();
        pathInputRef.current?.focus();
        pathInputRef.current?.select();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a" && !isTextInput) {
        e.preventDefault();
        setSelectedPaths(flatOrder.map((entry) => entry.path));
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && !isTextInput) {
        e.preventDefault();
        copySelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && !isTextInput) {
        e.preventDefault();
        cutSelection();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && !isTextInput) {
        e.preventDefault();
        void pasteClipboard();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !isTextInput) {
        e.preventDefault();
        void undoLastAction();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveTextEditsRef.current();
      } else if (e.key === "F2" && !isTextInput) {
        e.preventDefault();
        if (selectedPaths.length === 1 && currentPath) {
          const entry = flatOrder.find((item) => item.path === selectedPaths[0]);
          if (entry) startRenaming(entry);
        } else if (selectedPaths.length > 1) {
          startBulkRenaming(selectedPaths);
        }
      } else if (e.key === "Delete" && !isTextInput) {
        e.preventDefault();
        if (selectedPaths.length > 0) requestDelete(selectedPaths);
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        goUp();
      } else if (
        !isTextInput &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !bulkRenameEntries &&
        !deleteConfirmation &&
        currentPath &&
        /^[a-zA-Z0-9]$/.test(e.key)
      ) {
        e.preventDefault();
        searchInputRef.current?.focus();
        setSearchQuery((prev) => prev + e.key);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    currentPath,
    active,
    flatOrder,
    selectedPaths,
    clipboard,
    undoStack,
    bulkRenameEntries,
    deleteConfirmation,
  ]);

  async function loadDirectory(
    path: string,
    options?: { silent?: boolean },
  ): Promise<DirEntryInfo[] | undefined> {
    directorySummaryRequest.current += 1;
    setLoading(true);
    if (!options?.silent) setError(null);
    setSearchQuery("");
    setSelectedPaths([]);
    selectionAnchorRef.current = null;
    setSelectedFile(null);
    setFileContent(null);
    setEditedContent("");
    setDirectorySummary(null);
    setDirectorySummaryLoading(false);
    setDirectorySummaryError(null);
    try {
      const result = await invoke<DirEntryInfo[]>("read_directory", { path });
      setEntries(result);
      setCurrentPath(path);
      setPathInput(path);
      return result;
    } catch {
      if (!options?.silent) {
        setError(t("pathNotFoundError").replace("{path}", path));
      }
      return undefined;
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDirectory(initialPath, { silent: true }).then((result) => {
      const match = result?.find((entry) => entry.path === initialFile);
      if (match) {
        setSelectedPaths([match.path]);
        void openEntryInView(match);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onPathChange(currentPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

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

  function clearPdfPreview() {
    if (pdfPreviewUrlRef.current) {
      URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
    }
    setPdfPreviewUrl(null);
  }

  function clearAudioPreview() {
    if (audioPreviewUrlRef.current) {
      URL.revokeObjectURL(audioPreviewUrlRef.current);
      audioPreviewUrlRef.current = null;
    }
    setAudioPreviewUrl(null);
  }

  function clearVideoPreview() {
    if (videoPreviewUrlRef.current?.startsWith("blob:")) {
      URL.revokeObjectURL(videoPreviewUrlRef.current);
    }
    videoPreviewUrlRef.current = null;
    setVideoPreviewUrl(null);
  }

  function clearImagePreview() {
    if (imagePreviewUrlRef.current) {
      URL.revokeObjectURL(imagePreviewUrlRef.current);
      imagePreviewUrlRef.current = null;
    }
    setImagePreviewUrl(null);
  }

  useEffect(() => {
    return () => {
      if (pdfPreviewUrlRef.current) {
        URL.revokeObjectURL(pdfPreviewUrlRef.current);
      }
      if (audioPreviewUrlRef.current) {
        URL.revokeObjectURL(audioPreviewUrlRef.current);
      }
      if (videoPreviewUrlRef.current?.startsWith("blob:")) {
        URL.revokeObjectURL(videoPreviewUrlRef.current);
      }
      if (imagePreviewUrlRef.current) {
        URL.revokeObjectURL(imagePreviewUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!previewFullscreen || !selectedFile || (!audioPreviewUrl && !videoPreviewUrl)) return;
    const filePath = selectedFile.path;
    const interval = setInterval(() => {
      if (!progressTrackingArmedRef.current) return;
      const el = mediaElRef.current;
      if (!el) return;
      setMediaProgress(filePath, Math.floor(el.currentTime));
    }, 1000);
    return () => clearInterval(interval);
  }, [previewFullscreen, selectedFile, audioPreviewUrl, videoPreviewUrl]);

  function setMediaRef(el: HTMLMediaElement | null) {
    mediaElRef.current = el;
    if (el && pendingResumeSecondsRef.current !== null) {
      el.currentTime = pendingResumeSecondsRef.current;
      pendingResumeSecondsRef.current = null;
    }
  }

  function handleMediaLoadedMetadata(event: { currentTarget: HTMLMediaElement }) {
    if (pendingResumeSecondsRef.current !== null) {
      event.currentTarget.currentTime = pendingResumeSecondsRef.current;
      pendingResumeSecondsRef.current = null;
    }
  }

  function enterFullscreenView(filePath: string, isMedia: boolean) {
    recordLastOpened(filePath);
    setPreviewFullscreen(true);
    if (isMedia) {
      const stored = getMediaProgress(filePath);
      if (stored > 0) {
        progressTrackingArmedRef.current = false;
        setResumePrompt({ filePath, seconds: stored });
        return;
      }
    }
    progressTrackingArmedRef.current = true;
    setResumePrompt(null);
  }

  function answerResumePrompt(resume: boolean) {
    if (!resumePrompt) return;
    if (resume) {
      const el = mediaElRef.current;
      if (el) {
        el.currentTime = resumePrompt.seconds;
      } else {
        pendingResumeSecondsRef.current = resumePrompt.seconds;
      }
    }
    progressTrackingArmedRef.current = true;
    setResumePrompt(null);
  }

  async function openEntryInView(entry: DirEntryInfo) {
    const ext = extensionOf(entry.name);
    const category = categoryOf(false, ext);
    enterFullscreenView(entry.path, category === "audio" || category === "video");
    await openEntry(entry);
  }

  async function saveTextEdits() {
    if (!selectedFile || fileContent === null || editedContent === fileContent) return;
    setSavingText(true);
    try {
      await writeTextFile(selectedFile.path, editedContent);
      setFileContent(editedContent);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingText(false);
    }
  }
  saveTextEditsRef.current = () => void saveTextEdits();

  function handlePanelResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanelResizing(true);
  }

  function handlePanelResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.buttons === 0) return;
    const width = window.innerWidth - event.clientX;
    setFullscreenPanelWidth(Math.min(600, Math.max(220, width)));
  }

  function handlePanelResizeEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setPanelResizing(false);
  }

  async function openEntry(entry: DirEntryInfo) {
    if (entry.is_dir) {
      directorySummaryRequest.current += 1;
      const requestId = directorySummaryRequest.current;
      setSelectedFile(entry);
      setFileContent(null);
      setEditedContent("");
      clearPdfPreview();
      clearAudioPreview();
      clearVideoPreview();
      setPreviewFullscreen(false);
      setError(null);
      setDirectorySummary(null);
      setDirectorySummaryLoading(true);
      setDirectorySummaryError(null);
      try {
        const summary = await invoke<DirectorySummary>("directory_summary", {
          path: entry.path,
        });
        if (directorySummaryRequest.current === requestId) {
          setDirectorySummary(summary);
        }
      } catch (cause) {
        if (directorySummaryRequest.current === requestId) {
          setDirectorySummaryError(String(cause));
        }
      } finally {
        if (directorySummaryRequest.current === requestId) {
          setDirectorySummaryLoading(false);
        }
      }
      return;
    }

    directorySummaryRequest.current += 1;
    setSelectedFile(entry);
    setFileContent(null);
    setEditedContent("");
    const ext = extensionOf(entry.name);
    const category = categoryOf(false, ext);
    clearPdfPreview();
    clearAudioPreview();
    clearVideoPreview();
    clearImagePreview();
    setError(null);
    setDirectorySummary(null);
    setDirectorySummaryLoading(false);
    setDirectorySummaryError(null);

    if (ext === "pdf") {
      try {
        const bytes = await readFile(entry.path);
        const blob = new Blob([bytes], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        pdfPreviewUrlRef.current = url;
        setPdfPreviewUrl(url);
      } catch (e) {
        setError(String(e));
      }
      return;
    }

    if (category === "audio") {
      try {
        const bytes = await readFile(entry.path);
        const blob = new Blob([bytes], { type: AUDIO_MIME_TYPES[ext] ?? "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        audioPreviewUrlRef.current = url;
        setAudioPreviewUrl(url);
      } catch (e) {
        setError(String(e));
      }
      return;
    }

    if (category === "video") {
      try {
        const url = convertFileSrc(entry.path);
        videoPreviewUrlRef.current = url;
        setVideoPreviewUrl(url);
      } catch (e) {
        setError(String(e));
      }
      return;
    }

    if (category === "image") {
      try {
        const bytes = await readFile(entry.path);
        const blob = new Blob([bytes], { type: IMAGE_MIME_TYPES[ext] ?? "image/png" });
        const url = URL.createObjectURL(blob);
        imagePreviewUrlRef.current = url;
        setImagePreviewUrl(url);
      } catch (e) {
        setError(String(e));
      }
      return;
    }

    try {
      const content = await readTextFile(entry.path);
      setFileContent(content);
      setEditedContent(content);
    } catch (e) {
      setError(String(e));
    }
  }

  function parentPathOf(path: string): string | null {
    const sep = path.includes("\\") ? "\\" : "/";
    const trimmed = path.replace(/[\\/]+$/, "");
    const parentIdx = trimmed.lastIndexOf(sep);
    if (parentIdx <= 0) return null;
    return trimmed.slice(0, parentIdx) || sep;
  }

  function goUp() {
    if (!currentPath) return;
    const parent = parentPathOf(currentPath);
    if (parent) loadDirectory(parent);
  }

  function startRenaming(entry: DirEntryInfo) {
    setRenamingPath(entry.path);
    setEntryRenameValue(entry.name);
  }

  function cancelRenaming() {
    setRenamingPath(null);
    setEntryRenameValue("");
  }

  async function commitRenaming(entry: DirEntryInfo, parentPath: string) {
    const trimmed = entryRenameValue.trim();
    cancelRenaming();
    if (!trimmed || trimmed === entry.name) return;
    const newPath = joinPath(parentPath, trimmed);
    try {
      await rename(entry.path, newPath);
      pushUndo({ type: "rename", items: [{ from: entry.path, to: newPath }] });
      refreshAllVisibleDirectories();
      if (selectedFile?.path === entry.path) {
        setSelectedPaths([newPath]);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function startBulkRenaming(paths: string[]) {
    const targets = flatOrder.filter((entry) => paths.includes(entry.path));
    if (targets.length < 2) return;
    setBulkRenameEntries(targets);
    setBulkPattern("");
    setBulkStartNumber(1);
    setBulkOverrides({});
  }

  function cancelBulkRenaming() {
    setBulkRenameEntries(null);
    setBulkOverrides({});
  }

  function bulkPatternNameFor(entry: DirEntryInfo, index: number): string {
    const dot = entry.is_dir ? -1 : entry.name.lastIndexOf(".");
    const ext = dot > 0 ? entry.name.slice(dot) : "";
    const number = String(bulkStartNumber + index);
    const base = bulkPattern.includes("{n}")
      ? bulkPattern.split("{n}").join(number)
      : `${bulkPattern}${number}`;
    return `${base}${ext}`;
  }

  function bulkNameFor(entry: DirEntryInfo, index: number): string {
    return bulkOverrides[entry.path] ?? bulkPatternNameFor(entry, index);
  }

  function isBulkRenameValid(): boolean {
    if (!bulkRenameEntries) return false;
    const names = bulkRenameEntries.map((entry, index) => bulkNameFor(entry, index).trim());
    return names.every((name) => name.length > 0) && new Set(names).size === names.length;
  }

  async function confirmBulkRenaming() {
    if (!bulkRenameEntries || !currentPath) return;
    setBulkSaving(true);
    const renamedItems: { from: string; to: string }[] = [];
    for (const [index, entry] of bulkRenameEntries.entries()) {
      const trimmed = bulkNameFor(entry, index).trim();
      if (!trimmed || trimmed === entry.name) continue;
      const newPath = joinPath(currentPath, trimmed);
      try {
        await rename(entry.path, newPath);
        renamedItems.push({ from: entry.path, to: newPath });
      } catch (e) {
        setError(String(e));
      }
    }
    if (renamedItems.length > 0) pushUndo({ type: "rename", items: renamedItems });
    setBulkSaving(false);
    setBulkRenameEntries(null);
    setBulkOverrides({});
    setSelectedPaths([]);
    refreshAllVisibleDirectories();
  }

  function requestDelete(paths: string[]) {
    if (paths.length === 0) return;
    setDeleteConfirmation({ paths });
  }

  async function confirmDelete() {
    if (!deleteConfirmation) return;
    const { paths } = deleteConfirmation;
    setDeleteConfirmation(null);
    for (const path of paths) {
      try {
        await remove(path, { recursive: true });
      } catch (e) {
        setError(String(e));
      }
    }
    refreshAllVisibleDirectories();
    setSelectedPaths((prev) => prev.filter((path) => !paths.includes(path)));
    if (selectedFile && paths.includes(selectedFile.path)) {
      setSelectedFile(null);
      setFileContent(null);
      setEditedContent("");
      setPreviewFullscreen(false);
      clearPdfPreview();
      clearAudioPreview();
      clearVideoPreview();
      clearImagePreview();
    }
  }

  function uniqueNameFor(baseName: string, suffix: string): string {
    const existingNames = new Set(entries.map((e) => e.name.toLowerCase()));
    let name = `${baseName}${suffix}`;
    let counter = 2;
    while (existingNames.has(name.toLowerCase())) {
      name = `${baseName} (${counter})${suffix}`;
      counter++;
    }
    return name;
  }

  async function createTextFile() {
    if (!currentPath) return;
    const name = uniqueNameFor(t("newTextFile"), ".txt");
    try {
      const path = joinPath(currentPath, name);
      await writeTextFile(path, "");
      const result = await loadDirectory(currentPath, { silent: true });
      const created = result?.find((e) => e.path === path);
      if (created) {
        setSelectedPaths([created.path]);
        selectionAnchorRef.current = created.path;
        startRenaming(created);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function createFolder() {
    if (!currentPath) return;
    const name = uniqueNameFor(t("newFolder"), "");
    try {
      const path = joinPath(currentPath, name);
      await mkdir(path);
      const result = await loadDirectory(currentPath, { silent: true });
      const created = result?.find((e) => e.path === path);
      if (created) {
        setSelectedPaths([created.path]);
        selectionAnchorRef.current = created.path;
        startRenaming(created);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  function pushUndo(action: UndoAction) {
    setUndoStack((prev) => [...prev, action]);
  }

  async function undoLastAction() {
    const action = undoStack[undoStack.length - 1];
    if (!action) return;
    setUndoStack((prev) => prev.slice(0, -1));
    if (action.type === "copy") {
      for (const path of action.paths) {
        try {
          await remove(path, { recursive: true });
        } catch (e) {
          setError(String(e));
        }
      }
    } else {
      for (const { from, to } of action.items) {
        try {
          await rename(to, from);
        } catch (e) {
          setError(String(e));
        }
      }
    }
    refreshAllVisibleDirectories();
  }

  async function moveEntriesTo(sourcePaths: string[], targetDirPath: string) {
    const movedItems: { from: string; to: string }[] = [];
    for (const sourcePath of sourcePaths) {
      if (sourcePath === targetDirPath) continue;
      const destPath = joinPath(targetDirPath, basenameOf(sourcePath));
      if (destPath === sourcePath) continue;
      try {
        await rename(sourcePath, destPath);
        movedItems.push({ from: sourcePath, to: destPath });
      } catch (e) {
        setError(String(e));
      }
    }
    if (movedItems.length > 0) pushUndo({ type: "move", items: movedItems });
    refreshAllVisibleDirectories();
  }

  function uniqueCopyNameFor(name: string): string {
    const existingNames = new Set(entries.map((e) => e.name.toLowerCase()));
    if (!existingNames.has(name.toLowerCase())) return name;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let counter = 2;
    let candidate = `${base} (${counter})${ext}`;
    while (existingNames.has(candidate.toLowerCase())) {
      counter++;
      candidate = `${base} (${counter})${ext}`;
    }
    return candidate;
  }

  async function openFilesExternally(paths: string[]) {
    for (const path of paths) {
      try {
        await openPath(path);
      } catch (e) {
        setError(String(e));
      }
    }
  }

  function copySelection() {
    if (selectedPaths.length === 0) return;
    setClipboard({ paths: selectedPaths, mode: "copy" });
  }

  function cutSelection() {
    if (selectedPaths.length === 0) return;
    setClipboard({ paths: selectedPaths, mode: "cut" });
  }

  async function pasteClipboard() {
    if (!clipboard || !currentPath) return;
    const { paths, mode } = clipboard;
    if (mode === "cut") {
      await moveEntriesTo(paths, currentPath);
      setClipboard(null);
      return;
    }
    const createdPaths: string[] = [];
    for (const sourcePath of paths) {
      const destName = uniqueCopyNameFor(basenameOf(sourcePath));
      const destPath = joinPath(currentPath, destName);
      if (destPath === sourcePath) continue;
      try {
        await invoke("copy_path", { source: sourcePath, destination: destPath });
        createdPaths.push(destPath);
      } catch (e) {
        setError(String(e));
      }
    }
    if (createdPaths.length > 0) pushUndo({ type: "copy", paths: createdPaths });
    refreshAllVisibleDirectories();
  }

  function startDraggingEntry(e: ReactDragEvent, entry: DirEntryInfo) {
    const paths =
      selectedPaths.includes(entry.path) && selectedPaths.length > 1
        ? selectedPaths
        : [entry.path];
    e.dataTransfer.setData(FILE_MOVE_DRAG_TYPE, JSON.stringify(paths));
    if (entry.is_dir && paths.length === 1) {
      e.dataTransfer.setData(FAVORITE_FOLDER_DRAG_TYPE, entry.path);
    }
    e.dataTransfer.effectAllowed = "move";
    setIsDraggingFavorite(true);
    void startDrag({ item: paths, icon: dragIconUrl, mode: "copy" }).catch(() => {});
  }

  function handleEntryDragOver(e: ReactDragEvent, targetDirPath: string) {
    if (!e.dataTransfer.types.includes(FILE_MOVE_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTargetPath(targetDirPath);
  }

  function handleEntryDragLeave(targetDirPath: string) {
    setDropTargetPath((prev) => (prev === targetDirPath ? null : prev));
  }

  function handleEntryDrop(e: ReactDragEvent, targetDirPath: string) {
    if (!e.dataTransfer.types.includes(FILE_MOVE_DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTargetPath(null);
    setIsDraggingFavorite(false);
    const raw = e.dataTransfer.getData(FILE_MOVE_DRAG_TYPE);
    if (!raw) return;
    let paths: string[];
    try {
      const parsed: unknown = JSON.parse(raw);
      paths = Array.isArray(parsed) ? parsed : [raw];
    } catch {
      paths = [raw];
    }
    void moveEntriesTo(paths, targetDirPath);
  }

  function startDraggingFolder(e: ReactDragEvent, path: string) {
    e.dataTransfer.setData(FAVORITE_FOLDER_DRAG_TYPE, path);
    e.dataTransfer.effectAllowed = "move";
    setIsDraggingFavorite(true);
  }

  function startDraggingGroup(e: ReactDragEvent, groupId: string) {
    e.dataTransfer.setData(FAVORITE_GROUP_DRAG_TYPE, groupId);
    e.dataTransfer.effectAllowed = "move";
    setIsDraggingFavorite(true);
  }

  function endDraggingFavorite() {
    setDropTargetGroupId(null);
    setDropTargetPath(null);
    setIsDraggingFavorite(false);
  }

  function handleGroupDragOver(e: ReactDragEvent, groupId: string) {
    if (
      !e.dataTransfer.types.includes(FAVORITE_FOLDER_DRAG_TYPE) &&
      !e.dataTransfer.types.includes(FAVORITE_GROUP_DRAG_TYPE)
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    setDropTargetGroupId(groupId);
  }

  function handleGroupDrop(e: ReactDragEvent, groupId: string) {
    e.preventDefault();
    e.stopPropagation();
    const path = e.dataTransfer.getData(FAVORITE_FOLDER_DRAG_TYPE);
    const draggedGroupId = e.dataTransfer.getData(FAVORITE_GROUP_DRAG_TYPE);
    if (path) {
      setFavorites((prev) => moveFavoriteToGroup(prev, path, groupId));
    } else if (draggedGroupId) {
      setFavorites((prev) => moveFavoriteGroup(prev, draggedGroupId, groupId));
    }
    setDropTargetGroupId(null);
    setIsDraggingFavorite(false);
  }

  function handleFavoritesBarDrop(e: ReactDragEvent) {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    const path = e.dataTransfer.getData(FAVORITE_FOLDER_DRAG_TYPE);
    const draggedGroupId = e.dataTransfer.getData(FAVORITE_GROUP_DRAG_TYPE);
    if (path) {
      setFavorites((prev) => moveFavoriteToGroup(prev, path, null));
    } else if (draggedGroupId) {
      setFavorites((prev) => moveFavoriteGroup(prev, draggedGroupId, null));
    }
    setDropTargetGroupId(null);
    setIsDraggingFavorite(false);
  }

  function toggleFavoriteGroup(group: FavoriteGroup) {
    setOpenGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(group.id)) {
        next.delete(group.id);
        for (const descendantId of descendantGroupIds(group)) next.delete(descendantId);
      } else {
        next.add(group.id);
      }
      return next;
    });
  }

  function renderNewGroupInput() {
    return (
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
            setCreatingGroupParentId(null);
            setNewGroupName("");
          }
        }}
        onBlur={commitNewGroup}
      />
    );
  }

  function renderFavoriteGroup(
    group: FavoriteGroup,
    parentGroupId: string | null,
  ) {
    const isOpen = openGroupIds.has(group.id);
    const isRoot = parentGroupId === null;
    return (
      <div
        className={`favorite-group${dropTargetGroupId === group.id ? " drop-target" : ""}`}
        key={group.id}
        onDragOver={(e) => handleGroupDragOver(e, group.id)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setDropTargetGroupId(null);
          }
        }}
        onDrop={(e) => handleGroupDrop(e, group.id)}
      >
        {renamingGroupId === group.id ? (
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
            draggable
            onDragStart={(e) => startDraggingGroup(e, group.id)}
            onDragEnd={endDraggingFavorite}
            onClick={() => toggleFavoriteGroup(group)}
            onContextMenu={(e) =>
              openContextMenu(e, [...groupMenuFor(group.id), newGroupMenuItem(group.id)])
            }
          >
            📁 {group.name}
          </button>
        )}

        {isRoot && isOpen && !isDraggingFavorite && (
          <div
            className="favorite-dropdown-overlay"
            onClick={() => setOpenGroupIds(new Set())}
          />
        )}
        {isOpen && (
          <div
            className={`favorite-dropdown${isRoot ? "" : " nested-dropdown"}`}
            onContextMenu={(e) => openContextMenu(e, [newGroupMenuItem(group.id)])}
          >
            {group.items.length === 0 && creatingGroupParentId !== group.id && (
              <p className="hint">{t("emptyGroup")}</p>
            )}
            {group.items.map((item) =>
              item.type === "folder" ? (
                <button
                  key={item.id}
                  className={`favorite-dropdown-item${dropTargetPath === item.path ? " drop-target-move" : ""}`}
                  title={item.path}
                  draggable
                  onDragStart={(e) => startDraggingFolder(e, item.path)}
                  onDragEnd={endDraggingFavorite}
                  onDragOver={(e) => handleEntryDragOver(e, item.path)}
                  onDragLeave={() => handleEntryDragLeave(item.path)}
                  onDrop={(e) => handleEntryDrop(e, item.path)}
                  onClick={() => {
                    loadDirectory(item.path);
                    setOpenGroupIds(new Set());
                  }}
                  onMouseDown={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    onOpenInNewTab(item.path);
                    setOpenGroupIds(new Set());
                  }}
                  onContextMenu={(e) =>
                    openContextMenu(e, [
                      { label: t("openInNewTab"), onClick: () => onOpenInNewTab(item.path) },
                      ...groupItemMenuFor(item.path),
                      newGroupMenuItem(group.id),
                    ])
                  }
                >
                  {basenameOf(item.path)}
                </button>
              ) : (
                renderFavoriteGroup(item, group.id)
              ),
            )}
            {creatingGroup && creatingGroupParentId === group.id && renderNewGroupInput()}
          </div>
        )}
      </div>
    );
  }

  function renderEntryList(list: DirEntryInfo[]) {
    return (
      <ul>
        {list.map((entry) => renderTreeEntry(entry, 0, currentPath ?? undefined))}
      </ul>
    );
  }

  function renderParentEntry() {
    if (!currentPath) return null;
    const parent = parentPathOf(currentPath);
    if (!parent) return null;
    return (
      <ul>
        <li className="tree-node">
          <div
            className={`tree-entry-row${viewMode === "block" ? " tree-block-tile" : ""}${dropTargetPath === parent ? " drop-target-move" : ""}`}
            onClick={() => void loadDirectory(parent)}
            onDoubleClick={() => void loadDirectory(parent)}
            onDragOver={(e) => handleEntryDragOver(e, parent)}
            onDragLeave={() => handleEntryDragLeave(parent)}
            onDrop={(e) => handleEntryDrop(e, parent)}
            title={parent}
          >
            <span className="tree-toggle-spacer" />
            <span className="icon">📁</span>
            <span className="name">..</span>
            {viewMode === "list" && (
              <>
                <span className="meta meta-size" />
                <span className="meta meta-date" />
                <span className="meta meta-date" />
              </>
            )}
          </div>
        </li>
      </ul>
    );
  }

  function renderFileListContents() {
    return (
      <>
        {renderParentEntry()}
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
      </>
    );
  }

  function renderTreeEntry(entry: DirEntryInfo, depth = 0, parentPath?: string) {
    const expanded = expandedDirectories.has(entry.path);
    const treeState = treeDirectories[entry.path];
    const blockView = viewMode === "block";
    const colorHex = colorHexFor(fileColors[entry.path]);
    const isRenaming = renamingPath === entry.path;
    return (
      <li
        className={`tree-node${blockView && depth === 0 && entry.is_dir && expanded ? " expanded-tree-node" : ""}`}
        key={entry.path}
      >
        <div
          className={`tree-entry-row${blockView && depth === 0 && !expanded ? " tree-block-tile" : ""}${blockView && (expanded || depth > 0) ? " tree-compact-row" : ""}${selectedPaths.includes(entry.path) ? " selected" : ""}${dropTargetPath === entry.path ? " drop-target-move" : ""}`}
          draggable={!isRenaming}
          onDragStart={(e) => startDraggingEntry(e, entry)}
          onDragEnd={endDraggingFavorite}
          onDragOver={(e) => {
            if (entry.is_dir) handleEntryDragOver(e, entry.path);
          }}
          onDragLeave={() => {
            if (entry.is_dir) handleEntryDragLeave(entry.path);
          }}
          onDrop={(e) => {
            if (entry.is_dir) handleEntryDrop(e, entry.path);
          }}
          onClick={(e) => {
            if (isRenaming) return;
            if (e.shiftKey) {
              const anchor = selectionAnchorRef.current ?? entry.path;
              const anchorIndex = flatOrder.findIndex((item) => item.path === anchor);
              const targetIndex = flatOrder.findIndex((item) => item.path === entry.path);
              if (anchorIndex === -1 || targetIndex === -1) {
                setSelectedPaths([entry.path]);
              } else {
                const [start, end] =
                  anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
                setSelectedPaths(flatOrder.slice(start, end + 1).map((item) => item.path));
              }
              return;
            }
            if (e.ctrlKey || e.metaKey) {
              setSelectedPaths((prev) =>
                prev.includes(entry.path)
                  ? prev.filter((path) => path !== entry.path)
                  : [...prev, entry.path],
              );
              selectionAnchorRef.current = entry.path;
              return;
            }
            if (previewFullscreen && e.detail > 1) return;
            setSelectedPaths([entry.path]);
            selectionAnchorRef.current = entry.path;
            if (previewFullscreen && canPreviewEntry(entry)) {
              void openEntryInView(entry);
            } else {
              openEntry(entry);
            }
          }}
          onDoubleClick={() => {
            if (entry.is_dir) {
              void loadDirectory(entry.path);
            } else if (!previewFullscreen && canPreviewEntry(entry)) {
              void openEntryInView(entry);
            }
          }}
          onMouseDown={(e) => {
            if (e.button !== 1) return;
            e.preventDefault();
            if (entry.is_dir) {
              onOpenInNewTab(entry.path);
            } else {
              onOpenInNewTab(parentPath ?? currentPath ?? "", entry.path);
            }
          }}
          onContextMenu={(e) => {
            const colorPaths = selectedPaths.includes(entry.path)
              ? selectedPaths
              : [entry.path];
            setSelectedPaths(colorPaths);
            if (entry.is_dir) {
              openContextMenu(e, directoryMenuFor(entry, colorPaths, parentPath));
            } else {
              const items = fileMenuFor(entry, colorPaths, parentPath);
              if (items.length > 0) openContextMenu(e, items);
            }
          }}
          title={entry.path}
        >
          {entry.is_dir ? (
            <button
              className="tree-toggle"
              aria-label={t(expanded ? "hideFolderContents" : "showFolderContents")}
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                toggleDirectoryTree(entry.path);
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="tree-toggle-spacer" />
          )}
          <span className="icon">{iconFor(entry.is_dir, extensionOf(entry.name))}</span>
          {colorHex && <span className="color-dot" style={{ backgroundColor: colorHex }} />}
          {isRenaming ? (
            <input
              autoFocus
              className="rename-input"
              value={entryRenameValue}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
              onFocus={(e) => {
                const dot = entry.name.lastIndexOf(".");
                if (!entry.is_dir && dot > 0) {
                  e.currentTarget.setSelectionRange(0, dot);
                } else {
                  e.currentTarget.select();
                }
              }}
              onChange={(e) => setEntryRenameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") void commitRenaming(entry, parentPath ?? currentPath ?? "");
                if (e.key === "Escape") cancelRenaming();
              }}
              onBlur={() => void commitRenaming(entry, parentPath ?? currentPath ?? "")}
            />
          ) : (
            <span className="name">{entry.name}</span>
          )}
          {viewMode === "list" && (
            <>
              <span className="meta meta-size">{!entry.is_dir ? formatSize(entry.size) : ""}</span>
              <span className="meta meta-date">{formatDate(entry.modified)}</span>
              <span className="meta meta-date">{formatDate(getLastOpened(entry.path))}</span>
            </>
          )}
        </div>
        {entry.is_dir && expanded && (
          <div className={viewMode === "block" ? "tree-contents" : undefined}>
            <ul className="tree-children">
              {treeState?.loading && <li className="tree-message hint">{t("loading")}</li>}
              {treeState?.error && (
                <li className="tree-message error">{treeState.error}</li>
              )}
              {treeState?.entries?.length === 0 && (
                <li className="tree-message hint">{t("emptyFolder")}</li>
              )}
              {treeState?.entries?.map((child) =>
                renderTreeEntry(child, depth + 1, entry.path),
              )}
            </ul>
          </div>
        )}
      </li>
    );
  }

  function renderSelectedPreview() {
    if (!selectedFile) return null;

    if (selectedFile.is_dir) {
      return (
        <>
          <h3>{selectedFile.name}</h3>
          {directorySummaryLoading && <p className="hint">{t("folderSummaryLoading")}</p>}
          {directorySummaryError && (
            <p className="error">
              {t("folderSummaryError").replace("{error}", directorySummaryError)}
            </p>
          )}
          {directorySummary && (
            <dl className="folder-summary">
              <dt>{t("folderItemCount")}</dt>
              <dd>{directorySummary.item_count.toLocaleString(language === "pt" ? "pt-BR" : "en-US")}</dd>
              <dt>{t("folderTotalSize")}</dt>
              <dd>
                {directorySummary.size_bytes.toLocaleString(language === "pt" ? "pt-BR" : "en-US")} bytes
              </dd>
            </dl>
          )}
        </>
      );
    }

    if (pdfPreviewUrl) {
      return (
        <div className="preview-pane">
          <embed
            className="pdf-preview"
            src={`${pdfPreviewUrl}#toolbar=1&navpanes=0`}
            type="application/pdf"
          />
        </div>
      );
    }

    if (audioPreviewUrl) {
      return (
        <>
          <h3>{selectedFile.name}</h3>
          {!previewFullscreen && (
            <audio className="audio-preview" controls src={audioPreviewUrl} />
          )}
        </>
      );
    }

    if (videoPreviewUrl) {
      return (
        <>
          <h3>{selectedFile.name}</h3>
          {!previewFullscreen && (
            <video className="video-preview" controls src={videoPreviewUrl} />
          )}
        </>
      );
    }

    if (imagePreviewUrl) {
      return (
        <>
          <h3>{selectedFile.name}</h3>
          <img className="image-preview" src={imagePreviewUrl} alt={selectedFile.name} />
        </>
      );
    }

    if (fileContent === null) {
      return (
        <>
          <h3>{selectedFile.name}</h3>
          <p className="hint">{t("noPreviewHint")}</p>
        </>
      );
    }

    const isDirty = editedContent !== fileContent;
    return (
      <>
        <h3>{selectedFile.name}</h3>
        <div className="text-edit-toolbar">
          <button
            type="button"
            className="primary"
            onClick={saveTextEdits}
            disabled={!isDirty || savingText}
          >
            {savingText ? t("saving") : t("saveEdit")}
          </button>
        </div>
        <textarea
          className="text-edit-textarea"
          value={editedContent}
          onChange={(e) => setEditedContent(e.currentTarget.value)}
        />
      </>
    );
  }

  function renderFullscreenContent() {
    if (pdfPreviewUrl) {
      return (
        <embed
          className="preview-fullscreen-embed"
          src={`${pdfPreviewUrl}#toolbar=1&navpanes=0`}
          type="application/pdf"
        />
      );
    }
    if (audioPreviewUrl) {
      return (
        <div className="preview-fullscreen-audio-wrap">
          <audio
            className="preview-fullscreen-audio"
            controls
            src={audioPreviewUrl}
            ref={setMediaRef}
            onLoadedMetadata={handleMediaLoadedMetadata}
          />
        </div>
      );
    }
    if (videoPreviewUrl) {
      return (
        <video
          className="preview-fullscreen-video"
          controls
          src={videoPreviewUrl}
          ref={setMediaRef}
          onLoadedMetadata={handleMediaLoadedMetadata}
        />
      );
    }
    if (imagePreviewUrl) {
      return (
        <img
          className="preview-fullscreen-image"
          src={imagePreviewUrl}
          alt={selectedFile?.name ?? ""}
        />
      );
    }
    if (fileContent !== null) {
      const isDirty = editedContent !== fileContent;
      return (
        <div className="preview-fullscreen-text-wrap">
          <div className="text-edit-toolbar preview-fullscreen-text-toolbar">
            <button
              type="button"
              className="primary"
              onClick={saveTextEdits}
              disabled={!isDirty || savingText}
            >
              {savingText ? t("saving") : t("saveEdit")}
            </button>
          </div>
          <textarea
            className="preview-fullscreen-textarea"
            value={editedContent}
            onChange={(e) => setEditedContent(e.currentTarget.value)}
          />
        </div>
      );
    }
    return null;
  }

  return (
    <main className="explorer" style={{ display: active ? "flex" : "none" }}>
      <header className="toolbar">
        <div className="path-bar">
          <button
            className="icon-btn"
            title={`${t("exitFolder")} (Alt+Up)`}
            onClick={goUp}
            disabled={!currentPath}
          >
            ⬆
          </button>
          <input
            ref={pathInputRef}
            type="text"
            className="path-input"
            value={pathInput}
            placeholder={t("noFolderSelected")}
            title="Ctrl+L"
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
          <div className="new-item-menu">
            <button
              className="icon-btn"
              title={t("newItem")}
              onClick={() => setNewItemMenuOpen((open) => !open)}
              disabled={!currentPath}
            >
              ➕
            </button>
            {newItemMenuOpen && (
              <>
                <div
                  className="new-item-menu-overlay"
                  onClick={() => setNewItemMenuOpen(false)}
                />
                <div className="new-item-dropdown">
                  <button
                    className="new-item-dropdown-item"
                    onClick={() => {
                      setNewItemMenuOpen(false);
                      void createTextFile();
                    }}
                  >
                    📝 {t("newTextFile")}
                  </button>
                  <button
                    className="new-item-dropdown-item"
                    onClick={() => {
                      setNewItemMenuOpen(false);
                      void createFolder();
                    }}
                  >
                    📁 {t("newFolder")}
                  </button>
                </div>
              </>
            )}
          </div>
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

      <div
        className="favorites-bar"
        onContextMenu={(e) => openContextMenu(e, [newGroupMenuItem(null)])}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes(FAVORITE_FOLDER_DRAG_TYPE) ||
            e.dataTransfer.types.includes(FAVORITE_GROUP_DRAG_TYPE)
          ) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={handleFavoritesBarDrop}
      >
        {favorites.map((entry) =>
          entry.type === "folder" ? (
            <button
              key={entry.id}
              className={`favorite-chip${dropTargetPath === entry.path ? " drop-target-move" : ""}`}
              title={entry.path}
              draggable
              onDragStart={(e) => startDraggingFolder(e, entry.path)}
              onDragEnd={endDraggingFavorite}
              onDragOver={(e) => handleEntryDragOver(e, entry.path)}
              onDragLeave={() => handleEntryDragLeave(entry.path)}
              onDrop={(e) => handleEntryDrop(e, entry.path)}
              onClick={() => loadDirectory(entry.path)}
              onMouseDown={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                onOpenInNewTab(entry.path);
              }}
              onContextMenu={(e) =>
                openContextMenu(e, [
                  { label: t("openInNewTab"), onClick: () => onOpenInNewTab(entry.path) },
                  ...favoriteMenuFor(entry.path),
                  newGroupMenuItem(null),
                ])
              }
            >
              <span className="favorite-name">{basenameOf(entry.path)}</span>
            </button>
          ) : (
            renderFavoriteGroup(entry, null)
          ),
        )}

        {creatingGroup && creatingGroupParentId === null && renderNewGroupInput()}
      </div>

      {currentPath && (
        <div className="controls">
          <div className="controls-main">
            <input
              ref={searchInputRef}
              type="text"
              className="search-input"
              placeholder={t("searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
            />

            <button
              className={`advanced-filters-toggle${advancedFiltersOpen ? " active" : ""}`}
              aria-expanded={advancedFiltersOpen}
              aria-controls="advanced-filters-panel"
              onClick={() => setAdvancedFiltersOpen((open) => !open)}
            >
              {t("advancedFilters")}
              <span aria-hidden="true">{advancedFiltersOpen ? "▴" : "▾"}</span>
            </button>

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

          {advancedFiltersOpen && (
            <div className="advanced-filters-panel" id="advanced-filters-panel">
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
                <span className="control-label">{t("extensionLabel")}</span>
                <input
                  className="extension-filter-input"
                  type="text"
                  value={extensionFilter}
                  placeholder="pdf"
                  onChange={(e) => setExtensionFilter(e.currentTarget.value)}
                />
              </label>
              <label className="control control-checkbox">
                <input
                  type="checkbox"
                  checked={searchCaseSensitive}
                  onChange={(e) => setSearchCaseSensitive(e.currentTarget.checked)}
                />
                <span className="control-label">{t("searchCaseSensitive")}</span>
              </label>
              <label className="control control-checkbox">
                <input
                  type="checkbox"
                  checked={searchIgnoreSpecialChars}
                  onChange={(e) => setSearchIgnoreSpecialChars(e.currentTarget.checked)}
                />
                <span className="control-label">{t("searchIgnoreSpecialChars")}</span>
              </label>
            </div>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panes">
        <div
          className={`file-list view-${viewMode}`}
          onContextMenu={(e) => {
            if (!currentPath) return;
            openContextMenu(e, [
              { label: t("newTextFile"), onClick: () => void createTextFile() },
              { label: t("newFolder"), onClick: () => void createFolder() },
            ]);
          }}
        >
          {viewMode === "list" && (
            <div className="file-list-header tree-entry-row">
              <span className="tree-toggle-spacer" />
              <span className="icon" aria-hidden="true" />
              <span className="name">
                <button className="column-sort" onClick={() => sortBy("name")}>
                  {t("columnName")}
                  {sortKey === "name" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              </span>
              <span className="meta meta-size">
                <button className="column-sort" onClick={() => sortBy("size")}>
                  {t("columnSize")}
                  {sortKey === "size" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              </span>
              <span className="meta meta-date">
                <button className="column-sort" onClick={() => sortBy("modified")}>
                  {t("columnModified")}
                  {sortKey === "modified" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                </button>
              </span>
              <span className="meta meta-date">{t("columnLastOpened")}</span>
            </div>
          )}
          {renderFileListContents()}
        </div>
      </div>

      {selectedFile && (
        <div className="preview-overlay">
          <button
            className="overlay-close"
            onClick={() => {
              directorySummaryRequest.current += 1;
              setSelectedPaths([]);
              setSelectedFile(null);
              setFileContent(null);
              setEditedContent("");
              clearPdfPreview();
              clearAudioPreview();
              clearVideoPreview();
              clearImagePreview();
            }}
            aria-label="Close preview"
          >
            ×
          </button>
          {renderSelectedPreview()}
        </div>
      )}

      {previewFullscreen && (
        <div className={panelResizing ? "preview-fullscreen resizing" : "preview-fullscreen"}>
          <button
            className="overlay-close preview-fullscreen-close"
            onClick={() => setPreviewFullscreen(false)}
            aria-label={t("closeFullscreen")}
          >
            ×
          </button>
          <div className="preview-fullscreen-content">{renderFullscreenContent()}</div>
          <div className="preview-fullscreen-filelist" style={{ width: fullscreenPanelWidth }}>
            <div
              className="preview-fullscreen-resize-handle"
              onPointerDown={handlePanelResizeStart}
              onPointerMove={handlePanelResizeMove}
              onPointerUp={handlePanelResizeEnd}
              onPointerCancel={handlePanelResizeEnd}
            />
            <div className="file-list view-list">{renderFileListContents()}</div>
          </div>
        </div>
      )}

      {resumePrompt && (
        <div className="modal-backdrop">
          <div className="resume-prompt">
            <p>{t("resumePromptMessage").replace("{time}", formatSeconds(resumePrompt.seconds))}</p>
            <div className="resume-prompt-actions">
              <button type="button" onClick={() => answerResumePrompt(false)}>
                {t("no")}
              </button>
              <button type="button" className="primary" onClick={() => answerResumePrompt(true)}>
                {t("yes")}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmation && (
        <div className="modal-backdrop">
          <div className="resume-prompt">
            <p>
              {deleteConfirmation.paths.length === 1
                ? t("deleteConfirmSingle").replace(
                    "{name}",
                    basenameOf(deleteConfirmation.paths[0]),
                  )
                : t("deleteConfirmMultiple").replace(
                    "{count}",
                    String(deleteConfirmation.paths.length),
                  )}
            </p>
            <div className="resume-prompt-actions">
              <button type="button" onClick={() => setDeleteConfirmation(null)}>
                {t("no")}
              </button>
              <button type="button" className="primary" onClick={() => void confirmDelete()}>
                {t("delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {bulkRenameEntries && (
        <div className="modal-backdrop">
          <div className="bulk-rename-modal">
            <h3>{t("renameMultiple")}</h3>
            <div className="bulk-rename-pattern">
              <label className="control">
                <span className="control-label">{t("bulkRenameBaseName")}</span>
                <input
                  autoFocus
                  type="text"
                  placeholder="{n}"
                  value={bulkPattern}
                  onChange={(e) => setBulkPattern(e.currentTarget.value)}
                />
              </label>
              <label className="control">
                <span className="control-label">{t("bulkRenameStartNumber")}</span>
                <input
                  type="number"
                  className="bulk-rename-number-input"
                  value={bulkStartNumber}
                  onChange={(e) => setBulkStartNumber(Number(e.currentTarget.value) || 1)}
                />
              </label>
            </div>
            <p className="bulk-rename-hint">{t("bulkRenamePatternHint")}</p>
            <ul className="bulk-rename-list">
              {bulkRenameEntries.map((entry, index) => {
                const newName = bulkNameFor(entry, index);
                const overridden = bulkOverrides[entry.path] !== undefined;
                return (
                  <li className="bulk-rename-row" key={entry.path}>
                    <span className="bulk-rename-old" title={entry.name}>
                      {entry.name}
                    </span>
                    <span className="bulk-rename-arrow">→</span>
                    <input
                      className="bulk-rename-input"
                      value={newName}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setBulkOverrides((prev) => ({ ...prev, [entry.path]: value }));
                      }}
                    />
                    <button
                      type="button"
                      className="bulk-rename-reset"
                      title={t("bulkRenameReset")}
                      disabled={!overridden}
                      onClick={() =>
                        setBulkOverrides((prev) => {
                          const next = { ...prev };
                          delete next[entry.path];
                          return next;
                        })
                      }
                    >
                      ↺
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="resume-prompt-actions">
              <button type="button" onClick={cancelBulkRenaming} disabled={bulkSaving}>
                {t("no")}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => void confirmBulkRenaming()}
                disabled={bulkSaving || !isBulkRenameValid()}
              >
                {bulkSaving ? t("saving") : t("rename")}
              </button>
            </div>
          </div>
        </div>
      )}

      <ContextMenu state={contextMenu} onClose={() => setContextMenu(null)} />
    </main>
  );
}

function FileExplorer() {
  const { t } = useLanguage();
  const [favorites, setFavorites] = useState<FavoriteEntry[]>(() =>
    sanitizeFavorites(readStorage<unknown>("favorites", [])),
  );
  const [fileColors, setFileColors] = useState<FileColors>(() =>
    readStorage<FileColors>("fileColors", {}),
  );
  const [clipboard, setClipboard] = useState<ClipboardState>(null);
  useEffect(() => writeStorage("favorites", favorites), [favorites]);
  useEffect(() => writeStorage("fileColors", fileColors), [fileColors]);

  const [tabs, setTabs] = useState<TabMeta[]>(() => [createTab("C:\\")]);
  const [activeTabId, setActiveTabId] = useState<string>(() => tabs[0].id);
  const tabPaths = useRef<Record<string, string | null>>({});
  const previousActiveTabIdRef = useRef<string | null>(null);

  function switchToTab(id: string) {
    if (id === activeTabId) return;
    previousActiveTabIdRef.current = activeTabId;
    setActiveTabId(id);
  }

  function handleTabPathChange(id: string, path: string | null) {
    tabPaths.current[id] = path;
    setTabs((prev) =>
      prev.map((tab) => (tab.id === id ? { ...tab, title: path ? basenameOf(path) : "" } : tab)),
    );
  }

  function addTab() {
    const basePath = tabPaths.current[activeTabId] ?? "C:\\";
    const tab = createTab(basePath);
    setTabs([...tabs, tab]);
    switchToTab(tab.id);
  }

  function closeTab(id: string) {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((tab) => tab.id === id);
    const remaining = tabs.filter((tab) => tab.id !== id);
    setTabs(remaining);
    if (previousActiveTabIdRef.current === id) {
      previousActiveTabIdRef.current = null;
    }
    if (id === activeTabId) {
      const fallback = remaining[Math.max(0, index - 1)] ?? remaining[0];
      setActiveTabId(fallback.id);
    }
    delete tabPaths.current[id];
  }

  function openInNewTab(path: string, fileToSelect?: string) {
    const tab = createTab(path, fileToSelect);
    setTabs([...tabs, tab]);
    switchToTab(tab.id);
  }

  function switchToLastOrNextTab() {
    const previousId = previousActiveTabIdRef.current;
    if (previousId && tabs.some((tab) => tab.id === previousId)) {
      switchToTab(previousId);
      return;
    }
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    const nextTab = tabs[(currentIndex + 1) % tabs.length];
    if (nextTab) switchToTab(nextTab.id);
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        addTab();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "w") {
        e.preventDefault();
        closeTab(activeTabId);
      } else if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        switchToLastOrNextTab();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, activeTabId]);

  return (
    <div className="explorer-tabs">
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab${tab.id === activeTabId ? " active" : ""}`}
            title={tab.title}
            onClick={() => switchToTab(tab.id)}
          >
            <button className="tab-button">{tab.title || t("newTab")}</button>
            {tabs.length > 1 && (
              <button
                className="tab-close"
                aria-label={t("closeTab")}
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="tab-add" title={t("newTab")} onClick={addTab}>
          +
        </button>
      </div>
      <div className="tab-panels">
        {tabs.map((tab) => (
          <ExplorerTab
            key={tab.id}
            active={tab.id === activeTabId}
            initialPath={tab.initialPath}
            initialFile={tab.initialFile}
            onPathChange={(path) => handleTabPathChange(tab.id, path)}
            onOpenInNewTab={openInNewTab}
            favorites={favorites}
            setFavorites={setFavorites}
            fileColors={fileColors}
            setFileColors={setFileColors}
            clipboard={clipboard}
            setClipboard={setClipboard}
          />
        ))}
      </div>
    </div>
  );
}

export default FileExplorer;
