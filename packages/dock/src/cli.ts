#!/usr/bin/env node
import { executeCli, parseCliInvocation } from "@ykdz/cli-contract";
import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { cli } from "./cli-contract.ts";

const invocation = parseCliInvocation(cli, process.argv.slice(2));
const result = await executeCli(cli, {
  invocation,
  dependencies: undefined,
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
});
process.exitCode = result.exitCode;
