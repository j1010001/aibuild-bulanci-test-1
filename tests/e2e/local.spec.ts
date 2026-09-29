// M2.5 tasks 4-5: play vs bots in the browser, no server involved — Home → "Play vs bots"
// → setup → a match against bots with real key presses → match end → Play again → Home.
// Long stretches are advanced with window.GameClient.runTicks (paused page loop), so the
// test is fast and doesn't depend on real-time bot fights.

import { expect, test, type Page } from '@playwright/test';
import type { ClientView } from '../../src/client/model';
import { BUILT_IN_MAPS } from '../../src/session/maps';

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

test('play vs bots: set up, finish, play again, leave for home', async ({ page }) => {
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
  // Every setup choice reached the game: the map and the round wins to win.
  expect(await page.evaluate(() => window.GameAPI!.getState().config.targetScore)).toBe(1);
  expect((await view(page)).match!.map).toEqual(BUILT_IN_MAPS.find((m) => m.id === 'open')!.map);

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
  await setup.locator('select[data-key="mapId"]').selectOption('open');
  await setup.locator('input[data-key="targetScore"]').fill('4');
  await setup.locator('input[data-key="targetScore"]').dispatchEvent('change');
  await setup.getByRole('button', { name: 'Back' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'home');
  await page.reload();
  await page.getByRole('button', { name: 'Play vs bots' }).click();
  await expect(setup.locator('select[data-key="bots"]')).toHaveValue('5');
  await expect(setup.locator('select[data-key="difficulty"]')).toHaveValue('easy');
  await expect(setup.locator('select[data-key="mapId"]')).toHaveValue('open');
  await expect(setup.locator('input[data-key="targetScore"]')).toHaveValue('4');
});

test('stored setup values that are not valid fall back to the defaults', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('bps.botSetup', JSON.stringify({ bots: 99, difficulty: 'godlike', mapId: 'x', targetScore: 0 })));
  await page.reload();
  await page.getByRole('button', { name: 'Play vs bots' }).click();
  const setup = page.locator('.panel.setup');
  await expect(setup.locator('select[data-key="bots"]')).toHaveValue('3');
  await expect(setup.locator('select[data-key="difficulty"]')).toHaveValue('normal');
  await expect(setup.locator('select[data-key="mapId"]')).toHaveValue(BUILT_IN_MAPS[0]!.id);
  await expect(setup.locator('input[data-key="targetScore"]')).toHaveValue('3');
});

test('the setup screen by keyboard: focus starts on it, Enter starts; an emptied score keeps the previous value', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('bps.botSetup', JSON.stringify({ bots: 1, difficulty: 'easy', mapId: 'open', targetScore: 4 })));
  await page.reload();
  await page.getByRole('button', { name: 'Play vs bots' }).click();
  await expect(page.locator('select[data-key="bots"]')).toBeFocused();
  await page.locator('input[data-key="targetScore"]').fill('');
  await page.keyboard.press('Enter');
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  expect(await page.evaluate(() => window.GameAPI!.getState().config.targetScore)).toBe(4);
});

test('window.GameClient.startLocalMatch runs the same kind of match for a harness', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.GameClient !== undefined); // defined once the physics engine has loaded
  await page.evaluate(() => window.GameClient.startLocalMatch({ bots: 2, difficulty: 'easy', mapId: 'open', targetScore: 1, seed: 3 }, 'Harness'));
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  const names = await page.evaluate(() => window.GameAPI!.getState().players.map((p) => p.name));
  expect(names).toEqual(['Harness', 'Bot 2 (Easy)', 'Bot 3 (Easy)']);

  // The keyboard drives the human. Paused at once, so the page loop can't let anyone act
  // first; easy bots wait at least 400 ms after lining up, so a third of a second of
  // simulated play can't get the human killed.
  await page.evaluate(() => window.GameClient.pause());
  const me = (v: ClientView) => v.snapshot!.players.find((p) => p.id === v.playerId)!;
  const before = me(await view(page));
  expect(before.alive).toBe(true);
  await page.locator('canvas').click({ position: { x: 5, y: 5 } });
  const key = before.pos.x > 20 ? 'ArrowLeft' : 'ArrowRight';
  await page.keyboard.down(key);
  await page.evaluate(() => window.GameClient.runTicks(20));
  await page.keyboard.up(key);
  const after = me(await view(page));
  expect(after.alive).toBe(true);
  expect(Math.hypot(after.pos.x - before.pos.x, after.pos.y - before.pos.y)).toBeGreaterThan(0.5);

  await playToTheEnd(page);
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'matchEnd');
  // Play again only after a match — mid-match it is ignored (review of task 3, finding 1).
  await page.evaluate(() => window.GameClient.resume());
  await page.getByRole('button', { name: 'Play again' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'match');
  await page.evaluate(() => window.GameClient.playAgain());
  expect((await view(page)).screen).toBe('match');
  // …and Home from the results screen.
  await playToTheEnd(page);
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.locator('#ui')).toHaveAttribute('data-screen', 'home');
  expect(await page.evaluate(() => window.GameAPI)).toBeNull();
});
