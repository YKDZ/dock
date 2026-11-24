function isInstalledDependency(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as {
    readonly version?: unknown;
    readonly missing?: unknown;
    readonly peerMissing?: unknown;
  };
  return (
    typeof entry.version === "string" &&
    entry.version.length > 0 &&
    entry.missing !== true &&
    entry.peerMissing !== true
  );
}

/** Collects genuinely installed package names from `npm ls --all --json` output, skipping unmet optional peer placeholders. */
export function collectInstalledPackageNames(
  value: unknown,
  names: Set<string> = new Set<string>(),
): Set<string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return names;
  }
  const packageValue = value as {
    readonly dependencies?: unknown;
  };
  if (
    typeof packageValue.dependencies !== "object" ||
    packageValue.dependencies === null ||
    Array.isArray(packageValue.dependencies)
  ) {
    return names;
  }
  for (const [name, dependency] of Object.entries(packageValue.dependencies)) {
    if (isInstalledDependency(dependency)) {
      names.add(name);
    }
    collectInstalledPackageNames(dependency, names);
  }
  return names;
}
