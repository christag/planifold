/**
 * Validates every plugins/<id>/plugin.json against the manifest schema and
 * smoke-tests the grammar with an empty piece of each kind.
 *
 *   npx tsx scripts/validate-plugins.ts [dir ...]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCatalog, buildSentence, safeParseManifest, type PieceData, type PluginManifest } from "@piecewise/shared";

const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [resolve(process.cwd(), "plugins")];
let failed = 0;
const manifests: PluginManifest[] = [];
for (const dir of dirs) {
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, "plugin.json");
    try {
      if (!statSync(join(dir, name)).isDirectory()) continue;
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const r = safeParseManifest(raw);
      if (!r.ok) {
        failed++;
        console.error(`✗ ${name}\n  ${r.errors.join("\n  ")}`);
        continue;
      }
      if (r.manifest.id !== name) {
        failed++;
        console.error(`✗ ${name}: manifest id "${r.manifest.id}" must match the directory name`);
        continue;
      }
      manifests.push(r.manifest);
      const m = r.manifest;
      const shape = m.kind === "transforms" ? `${m.operations?.length ?? 0} operations` : `${m.objects?.length ?? 0} objects, ${m.actions?.length ?? 0} actions`;
      console.log(`✓ ${name.padEnd(18)} ${m.name.padEnd(22)} ${shape}`);
    } catch (e) {
      failed++;
      console.error(`✗ ${name}: ${(e as Error).message}`);
    }
  }
}
const catalog = buildCatalog(manifests);
for (const kind of ["input", "transform", "output"] as const) {
  const piece: PieceData = { id: `smoke-${kind}`, kind, slots: {}, position: 0 };
  const s = buildSentence(piece, { catalog, pieces: [piece] });
  if (!s.tokens.length) {
    failed++;
    console.error(`✗ grammar produced no tokens for an empty ${kind}`);
  }
}
console.log(`\n${manifests.length} plugins, ${catalog.integrations.length} integrations, ${catalog.operations.length} operations${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
