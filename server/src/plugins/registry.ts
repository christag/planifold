/**
 * Loads plugin manifests from disk and merges administrator settings into a
 * catalog. Built-in plugins ship with the app; extra plugins come from
 * PLUGINS_DIR. A plugin directory holds `plugin.json` and, optionally, a README.
 */
import { buildCatalog, safeParseManifest, type Catalog, type PluginManifest, type PluginOverrides } from "@planifold/shared";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import { now, parseJson } from "../db/index.js";
import type { PluginSettingsRow } from "../db/models.js";

export interface LoadedPlugin {
  manifest: PluginManifest;
  source: "builtin" | "installed";
  dir: string;
  readme: string | null;
}

export interface PluginProblem {
  dir: string;
  errors: string[];
}

export class PluginRegistry {
  plugins = new Map<string, LoadedPlugin>();
  problems: PluginProblem[] = [];
  private catalogCache: Catalog | null = null;

  constructor(
    private db: Db,
    private dirs: Array<{ path: string | undefined; source: "builtin" | "installed" }>,
    private log: (msg: string) => void = () => {},
  ) {}

  load(): void {
    this.plugins.clear();
    this.problems = [];
    for (const { path, source } of this.dirs) {
      if (!path || !existsSync(path)) continue;
      for (const name of readdirSync(path).sort()) {
        const dir = join(path, name);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch (e) {
          this.problems.push({ dir, errors: [`cannot read: ${(e as Error).message}`] });
          continue;
        }
        const file = join(dir, "plugin.json");
        if (!existsSync(file)) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(file, "utf8"));
        } catch (e) {
          this.problems.push({ dir, errors: [`plugin.json is not valid JSON: ${(e as Error).message}`] });
          continue;
        }
        const r = safeParseManifest(raw);
        if (!r.ok) {
          this.problems.push({ dir, errors: r.errors });
          continue;
        }
        if (r.manifest.id !== name) {
          this.problems.push({ dir, errors: [`manifest id "${r.manifest.id}" must match the directory name "${name}"`] });
          continue;
        }
        const readmeFile = join(dir, "README.md");
        this.plugins.set(r.manifest.id, { manifest: r.manifest, source, dir, readme: existsSync(readmeFile) ? readFileSync(readmeFile, "utf8") : null });
      }
    }
    this.log(`loaded ${this.plugins.size} plugins${this.problems.length ? `, ${this.problems.length} with problems` : ""}`);
    this.invalidate();
  }

  invalidate(): void {
    this.catalogCache = null;
  }

  settings(): Map<string, PluginSettingsRow> {
    const rows = this.db.prepare("SELECT * FROM plugin_settings").all() as PluginSettingsRow[];
    return new Map(rows.map((r) => [r.plugin_id, r]));
  }

  overridesFor(row: PluginSettingsRow | undefined): PluginOverrides {
    if (!row) return {};
    const ov = parseJson<PluginOverrides>(row.overrides, {});
    return { ...ov, enabled: !!row.enabled, guidance: row.guidance, setupNotes: row.setup_notes };
  }

  /** The catalog every user sees: enabled plugins with overrides applied. */
  catalog(): Catalog {
    if (this.catalogCache) return this.catalogCache;
    const settings = this.settings();
    const overrides: Record<string, PluginOverrides> = {};
    for (const [id, row] of settings) overrides[id] = this.overridesFor(row);
    this.catalogCache = buildCatalog([...this.plugins.values()].map((p) => p.manifest), overrides);
    return this.catalogCache;
  }

  updateSettings(pluginId: string, patch: Partial<{ enabled: boolean; ownerId: string | null; guidance: string | null; setupNotes: string | null; overrides: PluginOverrides }>): PluginSettingsRow {
    const existing = this.settings().get(pluginId);
    const next: PluginSettingsRow = {
      plugin_id: pluginId,
      enabled: (patch.enabled ?? (existing ? !!existing.enabled : true)) ? 1 : 0,
      owner_id: patch.ownerId !== undefined ? patch.ownerId : (existing?.owner_id ?? null),
      guidance: patch.guidance !== undefined ? patch.guidance : (existing?.guidance ?? null),
      setup_notes: patch.setupNotes !== undefined ? patch.setupNotes : (existing?.setup_notes ?? null),
      overrides: JSON.stringify(patch.overrides ?? parseJson<PluginOverrides>(existing?.overrides, {})),
      updated_at: now(),
    };
    this.db
      .prepare(
        `INSERT INTO plugin_settings (plugin_id, enabled, owner_id, guidance, setup_notes, overrides, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET enabled = excluded.enabled, owner_id = excluded.owner_id, guidance = excluded.guidance, setup_notes = excluded.setup_notes, overrides = excluded.overrides, updated_at = excluded.updated_at`,
      )
      .run(next.plugin_id, next.enabled, next.owner_id, next.guidance, next.setup_notes, next.overrides, next.updated_at);
    this.invalidate();
    return next;
  }
}
