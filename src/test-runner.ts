import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

function collectTests(directory: string): string[] {
  const tests: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      tests.push(path);
    }
  }
  return tests.sort();
}

const target = resolve(process.argv[2] ?? "dist");
const tests = collectTests(target);
if (tests.length === 0) {
  process.stderr.write(`No compiled tests found under ${target}.\n`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...tests], { stdio: "inherit" });
  if (result.error !== undefined) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
}
