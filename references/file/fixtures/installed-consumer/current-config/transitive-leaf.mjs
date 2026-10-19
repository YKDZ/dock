import { file } from "@ykdz/dock-reference-file";

export const transitiveReference = file
  .from("same-a.txt")
  .reference("transitive-reference");
