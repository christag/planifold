import { expect, test } from "@playwright/test";
import { pick, sentence, shot, signIn, type } from "./helpers.js";

const THOUGHT = "I want to take my emails about pasta and send them to all my friends";

test.describe("desktop", () => {
  test.skip(({ isMobile }) => !!isMobile);

  test("plans a thought one piece at a time", async ({ page }) => {
    await signIn(page);
    await shot(page, "01-plans-empty");

    await page.getByRole("button", { name: "New plan" }).click();
    await page.getByLabel("Your thought").fill(THOUGHT);
    await shot(page, "02-thought");
    await page.getByRole("button", { name: "Break it into pieces" }).click();

    // The workspace opens on the first empty input; the helper proposes a breakdown.
    await expect(sentence(page)).toContainText("From");
    await expect(page.locator(".helper .suggestion").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "03-workspace-breakdown");

    // Apply the input suggestion: it should fill the sentence through the grammar.
    const inputSuggestion = page.locator(".helper .suggestion.kind-input").first();
    await inputSuggestion.getByRole("button", { name: "Apply" }).click();
    await expect(sentence(page)).toContainText("I want to get emails from Gmail where subject contains “pasta”.");
    await expect(page.locator(".focus .pill.ok")).toContainText("Complete");
    await shot(page, "04-input-complete");

    // Optional blanks: a schedule.
    await page.getByRole("button", { name: /^when should this run\?/ }).click();
    await shot(page, "05-slot-menu");
    await page.getByRole("dialog").getByRole("option", { name: /^every morning/ }).click();
    await expect(sentence(page)).toContainText("every morning.");

    // Second input: the friends list, built entirely by hand.
    await page.getByRole("button", { name: "Add an input" }).click();
    await expect(sentence(page)).toHaveText(/From\s*somewhere/);
    await pick(page, "somewhere", "Gmail");
    await pick(page, "what?", "contacts");
    await pick(page, "which ones?", "contact group");
    await pick(page, "is…", "is");
    await type(page, "what?", "Friends");
    await expect(sentence(page)).toContainText("I want to get contacts from Gmail where contact group is “Friends”.");

    // A transformation that reads the emails.
    await page.getByRole("button", { name: "Add a transformation" }).click();
    await pick(page, "a piece", "emails from Gmail about “pasta”");
    await pick(page, "do what?", "summarize each one");
    await pick(page, "…", "in one line");
    await expect(sentence(page)).toContainText("Take emails from Gmail about “pasta” and summarize each one in one line.");
    await expect(page.locator(".focus .pill.pen")).toContainText("AI step");
    await shot(page, "06-transform-complete");

    // The expected output sends the summaries to each friend.
    await page.getByRole("button", { name: "Add an expected output" }).click();
    await expect(sentence(page)).toHaveText(/To\s*somewhere/);
    await pick(page, "somewhere", "Gmail");
    await pick(page, "what?", "summaries of emails");
    await pick(page, "what kind of thing?", "an email");
    await pick(page, "who?", "each person in contacts from Gmail");
    await expect(sentence(page)).toContainText("Send summaries of emails from Gmail about “pasta” to Gmail as an email to each person in contacts from Gmail about “Friends”.");
    await type(page, "how will I know it worked?", "every friend gets exactly one email");
    await expect(sentence(page)).toContainText("I’ll know it worked when “every friend gets exactly one email”.");
    await shot(page, "07-output-complete");

    // Loose end: mark a blank as unsure, see it tracked, then resolve it.
    await page.getByRole("button", { name: /^with the subject/ }).click();
    await page.getByRole("button", { name: "I'm not sure yet" }).click();
    await page.getByLabel("What are you unsure about").fill("Should it be one per recipe?");
    await page.getByRole("button", { name: "Save loose end" }).click();
    await expect(page.locator(".rail-loose")).toContainText("Should it be one per recipe?");
    await shot(page, "08-loose-end");
    await page.locator(".rail-loose button").first().click();
    await page.getByRole("dialog").locator("input").last().fill("Pasta news");
    await page.getByRole("dialog").getByRole("button", { name: "Use" }).click();
    await expect(sentence(page)).toContainText("with the subject “Pasta news”");

    // Readiness shows in the top bar once everything connects.
    await expect(page.locator(".ws-top .pill")).toContainText("Ready to hand off");

    // Map view.
    await page.getByRole("tab", { name: "Map" }).click();
    await expect(page.locator(".map-node")).toHaveCount(4);
    await shot(page, "09-map");

    // Handoff view.
    await page.getByRole("tab", { name: "Handoff" }).click();
    await expect(page.locator(".handoff-doc")).toContainText("reads Transformation 1");
    await expect(page.locator(".handoff-doc")).toContainText("Send summaries of emails");
    await page.getByRole("button", { name: "Write the brief" }).click();
    await expect(page.locator(".handoff-doc")).toContainText("Suggested build approach", { timeout: 20_000 });
    await shot(page, "10-handoff");
    await page.getByRole("button", { name: "Mark as handed off" }).click();
    await expect(page.locator(".handoff-doc")).toContainText("handed off");
  });

  test("administers users, AI providers, guidance and integrations", async ({ page }) => {
    await signIn(page);
    // Leave no providers behind from earlier runs.
    const existing = await page.request.get("/api/admin/providers").then((r) => r.json());
    for (const p of existing.providers) await page.request.delete(`/api/admin/providers/${p.id}`);
    const stamp = Date.now().toString(36);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await shot(page, "11-admin-overview");

    await page.goto("/admin/guidance");
    await page.getByLabel("Preferred way to build automations").fill("Claude Routines for most tasks; n8n only for high-volume pipelines");
    await page.getByLabel("Organization guidance").fill("Never email customers without a person reviewing a draft first.");
    await page.getByRole("button", { name: "Save guidance" }).click();
    await expect(page.locator(".toast")).toContainText("Guidance saved");

    await page.goto("/admin/ai");
    await page.getByRole("button", { name: "Add a provider" }).click();
    await page.getByLabel("Kind").selectOption("openai_compatible");
    await page.getByLabel("Model id").fill("llama-3.3-70b");
    await page.getByLabel("Base URL").fill("http://127.0.0.1:9/v1");
    await shot(page, "12-admin-ai-form");
    await page.getByRole("button", { name: "Add provider" }).click();
    const provider = page.locator(".provider", { hasText: "llama-3.3-70b" }).first();
    await expect(provider).toBeVisible();
    await provider.getByRole("button", { name: "Test" }).click();
    await expect(provider).toContainText("Tested", { timeout: 15_000 });
    await shot(page, "13-admin-ai");
    await provider.getByLabel("Remove").click();
    await provider.getByRole("button", { name: "Remove" }).click();
    await expect(page.locator(".provider")).toHaveCount(0);

    await page.goto("/admin/users");
    await page.getByLabel("Name").fill("Sam Planner");
    await page.getByLabel("Email").fill(`sam-${stamp}@example.com`);
    await page.getByRole("button", { name: "Add person" }).click();
    await expect(page.locator(".reveal")).toBeVisible();
    await shot(page, "14-admin-users");

    await page.goto("/admin/integrations");
    await expect(page.locator(".plugin-card")).toHaveCount(23);
    const gmail = page.locator(".plugin-card", { hasText: "Gmail" }).first();
    await gmail.getByRole("button", { name: "Edit" }).click();
    await gmail.getByLabel("Guidance for Plani").fill(`Only the shared mailbox automations-${stamp}@example.com may send.`);
    await gmail.getByRole("button", { name: "Save changes" }).click();
    await expect(page.locator(".toast")).toContainText("Saved");
    await shot(page, "15-admin-integrations");

    await page.goto("/admin/audit");
    await expect(page.locator(".table")).toContainText("settings.updated");
  });
});

