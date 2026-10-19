import { binding, defineConfig } from "@ykdz/dock";
import { file, type FileReference } from "@ykdz/dock-reference-file";

const guide: FileReference = file.from("guide.md").reference("guide");

export default defineConfig({
  plugins: [file],
  bindings: [binding("guide-policy", [guide])],
});
