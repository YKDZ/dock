import { type ReferenceOptions, type ReferenceValue } from "@ykdz/dock";
import {
  file,
  type FileReference,
  type FileTextSelection,
} from "@ykdz/dock-reference-file";

const localText = file
  .at(import.meta.url)
  .from("./guide.md")
  .quote("当前正文")
  .reference("local-text");
const localValue: ReferenceValue<typeof localText> = "当前正文";
const localReference: FileReference<"local-text", string, FileTextSelection> =
  localText;
const location: string = localText.target;
const localOptions: ReferenceOptions = { declaredAt: import.meta.url };
void localValue;
void localReference;
void location;
void localOptions;
