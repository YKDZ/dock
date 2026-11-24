import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Like other root check entrypoints, resolve repository root with realpath. */
const repositoryRoot = realpathSync.native(process.cwd());

/** Root version shape gates match the root declarations accepted by package addition. */
const exactNodeVersion = /^\d+\.\d+\.\d+$/u;
const exactPnpmPin = /^pnpm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/** Format of `pnpm --version` in CI, matching the root pin without the tool name prefix. */
const exactPnpmVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

/** Slot locations only recognize the two planner-declared shapes; the checker does not interpret file formats or version semantics. */
type MirrorSlotLocation =
  | { readonly kind: "json-pointer"; readonly pointer: string }
  | { readonly kind: "text-anchor"; readonly name: string };

type MirrorSlot = {
  readonly id: string;
  readonly path: string;
  readonly location: MirrorSlotLocation;
};

/** Slot manifest projected from planner mirror slot declarations; this file does not maintain a second source of truth. */
const carriedMirrorSlots: unknown = JSON.parse(
  `[
  {
    "id": "node-version-build-arg",
    "path": ".devcontainer/devcontainer.json",
    "location": {
      "kind": "json-pointer",
      "pointer": "/build/args/NODE_VERSION"
    }
  }
]`,
);

type SlotReading =
  | { readonly status: "explained"; readonly observed: string }
  | { readonly status: "missing"; readonly reason: string }
  | { readonly status: "unexplainable"; readonly reason: string };

/** Display label for a slot location used in diagnostics. */
function locationLabel(location: MirrorSlotLocation): string {
  return location.kind === "json-pointer"
    ? `JSON pointer ${location.pointer}`
    : `anchor @template-mirror ${location.name}`;
}

function isMirrorSlot(value: unknown): value is MirrorSlot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const slot = value as Record<string, unknown>;
  if (typeof slot.id !== "string" || typeof slot.path !== "string") {
    return false;
  }
  const location = slot.location;
  if (typeof location !== "object" || location === null) {
    return false;
  }
  const fields = location as Record<string, unknown>;
  if (fields.kind === "json-pointer") {
    return typeof fields.pointer === "string";
  }

  return fields.kind === "text-anchor" && typeof fields.name === "string";
}

/** Report a single error if the carried manifest shape is invalid rather than silently skipping slots. */
function readCarriedMirrorSlots(): {
  readonly diagnostics: readonly string[];
  readonly slots: readonly MirrorSlot[];
} {
  if (!Array.isArray(carriedMirrorSlots)) {
    return {
      diagnostics: [
        "Carried mirror slot manifest is not an array: invalid template variable substitution result",
      ],
      slots: [],
    };
  }
  const diagnostics: string[] = [];
  const slots: MirrorSlot[] = [];
  for (const [index, entry] of carriedMirrorSlots.entries()) {
    if (isMirrorSlot(entry)) {
      slots.push(entry);
      continue;
    }
    diagnostics.push(
      `Carried mirror slot manifest entry ${index + 1} has invalid shape: ${JSON.stringify(entry)}`,
    );
  }

  return { diagnostics, slots };
}

/** Root declaration check also validates packageManager, though pnpm has no static mirror consumer. */
type RootToolchain = {
  readonly nodeVersion: string;
  readonly packageManagerPin: string;
};