test.describe("mobile", () => {
  test.skip(({ isMobile }) => !isMobile);

  test("works one blank at a time on a phone", async ({ page }) => {
    await signIn(page);
    await shot(page, "m1-plans");
    await page.locator(".plan-card-body").first().click();
    await expect(page.locator(".piece-strip")).toBeVisible();
    await shot(page, "m2-workspace");

    // Open a blank: the menu becomes a bottom sheet.
    await page.getByRole("button", { name: "Plan overview" }).click();
    await expect(page.getByRole("dialog", { name: "Plan overview" })).toBeVisible();
    await shot(page, "m3-plan-sheet");
    await page.getByRole("dialog", { name: "Plan overview" }).getByRole("button", { name: "Add an input" }).click();
    await expect(sentence(page)).toHaveText(/From\s*somewhere/);
    await expect(page.getByRole("dialog", { name: "Choose somewhere" })).toBeVisible();
    await shot(page, "m4-slot-sheet");
    await page.getByRole("dialog").getByPlaceholder(/Search/).fill("Slack");
    await page.getByRole("dialog").getByRole("option", { name: /^Slack/ }).click();
    await expect(sentence(page)).toContainText("from Slack");
    // The next blank opens by itself; dismiss it to reach the helper button.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Open Plani" }).click();
    await expect(page.getByRole("dialog", { name: "Plani" })).toBeVisible();
    await shot(page, "m5-helper-sheet");
    await page.getByRole("button", { name: "Done" }).click();

    await page.getByRole("tab", { name: "Map" }).click();
    await expect(page.locator(".map-node").first()).toBeVisible();
    await shot(page, "m6-map");
    await page.getByRole("tab", { name: "Handoff" }).click();
    await expect(page.locator(".handoff-doc")).toBeVisible();
    await shot(page, "m7-handoff");
  });
});
