import { build } from "esbuild";
import { cpSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

// Bundle everything into one JS file
await build({
  entryPoints: [resolve(__dirname, "../dynafetch-core/src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: resolve(__dirname, "dist/index.js"),
  sourcemap: true,
  // Keep node builtins and npm dependencies external
  external: [
    "node:*",
    "cheerio",
    "jsdom",
    "esbuild",
    "ws",
    "@babel/core",
    "@babel/parser",
    "@babel/traverse",
    "@babel/generator",
    "@babel/types",
    "crypto",
  ],
  // Replace __dirname in the bundle with a runtime reference
  define: {
    "__bundled_package": "true",
  },
  banner: {
    js: `import { createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirname_fn } from "node:path"; const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirname_fn(__filename); const require = createRequire(import.meta.url);`,
  },
});

// Copy precompiled binaries
const binSrc = resolve(root, "packages/dynafetch-net/bin");
const binDst = resolve(__dirname, "bin");
mkdirSync(binDst, { recursive: true });
cpSync(binSrc, binDst, { recursive: true });

console.log("Build complete: dist/index.js + bin/");
