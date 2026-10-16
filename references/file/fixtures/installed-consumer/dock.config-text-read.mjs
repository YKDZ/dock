import { file } from "@dock/reference-file";
import { binding, defineConfig } from "@dock/sdk";

const runtimePort = file
  .from("guide.md")
  .region("runtime")
  .match("port=(\\d+)", 1)
  .reference("runtime-port");

export default defineConfig({
  plugins: [file],
  bindings: [binding("runtime-policy", [runtimePort])],
});
