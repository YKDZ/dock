import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

type Release = {
  name: string;
  body: string;
  prerelease: boolean;
  draft: boolean;
  target_commitish: string;
  assets: { name: string }[];
};
type State = {
  calls: string[][];
  tag?: string;
  release?: Release;
  assets: Record<string, string>;
  failCreateAfterWrite?: boolean;
};
const file = process.env.DOCK_RELEASE_TEST_GITHUB!;
const state = JSON.parse(readFileSync(file, "utf8")) as State;
const args = process.argv.slice(2);
state.calls.push(args);
const value = (flag: string) => args[args.indexOf(flag) + 1]!;
if (args[0] === "api") {
  const result = args[1]!.includes("git/ref")
    ? state.tag
      ? { object: { type: "commit", sha: state.tag } }
      : undefined
    : state.release;
  if (result) process.stdout.write(JSON.stringify(result));
  else {
    process.stderr.write("gh: Not Found (HTTP 404)\n");
    process.exitCode = 1;
  }
} else if (args[1] === "create") {
  state.tag = value("--target");
  state.release = {
    name: value("--title"),
    body: readFileSync(value("--notes-file"), "utf8"),
    prerelease: args.includes("--prerelease"),
    draft: false,
    target_commitish: state.tag,
    assets: [],
  };
  if (state.failCreateAfterWrite) {
    delete state.failCreateAfterWrite;
    process.exitCode = 1;
  } else
    for (const path of args.slice(3, args.indexOf("--repo"))) {
      state.assets[basename(path)] = readFileSync(path).toString("base64");
      state.release.assets.push({ name: basename(path) });
    }
} else if (args[1] === "upload") {
  const path = args[3]!;
  state.assets[basename(path)] = readFileSync(path).toString("base64");
  state.release!.assets.push({ name: basename(path) });
} else if (args[1] === "download") {
  const directory = value("--dir");
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(state.assets))
    writeFileSync(join(directory, name), Buffer.from(bytes, "base64"));
} else throw new Error(`未知 GitHub 边界操作 ${args.join(" ")}`);
writeFileSync(file, JSON.stringify(state));
