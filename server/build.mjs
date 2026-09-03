import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => d !== "@planifold/shared");

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/server.js",
  sourcemap: true,
  external,
  banner: { js: "// Planifold server bundle. Source: https://github.com/christag/planifold" },
  logLevel: "info",
});
