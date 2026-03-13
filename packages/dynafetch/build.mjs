import { build } from "esbuild";
import { mkdirSync, chmodSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const goSrc = resolve(root, "packages/dynafetch-net");

// Bundle everything into one JS file
await build({
  entryPoints: [resolve(__dirname, "../dynafetch-core/src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  outfile: resolve(__dirname, "dist/index.js"),
  sourcemap: true,
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
  define: {
    "__bundled_package": "true",
  },
  banner: {
    js: `import { createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __dirname_fn } from "node:path"; const __filename = __fileURLToPath(import.meta.url); const __dirname = __dirname_fn(__filename); const require = createRequire(import.meta.url);`,
  },
});

// Cross-compile Go binaries directly into the package bin/ directory.
const binDir = resolve(__dirname, "bin");
mkdirSync(binDir, { recursive: true });

const targets = [
  { goos: "darwin", goarch: "arm64", name: "dynafetch-net-darwin-arm64" },
  { goos: "darwin", goarch: "amd64", name: "dynafetch-net-darwin-x64" },
  { goos: "linux",  goarch: "amd64", name: "dynafetch-net-linux-x64" },
  { goos: "linux",  goarch: "arm64", name: "dynafetch-net-linux-arm64" },
  { goos: "windows", goarch: "amd64", name: "dynafetch-net-win32-x64.exe" },
];

for (const t of targets) {
  const out = resolve(binDir, t.name);
  execSync(`GOOS=${t.goos} GOARCH=${t.goarch} CGO_ENABLED=0 go build -ldflags="-s -w" -o ${out} .`, {
    cwd: goSrc,
    stdio: "inherit",
  });
  try { chmodSync(out, 0o755); } catch {}
}

console.log("Build complete: dist/index.js + bin/");
