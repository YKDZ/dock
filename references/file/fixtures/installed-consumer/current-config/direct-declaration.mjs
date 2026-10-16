import { file } from "@dock/reference-file";

export const directReference = file
  .from("same-a.txt")
  .reference("current-reference");
