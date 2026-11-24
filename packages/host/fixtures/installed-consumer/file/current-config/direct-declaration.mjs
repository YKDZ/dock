import { file } from "@ykdz/dock";

export const directReference = file
  .from("same-a.txt")
  .reference("current-reference");
