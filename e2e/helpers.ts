import { expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

export const ADMIN = { email: "admin@example.com", password: "correct-horse-battery-staple", name: "Avery Admin" };
const shots = process.env.PW_SHOTS ?? "e2e/screenshots";
mkdirSync(shots, { recursive: true });

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}

/** Completes first-run setup if needed, otherwise signs in. */
export async function signIn(page: Page) {
  const cfg = await page.request.get("/api/auth/config").then((r) => r.json());
  if (cfg.needsSetup) {
    await page.goto("/setup");
    await page.getByLabel("Organization name").fill("Example Co");
    await page.getByLabel("Your name").fill(ADMIN.name);
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Create administrator" }).click();
  } else {
    await page.goto("/login");
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByRole("heading", { name: "Plans", exact: true })).toBeVisible();
}

/** Opens a blank by its placeholder and picks an option by label. */
async function openBlank(page: Page, blank: string) {
  const dialog = page.getByRole("dialog", { name: `Choose ${blank}` });
  // The menu often opens by itself after the previous blank is filled; only click when it doesn't.
  try {
    await dialog.waitFor({ state: "visible", timeout: 1500 });
  } catch {
    await page.getByRole("button", { name: new RegExp(`^${escape(blank)}`) }).first().click();
    await expect(dialog).toBeVisible();
  }
  return dialog;
}

export async function pick(page: Page, blank: string, option: string) {
  const dialog = await openBlank(page, blank);
  const search = dialog.getByPlaceholder(/Search/);
  if (await search.isVisible().catch(() => false)) await search.fill(option);
  await dialog.getByRole("option", { name: new RegExp(`^${escape(option)}`) }).first().click();
}

/** Opens a blank and types a value. */
export async function type(page: Page, blank: string, value: string) {
  const dialog = await openBlank(page, blank);
  await dialog.locator("input").last().fill(value);
  await dialog.getByRole("button", { name: "Use" }).click();
}

export const sentence = (page: Page) => page.locator(".focus .sentence").first();

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
