/**
 * Build the host faces (service entry + typert/remote artifacts) as ESM for
 * Node. @deepseek-ai/*, serialport and native `.node` addons stay external;
 * ssh2 itself (pure JS) is bundled so the tarball works without a profile
 * dependency edge. zod and the local SFTP helpers are bundled too.
 */
import { build } from "esbuild";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(resolve(rootDir, "lib", "chunks"), { recursive: true, force: true });

await build({
  entryPoints: [
    resolve(rootDir, "src/index.js"),
    resolve(rootDir, "src/typert.js"),
    resolve(rootDir, "src/remote.js")
  ],
  outdir: resolve(rootDir, "lib"),
  format: "esm",
  platform: "node",
  target: "node20",
  bundle: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  sourcemap: false,
  banner: {
    js: [
      "import { createRequire as __dshCreateRequire } from 'node:module';",
      "import { fileURLToPath as __dshFileURLToPath } from 'node:url';",
      "import { dirname as __dshDirname } from 'node:path';",
      "const require = __dshCreateRequire(import.meta.url);",
      "const __filename = __dshFileURLToPath(import.meta.url);",
      "const __dirname = __dshDirname(__filename);"
    ].join(" ")
  },
  // ssh2 is pure JS and is bundled so the plugin works from a tarball even
  // when DSH's profile resolver has no pnpm-recorded dependency edge for it.
  // serialport is a native binding and must stay external; cpu-features is an
  // optional native ssh2 dependency that ssh2 probes defensively.
  // `*.node` matters on Linux CI: ssh2 probes an optional native binding and
  // esbuild cannot parse it. Keeping the require external lets ssh2 fall back
  // to its pure-JS implementation when the addon is absent.
  external: ["@deepseek-ai/*", "serialport", "@serialport/*", "cpu-features", "*.node"],
  logLevel: "info"
});
for (const file of ["index.js", "typert.js", "remote.js"]) {
  const path = resolve(rootDir, "lib", file);
  writeFileSync(path, readFileSync(path, "utf8").replace(/[ \t]+$/gm, ""), "utf8");
}
console.log("build-host: wrote lib/index.js, lib/typert.js, lib/remote.js");
