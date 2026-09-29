// Two-browser smoke test (spec §15): create code → join → ready → start → a kill by real
// key presses → round → match end, seen identically by both players. Each player has
// its own browser context (separate storage, like two devices).

import { expect, test, type Page } from '@playwright/test';
import { chaseAndShoot } from '../../src/client/bot';
import { directionForScreen } from '../../src/camera';
import type { ClientView } from '../../src/client/model';
import type { Direction } from '../../src/sim';

const KEY_FOR: Record<Direction, string> = {
  [directionForScreen('up')]: 'ArrowUp',
  [directionForScreen('down')]: 'ArrowDown',
  [directionForScreen('left')]: 'ArrowLeft',
  [directionForScreen('right')]: 'ArrowRight',
} as Record<Direction, string>;

async function view(page: Page): Promise<ClientView> {
  return page.evaluate(() => window.GameClient.view());
}

async function openHome(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.locator('input.name').fill(name);
}

test('two players: create, join, play to a winner', async ({ browser }) => {
  const errors: string[] = [];
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const p of [a, b]) p.on('pageerror', (e) => errors.push(e.message));

  // Ann creates a room; its code is shown in the lobby.
  await openHome(a, 'Ann');
  await a.getByRole('button', { name: 'Create game' }).click();
  const code = (await a.locator('.code-big strong').textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9]{5}$/);

  // Bo joins with the code and readies.
  await openHome(b, 'Bo');
  await b.locator('input.code').fill(code.toLowerCase());
  await b.getByRole('button', { name: 'Join' }).click();
  await expect(b.locator('.code-big strong')).toHaveText(code);
  await b.getByRole('button', { name: 'Ready' }).click();

  // Ann picks the open map and a one-point match, and starts.
  await a.locator('select[data-key="mapId"]').selectOption('open');
  const target = a.locator('input[data-key="targetScore"]');
  await target.fill('1');
  await target.dispatchEvent('change');
  await expect(a.locator('.players li')).toHaveCount(2);
  await expect(a.getByRole('button', { name: 'Start match' })).toBeEnabled();
  await a.getByRole('button', { name: 'Start match' }).click();
  await expect(a.locator('#ui')).toHaveAttribute('data-screen', 'match');
  await expect(b.locator('#ui')).toHaveAttribute('data-screen', 'match');
  await expect(a.locator('.hud')).toContainText('Ann (you)');

  // Ann hunts Bo with real key presses; the decisions come from the bots' strategy.
  await a.locator('canvas').click({ position: { x: 5, y: 5 } }); // focus the page, not a field
  let held: string | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const v = await view(a);
    if (v.screen !== 'match') break;
    const bo = v.snapshot?.players.find((p) => p.id !== v.playerId);
    if (!v.snapshot || !v.playerId || !bo) continue;
    const decision = chaseAndShoot(v.snapshot, v.playerId, bo.id);
    const key = decision.moveDir ? KEY_FOR[decision.moveDir] : null;
    if (key !== held) {
      if (held) await a.keyboard.up(held);
      if (key) await a.keyboard.down(key);
      held = key;
    }
    if (decision.shoot) await a.keyboard.press('Space');
    await a.waitForTimeout(40);
  }
  if (held) await a.keyboard.up(held);

  // Both players see the same result.
  await expect(a.locator('.matchend h2')).toHaveText('Ann wins the match');
  await expect(b.locator('.matchend h2')).toHaveText('Ann wins the match');
  const final = await view(b);
  expect(final.result).toEqual({ winnerId: (await view(a)).playerId, scores: expect.any(Object) });

  // Back to the lobby together.
  await a.getByRole('button', { name: 'Back to lobby' }).click();
  await expect(a.locator('#ui')).toHaveAttribute('data-screen', 'lobby');
  expect(errors).toEqual([]);

  await ctxA.close();
  await ctxB.close();
});

test('practice runs in the browser with no server involvement', async ({ page }) => {
  await openHome(page, 'Solo');
  await page.getByRole('button', { name: 'Practice' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  const before = (await view(page)).snapshot!.players[0]!.pos;
  await page.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.down(before.x > 20 ? 'ArrowLeft' : 'ArrowRight');
  await page.waitForTimeout(400);
  await page.keyboard.up(before.x > 20 ? 'ArrowLeft' : 'ArrowRight');
  const after = (await view(page)).snapshot!.players[0]!.pos;
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(0.5);
});
