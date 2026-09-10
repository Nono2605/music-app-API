const COMBINING_MARKS = /[̀-ͯ]/g;

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

// Suffixe pour retenter un slug après une collision unique (23505).
export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}
