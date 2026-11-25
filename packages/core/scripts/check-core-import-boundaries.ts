import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const allowedImports: Record<string, readonly string[]> = {
  "json-cst": [],
  "json-value": [],
  contracts: ["json-cst", "json-value"],
  check: ["contracts", "json-value"],
  "update-baseline": ["contracts", "check"],
  index: ["contracts", "json-cst", "json-value", "check", "update-baseline"],
};
const importPattern =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gu;
const violations: string[] = [];

for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) {
    violations.push(
      `Core source directory only allows registered top-level TypeScript modules: ${entry.name}`,
    );
    continue;
  }

  const moduleName = entry.name.slice(0, -".ts".length);
  const allowed = allowedImports[moduleName];
  if (!allowed) {
    violations.push(
      `Core source module does not have registered dependency directions: ${entry.name}`,
    );
    continue;
  }

  const source = readFileSync(
    new URL(`../src/${entry.name}`, import.meta.url),
    "utf8",
  );
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3]!;
    if (!specifier.startsWith("./")) {
      violations.push(
        `${entry.name} cannot depend on modules outside src/: ${specifier}`,
      );
      continue;
    }

    const importedModule = specifier.slice(2).replace(/\.(?:js|ts)$/u, "");
    if (!allowed.includes(importedModule)) {
      violations.push(
        `${entry.name} is not allowed to depend on ${importedModule}: ${specifier}`,
      );
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
}
