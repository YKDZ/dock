import { file } from "@boringparts/dock";

export const directReference = file
  .from("same-a.txt")
  .reference("current-reference");
