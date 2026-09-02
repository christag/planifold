import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, createUserAs, setupAdmin, type TestApp } from "./helpers.js";

describe("plans and pieces", () => {
  let t: TestApp;
  let admin: string;
  let sam: string;
  let planId: string;
  let inputId: string;
  let transformId: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    sam = (await createUserAs(t, admin, "sam@example.com")).cookie;
  });
  afterAll(() => t.close());

  const api = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>, cookie = sam) => t.app.inject({ method, url, headers: { cookie }, payload });

  it("serves the catalog to signed-in users", async () => {
    const res = await api("GET", "/api/catalog");
    expect(res.statusCode).toBe(200);
    const ids = res.json().catalog.integrations.map((i: { id: string }) => i.id);
    expect(ids).toContain("gmail");
    expect(res.json().catalog.operations.length).toBeGreaterThan(10);
  });

  it("creates a plan with a title from the thought and one empty input", async () => {
    const res = await api("POST", "/api/plans", { thought: "I want to take my emails about pasta and send them to all my friends" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    planId = body.plan.id;
    expect(body.plan.title).toBe("Take my emails about pasta and send them…");
    expect(body.pieces).toHaveLength(1);
    inputId = body.pieces[0].id;
    expect(body.pieces[0]).toMatchObject({ kind: "input", slots: {} });
  });

  it("fills slots through the grammar and drops what doesn't fit", async () => {
    const res = await api("PATCH", `/api/plans/${planId}/pieces/${inputId}`, {
      slots: {
        integration: { kind: "option", id: "gmail" },
        object: { kind: "option", id: "emails" },
        "filter.0.field": { kind: "option", id: "subject" },
        "filter.0.op": { kind: "option", id: "contains" },
        "filter.0.value": { kind: "text", text: "pasta" },
        bogus: { kind: "option", id: "nope" },
        "filter.0.other": { kind: "text", text: "stale" },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().dropped.sort()).toEqual(["bogus", "filter.0.other"]);
    expect(Object.keys(res.json().piece.slots).sort()).toEqual(["filter.0.field", "filter.0.op", "filter.0.value", "integration", "object"]);
  });

  it("adds a transformation that references the input", async () => {
    const res = await api("POST", `/api/plans/${planId}/pieces`, {
      kind: "transform",
      slots: { source: { kind: "ref", pieceId: inputId }, operation: { kind: "option", id: "summarize" }, "p.length": { kind: "option", id: "in one line" } },
    });
    expect(res.statusCode).toBe(200);
    transformId = res.json().piece.id;
    expect(res.json().piece.slots.source).toEqual({ kind: "ref", pieceId: inputId });
  });

  it("applies a helper suggestion in grammar order", async () => {
    const res = await api("POST", `/api/plans/${planId}/pieces/apply`, {
      pieceId: null,
      kind: "output",
      slots: [
        { id: "p.to", type: "text", value: "friends@example.com" },
        { id: "action", type: "option", value: "send_email" },
        { id: "source", type: "ref", value: transformId },
        { id: "integration", type: "option", value: "Gmail" },
        { id: "p.nonexistent", type: "text", value: "x" },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toEqual(["integration", "source", "action", "p.to"]);
    expect(res.json().dropped).toEqual(["p.nonexistent"]);
    expect(res.json().pieces).toHaveLength(3);
  });

  it("renders a handoff with numbering and org guidance", async () => {
    await t.app.inject({ method: "PATCH", url: "/api/admin/settings", headers: { cookie: admin }, payload: { preferredBuilder: "Claude Routines", orgGuidance: "Prefer Claude Routines over n8n." } });
    const res = await api("GET", `/api/plans/${planId}/handoff`);
    expect(res.statusCode).toBe(200);
    const md: string = res.json().markdown;
    expect(md).toContain("### Input 1 · emails from Gmail about “pasta”");
    expect(md).toContain("### Transformation 1 · summaries of emails from Gmail about “pasta” · AI step");
    expect(md).toContain("### Expected output 1 · an email via Gmail");
    expect(md).toContain("Send summaries of emails from Gmail about “pasta” to Gmail as an email to “friends@example.com”.");
    expect(md).toContain("Preferred builder: Claude Routines");
    expect(res.json().doc.pieces[2].dependsOn).toEqual(["Transformation 1"]);
  });

  it("reconciles downstream references when a piece is deleted", async () => {
    const res = await api("DELETE", `/api/plans/${planId}/pieces/${inputId}`);
    expect(res.statusCode).toBe(200);
    const transform = res.json().pieces.find((p: { id: string }) => p.id === transformId);
    expect(transform.slots.source).toBeUndefined();
    expect(transform.slots.operation).toBeUndefined();
  });

  it("keeps plans private to their owner but visible to app admins", async () => {
    const other = (await createUserAs(t, admin, "kim@example.com")).cookie;
    const denied = await api("GET", `/api/plans/${planId}`, undefined, other);
    expect(denied.statusCode).toBe(403);
    const asAdmin = await api("GET", `/api/plans/${planId}`, undefined, admin);
    expect(asAdmin.statusCode).toBe(200);
    const list = await api("GET", "/api/plans", undefined, other);
    expect(list.json().plans).toEqual([]);
  });

  it("caps typed text applied from suggestions", async () => {
    const res = await api("POST", `/api/plans/${planId}/pieces/apply`, { pieceId: null, kind: "input", slots: [{ id: "integration", type: "option", value: "gmail" }, { id: "qualifier", type: "text", value: "x".repeat(2001) }] });
    expect(res.statusCode).toBe(400);
  });

  it("cascades invalidation through the whole chain when a piece is deleted", async () => {
    const created = await api("POST", "/api/plans", { thought: "cascade" });
    const pid = created.json().plan.id;
    const input = created.json().pieces[0].id;
    await api("PATCH", `/api/plans/${pid}/pieces/${input}`, { slots: { integration: { kind: "option", id: "gmail" }, object: { kind: "option", id: "emails" }, "filter.0.field": { kind: "option", id: "__all__" } } });
    const t1 = (await api("POST", `/api/plans/${pid}/pieces`, { kind: "transform", slots: { source: { kind: "ref", pieceId: input }, operation: { kind: "option", id: "pick_fields" }, "p.fields.0": { kind: "option", id: "subject" } } })).json().piece.id;
    const t2 = (await api("POST", `/api/plans/${pid}/pieces`, { kind: "transform", slots: { source: { kind: "ref", pieceId: t1 }, operation: { kind: "option", id: "filter" }, "p.condition.0.field": { kind: "option", id: "subject" }, "p.condition.0.op": { kind: "option", id: "contains" }, "p.condition.0.value": { kind: "text", text: "x" } } })).json().piece.id;
    const after = await api("DELETE", `/api/plans/${pid}/pieces/${input}`);
    const pieces = after.json().pieces as Array<{ id: string; slots: Record<string, unknown> }>;
    expect(pieces.find((p) => p.id === t1)!.slots.source).toBeUndefined();
    const second = pieces.find((p) => p.id === t2)!.slots;
    expect(second.source).toEqual({ kind: "ref", pieceId: t1 });
    expect(second["p.condition.0.field"]).toBeUndefined();
  });

  it("validates input shapes", async () => {
    const res = await api("POST", `/api/plans/${planId}/pieces`, { kind: "widget" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("validation");
  });
});
