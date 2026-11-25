import { file } from "@ykdz/dock";

export const reexportReference = file
  .from("same-a.txt")
  .reference("reexport-reference");
