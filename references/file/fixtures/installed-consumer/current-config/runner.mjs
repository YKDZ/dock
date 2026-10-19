import assert from "node:assert/strict";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import { check, MaintenanceError, updateBaseline } from "@ykdz/dock";

await verifyDirectEntryAndRecovery();
await verifyReexportedDeclaration();
await verifyTransitiveDeclaration();
await verifyDependencyDeclaration();
await verifyConfigurationIsolation();
process.stdout.write("同进程当前声明、错误恢复与自然退出通过。\n");

async function verifyDirectEntryAndRecovery() {
  const configPath = new URL("./direct-config.mjs", import.meta.url);
  const declarationPath = new URL("./direct-declaration.mjs", import.meta.url);
  const baselinePath = new URL("./direct.baseline.json", import.meta.url);
  const originalConfig = await readFile(configPath, "utf8");
  const currentConfig = originalConfig.replace(
    'binding("direct-binding"',
    'binding("direct-binding-current"',
  );
  assert.notEqual(currentConfig, originalConfig);

  await writeFile(new URL("./same-a.txt", import.meta.url), "相同事实\n");
  await writeFile(new URL("./same-b.txt", import.meta.url), "相同事实\n");
  const initial = await updateBaseline(configPath);
  assert.equal(initial.status, "updated");
  assertConsistent(await check(configPath), "direct-binding");

  await writeFile(configPath, currentConfig, "utf8");
  const changedEntry = await check(configPath);
  assertChange(changedEntry, "direct-binding", "binding-removed");
  assertChange(changedEntry, "direct-binding-current", "binding-added");
  const latestConfig = currentConfig.replace(
    "direct-binding-current",
    "direct-binding-after-check",
  );
  assert.notEqual(latestConfig, currentConfig);
  await writeFile(configPath, latestConfig, "utf8");
  assert.equal((await updateBaseline(configPath)).status, "updated");
  assertConsistent(await check(configPath), "direct-binding-after-check");

  const originalDeclaration = await readFile(declarationPath, "utf8");
  const currentDeclaration = originalDeclaration.replace(
    "same-a.txt",
    "same-b.txt",
  );
  assert.notEqual(currentDeclaration, originalDeclaration);
  await writeFile(declarationPath, currentDeclaration, "utf8");
  assertReferenceDefinitionChange(
    await check(configPath),
    "direct-binding-after-check",
    "current-reference",
  );

  const latestDeclaration = currentDeclaration.replace(
    "same-b.txt",
    "same-c.txt",
  );
  assert.notEqual(latestDeclaration, currentDeclaration);
  await writeFile(declarationPath, latestDeclaration, "utf8");
  await writeFile(
    new URL("./same-c.txt", import.meta.url),
    "检查后声明的事实\n",
  );
  const updateAfterCheck = await updateBaseline(configPath);
  assert.equal(updateAfterCheck.status, "updated");
  assert.equal(
    updateAfterCheck.baseline.bindings["direct-binding-after-check"]
      ?.references["current-reference"]?.value,
    "检查后声明的事实\n",
  );
  assertConsistent(await check(configPath), "direct-binding-after-check");

  const originalBaseline = await readFile(baselinePath);
  await rm(declarationPath);
  await assertConfigLoadFailure(updateBaseline(configPath));
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  await writeFile(declarationPath, latestDeclaration, "utf8");
  assertConsistent(await check(configPath), "direct-binding-after-check");

  await writeFile(
    declarationPath,
    "export const directReference = ;\n",
    "utf8",
  );
  await assertConfigLoadFailure(updateBaseline(configPath));
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  await writeFile(declarationPath, latestDeclaration, "utf8");
  assertConsistent(await check(configPath), "direct-binding-after-check");

  await writeFile(configPath, "export default ;\n", "utf8");
  await assertConfigLoadFailure(check(configPath));
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  await writeFile(configPath, latestConfig, "utf8");
  assertConsistent(await check(configPath), "direct-binding-after-check");

  const removedEntry = new URL("./direct-config.mjs.removed", import.meta.url);
  await rename(configPath, removedEntry);
  await assertConfigLoadFailure(updateBaseline(configPath));
  assert.deepEqual(await readFile(baselinePath), originalBaseline);
  await rename(removedEntry, configPath);
  assertConsistent(await check(configPath), "direct-binding-after-check");
}

async function verifyReexportedDeclaration() {
  await verifyImportedDefinition({
    configFile: "reexport.js",
    declarationFile: "reexport-leaf.mjs",
    bindingId: "reexport-binding",
    referenceId: "reexport-reference",
    before: "same-a.txt",
    after: "same-b.txt",
  });
}

async function verifyTransitiveDeclaration() {
  await verifyImportedDefinition({
    configFile: "transitive.ts",
    declarationFile: "transitive-leaf.mjs",
    bindingId: "transitive-binding",
    referenceId: "transitive-reference",
    before: "same-a.txt",
    after: "same-b.txt",
  });
}

