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
import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
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
  const [selectedFile, setSelectedFile] = useState<DirEntryInfo | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
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
  const [extensionFilter, setExtensionFilter] = useState("");
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
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

  function directoryMenuFor(path: string, colorPaths: string[]): ContextMenuItem[] {
    return [
      { label: t("openInNewTab"), onClick: () => onOpenInNewTab(path) },
      ...favoriteMenuFor(path),
      {
        label: t(expandedDirectories.has(path) ? "hideFolderContents" : "showFolderContents"),
        onClick: () => toggleDirectoryTree(path),
      },
      ...colorMenuFor(colorPaths),
    ];
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
    return [...items, ...colorMenuFor(colorPaths)];
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
    const query = searchQuery.trim().toLowerCase();
    const extension = extensionFilter.trim().replace(/^\.+/, "").toLowerCase();
    const filtered = entries.filter((entry) => {
      if (typeFilter === "folders" && !entry.is_dir) return false;
      if (typeFilter === "files" && entry.is_dir) return false;
      if (query && !entry.name.toLowerCase().includes(query)) return false;
      if (extension && (entry.is_dir || extensionOf(entry.name) !== extension)) return false;
      return true;
    });
    return [...filtered].sort((a, b) => compareEntries(a, b, sortKey, sortDir));
  }, [entries, searchQuery, extensionFilter, typeFilter, sortKey, sortDir]);

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
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        goUp();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentPath, active, flatOrder]);

  async function loadDirectory(
    path: string,
    options?: { silent?: boolean },
  ): Promise<DirEntryInfo[] | undefined> {
    directorySummaryRequest.current += 1;
    setLoading(true);
    if (!options?.silent) setError(null);
    setSelectedPaths([]);
    selectionAnchorRef.current = null;
    setSelectedFile(null);
    setFileContent(null);
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
                  className="favorite-dropdown-item"
                  title={item.path}
                  draggable
                  onDragStart={(e) => startDraggingFolder(e, item.path)}
                  onDragEnd={endDraggingFavorite}
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

  function renderFileListContents() {
    return (
      <>
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
    return (
      <li
        className={`tree-node${blockView && depth === 0 && entry.is_dir && expanded ? " expanded-tree-node" : ""}`}
        key={entry.path}
      >
        <div
          className={`tree-entry-row${blockView && depth === 0 && !expanded ? " tree-block-tile" : ""}${blockView && (expanded || depth > 0) ? " tree-compact-row" : ""}${selectedPaths.includes(entry.path) ? " selected" : ""}`}
          draggable={entry.is_dir}
          onDragStart={(e) => startDraggingFolder(e, entry.path)}
          onDragEnd={endDraggingFavorite}
          onClick={(e) => {
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
              openContextMenu(e, directoryMenuFor(entry.path, colorPaths));
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
          <span className="name">{entry.name}</span>
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
            src={`${pdfPreviewUrl}#toolbar=0&navpanes=0&scrollbar=0`}
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

    return (
      <>
        <h3>{selectedFile.name}</h3>
        {fileContent !== null ? (
          <pre>{fileContent}</pre>
        ) : (
          <p className="hint">{t("noPreviewHint")}</p>
        )}
      </>
    );
  }

  function renderFullscreenContent() {
    if (pdfPreviewUrl) {
      return (
        <embed
          className="preview-fullscreen-embed"
          src={`${pdfPreviewUrl}#toolbar=0&navpanes=0&scrollbar=0`}
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
      return <pre className="preview-fullscreen-text">{fileContent}</pre>;
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
              className="favorite-chip"
              title={entry.path}
              draggable
              onDragStart={(e) => startDraggingFolder(e, entry.path)}
              onDragEnd={endDraggingFavorite}
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
            </div>
          )}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      <div className="panes">
        <div className={`file-list view-${viewMode}`}>
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
          />
        ))}
      </div>
    </div>
  );
}

export default FileExplorer;
