export type FileColorId = "red" | "yellow" | "green" | "blue" | "purple";

export type FileColorDef = {
  id: FileColorId;
  hex: string;
};

export const FILE_COLORS: FileColorDef[] = [
  { id: "red", hex: "#e5484d" },
  { id: "yellow", hex: "#f5b800" },
  { id: "green", hex: "#30a46c" },
  { id: "blue", hex: "#0091ff" },
  { id: "purple", hex: "#8e4ec6" },
];

export type FileColors = Record<string, FileColorId>;

export function colorHexFor(id: FileColorId | undefined): string | undefined {
  return FILE_COLORS.find((color) => color.id === id)?.hex;
}

export function setFileColor(colors: FileColors, path: string, colorId: FileColorId): FileColors {
  return { ...colors, [path]: colorId };
}

export function removeFileColor(colors: FileColors, path: string): FileColors {
  if (!(path in colors)) return colors;
  const next = { ...colors };
  delete next[path];
  return next;
}
