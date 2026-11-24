import { file } from "@ykdz/dock";

export const transitiveReference = file
  .from("same-a.txt")
  .reference("transitive-reference");
