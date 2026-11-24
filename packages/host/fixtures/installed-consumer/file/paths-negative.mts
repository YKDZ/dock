import { file } from "@ykdz/dock";

// @ts-expect-error at requires a standard module URL.
file.at(42);

// @ts-expect-error at target must still be a plain file path or file: URL.
file.at(import.meta.url).from(42);
