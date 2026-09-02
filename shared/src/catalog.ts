/**
 * The catalog is what the grammar engine reads: every enabled integration
 * and operation, with administrator overrides already applied.
 */
import type { ActionDef, Field, ObjectDef, OperationDef, Param, PluginManifest } from "./manifest.js";

export interface PluginOverrides {
  enabled?: boolean;
  disabledObjects?: string[];
  disabledActions?: string[];
  disabledOperations?: string[];
  /** Organization-specific instruction for the AI helper. Replaces the manifest default. */
  guidance?: string | null;
  /** How to get access, who owns it, gotchas. Shown to people and to the helper. */
  setupNotes?: string | null;
}

export interface CatalogObject {
  id: string;
  label: string;
  singular: string;
  description?: string;
  fields: Field[];
  allowCustomFields: boolean;
  filterable: boolean;
  timeField?: string;
  qualifier?: ObjectDef["qualifier"];
}

export interface CatalogAction {
  id: string;
  label: string;
  description?: string;
  pattern: "send" | "create";
  verb: string;
  params: Param[];
  source: "required" | "optional" | "none";
}

export interface CatalogIntegration {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  website?: string;
  roles: Array<"input" | "output">;
  objects: CatalogObject[];
  actions: CatalogAction[];
  guidance?: string;
  setupNotes?: string;
}

export interface CatalogOperation extends Omit<OperationDef, "ai" | "params"> {
  pluginId: string;
  ai: boolean;
  params: Param[];
}

export interface Catalog {
  integrations: CatalogIntegration[];
  operations: CatalogOperation[];
  /** Guidance for transform plugins, keyed by plugin id. */
  transformGuidance: Record<string, string>;
}

function toObject(o: ObjectDef): CatalogObject {
  return {
    id: o.id,
    label: o.label,
    singular: o.singular,
    description: o.description,
    fields: o.fields,
    allowCustomFields: o.allowCustomFields ?? o.fields.length === 0,
    filterable: o.filterable ?? true,
    timeField: o.timeField,
    qualifier: o.qualifier,
  };
}

function toAction(a: ActionDef): CatalogAction {
  return {
    id: a.id,
    label: a.label,
    description: a.description,
    pattern: a.pattern,
    verb: a.verb ?? (a.pattern === "create" ? "Create" : "Send"),
    params: a.params,
    source: a.source,
  };
}

export function buildCatalog(manifests: PluginManifest[], overrides: Record<string, PluginOverrides> = {}): Catalog {
  const integrations: CatalogIntegration[] = [];
  const operations: CatalogOperation[] = [];
  const transformGuidance: Record<string, string> = {};

  for (const m of manifests) {
    const ov = overrides[m.id] ?? {};
    if (ov.enabled === false) continue;
    const guidance = ov.guidance?.trim() || m.guidance?.trim() || undefined;
    if (m.kind === "integration") {
      const disabledObjects = new Set(ov.disabledObjects ?? []);
      const disabledActions = new Set(ov.disabledActions ?? []);
      const objects = (m.objects ?? []).filter((o) => !disabledObjects.has(o.id)).map(toObject);
      const actions = (m.actions ?? []).filter((a) => !disabledActions.has(a.id)).map(toAction);
      const roles = (m.roles ?? []).filter((r) => (r === "input" ? objects.length > 0 : actions.length > 0));
      if (roles.length === 0) continue;
      integrations.push({
        id: m.id,
        name: m.name,
        description: m.description,
        category: m.category ?? "Other",
        icon: m.icon ?? m.name.slice(0, 1).toUpperCase(),
        website: m.website,
        roles,
        objects,
        actions,
        guidance,
        setupNotes: ov.setupNotes?.trim() || m.setup?.notes?.trim() || undefined,
      });
    } else {
      const disabled = new Set(ov.disabledOperations ?? []);
      for (const op of m.operations ?? []) {
        if (disabled.has(op.id)) continue;
        operations.push({ ...op, pluginId: m.id, ai: op.ai ?? false, params: op.params });
      }
      if (guidance) transformGuidance[m.id] = guidance;
    }
  }

  integrations.sort((a, b) => a.name.localeCompare(b.name));
  return { integrations, operations, transformGuidance };
}

export function findIntegration(catalog: Catalog, id: string | undefined): CatalogIntegration | undefined {
  return id ? catalog.integrations.find((i) => i.id === id) : undefined;
}

export function findOperation(catalog: Catalog, id: string | undefined): CatalogOperation | undefined {
  return id ? catalog.operations.find((o) => o.id === id) : undefined;
}
