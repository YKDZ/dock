import { file } from "@dock/reference-file";

export const transitiveReference = file
  .from("same-a.txt")
  .reference("transitive-reference");
