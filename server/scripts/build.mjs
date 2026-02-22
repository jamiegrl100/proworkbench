import { build } from "esbuild";

await build({
  entryPoints: ["src/index.js"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  sourcemap: true,
  target: "node18",
  packages: "external",
});

console.log("[server] built to dist/");
