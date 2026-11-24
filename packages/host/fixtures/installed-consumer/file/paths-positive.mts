import {
  file,
  type FileReference,
  type FileTextSelection,
  type ReferenceOptions,
  type ReferenceValue,
} from "@ykdz/dock";

const localText = file
  .at(import.meta.url)
  .from("./guide.md")
  .quote("Current body")
  .reference("local-text");
const localValue: ReferenceValue<typeof localText> = "Current body";
const localReference: FileReference<"local-text", string, FileTextSelection> =
  localText;
const location: string = localText.target;
const localOptions: ReferenceOptions = { declaredAt: import.meta.url };
void localValue;
void localReference;
void location;
void localOptions;
