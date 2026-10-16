const testNamePattern =
  process.env.DOCK_VITEST_CASE_PATTERN === "nonprefix" ? /ONE/i : /chosen/i;

export default { test: { testNamePattern } };
