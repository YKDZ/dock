import { file } from "@dock/reference-file";

export const reexportReference = file
  .from("same-a.txt")
  .reference("reexport-reference");
