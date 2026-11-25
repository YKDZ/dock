import { binding, defineConfig, file } from "@boringparts/dock";

const runtimePort = file
  .from("guide.md")
  .region("runtime")
  .match("port=(\\d+)", 1)
  .reference("runtime-port");

export default defineConfig({
  plugins: [file],
  bindings: [binding("runtime-policy", [runtimePort])],
});