async function verifyDependencyDeclaration() {
  await verifyImportedDefinition({
    configFile: "dependency.mts",
    declarationFile: "node_modules/current-config-declarations/index.mjs",
    bindingId: "dependency-binding",
    referenceId: "dependency-reference",
    before: "same-a.txt",
    after: "same-b.txt",
  });
}

async function verifyImportedDefinition(input) {
  const configPath = new URL(`./${input.configFile}`, import.meta.url);
  const declarationPath = new URL(
    `./${input.declarationFile}`,
    import.meta.url,
  );
  const baselinePath = new URL(
    `./${input.bindingId}.baseline.json`,
    import.meta.url,
  );
  const originalDeclaration = await readFile(declarationPath, "utf8");
  const currentDeclaration = originalDeclaration.replace(
    input.before,
    input.after,
  );
  assert.notEqual(currentDeclaration, originalDeclaration);

  assert.equal((await updateBaseline(configPath)).status, "updated");
  assertConsistent(await check(configPath), input.bindingId);
  await writeFile(declarationPath, currentDeclaration, "utf8");
  assertReferenceDefinitionChange(
    await check(configPath),
    input.bindingId,
    input.referenceId,
  );
  assert.equal((await updateBaseline(configPath)).status, "updated");
  assertConsistent(await check(configPath), input.bindingId);
  await rm(baselinePath);
}

async function verifyConfigurationIsolation() {
  const firstConfig = new URL("./isolation-one.mjs", import.meta.url);
  const secondConfig = new URL("./isolation-two.mjs", import.meta.url);
  const firstBaseline = new URL(
    "./isolation-one.baseline.json",
    import.meta.url,
  );
  const secondBaseline = new URL(
    "./isolation-two.baseline.json",
    import.meta.url,
  );

  await writeFile(new URL("./isolation-one.txt", import.meta.url), "项目一\n");
  await writeFile(new URL("./isolation-two.txt", import.meta.url), "项目二\n");
  assert.equal((await updateBaseline(firstConfig)).status, "updated");
  assert.equal((await updateBaseline(secondConfig)).status, "updated");
  assert.equal(
    JSON.parse(await readFile(firstBaseline, "utf8")).bindings[
      "isolation-binding"
    ].references["isolation-reference"].value,
    "项目一\n",
  );
  assert.equal(
    JSON.parse(await readFile(secondBaseline, "utf8")).bindings[
      "isolation-binding"
    ].references["isolation-reference"].value,
    "项目二\n",
  );

  await writeFile(
    new URL("./isolation-one.txt", import.meta.url),
    "项目一已更新\n",
  );
  assertFactChange(await check(firstConfig), "isolation-binding");
  assertConsistent(await check(secondConfig), "isolation-binding");
  assert.equal((await updateBaseline(firstConfig)).status, "updated");
  assertConsistent(await check(firstConfig), "isolation-binding");
  assertConsistent(await check(secondConfig), "isolation-binding");
}

function assertConsistent(report, bindingId) {
  const result = report.bindings.find(
    (bindingResult) => bindingResult.bindingId === bindingId,
  );
  assert.ok(result, `报告缺少关联 ${bindingId}`);
  assert.equal(result.consistency, "consistent");
}

function assertChange(report, bindingId, kind) {
  const result = report.bindings.find(
    (bindingResult) => bindingResult.bindingId === bindingId,
  );
  assert.ok(result, `报告缺少关联 ${bindingId}`);
  assert.ok(
    result.changes.some((change) => change.kind === kind),
    `关联 ${bindingId} 缺少 ${kind} 变化`,
  );
}

function assertReferenceDefinitionChange(report, bindingId, referenceId) {
  const result = report.bindings.find(
    (bindingResult) => bindingResult.bindingId === bindingId,
  );
  assert.ok(result, `报告缺少关联 ${bindingId}`);
  assert.equal(result.consistency, "inconsistent");
  assert.ok(
    result.changes.some(
      (change) =>
        change.kind === "reference-definition" &&
        change.referenceId === referenceId,
    ),
    `关联 ${bindingId} 未发现引用 ${referenceId} 定义变化`,
  );
}

function assertFactChange(report, bindingId) {
  const result = report.bindings.find(
    (bindingResult) => bindingResult.bindingId === bindingId,
  );
  assert.ok(result, `报告缺少关联 ${bindingId}`);
  assert.ok(
    result.changes.some((change) => change.kind === "fact"),
    `关联 ${bindingId} 未发现事实变化`,
  );
}

async function assertConfigLoadFailure(operation) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof MaintenanceError);
    assert.match(error.code, /^config-(?:not-found|load-failed)$/);
    return true;
  });
}
