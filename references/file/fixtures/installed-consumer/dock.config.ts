import { file, type FileReference } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

const guide: FileReference = file.from("guide.md").reference("guide");

export default defineConfig({
  plugins: [file],
  bindings: [binding("guide-policy", [guide])],
});
