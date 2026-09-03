import { PIECE_KIND_LABEL, type PieceKind } from "@planifold/shared";
import { Background, Controls, Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import { usePlan } from "../lib/planStore.js";
import { Check } from "../ui/icons.js";

type PieceNodeData = { pieceId: string; kind: PieceKind; number: string; label: string; text: string; status: string; ai: boolean };
type PieceNode = Node<PieceNodeData, "piece">;

function PieceNodeView({ data, selected }: NodeProps<PieceNode>) {
  return (
    <div className={`map-node kind-${data.kind}${selected ? " selected" : ""}`}>
      {data.kind !== "input" && <Handle type="target" position={Position.Left} />}
      <div className="row" style={{ gap: 6 }}>
        <span className="kind-dot" />
        <span className="eyebrow" style={{ color: "var(--kind)" }}>
          {PIECE_KIND_LABEL[data.kind].singular} {data.number}
        </span>
        <span className={`status-dot ${data.status}`} style={{ marginLeft: "auto" }} title={data.status} />
      </div>
      <div className="map-node-label">{data.label}</div>
      <div className="map-node-text serif">{data.text}</div>
      {data.status === "complete" && (
        <div className="tiny" style={{ color: "var(--ok)", display: "flex", alignItems: "center", gap: 4 }}>
          <Check /> complete
        </div>
      )}
      {data.kind !== "output" && <Handle type="source" position={Position.Right} />}
    </div>
  );
}

const nodeTypes = { piece: PieceNodeView };
const COL: Record<PieceKind, number> = { input: 0, transform: 1, output: 2 };

/** The whole plan as a graph. Read-only on purpose: editing happens one piece at a time. */
export function MapView() {
  const pieces = usePlan((s) => s.pieces);
  const analysis = usePlan((s) => s.analysis);
  const focus = usePlan((s) => s.focus);
  const focusId = usePlan((s) => s.focusId);

  const { nodes, edges } = useMemo(() => {
    const ordered = [...pieces].sort((a, b) => a.position - b.position);
    const rows: Record<PieceKind, number> = { input: 0, transform: 0, output: 0 };
    const counts: Record<PieceKind, number> = { input: 0, transform: 0, output: 0 };
    const nodes: PieceNode[] = ordered.map((p) => {
      const s = analysis?.sentences[p.id];
      const row = rows[p.kind]++;
      const n = ++counts[p.kind];
      return {
        id: p.id,
        type: "piece",
        position: { x: COL[p.kind] * 340, y: row * 170 },
        selected: p.id === focusId,
        data: { pieceId: p.id, kind: p.kind, number: String(n), label: s?.label ?? "", text: s?.text ?? "", status: s?.status ?? "empty", ai: s?.ai ?? false },
      };
    });
    const edges: Edge[] = (analysis?.edges ?? []).map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to, type: "smoothstep" }));
    return { nodes, edges };
  }, [pieces, analysis, focusId]);

  if (pieces.length === 0)
    return (
      <div className="map-empty">
        <p className="muted">Add pieces to see how they connect.</p>
      </div>
    );

  return (
    <div className="map">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => focus(node.id)}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="map-legend">
        {(["input", "transform", "output"] as PieceKind[]).map((k) => (
          <span key={k} className={`row kind-${k} tiny muted`}>
            <span className="kind-dot" /> {PIECE_KIND_LABEL[k].plural}
          </span>
        ))}
        <span className="tiny faint">Click a piece to edit it.</span>
      </div>
    </div>
  );
}
