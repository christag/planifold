import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, parseManifest, type Catalog, type PieceData, type PieceKind, type SlotValue } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const pluginsDir = join(here, "..", "..", "plugins");

export function loadCatalog(ids = ["gmail", "monday", "google-sheets", "report", "core-transforms"]): Catalog {
  const manifests = ids.map((id) => parseManifest(JSON.parse(readFileSync(join(pluginsDir, id, "plugin.json"), "utf8"))));
  return buildCatalog(manifests);
}

let n = 0;
export function piece(kind: PieceKind, slots: Record<string, SlotValue> = {}, extra: Partial<PieceData> = {}): PieceData {
  n++;
  return { id: extra.id ?? `${kind}-${n}`, kind, slots, position: extra.position ?? n, label: extra.label ?? null, notes: extra.notes ?? null };
}

export const opt = (id: string): SlotValue => ({ kind: "option", id });
export const txt = (text: string): SlotValue => ({ kind: "text", text });
export const ref = (pieceId: string): SlotValue => ({ kind: "ref", pieceId });
export const unsure = (note?: string): SlotValue => ({ kind: "unsure", note });