/** Read root declarations: if the shape gate fails, report shape issues only without checking mirror drift or runtime facts. */
function readRootToolchain(): {
  readonly diagnostics: readonly string[];
  readonly root: RootToolchain | undefined;
} {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Root package.json could not be parsed: ${error instanceof Error ? error.message : String(error)}; cannot verify static mirrors until the root manifest is fixed`,
      ],
      root: undefined,
    };
  }
  const fields = (
    typeof manifest === "object" && manifest !== null ? manifest : {}
  ) as Record<string, unknown>;
  const engines = fields.engines;
  const nodeDeclaration =
    typeof engines === "object" && engines !== null
      ? (engines as Record<string, unknown>).node
      : undefined;
  const packageManagerDeclaration = fields.packageManager;
  const diagnostics: string[] = [];
  const isExactNode =
    typeof nodeDeclaration === "string" &&
    exactNodeVersion.test(nodeDeclaration);
  if (!isExactNode) {
    diagnostics.push(
      `Root package.json engines.node must be an exact 3-part Node version (e.g. "26.13.1"), got ${JSON.stringify(nodeDeclaration ?? null)}; static mirror slots coordinate on the root declaration, so set the root to a tested exact patch version`,
    );
  }
  const isExactPin =
    typeof packageManagerDeclaration === "string" &&
    exactPnpmPin.test(packageManagerDeclaration);
  if (!isExactPin) {
    diagnostics.push(
      `Root package.json packageManager must be a single exact pnpm pin (e.g. "pnpm@12.21.0", no range), got ${JSON.stringify(packageManagerDeclaration ?? null)}; fix the root declaration first`,
    );
  }
  if (diagnostics.length > 0 || !isExactNode || !isExactPin) {
    return { diagnostics, root: undefined };
  }

  return {
    diagnostics: [],
    root: {
      nodeVersion: nodeDeclaration,
      packageManagerPin: packageManagerDeclaration,
    },
  };
}

function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") {
    throw new Error("Mirror slot cannot target the document root itself");
  }
  if (!pointer.startsWith("/")) {
    throw new Error("JSON Pointer must start with '/'");
  }

  return pointer
    .slice(1)
    .split("/")
    .map((token) => {
      if (/~(?:[^01]|$)/u.test(token)) {
        throw new Error("JSON Pointer only allows '~0' and '~1' escapes");
      }

      return token.replaceAll("~1", "/").replaceAll("~0", "~");
    });
}

const missingValue = Symbol("missing");

/** Bounded RFC 6901 lookup: returns missingValue when absent so missing paths are reported separately from type mismatches. */
function readJsonPointer(
  document: unknown,
  segments: readonly string[],
): unknown {
  let current: unknown = document;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      return missingValue;
    }
    const container = current as Record<string, unknown>;
    if (!Object.hasOwn(container, segment)) {
      return missingValue;
    }
    current = container[segment];
  }

  return current;
}

/** Structured slot reader: parses JSON and extracts a string scalar so indentation and key order do not matter. */
function readStructuredSlot(filePath: string, pointer: string): SlotReading {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    return {
      reason: `file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      status: "unexplainable",
    };
  }
  let segments: readonly string[];
  try {
    segments = parseJsonPointer(pointer);
  } catch (error) {
    return {
      reason: error instanceof Error ? error.message : String(error),
      status: "unexplainable",
    };
  }
  const value = readJsonPointer(document, segments);
  if (value === missingValue) {
    return {
      reason: "declared location does not exist in file",
      status: "missing",
    };
  }
  if (typeof value !== "string") {
    return {
      reason: `value at location must be a string scalar, got ${JSON.stringify(value)}`,
      status: "unexplainable",
    };
  }

  return { observed: value, status: "explained" };
}

type MirrorMarker =
  | { readonly kind: "start"; readonly name: string }
  | { readonly kind: "end" }
  | { readonly kind: "content" };

