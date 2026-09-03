import { cleanPiece, type Catalog, type PieceData, type PieceKind, type SlotValue } from "@planifold/shared";
import type { Db } from "../db/index.js";
import { now } from "../db/index.js";
import { toMessage, toPiece, toPlan, uuid, type HelperMessageRow, type Piece, type PieceRow, type Plan, type PlanRow } from "../db/models.js";

export function listPlans(db: Db, ownerId: string | null): Array<Plan & { pieceCount: number; ownerName?: string }> {
  const sql = `SELECT p.*, (SELECT COUNT(*) FROM pieces x WHERE x.plan_id = p.id) AS piece_count, u.name AS owner_name
               FROM plans p JOIN users u ON u.id = p.owner_id ${ownerId ? "WHERE p.owner_id = ?" : ""} ORDER BY p.updated_at DESC`;
  const rows = (ownerId ? db.prepare(sql).all(ownerId) : db.prepare(sql).all()) as Array<PlanRow & { piece_count: number; owner_name: string }>;
  return rows.map((r) => ({ ...toPlan(r), pieceCount: r.piece_count, ownerName: r.owner_name }));
}

export function getPlan(db: Db, id: string): Plan | undefined {
  const r = db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as PlanRow | undefined;
  return r ? toPlan(r) : undefined;
}

export function createPlan(db: Db, ownerId: string, input: { title: string; thought: string }): Plan {
  const id = uuid();
  const t = now();
  db.prepare("INSERT INTO plans (id, owner_id, title, thought, facts, status, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', 'draft', ?, ?)").run(id, ownerId, input.title, input.thought, t, t);
  return getPlan(db, id)!;
}

export function updatePlan(db: Db, id: string, patch: Partial<{ title: string; thought: string; facts: string[]; status: Plan["status"]; brief: string | null }>): Plan {
  const sets: string[] = ["updated_at = ?"];
  const args: unknown[] = [now()];
  if (patch.title !== undefined) (sets.push("title = ?"), args.push(patch.title));
  if (patch.thought !== undefined) (sets.push("thought = ?"), args.push(patch.thought));
  if (patch.facts !== undefined) (sets.push("facts = ?"), args.push(JSON.stringify(patch.facts)));
  if (patch.status !== undefined) (sets.push("status = ?"), args.push(patch.status));
  if (patch.brief !== undefined) (sets.push("brief = ?"), args.push(patch.brief));
  db.prepare(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return getPlan(db, id)!;
}

export function touchPlan(db: Db, id: string): void {
  db.prepare("UPDATE plans SET updated_at = ? WHERE id = ?").run(now(), id);
}

export function deletePlan(db: Db, id: string): void {
  db.prepare("DELETE FROM plans WHERE id = ?").run(id);
}

export function listPieces(db: Db, planId: string): Piece[] {
  return (db.prepare("SELECT * FROM pieces WHERE plan_id = ? ORDER BY position, created_at").all(planId) as PieceRow[]).map(toPiece);
}

export function getPiece(db: Db, planId: string, id: string): Piece | undefined {
  const r = db.prepare("SELECT * FROM pieces WHERE plan_id = ? AND id = ?").get(planId, id) as PieceRow | undefined;
  return r ? toPiece(r) : undefined;
}

export function asPieceData(p: Piece): PieceData {
  return { id: p.id, kind: p.kind, slots: p.slots, label: p.label, notes: p.notes, position: p.position };
}

export function insertPiece(db: Db, planId: string, input: { kind: PieceKind; slots?: Record<string, SlotValue>; label?: string | null; notes?: string | null; position?: number }): Piece {
  const id = uuid();
  const t = now();
  const position = input.position ?? ((db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM pieces WHERE plan_id = ?").get(planId) as { p: number }).p);
  db.prepare("INSERT INTO pieces (id, plan_id, kind, position, slots, label, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    planId,
    input.kind,
    position,
    JSON.stringify(input.slots ?? {}),
    input.label ?? null,
    input.notes ?? null,
    t,
    t,
  );
  touchPlan(db, planId);
  return getPiece(db, planId, id)!;
}

export function savePiece(db: Db, planId: string, id: string, patch: Partial<{ slots: Record<string, SlotValue>; label: string | null; notes: string | null; position: number }>): Piece {
  const sets: string[] = ["updated_at = ?"];
  const args: unknown[] = [now()];
  if (patch.slots !== undefined) (sets.push("slots = ?"), args.push(JSON.stringify(patch.slots)));
  if (patch.label !== undefined) (sets.push("label = ?"), args.push(patch.label));
  if (patch.notes !== undefined) (sets.push("notes = ?"), args.push(patch.notes));
  if (patch.position !== undefined) (sets.push("position = ?"), args.push(patch.position));
  db.prepare(`UPDATE pieces SET ${sets.join(", ")} WHERE plan_id = ? AND id = ?`).run(...args, planId, id);
  touchPlan(db, planId);
  return getPiece(db, planId, id)!;
}

export function deletePiece(db: Db, planId: string, id: string): void {
  db.prepare("DELETE FROM pieces WHERE plan_id = ? AND id = ?").run(planId, id);
  touchPlan(db, planId);
}

/**
 * Runs every piece of a plan through the grammar and persists any that
 * carried stale slots (after a delete, a plugin change, or a reorder).
 * Repeats until nothing changes, because one pruned reference can invalidate
 * a piece further downstream. Returns the cleaned pieces.
 */
export function reconcilePlan(db: Db, planId: string, catalog: Catalog): Piece[] {
  let pieces = listPieces(db, planId);
  const tx = db.transaction(() => {
    for (let pass = 0; pass < 8; pass++) {
      const ctx = { catalog, pieces: pieces.map(asPieceData) };
      let changed = false;
      const next: Piece[] = [];
      for (const p of pieces) {
        const { piece: cleaned } = cleanPiece(asPieceData(p), ctx);
        if (JSON.stringify(cleaned.slots) !== JSON.stringify(p.slots)) {
          changed = true;
          next.push(savePiece(db, planId, p.id, { slots: cleaned.slots }));
        } else next.push(p);
      }
      pieces = next;
      if (!changed) break;
    }
  });
  tx();
  return pieces;
}

export function listMessages(db: Db, planId: string, limit = 200) {
  return (db.prepare("SELECT * FROM helper_messages WHERE plan_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(planId, limit) as HelperMessageRow[]).reverse().map(toMessage);
}

export function addMessage(db: Db, planId: string, role: "user" | "assistant", content: string, payload?: unknown) {
  const id = uuid();
  db.prepare("INSERT INTO helper_messages (id, plan_id, role, content, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, planId, role, content, payload === undefined ? null : JSON.stringify(payload), now());
  return id;
}

export function clearMessages(db: Db, planId: string): void {
  db.prepare("DELETE FROM helper_messages WHERE plan_id = ?").run(planId);
}
