import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const allowedImports: Record<string, readonly string[]> = {
  contracts: [],
  check: ["contracts", "coverage"],
  coverage: ["contracts"],
  accept: ["contracts"],
  index: ["contracts", "accept", "check", "coverage"],
};
const importPattern =
  /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']/gu;
const violations: string[] = [];

for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) {
    violations.push(
      `core 源目录只允许已登记的顶层 TypeScript 模块：${entry.name}`,
    );
    continue;
  }

  const moduleName = entry.name.slice(0, -".ts".length);
  const allowed = allowedImports[moduleName];
  if (!allowed) {
    violations.push(`core 源模块尚未登记依赖方向：${entry.name}`);
    continue;
  }

  const source = readFileSync(
    new URL(`../src/${entry.name}`, import.meta.url),
    "utf8",
  );
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3]!;
    if (!specifier.startsWith("./")) {
      violations.push(`${entry.name} 不能依赖包外模块：${specifier}`);
      continue;
    }

    const importedModule = specifier.slice(2).replace(/\.(?:js|ts)$/u, "");
    if (!allowed.includes(importedModule)) {
      violations.push(
        `${entry.name} 不允许依赖 ${importedModule}：${specifier}`,
      );
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exitCode = 1;
}
