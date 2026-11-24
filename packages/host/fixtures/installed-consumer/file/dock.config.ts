import { binding, defineConfig, file, type FileReference } from "@ykdz/dock";

const guide: FileReference = file.from("guide.md").reference("guide");

export default defineConfig({
  plugins: [file],
  bindings: [binding("guide-policy", [guide])],
});
