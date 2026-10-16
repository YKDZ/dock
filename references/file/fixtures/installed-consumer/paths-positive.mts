import {
  file,
  type FileReference,
  type FileTextSelection,
} from "@dock/reference-file";
import { type ReferenceOptions, type ReferenceValue } from "@dock/sdk";

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
