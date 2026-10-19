import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type State = {
  calls: string[][];
  packages: {
    name: string;
    version: string;
    file: string;
    integrity: string;
  }[];
  versions: Record<string, Record<string, { integrity: string }>>;
  tags: Record<string, Record<string, string>>;
  failPublishAt?: number;
  failAfterWrite?: boolean;
  failInstall?: boolean;
};
const file = process.env.DOCK_RELEASE_TEST_STATE!;
const state = JSON.parse(readFileSync(file, "utf8")) as State;
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(file, JSON.stringify(state));
const output = (value: unknown) => process.stdout.write(JSON.stringify(value));
const missing = () => {
  output({ error: { code: "E404" } });
  process.exitCode = 1;
};
if (args[0] === "view") {
  const spec = args[1]!;
  if (args[2] === "dist-tags") {
    const separator = spec.lastIndexOf("@");
    const name = separator > 0 ? spec.slice(0, separator) : spec;
    const tag = separator > 0 ? spec.slice(separator + 1) : "latest";
    const tags = state.tags[name];
    if (tags?.[tag]) output(tags);
    else if (!tags || tag !== "latest") missing();
  } else {
    const separator = spec.lastIndexOf("@");
    const dist =
      state.versions[spec.slice(0, separator)]?.[spec.slice(separator + 1)];
    if (dist) output(dist);
    else missing();
  }
} else if (args[0] === "publish") {
  const artifact = state.packages.find((entry) => entry.file === args[1])!;
  const published = Object.values(state.versions).reduce(
    (sum, versions) => sum + Object.keys(versions).length,
    0,
  );
  const fail = state.failPublishAt === published;
  if (fail) delete state.failPublishAt;
  if (!fail || state.failAfterWrite) {
    (state.versions[artifact.name] ??= {})[artifact.version] = {
      integrity: artifact.integrity,
    };
    (state.tags[artifact.name] ??= {})[
      args.find((arg) => arg.startsWith("--tag="))!.slice(6)
    ] = artifact.version;
  }
  if (fail) {
    process.stderr.write("模拟外部发布中断\n");
    process.exitCode = 1;
  }
} else if (args[0] === "install") {
  if (state.failInstall) {
    process.stderr.write("模拟注册表安装失败\n");
    process.exitCode = 1;
  } else {
    const packages: Record<string, unknown> = {};
    for (const artifact of state.packages) {
      if (!args.includes(`${artifact.name}@${artifact.version}`))
        throw new Error("缺少精确注册表安装参数");
      const destination = join(process.cwd(), "node_modules", artifact.name);
      mkdirSync(destination, { recursive: true });
      const result = spawnSync("tar", [
        "-xzf",
        artifact.file,
        "--strip-components=1",
        "-C",
        destination,
      ]);
      if (result.status !== 0) throw new Error("注册表替身无法提供压缩包");
      packages[`node_modules/${artifact.name}`] = {
        version: artifact.version,
        integrity: artifact.integrity,
        resolved: `https://registry.npmjs.org/${artifact.name}/-/package.tgz`,
      };
    }
    mkdirSync("node_modules/.bin", { recursive: true });
    symlinkSync("../@ykdz/dock/cli.js", "node_modules/.bin/dock");
    writeFileSync("package-lock.json", JSON.stringify({ packages }));
  }
} else throw new Error(`未知 npm 边界操作 ${args.join(" ")}`);
save();
