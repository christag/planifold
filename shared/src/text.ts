import type { Token } from "./types.js";

const NO_SPACE_BEFORE = new Set([".", ",", ";", ":", "?", "!"]);

/** Joins tokens into readable prose. Blanks render as [placeholder]. */
export function tokensToText(tokens: Token[], opts: { blank?: (placeholder: string, optional: boolean) => string } = {}): string {
  const blank = opts.blank ?? ((p, optional) => (optional ? "" : `[${p}]`));
  const parts: string[] = [];
  for (const t of tokens) {
    let s: string;
    if (t.type === "text") s = t.text;
    else if (t.display !== null && t.value) {
      s = t.value.kind === "text" ? `“${t.display}”` : t.display;
      if (t.value.kind === "text" && t.spec.textPrefix) s = `${t.spec.textPrefix} ${s}`;
    } else if (t.value?.kind === "unsure") s = `[not sure yet: ${t.spec.placeholder}]`;
    else s = blank(t.spec.placeholder, !!t.spec.optional);
    if (!s) continue;
    parts.push(s);
  }
  let out = "";
  for (const p of parts) {
    if (out && !NO_SPACE_BEFORE.has(p.slice(0, 1))) out += " ";
    out += p;
  }
  return out;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1") || "value";
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}
