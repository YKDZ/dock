import { file } from "@dock/reference-file";

// @ts-expect-error at 需要标准模块 URL。
file.at(42);

// @ts-expect-error at 的目标仍须是普通文件路径或 file: URL。
file.at(import.meta.url).from(42);