/** Paired anchor grammar matching Core projection: strips comment punctuation and recognizes marker tokens only. */
function mirrorMarker(line: string): MirrorMarker {
  const stripped = line
    .trim()
    .replace(/^[#;%*/-]+/u, "")
    .trim();
  if (stripped === "@end-template-mirror") {
    return { kind: "end" };
  }
  const start = /^@template-mirror\s+(\S+)$/u.exec(stripped);
  if (start?.[1] !== undefined) {
    return { kind: "start", name: start[1] };
  }

  return { kind: "content" };
}

/** Anchor block must be unique and hold exactly one line, otherwise it cannot be located. */
function locateAnchorCarrier(
  lines: readonly string[],
  name: string,
): string | undefined {
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = mirrorMarker(line);
    if (marker.kind === "start" && marker.name === name) {
      starts.push(index);
    }
  }
  if (starts.length !== 1) {
    return undefined;
  }
  const start = starts[0]!;
  for (let index = start + 1; index < lines.length; index += 1) {
    const marker = mirrorMarker(lines[index]!);
    if (marker.kind === "start") {
      return undefined;
    }
    if (marker.kind !== "end") {
      continue;
    }

    return index - start === 2 ? lines[start + 1] : undefined;
  }

  return undefined;
}

function escapeToken(value: string): string {
  return value.replaceAll(/[.$()*?[\]{}+/|^\\]/gu, String.raw`\$&`);
}

/** When markers cannot be located, check whether an assignment or reference remains to distinguish corruption from opting out. */
function usesSlotName(text: string, name: string): boolean {
  const token = escapeToken(name);

  return (
    new RegExp(`(?:^|[^\\w$])${token}\\s*=`, "u").test(text) ||
    new RegExp(String.raw`\$\{\s*${token}\s*\}`, "u").test(text)
  );
}

function readArgDefault(carrier: string, name: string): string | undefined {
  const match = new RegExp(
    `^ARG\\s+${escapeToken(name)}\\s*=\\s*"([^"\\r\\n]*)"\\s*$`,
    "u",
  ).exec(carrier.trim());

  return match?.[1];
}

/** Text-anchor slot reader: compares only the default value token of the single ARG line inside the anchor block. */
function readTextSlot(name: string, text: string): SlotReading {
  const carrier = locateAnchorCarrier(text.split(/\r?\n/u), name);
  if (carrier === undefined) {
    return usesSlotName(text, name)
      ? {
          reason:
            "anchor block is missing, duplicated, unpaired, or contains extra lines while a declaration or reference still exists",
          status: "unexplainable",
        }
      : {
          reason: "neither anchor nor carrier declaration is in the file",
          status: "missing",
        };
  }
  const observed = readArgDefault(carrier, name);
  if (observed === undefined) {
    return {
      reason: `line inside anchor block is not in \`ARG ${name}="..."\` form: ${carrier.trim()}`,
      status: "unexplainable",
    };
  }

  return { observed, status: "explained" };
}

/** Rust static mirrors are owned by [toolchain].channel in root rust-toolchain.toml, bound by the slot leaf token. */
const rustChannelSourcePath = "rust-toolchain.toml";
const rustMirrorSlotToken = "RUST_TOOLCHAIN";

/** Slot root token: last segment for json-pointer or name for text-anchor, matching the planner declaration shape. */
function mirrorSlotRootToken(slot: MirrorSlot): string {
  return slot.location.kind === "json-pointer"
    ? (slot.location.pointer.split("/").at(-1) ?? "")
    : slot.location.name;
}

type RootChannelReading =
  | { readonly channel: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "missing" }
  | { readonly reason: string; readonly status: "unexplainable" };

/**
 * Structured reader for root rust-toolchain.toml [toolchain].channel.
 * Lazily imports smol-toml only when the manifest carries a Rust slot so non-Rust repos never touch rust-toolchain.toml or load the parser.
 */
async function readRootToolchainChannel(): Promise<RootChannelReading> {
  let text: string;
  try {
    text = readFileSync(
      path.join(repositoryRoot, rustChannelSourcePath),
      "utf8",
    );
  } catch {
    return {
      reason: `${rustChannelSourcePath} does not exist`,
      status: "missing",
    };
  }
  const { parse } = await import("smol-toml");
  let declaration: unknown;
  try {
    declaration = parse(text);
  } catch (error) {
    return {
      reason: `not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
      status: "unexplainable",
    };
  }
  const toolchain =
    typeof declaration === "object" && declaration !== null
      ? (declaration as Record<string, unknown>).toolchain
      : undefined;
  const channel =
    typeof toolchain === "object" && toolchain !== null
      ? (toolchain as Record<string, unknown>).channel
      : undefined;
  if (channel === undefined) {
    return {
      reason: `${rustChannelSourcePath} [toolchain] table has no channel declaration`,
      status: "missing",
    };
  }
  if (typeof channel !== "string" || channel.trim().length === 0) {
    return {
      reason: `[toolchain].channel must be a non-empty string, got ${JSON.stringify(channel)}`,
      status: "unexplainable",
    };
  }

  return { channel, status: "explained" };
}

function checkMirrorSlot(
  slot: MirrorSlot,
  root: RootToolchain,
  rustChannel: RootChannelReading | undefined,
): readonly string[] {
  const isRustSlot = mirrorSlotRootToken(slot) === rustMirrorSlotToken;
  let sourceLabel: string;
  let expected: string;
  if (isRustSlot) {
    if (rustChannel === undefined || rustChannel.status !== "explained") {
      const detail =
        rustChannel === undefined ? "not read" : rustChannel.reason;

      return [
        `Static mirror slot ${slot.id} cannot be checked: root ${rustChannelSourcePath} [toolchain].channel source is unreadable (${detail}); fix root ${rustChannelSourcePath} so [toolchain] declares a non-empty channel`,
      ];
    }
    sourceLabel = `root ${rustChannelSourcePath} [toolchain].channel`;
    expected = rustChannel.channel;
  } else {
    sourceLabel = "root engines.node";
    expected = root.nodeVersion;
  }
  const filePath = path.join(repositoryRoot, slot.path);
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return [
      `Static mirror slot ${slot.id} is missing: ${slot.path} does not exist; ${sourceLabel} is ${JSON.stringify(expected)}; restore the file to match the root declaration`,
    ];
  }
  const reading =
    slot.location.kind === "json-pointer"
      ? readStructuredSlot(filePath, slot.location.pointer)
      : readTextSlot(slot.location.name, contents);
  const position = locationLabel(slot.location);
  if (reading.status === "missing") {
    return [
      `Static mirror slot ${slot.id} is missing: ${position} in ${slot.path} is absent (${reading.reason}); ${sourceLabel} is ${JSON.stringify(expected)}; restore that location to match the root declaration`,
    ];
  }
  if (reading.status === "unexplainable") {
    return [
      `Static mirror slot ${slot.id} is unexplainable: ${position} in ${slot.path} ${reading.reason}; ${sourceLabel} is ${JSON.stringify(expected)}; restore a valid declaration (a JSON string value or a single ARG default line inside paired @template-mirror anchors)`,
    ];
  }
  if (reading.observed === expected) {
    return [];
  }

  return [
    `Static mirror slot ${slot.id} drifted: ${position} in ${slot.path} is ${JSON.stringify(reading.observed)}, while ${sourceLabel} is ${JSON.stringify(expected)}; update the mirror to match the root declaration, or update the root declaration first`,
  ];
}

/**
 * Runtime facts are checked only at CI boundaries where the workflow installs Node and pnpm from the root manifest.
 * Local non-CI host versions are ignored so valid static configurations are not rejected due to host differences.
 */
function ciRuntimeBoundaryApplies(): boolean {
  return /^(?:1|true)$/iu.test(process.env.CI ?? "");
}

type RuntimeVersionFact =
  | { readonly observed: string; readonly status: "explained" }
  | { readonly reason: string; readonly status: "unreadable" };

/** Read the self-reported pnpm version in the current environment without installing, switching, or querying the network. */
function readPnpmRuntimeVersion(): RuntimeVersionFact {
  const result = spawnSync("pnpm", ["--version"], { encoding: "utf8" });
  if (result.error !== undefined) {
    return {
      reason: `failed to invoke \`pnpm --version\`: ${result.error.message}`,
      status: "unreadable",
    };
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim();
    return {
      reason: `\`pnpm --version\` exited with code ${String(result.status)}: ${detail === "" ? "(no stderr output)" : detail}`,
      status: "unreadable",
    };
  }
  const observed = (result.stdout ?? "").trim();
  if (!exactPnpmVersion.test(observed)) {
    return {
      reason: `\`pnpm --version\` output is not a single exact version: ${JSON.stringify(observed)}`,
      status: "unreadable",
    };
  }

  return { observed, status: "explained" };
}

function checkRuntimeToolchainFacts(root: RootToolchain): readonly string[] {
  const diagnostics: string[] = [];
  const expectedNode = `v${root.nodeVersion}`;
  if (process.version !== expectedNode) {
    diagnostics.push(
      `Node runtime version mismatch: observed process.version ${JSON.stringify(process.version)} in CI, while root engines.node is ${JSON.stringify(root.nodeVersion)}; ensure CI installs Node from package.json rather than overriding it`,
    );
  }
  const pinnedVersion = root.packageManagerPin.slice("pnpm@".length);
  const pnpmFact = readPnpmRuntimeVersion();
  if (pnpmFact.status === "unreadable") {
    diagnostics.push(
      `Failed to read pnpm runtime version: ${pnpmFact.reason}; root packageManager is ${JSON.stringify(root.packageManagerPin)}; restore pnpm in CI`,
    );
  } else if (pnpmFact.observed !== pinnedVersion) {
    diagnostics.push(
      `pnpm runtime version mismatch: observed \`pnpm --version\` ${JSON.stringify(pnpmFact.observed)} in CI, while root packageManager is ${JSON.stringify(root.packageManagerPin)}; ensure CI uses the pinned pnpm version`,
    );
  }

  return diagnostics;
}

async function runToolchainMirrorCheck(): Promise<readonly string[]> {
  const carried = readCarriedMirrorSlots();
  if (carried.diagnostics.length > 0) {
    return carried.diagnostics;
  }
  const toolchain = readRootToolchain();
  if (toolchain.root === undefined) {
    return toolchain.diagnostics;
  }
  const root = toolchain.root;
  // Lazily import the TOML parser and read rust-toolchain.toml only when the manifest carries a Rust slot.
  const carriesRustSlot = carried.slots.some(
    (slot) => mirrorSlotRootToken(slot) === rustMirrorSlotToken,
  );
  const rustChannel = carriesRustSlot
    ? await readRootToolchainChannel()
    : undefined;
  const diagnostics: string[] = [];
  for (const slot of carried.slots) {
    diagnostics.push(...checkMirrorSlot(slot, root, rustChannel));
  }
  if (diagnostics.length === 0) {
    process.stdout.write(
      `Toolchain static mirror slots match: root Node ${root.nodeVersion}, ${carried.slots.length} slot(s)\n`,
    );
  }
  if (ciRuntimeBoundaryApplies()) {
    const runtimeDiagnostics = checkRuntimeToolchainFacts(root);
    diagnostics.push(...runtimeDiagnostics);
    if (runtimeDiagnostics.length === 0) {
      process.stdout.write(
        `Toolchain runtime facts match: CI verified current process against root Node ${root.nodeVersion} and ${root.packageManagerPin}\n`,
      );
    }
  }

  return diagnostics;
}

const diagnosticsFound = await runToolchainMirrorCheck();

if (diagnosticsFound.length > 0) {
  process.stderr.write(`${diagnosticsFound.join("\n")}\n`);
  process.exitCode = 1;
}
