import assert from "node:assert/strict";

import { inspect } from "@dock/sdk";

import config from "./user-config.config.mts";

const scope = { binding: ["用户配置状态"] };
const file = await inspect("./user-config.config.mts", scope);
const { configPath, ...common } = file;
assert.ok(configPath);
assert.deepEqual(await inspect(config, scope), common);
process.stdout.write(JSON.stringify(file));
