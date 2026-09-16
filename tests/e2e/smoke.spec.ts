import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUTPUT_DIR = path.resolve("tests/e2e/output");

test.beforeAll(() => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
});

test("home page loads without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  await page.goto("/");
  await page.waitForSelector("canvas", { state: "attached" });

  expect(errors, `console errors: ${errors.join("; ")}`).toEqual([]);
});

test("3D canvas renders non-blank pixels", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("canvas", { state: "attached" });
  // Give three.js at least one frame after the canvas attaches.
  await page.waitForTimeout(300);

  const shotPath = path.join(OUTPUT_DIR, "canvas-non-blank.png");
  const canvas = page.locator("canvas");
  await canvas.screenshot({ path: shotPath });

  // Pixel check inside the page: at least one pixel differs from the initial
  // clear color. This proves the WebGL context painted something.
  const distinctColors = await page.evaluate(() => {
    const cv = document.querySelector("canvas") as HTMLCanvasElement | null;
    if (!cv) return 0;
    const gl = (cv.getContext("webgl2") ?? cv.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return 0;
    const w = Math.min(cv.width, 200);
    const h = Math.min(cv.height, 200);
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const seen = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      const rgb = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      seen.add(rgb);
      if (seen.size > 4) return seen.size;
    }
    return seen.size;
  });
  expect(distinctColors, "canvas painted only one color; likely blank").toBeGreaterThan(1);
});

test("window.__game hook is present and reports practice state", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __game?: unknown }).__game));

  const shape = await page.evaluate(() => {
    const g = (window as unknown as { __game?: { getState: () => unknown } }).__game;
    if (!g) return null;
    const s = g.getState() as { phase?: string; tick?: number };
    return { phase: s.phase ?? null, tickIsNumber: typeof s.tick === "number" };
  });

  expect(shape).not.toBeNull();
  expect(shape!.phase).toBe("practice");
  expect(shape!.tickIsNumber).toBe(true);

  // press() must exist and be callable; walking skeleton has no observable
  // side effect yet (empty players array) — gameplay issues extend the hook.
  const pressOk = await page.evaluate(() => {
    const g = (window as unknown as { __game?: { press: (k: string) => void } }).__game;
    if (!g) return false;
    g.press("ArrowUp");
    g.press("Space");
    return true;
  });
  expect(pressOk).toBe(true);
});
