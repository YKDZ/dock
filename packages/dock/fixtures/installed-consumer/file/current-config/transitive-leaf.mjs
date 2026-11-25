import { file } from "@boringparts/dock";

export const transitiveReference = file
  .from("same-a.txt")
  .reference("transitive-reference");
