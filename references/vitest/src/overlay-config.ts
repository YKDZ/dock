import { pathToFileURL } from "node:url";

import type { ViteUserConfig as UserConfig } from "vitest/config";

export type OverlayConfigOptions = {
  readonly userConfigPath?: string;
  readonly root: string;
  readonly names: readonly string[];
  readonly suitePaths: readonly (readonly string[])[];
  readonly setupPath: string;
  readonly reporterPath: string;
};

/** 此模块在原生 Vitest 子进程中求值，维护预检只定位配置文件。 */
export async function createOverlayConfig(
  options: OverlayConfigOptions,
): Promise<UserConfig> {
  const userModule =
    options.userConfigPath === undefined
      ? undefined
      : ((await import(pathToFileURL(options.userConfigPath).href)) as {
          readonly default?: unknown;
        });
  let value: unknown = userModule?.default ?? {};
  if (typeof value === "function") {
    value = await value({ command: "serve", mode: "test" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Vitest 配置必须导出单一配置对象。");
  }
  const userConfig = value as UserConfig;
  const userTest = userConfig.test ?? {};
  const setupFiles = Array.isArray(userTest.setupFiles)
    ? userTest.setupFiles
    : userTest.setupFiles === undefined
      ? []
      : [userTest.setupFiles];
  const reporters = Array.isArray(userTest.reporters)
    ? userTest.reporters
    : userTest.reporters === undefined
      ? ["default" as const]
      : [userTest.reporters];
  const configuredPattern = userTest.testNamePattern;
  const selectedPatterns = options.names.flatMap((name) => {
    const escapedName = escapeRegExp(name);
    return [
      escapedName,
      escapeRegExp(name.replaceAll(" > ", " ")),
      escapedName.replaceAll(" > ", "(?: > | )"),
    ];
  });
  const suitePatterns = options.suitePaths.flatMap((suitePath) =>
    [`${suitePath.join(" > ")} > `, `${suitePath.join(" ")} `].map(
      (prefix) => `^${escapeRegExp(prefix)}[\\s\\S]*$`,
    ),
  );
  const selectedPatternsForRun = [
    ...new Set([...selectedPatterns, ...suitePatterns]),
  ];
  const configuredSource =
    configuredPattern === undefined
      ? undefined
      : configuredPattern instanceof RegExp
        ? configuredPattern.source
        : String(configuredPattern);
  // 用户正则只约束选择结果，不改变派生目标的大小写和锚点。
  const configuredFlags =
    configuredPattern instanceof RegExp
      ? configuredPattern.flags.replace(/[gyd]/g, "")
      : "";
  const configuredInlineFlags = configuredFlags.replace(/[^ims]/g, "");
  const configuredUnicodeFlags = configuredFlags.includes("v")
    ? "v"
    : configuredFlags.includes("u")
      ? "u"
      : "";
  const configuredExpression =
    configuredSource === undefined
      ? ""
      : configuredInlineFlags.length === 0
        ? `(?:${configuredSource})`
        : `(?${configuredInlineFlags}:${configuredSource})`;
  const filterPattern =
    configuredSource === undefined ? "" : `(?=[^]*?${configuredExpression})`;
  const testNamePattern = new RegExp(
    `^${filterPattern}(?:${selectedPatternsForRun.length === 0 ? "(?!)" : selectedPatternsForRun.join("|")})$`,
    configuredUnicodeFlags,
  );
  return {
    ...userConfig,
    root: options.root,
    test: {
      ...userTest,
      watch: false,
      dangerouslyIgnoreUnhandledErrors: false,
      // 允许已发现的空原生组；声明文件和必需成员由目录映射单独验证。
      passWithNoTests: true,
      testNamePattern,
      setupFiles: [...setupFiles, options.setupPath],
      reporters: [...reporters, options.reporterPath],
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
