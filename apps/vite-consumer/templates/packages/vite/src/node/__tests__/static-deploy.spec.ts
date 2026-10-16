import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { access, cp, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

const runCommand = promisify(execFile);

describe("本地静态部署", () => {
  test("新鲜构建的 HTML 和资源可经预览服务读取", async () => {
    const root = await mkdtemp(join(process.cwd(), ".dock-workflow-"));
    await cp(new URL("./fixtures/dock-static-site/", import.meta.url), root, {
      recursive: true,
    });
    const output = join(root, "dist");
    let preview: ReturnType<typeof spawn> | undefined;
    try {
      await assert.rejects(access(output), { code: "ENOENT" });
      if (process.env.DOCK_VITE_OMIT_BUILD !== "1") {
        await runCommand("npm", ["run", "build"], { cwd: root });
        await access(output);
      }
      preview = spawn(
        "npm",
        [
          "run",
          "preview",
          "--",
          "--host",
          "127.0.0.1",
          "--port",
          "0",
          "--strictPort",
        ],
        { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      if (process.env.DOCK_VITE_OMIT_BUILD === "1") {
        await assert.rejects(
          waitForPreview(preview),
          /The directory "dist" does not exist/u,
        );
        expect.fail("遗漏构建步骤后预览必须失败");
      }
      const origin = await waitForPreview(preview);
      const page = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
      const html = await page.text();
      expect(page.status, "遗漏构建步骤后预览必须失败").toBe(200);
      expect(html).toContain("静态预览");
      const script = html.match(/src="([^"\s]+\.js)"/)?.[1];
      assert.ok(script, "预览 HTML 必须引用打包后的 JavaScript");
      expect(script).toMatch(/^\/assets\/.+\.js$/);
      const resource = await fetch(new URL(script, origin), {
        signal: AbortSignal.timeout(5_000),
      });
      expect(resource.status).toBe(200);
      expect(await resource.text()).toContain("构建制品已加载");
    } finally {
      if (preview !== undefined) await stopPreview(preview);
      await rm(root, { recursive: true, force: true });
    }
  });
});

function waitForPreview(preview: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolveOrigin, rejectOrigin) => {
    let output = "";
    const timer = setTimeout(() => rejectOrigin(new Error(output)), 10_000);
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      const address = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (address !== undefined) {
        clearTimeout(timer);
        resolveOrigin(address);
      }
    };
    preview.stdout?.on("data", collect);
    preview.stderr?.on("data", collect);
    preview.once("error", (error) => {
      clearTimeout(timer);
      rejectOrigin(error);
    });
    preview.once("exit", (code) => {
      clearTimeout(timer);
      rejectOrigin(
        new Error(`预览在可访问前退出（${String(code)}）：${output}`),
      );
    });
  });
}

async function stopPreview(preview: ReturnType<typeof spawn>): Promise<void> {
  if (preview.exitCode !== null || preview.signalCode !== null) return;
  signalPreview(preview, "SIGTERM");
  if (await waitForClose(preview, 5_000)) return;
  signalPreview(preview, "SIGKILL");
  assert.ok(await waitForClose(preview, 5_000), "预览进程没有退出");
}

function signalPreview(
  preview: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void {
  if (preview.pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-preview.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  } else {
    preview.kill(signal);
  }
}

function waitForClose(
  preview: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<boolean> {
  if (preview.exitCode !== null || preview.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolveClosed) => {
    const timer = setTimeout(() => {
      preview.off("close", onClose);
      resolveClosed(false);
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolveClosed(true);
    };
    preview.once("close", onClose);
  });
}
