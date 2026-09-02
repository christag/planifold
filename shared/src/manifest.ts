/**
 * Plugin manifest schema.
 *
 * A plugin is a directory containing `plugin.json`. Integration plugins
 * describe the objects you can read (inputs) and the actions you can take
 * (outputs) in an upstream or downstream system. Transform plugins describe
 * operations that change data on its way through.
 *
 * Manifests are declarative on purpose: an integration administrator can
 * write one without touching code, and the grammar engine can build every
 * sentence from it.
 */
import { z } from "zod";

const slug = z.string().regex(/^[a-z][a-z0-9_]*$/, "use lowercase letters, digits and underscores");

export const FieldTypeSchema = z.enum([
  "string",
  "text",
  "number",
  "date",
  "datetime",
  "boolean",
  "enum",
  "person",
  "email",
  "url",
  "attachment",
]);
export type FieldType = z.infer<typeof FieldTypeSchema>;

export const FieldSchema = z.object({
  id: slug,
  label: z.string().min(1),
  type: FieldTypeSchema,
  values: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type Field = z.infer<typeof FieldSchema>;

export const ParamTypeSchema = z.enum([
  "text",
  "number",
  "date",
  "enum",
  "field",
  "fields",
  "texts",
  "condition",
  "ref",
  "ref-or-text",
]);
export type ParamType = z.infer<typeof ParamTypeSchema>;

export const ParamSchema = z.object({
  id: slug,
  /** Words that come right before the blank, e.g. "to" or "in the channel". */
  label: z.string(),
  type: ParamTypeSchema,
  placeholder: z.string().optional(),
  values: z.array(z.string()).optional(),
  optional: z.boolean().optional(),
  /** Words that follow the value once it is filled. */
  suffix: z.string().optional(),
  /** How a referenced piece reads in this position, e.g. "each person in {piece}". */
  refLabel: z.string().optional(),
  description: z.string().optional(),
});
export type Param = z.infer<typeof ParamSchema>;

export const QualifierSchema = z.object({
  label: z.string(),
  placeholder: z.string(),
  values: z.array(z.string()).optional(),
});

export const ObjectSchema = z.object({
  id: slug,
  /** Plural, lowercase: "emails", "items". */
  label: z.string().min(1),
  singular: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(FieldSchema).default([]),
  /** Let people type a field name that is not in the list (spreadsheets, databases). */
  allowCustomFields: z.boolean().optional(),
  filterable: z.boolean().optional(),
  /** Field id that makes "from the last 7 days" meaningful. */
  timeField: z.string().optional(),
  /** A container the object lives in: "in the spreadsheet ___". */
  qualifier: QualifierSchema.optional(),
});
export type ObjectDef = z.infer<typeof ObjectSchema>;

export const ActionSchema = z.object({
  id: slug,
  /** Noun phrase: "an email", "a new item", "new rows". */
  label: z.string().min(1),
  description: z.string().optional(),
  /** "send": Send {source} to {system} as {action}. "create": Create {action} in {system} from {source}. */
  pattern: z.enum(["send", "create"]).default("send"),
  verb: z.string().optional(),
  params: z.array(ParamSchema).default([]),
  source: z.enum(["required", "optional", "none"]).default("required"),
});
export type ActionDef = z.infer<typeof ActionSchema>;

export const ResultFieldsSchema = z.object({
  mode: z.enum(["same", "none", "replace", "extend"]).default("same"),
  fields: z.array(FieldSchema).optional(),
  /** A `texts` param whose entries become string fields of the result. */
  fromParam: z.string().optional(),
  /** A `texts` param whose entries become the values of a new enum field. */
  enumFromParam: z.object({ param: z.string(), fieldId: slug, label: z.string() }).optional(),
  /** A `ref` param whose piece's fields are appended to the result. */
  withRef: z.string().optional(),
  /** A `fields` param: only the chosen fields survive. */
  pickFromParam: z.string().optional(),
});

export const OperationSchema = z.object({
  id: slug,
  /** Verb phrase that follows "Take X and": "summarize each one". */
  label: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  params: z.array(ParamSchema).default([]),
  /** Marks a step that needs an LLM when it is built. */
  ai: z.boolean().optional(),
  result: z.object({
    /** Label template for the result: "summaries of {source}". */
    label: z.string().min(1),
    fields: ResultFieldsSchema.optional(),
  }),
});
export type OperationDef = z.infer<typeof OperationSchema>;

export const PluginManifestSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes"),
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    category: z.string().optional(),
    /** A short emoji or 1-2 letter mark. */
    icon: z.string().optional(),
    website: z.string().optional(),
    kind: z.enum(["integration", "transforms"]).default("integration"),
    roles: z.array(z.enum(["input", "output"])).optional(),
    objects: z.array(ObjectSchema).optional(),
    actions: z.array(ActionSchema).optional(),
    operations: z.array(OperationSchema).optional(),
    /** Default instruction for the AI helper about how this system is normally used. */
    guidance: z.string().optional(),
    setup: z
      .object({
        notes: z.string().optional(),
        docsUrl: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((m, ctx) => {
    if (m.kind === "integration") {
      const roles = m.roles ?? [];
      if (roles.length === 0) ctx.addIssue({ code: "custom", message: "integration plugins need at least one role", path: ["roles"] });
      if (roles.includes("input") && !(m.objects && m.objects.length)) ctx.addIssue({ code: "custom", message: "input role needs objects", path: ["objects"] });
      if (roles.includes("output") && !(m.actions && m.actions.length)) ctx.addIssue({ code: "custom", message: "output role needs actions", path: ["actions"] });
      const ids = new Set<string>();
      for (const o of m.objects ?? []) {
        if (ids.has(o.id)) ctx.addIssue({ code: "custom", message: `duplicate object id ${o.id}`, path: ["objects"] });
        ids.add(o.id);
        if (o.timeField && !o.fields.some((f) => f.id === o.timeField)) ctx.addIssue({ code: "custom", message: `timeField ${o.timeField} is not a field of ${o.id}`, path: ["objects"] });
        for (const f of o.fields) if (f.type === "enum" && !(f.values && f.values.length)) ctx.addIssue({ code: "custom", message: `enum field ${f.id} needs values`, path: ["objects"] });
      }
      const aids = new Set<string>();
      for (const a of m.actions ?? []) {
        if (aids.has(a.id)) ctx.addIssue({ code: "custom", message: `duplicate action id ${a.id}`, path: ["actions"] });
        aids.add(a.id);
      }
    } else {
      if (!(m.operations && m.operations.length)) ctx.addIssue({ code: "custom", message: "transform plugins need operations", path: ["operations"] });
      const ids = new Set<string>();
      for (const o of m.operations ?? []) {
        if (ids.has(o.id)) ctx.addIssue({ code: "custom", message: `duplicate operation id ${o.id}`, path: ["operations"] });
        ids.add(o.id);
        for (const p of o.params) if (p.type === "enum" && !(p.values && p.values.length)) ctx.addIssue({ code: "custom", message: `enum param ${p.id} needs values`, path: ["operations"] });
      }
    }
  });

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export function parseManifest(raw: unknown): PluginManifest {
  return PluginManifestSchema.parse(raw);
}

export function safeParseManifest(raw: unknown): { ok: true; manifest: PluginManifest } | { ok: false; errors: string[] } {
  const r = PluginManifestSchema.safeParse(raw);
  if (r.success) return { ok: true, manifest: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
