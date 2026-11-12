export type Category =
  | "folder"
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "audio"
  | "video"
  | "archive"
  | "code"
  | "text"
  | "other";

export const CATEGORY_ORDER: Category[] = [
  "folder",
  "image",
  "document",
  "spreadsheet",
  "presentation",
  "audio",
  "video",
  "archive",
  "code",
  "text",
  "other",
];

const CATEGORY_EXTENSIONS: Record<Exclude<Category, "folder" | "other">, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff"],
  document: ["pdf", "doc", "docx", "odt", "rtf"],
  spreadsheet: ["xls", "xlsx", "csv", "ods"],
  presentation: ["ppt", "pptx", "odp"],
  audio: ["mp3", "wav", "flac", "ogg", "m4a", "aac"],
  video: ["mp4", "mkv", "avi", "mov", "webm", "flv"],
  archive: ["zip", "rar", "7z", "tar", "gz", "bz2"],
  code: [
    "js", "jsx", "ts", "tsx", "rs", "py", "java", "c", "cpp", "h",
    "go", "rb", "php", "json", "html", "css", "sh", "yml", "yaml", "toml", "xml",
  ],
  text: ["txt", "md", "log"],
};

const EXTENSION_TO_CATEGORY = new Map<string, Category>();
for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
  for (const ext of extensions) {
    EXTENSION_TO_CATEGORY.set(ext, category as Category);
  }
}

export const CATEGORY_ICONS: Record<Category, string> = {
  folder: "📁",
  image: "🖼️",
  document: "📕",
  spreadsheet: "📊",
  presentation: "📙",
  audio: "🎵",
  video: "🎬",
  archive: "🗜️",
  code: "💻",
  text: "📝",
  other: "📄",
};

export function categoryOf(isDir: boolean, extension: string): Category {
  if (isDir) return "folder";
  return EXTENSION_TO_CATEGORY.get(extension) ?? "other";
}

export function iconFor(isDir: boolean, extension: string): string {
  return CATEGORY_ICONS[categoryOf(isDir, extension)];
}
