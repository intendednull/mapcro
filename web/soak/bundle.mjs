// Bundles the soak (TypeScript, plus the web client it drives) into .build/ for plain node with
// worker threads. npm packages (ws, fake-indexeddb) stay external and load from node_modules.
import { build } from "esbuild";
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
