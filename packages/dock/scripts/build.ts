import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";

type InternalEntry = {
  readonly specifier: string;
  readonly packageSlug: string;
};

const INTERNAL_ENTRIES: readonly InternalEntry[] = [
  { specifier: "@dock/core", packageSlug: "core" },
  { specifier: "@dock/host", packageSlug: "host" },
  { specifier: "@dock/host/maintenance-worker", packageSlug: "host" },
];

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(packageRoot, "dist");

function runBuildCompiler(): void {
  const tscBin = join(
    packageRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tsc.cmd" : "tsc",
  );
  execFileSync(tscBin, ["-p", "tsconfig.build.json", "--pretty", "false"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function collectModuleSpecifierNodes(
  sourceFile: ts.SourceFile,
): ts.StringLiteral[] {
  const literals: ts.StringLiteral[] = [];

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      literals.push(node.moduleSpecifier);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      literals.push(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      literals.push(node.arguments[0]);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      literals.push(node.moduleReference.expression);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

function isWithinDirectory(rootDir: string, candidatePath: string): boolean {
  const rel = relative(rootDir, candidatePath);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

async function collectFilesRecursively(
  rootDir: string,
  predicate: (path: string) => boolean,
): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFilesRecursively(fullPath, predicate)));
    } else if (entry.isFile() && predicate(fullPath)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Vendors built `.js` and `.d.ts` module graphs from declared internal `@dock/*` packages
 * into `dist/_internal/<slug>/` using `import.meta.resolve()`.
 */
async function vendorInternalPackages(): Promise<Map<string, string>> {
  const packageRootDistDirs = new Map<string, string>();
  const specifierTargets = new Map<string, string>();
  const queue: {
    readonly sourceJsPath: string;
    readonly packageSlug: string;
    readonly pkgRootDistDir: string;
  }[] = [];

  for (const entry of INTERNAL_ENTRIES) {
    const resolvedJsPath = fileURLToPath(import.meta.resolve(entry.specifier));
    let pkgRootDistDir = packageRootDistDirs.get(entry.packageSlug);
    if (pkgRootDistDir === undefined) {
      pkgRootDistDir = dirname(resolvedJsPath);
      packageRootDistDirs.set(entry.packageSlug, pkgRootDistDir);
    } else if (!isWithinDirectory(pkgRootDistDir, resolvedJsPath)) {
      throw new Error(
        `Resolved subpath ${entry.specifier} (${resolvedJsPath}) escapes ${pkgRootDistDir}.`,
      );
    }

    const relPath = relative(pkgRootDistDir, resolvedJsPath);
    const destJsPath = join(distDir, "_internal", entry.packageSlug, relPath);
    specifierTargets.set(entry.specifier, destJsPath);
    queue.push({
      sourceJsPath: resolvedJsPath,
      packageSlug: entry.packageSlug,
      pkgRootDistDir,
    });
  }

  const visited = new Set<string>();
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (visited.has(item.sourceJsPath)) {
      continue;
    }
    visited.add(item.sourceJsPath);

    const relJsPath = relative(item.pkgRootDistDir, item.sourceJsPath);
    const destJsPath = join(distDir, "_internal", item.packageSlug, relJsPath);
    await mkdir(dirname(destJsPath), { recursive: true });
    await copyFile(item.sourceJsPath, destJsPath);

    const filesToScan = [item.sourceJsPath];
    const sourceDtsPath = item.sourceJsPath.replace(/\.js$/u, ".d.ts");
    if (await fileExists(sourceDtsPath)) {
      const destDtsPath = destJsPath.replace(/\.js$/u, ".d.ts");
      await copyFile(sourceDtsPath, destDtsPath);
      filesToScan.push(sourceDtsPath);
    }

    for (const filePath of filesToScan) {
      const content = await readFile(filePath, "utf8");
      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true,
      );
      for (const literal of collectModuleSpecifierNodes(sourceFile)) {
        const specifier = literal.text;
        if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
          continue;
        }
        const resolvedTarget = resolve(dirname(filePath), specifier);
        const targetJsPath = resolvedTarget.replace(/\.ts$/u, ".js");
        if (!isWithinDirectory(item.pkgRootDistDir, targetJsPath)) {
          throw new Error(
            `Relative specifier ${specifier} in ${filePath} escapes ${item.pkgRootDistDir}.`,
          );
        }
        if (!visited.has(targetJsPath)) {
          queue.push({
            sourceJsPath: targetJsPath,
            packageSlug: item.packageSlug,
            pkgRootDistDir: item.pkgRootDistDir,
          });
        }
      }
    }
  }

  return specifierTargets;
}

function toPosixRelativeSpecifier(fromFile: string, toFile: string): string {
  const rel = relative(dirname(fromFile), toFile).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function isInternalDockSpecifier(specifier: string): boolean {
  return specifier === "@dock" || specifier.startsWith("@dock/");
}

/**
 * Rewrites all `@dock/*` module specifiers in `dist/*.{js,d.ts}` to relative paths
 * pointing at vendored modules under `dist/_internal/`.
 */
async function rewriteInternalSpecifiers(
  specifierTargets: ReadonlyMap<string, string>,
): Promise<void> {
  const distFiles = await collectFilesRecursively(
    distDir,
    (path) => path.endsWith(".js") || path.endsWith(".d.ts"),
  );

  for (const filePath of distFiles) {
    const content = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    const replacements: {
      readonly start: number;
      readonly end: number;
      readonly text: string;
    }[] = [];

    for (const literal of collectModuleSpecifierNodes(sourceFile)) {
      const specifier = literal.text;
      if (!isInternalDockSpecifier(specifier)) {
        continue;
      }
      const targetJsPath = specifierTargets.get(specifier);
      if (targetJsPath === undefined) {
        throw new Error(
          `Undeclared internal specifier "${specifier}" referenced in ${filePath}.`,
        );
      }
      replacements.push({
        start: literal.getStart(sourceFile),
        end: literal.getEnd(),
        text: JSON.stringify(toPosixRelativeSpecifier(filePath, targetJsPath)),
      });
    }

    if (replacements.length === 0) {
      continue;
    }

    replacements.sort((left, right) => right.start - left.start);
    let updated = content;
    for (const replacement of replacements) {
      updated =
        updated.slice(0, replacement.start) +
        replacement.text +
        updated.slice(replacement.end);
    }
    await writeFile(filePath, updated, "utf8");
  }
}

async function assertNoRemainingInternalSpecifiers(): Promise<void> {
  const distFiles = await collectFilesRecursively(
    distDir,
    (path) => path.endsWith(".js") || path.endsWith(".d.ts"),
  );

  for (const filePath of distFiles) {
    const content = await readFile(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const literal of collectModuleSpecifierNodes(sourceFile)) {
      if (isInternalDockSpecifier(literal.text)) {
        throw new Error(
          `Internal specifier "${literal.text}" remained in built output ${filePath}.`,
        );
      }
    }
  }
}

async function main(): Promise<void> {
  await rm(distDir, { recursive: true, force: true });
  runBuildCompiler();
  const specifierTargets = await vendorInternalPackages();
  await rewriteInternalSpecifiers(specifierTargets);
  await assertNoRemainingInternalSpecifiers();
  await chmod(join(distDir, "cli.js"), 0o755);
}

await main();
