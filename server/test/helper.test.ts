import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, setupAdmin, type TestApp } from "./helpers.js";

/** A tiny stand-in for a model API: records the request and returns a canned structured answer. */
function fakeModelServer(kind: "anthropic" | "openai", answer: unknown): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      const text = typeof answer === "string" ? answer : JSON.stringify(answer);
      res.setHeader("content-type", "application/json");
      if (kind === "anthropic") {
        res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: parsed.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
      } else if (req.url?.includes("/chat/completions")) {
        res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: parsed.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }));
      } else {
        res.end(
          JSON.stringify({
            id: "resp_1",
            object: "response",
            created_at: 1,
            status: "completed",
            model: parsed.model,
            output: [{ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }],
            output_text: text,
          }),
        );
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests })));
}

describe("helper", () => {
  let t: TestApp;
  let admin: string;
  let planId: string;
  let inputId: string;
  beforeAll(async () => {
    t = await createTestApp();
    admin = await setupAdmin(t);
    const res = await t.app.inject({ method: "POST", url: "/api/plans", headers: { cookie: admin }, payload: { thought: "I want to take my emails about pasta and send them to all my friends" } });
    planId = res.json().plan.id;
    inputId = res.json().pieces[0].id;
  });
  afterAll(() => t.close());

  it("reports that no model is configured", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/helper/status", headers: { cookie: admin } });
    expect(res.json()).toEqual({ configured: false, provider: null });
  });

  it("breaks a thought into pieces with rules alone", async () => {
    const res = await t.app.inject({ method: "POST", url: `/api/plans/${planId}/helper`, headers: { cookie: admin }, payload: { intent: "breakdown" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe("rules");
    expect(body.message).toContain("Admin → AI");
    const input = body.suggestions.find((s: { kind: string }) => s.kind === "input");
    expect(input).toMatchObject({ pieceId: inputId, valid: true });
    expect(input.preview).toBe("I want to get emails from Gmail where subject contains “pasta”.");
    const output = body.suggestions.find((s: { kind: string }) => s.kind === "output");
    expect(output.preview).toContain("to Gmail as an email");
    expect(body.questions.length).toBeGreaterThan(0);
  });

  it("refuses an empty chat message", async () => {
    const res = await t.app.inject({ method: "POST", url: `/api/plans/${planId}/helper`, headers: { cookie: admin }, payload: { intent: "chat", message: "   " } });
    expect(res.statusCode).toBe(400);
  });

  it("explains a focused blank with its options", async () => {
    const res = await t.app.inject({ method: "POST", url: `/api/plans/${planId}/helper`, headers: { cookie: admin }, payload: { intent: "slot", focus: { pieceId: inputId, slotId: "integration" } } });
    expect(res.json().message).toContain("Gmail");
    const applied = res.json().suggestions[0];
    expect(applied).toMatchObject({ kind: "input", valid: true });
  });

  it("uses a configured Anthropic model, caches the system prompt, and validates suggestions", async () => {
    const fake = await fakeModelServer("anthropic", {
      message: "Start with the emails.",
      suggestions: [
        { title: "Get pasta emails", pieceId: inputId, kind: "input", slots: [{ id: "integration", type: "option", value: "gmail" }, { id: "object", type: "option", value: "emails" }, { id: "filter.0.field", type: "option", value: "body" }, { id: "filter.0.op", type: "option", value: "contains" }, { id: "filter.0.value", type: "text", value: "pasta" }, { id: "timeRange", type: "option", value: "never" }], why: "Because." },
        { title: "Nonsense", pieceId: null, kind: "transform", slots: [{ id: "operation", type: "option", value: "teleport" }], why: "Bad." },
      ],
      questions: ["Which friends?"],
      remember: ["Friends means the Gmail contact group named Friends."],
    });
    try {
      const created = await t.app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie: admin }, payload: { kind: "anthropic", label: "Claude", model: "claude-opus-5", apiKey: "sk-ant-test-1234", baseUrl: fake.url } });
      expect(created.statusCode).toBe(200);
      expect(created.json().provider).toMatchObject({ isActive: true, hasKey: true, keyHint: "••••1234" });
      const status = await t.app.inject({ method: "GET", url: "/api/helper/status", headers: { cookie: admin } });
      expect(status.json().provider.model).toBe("claude-opus-5");

      const res = await t.app.inject({ method: "POST", url: `/api/plans/${planId}/helper`, headers: { cookie: admin }, payload: { intent: "chat", message: "Where do I start?" } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.source).toBe("model");
      expect(body.message).toBe("Start with the emails.");
      expect(body.suggestions[0]).toMatchObject({ valid: true, dropped: ["timeRange"] });
      expect(body.suggestions[0].preview).toBe("I want to get emails from Gmail where body contains “pasta”.");
      expect(body.suggestions[1]).toMatchObject({ valid: false });
      expect(body.facts).toEqual(["Friends means the Gmail contact group named Friends."]);

      // Facts remembered by the model respect the same cap as the editor.
      const fifty = Array.from({ length: 50 }, (_, i) => `fact ${i}`);
      await t.app.inject({ method: "PATCH", url: `/api/plans/${planId}`, headers: { cookie: admin }, payload: { facts: fifty } });
      const capped = await t.app.inject({ method: "POST", url: `/api/plans/${planId}/helper`, headers: { cookie: admin }, payload: { intent: "chat", message: "again" } });
      expect(capped.json().facts).toHaveLength(50);
      await t.app.inject({ method: "PATCH", url: `/api/plans/${planId}`, headers: { cookie: admin }, payload: { facts: [] } });

      const req = fake.requests[0] as { url: string; headers: Record<string, string>; body: { system: Array<{ cache_control?: unknown; text: string }>; output_config: { format: { type: string } }; messages: Array<{ role: string; content: string }> } };
      expect(req.url).toBe("/v1/messages");
      expect(req.headers["x-api-key"]).toBe("sk-ant-test-1234");
      expect(req.body.system[0]!.cache_control).toEqual({ type: "ephemeral" });
      expect(req.body.system[0]!.text).toContain("CATALOG");
      expect(req.body.output_config.format.type).toBe("json_schema");
      expect(req.body.messages.at(-1)!.content).toContain("PERSON SAYS: Where do I start?");

      const test = await t.app.inject({ method: "POST", url: `/api/admin/providers/${created.json().provider.id}/test`, headers: { cookie: admin } });
      expect(test.json().ok).toBe(true);
    } finally {
      fake.server.close();
    }
  });

  it("switches to an OpenAI model and writes a brief with it", async () => {
    const fake = await fakeModelServer("openai", "## Summary\nA brief from the fake model.");
    try {
      const created = await t.app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie: admin }, payload: { kind: "openai", label: "GPT", model: "gpt-5", apiKey: "sk-test-9999", baseUrl: fake.url } });
      const id = created.json().provider.id;
      const activated = await t.app.inject({ method: "POST", url: `/api/admin/providers/${id}/activate`, headers: { cookie: admin } });
      expect(activated.json().providers.filter((p: { isActive: boolean }) => p.isActive).map((p: { label: string }) => p.label)).toEqual(["GPT"]);
      const brief = await t.app.inject({ method: "POST", url: `/api/plans/${planId}/brief`, headers: { cookie: admin } });
      expect(brief.json()).toEqual({ brief: "## Summary\nA brief from the fake model.", source: "model" });
      const req = fake.requests[0] as { url: string; headers: Record<string, string>; body: { model: string } };
      expect(req.url).toBe("/responses");
      expect(req.headers.authorization).toBe("Bearer sk-test-9999");
      expect(req.body.model).toBe("gpt-5");
      const plan = await t.app.inject({ method: "GET", url: `/api/plans/${planId}`, headers: { cookie: admin } });
      expect(plan.json().plan.brief).toContain("fake model");
    } finally {
      fake.server.close();
    }
  });

  it("falls back to rules when the model is unreachable", async () => {
    const created = await t.app.inject({ method: "POST", url: "/api/admin/providers", headers: { cookie: admin }, payload: { kind: "openai_compatible", label: "Local", model: "llama", baseUrl: "http://127.0.0.1:9/v1" } });
    await t.app.inject({ method: "POST", url: `/api/admin/providers/${created.json().provider.id}/activate`, headers: { cookie: admin } });
    const res = await t.app.inject({ method: "POST", url: `/api/plans/${planId}/helper`, headers: { cookie: admin }, payload: { intent: "review" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().source).toBe("rules");
    expect(res.json().notice).toBeTruthy();
  });
});
