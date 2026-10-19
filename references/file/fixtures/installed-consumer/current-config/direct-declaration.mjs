import { file } from "@ykdz/dock-reference-file";

export const directReference = file
  .from("same-a.txt")
  .reference("current-reference");
