// M2.5 tasks 4-5: play vs bots in the browser, no server involved — Home → "Play vs bots"
// → setup → a match against bots with real key presses → match end → Play again → Home.
// Long stretches are advanced with window.GameClient.runTicks (paused page loop), so the
// test is fast and doesn't depend on real-time bot fights.

import { expect, test, type Page } from '@playwright/test';
import type { ClientView } from '../../src/client/model';

async function view(page: Page): Promise<ClientView> {
  return page.evaluate(() => window.GameClient.view());
}

/** With the page loop paused, run the match headlessly until it's over. */
async function playToTheEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.GameClient.pause();
    for (let i = 0; i < 100 && window.GameClient.view().screen === 'match'; i++) window.GameClient.runTicks(600);
  });
}

test('play vs bots: set up, play with the keyboard, finish, play again, go home', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('input.name').fill('Ann');
  await page.getByRole('button', { name: 'Play vs bots' }).click();

  // The setup screen: bot count, difficulty, map, target score.
  const setup = page.locator('.panel.setup');
  await expect(setup).toBeVisible();
  await expect(setup.locator('select[data-key="bots"] option')).toHaveCount(7); // 1–7 bots (8 players at most)
  await setup.locator('select[data-key="bots"]').selectOption('3');
  await setup.locator('select[data-key="difficulty"]').selectOption('hard');
  await setup.locator('select[data-key="mapId"]').selectOption('open');
  await setup.locator('input[data-key="targetScore"]').fill('1');
  await setup.getByRole('button', { name: 'Start' }).click();

  // Straight into the match (no lobby), bots named by number and difficulty.
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  const hud = page.locator('.hud');
  for (const name of ['Ann (you)', 'Bot 2 (Hard)', 'Bot 3 (Hard)', 'Bot 4 (Hard)']) await expect(hud).toContainText(name);
  expect(await page.evaluate(() => window.GameAPI?.getState().players.length)).toBe(4);

  // The keyboard drives the human: hold a key while a third of a second is simulated.
  await page.locator('canvas').click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => window.GameClient.pause());
  const me = (v: ClientView) => v.snapshot!.players.find((p) => p.id === v.playerId)!;
  const before = me(await view(page));
  const key = before.pos.x > 20 ? 'ArrowLeft' : 'ArrowRight';
  await page.keyboard.down(key);
  await page.evaluate(() => window.GameClient.runTicks(20));
  await page.keyboard.up(key);
  const after = me(await view(page));
  // (shot within that third of a second by a hard bot: dead, so it couldn't move — rare)
  expect(Math.hypot(after.pos.x - before.pos.x, after.pos.y - before.pos.y) > 0.5 || !after.alive).toBe(true);

  // To the end of the match.
  await playToTheEnd(page);
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'matchEnd');
  await expect(page.locator('.matchend h2')).toContainText('wins the match');
  expect(await page.evaluate(() => sessionStorage.getItem('bps.lastRoom'))).toBeNull(); // nothing to rejoin

  // Play again: the same bots, a new match.
  await page.evaluate(() => window.GameClient.resume());
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  await expect(hud).toContainText('Bot 4 (Hard)');

  // Leave → Home; the local game is gone.
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'home');
  expect(await page.evaluate(() => window.GameAPI)).toBeNull();
  expect(errors).toEqual([]);
});

test('the setup screen remembers the last choices, and Back returns home', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Play vs bots' }).click();
  const setup = page.locator('.panel.setup');
  await setup.locator('select[data-key="bots"]').selectOption('5');
  await setup.locator('select[data-key="difficulty"]').selectOption('easy');
  await setup.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'home');
  await page.reload();
  await page.getByRole('button', { name: 'Play vs bots' }).click();
  await expect(setup.locator('select[data-key="bots"]')).toHaveValue('5');
  await expect(setup.locator('select[data-key="difficulty"]')).toHaveValue('easy');
});

test('window.GameClient.startLocalMatch runs the same kind of match for a harness', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.GameClient !== undefined); // defined once the physics engine has loaded
  await page.evaluate(() => window.GameClient.startLocalMatch({ bots: 2, difficulty: 'easy', mapId: 'open', targetScore: 1, seed: 3 }, 'Harness'));
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  const names = await page.evaluate(() => window.GameAPI!.getState().players.map((p) => p.name));
  expect(names).toEqual(['Harness', 'Bot 2 (Easy)', 'Bot 3 (Easy)']);
  await playToTheEnd(page);
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'matchEnd');
  // Play again only after a match — mid-match it is ignored (review of task 3, finding 1).
  await page.evaluate(() => window.GameClient.resume());
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  await page.evaluate(() => window.GameClient.playAgain());
  expect((await view(page)).screen).toBe('match');
});
