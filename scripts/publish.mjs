import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const runtimeDir = resolve(root, "src", "fabrik-runtime");
const packagePath = resolve(runtimeDir, "package.json");
const packageVersion = process.env.PACKAGE_VERSION?.trim() ?? "";
const args = ["publish", "--access", "public"];

if (packageVersion) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.version = packageVersion;
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
}

if (process.env.NPM_CONFIG_PROVENANCE !== "false") {
  args.push("--provenance");
}
if (process.env.npm_config_tag) {
  args.push("--tag", process.env.npm_config_tag);
}
if (process.env.DRY_RUN === "1") {
  args.push("--dry-run");
}

const result = spawnSync("npm", args, {
  cwd: runtimeDir,
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
