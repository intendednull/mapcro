// Bundles the perf harness (TypeScript, plus the web client and soak pieces it drives) into
// .build/ for plain node with worker threads. npm packages stay external (node_modules).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "run.ts"), join(here, "worker.ts")],
  outdir: join(here, ".build"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: "inline",
  logLevel: "warning",
});
mkdirSync(join(here, ".build"), { recursive: true });
copyFileSync(join(here, "probe.js"), join(here, ".build", "probe.js"));
