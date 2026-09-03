import type { Catalog } from "./catalog.js";
import { findIntegration, findOperation } from "./catalog.js";
import { optionId } from "./grammar/context.js";
import { analyzePlan } from "./grammar/plan.js";
import { PIECE_KIND_LABEL, PIECE_KINDS, type PieceData, type PlanData } from "./types.js";

export interface HandoffOptions {
  orgGuidance?: string | null;
  preferredBuilder?: string | null;
  brief?: string | null;
  author?: string | null;
  generatedAt?: Date;
}

export interface HandoffPiece {
  id: string;
  kind: PieceData["kind"];
  number: string;
  label: string;
  sentence: string;
  status: string;
  notes: string | null;
  looseEnds: string[];
  dependsOn: string[];
  ai: boolean;
}

export interface HandoffDocument {
  plan: { id: string; title: string; thought: string; facts: string[]; status: string };
  pieces: HandoffPiece[];
  edges: Array<{ from: string; to: string }>;
  integrations: Array<{ id: string; name: string; guidance?: string; setupNotes?: string }>;
  guidance: { organization: string | null; preferredBuilder: string | null };
  brief: string | null;
  generatedAt: string;
}

export function buildHandoff(plan: PlanData, pieces: PieceData[], catalog: Catalog, opts: HandoffOptions = {}): HandoffDocument {
  const analysis = analyzePlan(pieces, catalog);
  const ordered = [...pieces].sort((a, b) => a.position - b.position);
  const numbers = new Map<string, string>();
  for (const kind of PIECE_KINDS) {
    let n = 0;
    for (const p of ordered) if (p.kind === kind) numbers.set(p.id, `${PIECE_KIND_LABEL[kind].singular} ${++n}`);
  }
  const usedIntegrations = new Map<string, { id: string; name: string; guidance?: string; setupNotes?: string }>();
  const hp: HandoffPiece[] = ordered.map((p) => {
    const s = analysis.sentences[p.id]!;
    if (p.kind !== "transform") {
      const integ = findIntegration(catalog, optionId(p, "integration"));
      if (integ) usedIntegrations.set(integ.id, { id: integ.id, name: integ.name, guidance: integ.guidance, setupNotes: integ.setupNotes });
    } else {
      const op = findOperation(catalog, optionId(p, "operation"));
      const g = op ? catalog.transformGuidance[op.pluginId] : undefined;
      if (op && g) usedIntegrations.set(`transforms:${op.pluginId}`, { id: op.pluginId, name: "Transformations", guidance: g });
    }
    return {
      id: p.id,
      kind: p.kind,
      number: numbers.get(p.id)!,
      label: s.label,
      sentence: s.text,
      status: s.status,
      notes: p.notes?.trim() || null,
      looseEnds: s.unsure.map((u) => (u.note ? `${u.placeholder}: ${u.note}` : u.placeholder)),
      dependsOn: s.refs.map((r) => numbers.get(r) ?? r),
      ai: s.ai,
    };
  });
  return {
    plan: { id: plan.id, title: plan.title, thought: plan.thought, facts: plan.facts, status: plan.status },
    pieces: hp,
    edges: analysis.edges,
    integrations: [...usedIntegrations.values()],
    guidance: { organization: opts.orgGuidance?.trim() || null, preferredBuilder: opts.preferredBuilder?.trim() || null },
    brief: opts.brief?.trim() || null,
    generatedAt: (opts.generatedAt ?? new Date()).toISOString(),
  };
}

export function renderHandoffMarkdown(doc: HandoffDocument): string {
  const L: string[] = [];
  L.push(`# ${doc.plan.title}`);
  L.push("");
  L.push(`> **The thought:** ${doc.plan.thought.trim() || "(not written down)"}`);
  L.push("");
  L.push(`Status: ${doc.plan.status.replace("_", " ")} · Generated ${doc.generatedAt.slice(0, 10)} with Planifold`);
  L.push("");
  if (doc.plan.facts.length) {
    L.push("## Things to remember");
    L.push("");
    for (const f of doc.plan.facts) L.push(`- ${f}`);
    L.push("");
  }
  for (const kind of PIECE_KINDS) {
    const ps = doc.pieces.filter((p) => p.kind === kind);
    L.push(`## ${PIECE_KIND_LABEL[kind].plural}`);
    L.push("");
    if (!ps.length) {
      L.push(`_None yet._`);
      L.push("");
      continue;
    }
    for (const p of ps) {
      L.push(`### ${p.number} · ${p.label}${p.ai ? " · AI step" : ""}`);
      L.push("");
      L.push(p.sentence);
      L.push("");
      if (p.dependsOn.length) L.push(`Reads from: ${p.dependsOn.join(", ")}`);
      if (p.status !== "complete") L.push(`Status: ${p.status}`);
      if (p.notes) {
        L.push("");
        L.push(`Notes: ${p.notes}`);
      }
      if (p.looseEnds.length) {
        L.push("");
        L.push("Loose ends:");
        for (const le of p.looseEnds) L.push(`- ${le}`);
      }
      L.push("");
    }
  }
  const allLoose = doc.pieces.flatMap((p) => p.looseEnds.map((le) => `${p.number}: ${le}`));
  if (allLoose.length) {
    L.push("## Loose ends");
    L.push("");
    for (const le of allLoose) L.push(`- ${le}`);
    L.push("");
  }
  const hasGuidance = doc.guidance.organization || doc.guidance.preferredBuilder || doc.integrations.some((i) => i.guidance || i.setupNotes);
  if (hasGuidance) {
    L.push("## How this should be built");
    L.push("");
    if (doc.guidance.preferredBuilder) L.push(`Preferred builder: ${doc.guidance.preferredBuilder}`);
    if (doc.guidance.organization) {
      L.push("");
      L.push(doc.guidance.organization);
    }
    for (const i of doc.integrations) {
      if (!i.guidance && !i.setupNotes) continue;
      L.push("");
      L.push(`**${i.name}**`);
      if (i.guidance) L.push(i.guidance);
      if (i.setupNotes) L.push(`Access: ${i.setupNotes}`);
    }
    L.push("");
  }
  if (doc.brief) {
    L.push("## Build brief");
    L.push("");
    L.push(doc.brief);
    L.push("");
  }
  return L.join("\n").trimEnd() + "\n";
}
