import { file } from "@boringparts/dock";

export const dependencyReference = file
  .from("same-a.txt")
  .reference("dependency-reference");
