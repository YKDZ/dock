import { file } from "@boringparts/dock";

export const reexportReference = file
  .from("same-a.txt")
  .reference("reexport-reference");
