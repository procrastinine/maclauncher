// Run against a local Vite preview using Playwright's page object and createLibraryFixture().
// The injected bridge records calls; no game, runtime, file, or network action reaches Electron.
module.exports = async function libraryLayoutBrowserTests(page, fixture) {
  const origin = new URL(page.url()).origin;
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const errors = [];
  const externalRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) externalRequests.push(request.url());
  });
  await page.addInitScript(state => {
    const stored = localStorage.getItem('__libraryFixturePreferences');
    if (stored) state.launcherSettings = JSON.parse(stored);
    const listeners = new Set();
    const calls = [];
    const test = window.__libraryTest = { state, calls, rowReads: {}, detailReads: 0 };
    for (const game of state.recents) {
      const name = game.name;
      Object.defineProperty(game, 'name', { enumerable: true, get() {
        test.rowReads[name] = (test.rowReads[name] || 0) + 1;
        return name;
      } });
    }
    const infoFields = state.modules[0].ui.infoFields;
    Object.defineProperty(state.modules[0].ui, 'infoFields', { enumerable: true, get() {
      test.detailReads++;
      return infoFields;
    } });
    test.broadcast = patch => {
      test.state = { ...test.state, ...patch };
      if (patch.launcherSettings) localStorage.setItem('__libraryFixturePreferences', JSON.stringify(test.state.launcherSettings));
      for (const listener of listeners) listener(test.state);
    };
    const patchGame = (gamePath, patch) => test.broadcast({ recents: test.state.recents.map(game => game.gamePath === gamePath ? { ...game, ...patch } : game) });
    const record = (method, result = true) => async (...args) => { calls.push({ method, args }); return result; };
    const api = {
      getState: async () => test.state,
      onState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      onOpenSettings: () => () => {},
      moduleAction: async (...args) => {
        calls.push({ method: 'moduleAction', args });
        if (args[1] === 'readSaveDocument') return { json: '{"a":1}', sourceHash: 'fixture-hash' };
        return args[1] === 'runtimeStatus' ? { ready: true, resolvedVersion: '2.0' } : { value: 'Ready' };
      },
      getCheatsPatchStatus: record('getCheatsPatchStatus', { patched: false }),
      getLibsPatchStatus: record('getLibsPatchStatus', { patched: false }),
      patchLibs: record('patchLibs', { patched: true }), unpatchLibs: record('unpatchLibs', { patched: false }),
      patchCheatsIntoGame: record('patchCheatsIntoGame', { patched: true }), unpatchCheatsFromGame: record('unpatchCheatsFromGame', { patched: false }),
      revealInFinder: record('revealInFinder'), createGameCommand: record('createGameCommand', '/Shortcuts/Alpha.command'),
      openRuntimeSettings: record('openRuntimeSettings'), runtimeAction: record('runtimeAction'),
      getSaveInfo: record('getSaveInfo', { name: 'Alpha', moduleId: 'fixture', moduleLabel: 'Fixture engine', saveDir: '/Saves/custom', canEditJson: true }),
      listSaveFiles: record('listSaveFiles', [{ name: 'save.json', path: '/Saves/custom/save.json', size: 42, mtimeMs: 0 }]),
      readSaveJson: record('readSaveJson', '{"a":1}'), setCheats: record('setCheats'),
      findMissingGames: async paths => {
        calls.push({ method: 'findMissingGames', args: [paths] });
        return paths.filter(path => [state.recents[2].gamePath, state.recents[4].gamePath].includes(path));
      },
      forgetGames: async paths => {
        calls.push({ method: 'forgetGames', args: [paths] });
        test.broadcast({ recents: test.state.recents.filter(game => !paths.includes(game.gamePath)) });
        return { removedPaths: paths, failures: [] };
      },
      deleteGames: async paths => {
        calls.push({ method: 'deleteGames', args: [paths] });
        test.broadcast({ recents: test.state.recents.filter(game => !paths.includes(game.gamePath)) });
        return { removedPaths: paths, failures: [] };
      },
      setGameModuleData: record('setGameModuleData'),
      pickSaveDir: record('pickSaveDir'), resetSaveDir: record('resetSaveDir'),
      setGameLibVersion: record('setGameLibVersion'),
      setGameRuntime: async (gamePath, runtimeId) => {
        calls.push({ method: 'setGameRuntime', args: [gamePath, runtimeId] }); patchGame(gamePath, { runtimeId });
      },
      setGameRuntimeData: async (gamePath, runtimeId, patch) => {
        calls.push({ method: 'setGameRuntimeData', args: [gamePath, runtimeId, patch] });
        const game = test.state.recents.find(game => game.gamePath === gamePath);
        patchGame(gamePath, { runtimeData: { ...game.runtimeData, [runtimeId]: { ...game.runtimeData[runtimeId], ...patch } } });
      },
      launchGame: async gamePath => {
        calls.push({ method: 'launchGame', args: [gamePath] });
        patchGame(gamePath, { lastPlayedAt: Date.now() }); test.broadcast({ running: { [gamePath]: 1 } });
      },
      stopGame: async gamePath => { calls.push({ method: 'stopGame', args: [gamePath] }); test.broadcast({ running: {} }); },
      forgetGame: async gamePath => {
        calls.push({ method: 'forgetGame', args: [gamePath] }); test.broadcast({ recents: test.state.recents.filter(game => game.gamePath !== gamePath) });
      },
      moveGame: async (gamePath, delta) => {
        calls.push({ method: 'moveGame', args: [gamePath, delta] });
        const recents = test.state.recents.slice();
        const index = recents.findIndex(game => game.gamePath === gamePath);
        const next = Math.max(0, Math.min(recents.length - 1, index + delta));
        recents.splice(next, 0, recents.splice(index, 1)[0]); test.broadcast({ recents });
      },
      reorderGame: async (gamePath, toIndex) => {
        calls.push({ method: 'reorderGame', args: [gamePath, toIndex] });
        const ids = new Set(test.state.launcherSettings.library.favorites);
        const display = test.state.recents.slice().sort((a, b) => Number(ids.has(b.gameId)) - Number(ids.has(a.gameId)));
        const from = display.findIndex(game => game.gamePath === gamePath);
        const favorite = ids.has(display[from].gameId);
        const count = display.filter(game => ids.has(game.gameId)).length;
        const index = Math.max(favorite ? 0 : count, Math.min(favorite ? count - 1 : display.length - 1, toIndex));
        display.splice(index, 0, display.splice(from, 1)[0]);
        const group = display.filter(game => ids.has(game.gameId) === favorite);
        let next = 0;
        test.broadcast({ recents: test.state.recents.map(game => ids.has(game.gameId) === favorite ? group[next++] : game) });
      },
      setGameFavorite: async (gamePath, favorite) => {
        calls.push({ method: 'setGameFavorite', args: [gamePath, favorite] });
        const game = test.state.recents.find(game => game.gamePath === gamePath);
        const library = test.state.launcherSettings.library;
        const favorites = library.favorites.filter(id => id !== game.gameId);
        if (favorite) favorites.push(game.gameId);
        test.broadcast({ launcherSettings: { ...test.state.launcherSettings, library: { ...library, favorites } } });
      },
      setLibrarySort: async sort => {
        calls.push({ method: 'setLibrarySort', args: [sort] });
        test.broadcast({ launcherSettings: { ...test.state.launcherSettings, library: { ...test.state.launcherSettings.library, sort } } });
      },
      setLauncherSettings: async patch => test.broadcast({ launcherSettings: { ...test.state.launcherSettings, ...patch } }),
      setModuleSettings: async (id, patch) => {
        calls.push({ method: 'setModuleSettings', args: [id, patch] });
        test.broadcast({ moduleSettings: { ...test.state.moduleSettings, [id]: { ...test.state.moduleSettings[id], ...patch } } });
      },
      openGameDialog: record('openGameDialog', []), openExternal: record('openExternal')
    };
    window.MacLauncher = { launcher: api };
    window.confirm = () => true;
    window.alert = () => {};
  }, fixture);
  await page.evaluate(() => localStorage.removeItem('__libraryFixturePreferences'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Show details for Alpha', exact: true }).waitFor();
  const details = page.locator('#game-details');
  const title = page.locator('#game-details-title');
  const select = name => page.getByRole('button', { name: `Show details for ${name}`, exact: true });
  const boxes = () => page.locator('.gameRow').evaluateAll(rows => rows.slice(0, 3).map(row => {
    const { x, y, width, height } = row.getBoundingClientRect(); return { x, y, width, height };
  }));
  const called = async (method, path) => page.evaluate(({ method, path }) => window.__libraryTest.calls.some(call => call.method === method && (!path || call.args[0] === path)), { method, path });
  assert(await title.textContent() === 'Game details', 'Initial selection must be empty');
  assert(!await details.isVisible(), 'The unselected library must use the full width');
  assert(!await called('moduleAction'), 'Unselected games must not run detail actions');
  await select('Alpha').focus();
  await select('Alpha').press('Enter');
  await page.waitForFunction(() => document.querySelector('#game-details-title').textContent === 'Alpha');
  await details.getByText('Status:', { exact: true }).waitFor();
  assert(await select('Alpha').getAttribute('aria-pressed') === 'true', 'Keyboard selection must expose pressed state');
  assert(await select('Alpha').evaluate(button => button === document.activeElement), 'Selection must retain keyboard focus');
  await select('Alpha').press('Space');
  assert(await title.textContent() === 'Alpha', 'Selecting the same game must not collapse its details');
  const initialBoxes = await boxes();
  assert(initialBoxes.every(box => box.height <= 66), 'Game rows must retain compact height even with override badges');
  await select('Beta').click();
  await page.waitForFunction(() => document.querySelector('#game-details-title').textContent === 'Beta');
  assert(await select('Alpha').getAttribute('aria-pressed') === 'false', 'Previous selection must clear');
  assert(JSON.stringify(await boxes()) === JSON.stringify(initialBoxes), 'Selecting games must not move or resize rows');
  assert(await page.locator('.gameList .gameDetails').count() === 0, 'Details must remain outside the list');
  const layout = await page.evaluate(() => {
    const list = document.querySelector('.libraryPane').getBoundingClientRect();
    const detail = document.querySelector('.detailsPane').getBoundingClientRect();
    return { listRight: list.right, detailLeft: detail.left, listTop: list.top, detailTop: detail.top };
  });
  assert(layout.detailLeft > layout.listRight && layout.detailTop === layout.listTop, 'Wide layout must place stable details to the right');
  await select('Alpha').click();
  await details.getByRole('combobox', { name: 'Managed runtime version', exact: true }).selectOption('1.0');
  await details.getByRole('combobox', { name: 'Runtime variant', exact: true }).selectOption('x64');
  await details.getByRole('combobox', { name: 'Channel', exact: true }).selectOption('preview');
  await details.getByRole('combobox', { name: 'Engine library', exact: true }).selectOption('2');
  await details.getByRole('button', { name: 'Runtime settings', exact: true }).click();
  await details.getByRole('button', { name: 'Extract', exact: true }).click();
  await select('Alpha').locator('..').getByRole('button', { name: 'Shortcut', exact: true }).click();
  assert(await called('openRuntimeSettings') && await called('setGameLibVersion') && await called('createGameCommand'), 'Details tools must retain their callbacks');
  const alphaPath = fixture.recents[0].gamePath;
  await page.locator('.libraryPane').getByRole('button', { name: 'Play Alpha', exact: true }).click();
  await page.locator('.libraryPane').getByRole('button', { name: 'Stop Alpha', exact: true }).waitFor();
  await page.locator('.libraryPane').getByRole('button', { name: 'Stop Alpha', exact: true }).click();
  await page.locator('.libraryPane').getByRole('button', { name: 'Play Alpha', exact: true }).waitFor();
  assert(await called('launchGame', alphaPath) && await called('stopGame', alphaPath), 'Row and details Play/Stop must use the selected path');
  await page.evaluate(() => { window.__libraryTest.rowReads = {}; window.__libraryTest.detailReads = 0; });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.modalBackdrop').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Runtimes', exact: true }).click();
  await page.locator('.modalBackdrop').waitFor();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const modalReads = await page.evaluate(() => ({ rows: window.__libraryTest.rowReads, details: window.__libraryTest.detailReads }));
  assert(Object.keys(modalReads.rows).length === 0 && modalReads.details === 0, 'Unrelated modal updates must not rerender rows or details');
  await select('Alpha').locator('..').getByRole('button', { name: 'Saves', exact: true }).click();
  await page.getByRole('button', { name: 'Edit JSON', exact: true }).click();
  await page.locator('textarea.codeArea').fill('{"a":2}');
  await page.getByRole('button', { name: 'Format', exact: true }).click();
  const editReads = await page.evaluate(() => ({ beta: window.__libraryTest.rowReads.Beta || 0, details: window.__libraryTest.detailReads }));
  assert(editReads.beta === 0 && editReads.details === 0, 'Save editing must not rerender unrelated rows or details');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await select('Alpha').locator('..').getByRole('button', { name: 'Cheats', exact: true }).click();
  await page.locator('.modalBackdrop').waitFor();
  await page.locator('.modalBackdrop input[type="number"]').fill('10');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  assert(await called('setCheats', alphaPath), 'Cheat editing must remain functional');
  await page.locator('.libraryPane').getByRole('button', { name: 'Reorder Beta', exact: true }).focus();
  await page.locator('.libraryPane').getByRole('button', { name: 'Reorder Beta', exact: true }).press('Alt+ArrowUp');
  await page.waitForFunction(() => document.querySelector('.gameSelect').getAttribute('aria-label') === 'Show details for Beta');
  assert(await title.textContent() === 'Alpha', 'Keyboard reordering must preserve selection');
  // Exercise the original internal drag/drop path as well as its keyboard alternative.
  await page.evaluate(() => {
    window.__libraryDrag = new DataTransfer();
    document.querySelector('[aria-label="Reorder Alpha"]').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: window.__libraryDrag }));
  });
  await page.evaluate(() => {
    const list = document.querySelector('.gameList');
    list.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientY: list.getBoundingClientRect().top + 1, dataTransfer: window.__libraryDrag }));
  });
  await page.waitForFunction(() => document.querySelector('.gameSelect').getAttribute('aria-label') === 'Show details for Alpha');
  await page.evaluate(() => document.querySelector('.gameList').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__libraryDrag })));
  await page.waitForFunction(() => window.__libraryTest.calls.filter(call => call.method === 'reorderGame').length >= 2);
  assert(await title.textContent() === 'Alpha', 'Drag reordering must preserve selection');

  const rowNames = () => page.locator('.gameSelect').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label').replace('Show details for ', '')));
  const sort = page.getByRole('combobox', { name: 'Sort games', exact: true });
  const beforePlay = await rowNames();
  await page.getByRole('button', { name: 'Play Beta', exact: true }).click();
  await page.getByRole('button', { name: 'Stop Beta', exact: true }).click();
  assert(JSON.stringify(await rowNames()) === JSON.stringify(beforePlay), 'Playing a game in Default must preserve dragged order');
  await page.getByRole('searchbox', { name: 'Search games' }).fill('Game-');
  const hiddenBefore = await page.evaluate(() => window.__libraryTest.state.recents.filter(game => !game.gamePath.includes('Game-')).map(game => game.gameId));
  await page.getByRole('button', { name: 'Reorder Game 4', exact: true }).press('Alt+ArrowUp');
  assert((await rowNames()).slice(0, 3).join(',') === 'Game 2,Game 4,Game 3', 'Filtered Default reordering must move visible games');
  const hiddenAfter = await page.evaluate(() => window.__libraryTest.state.recents.filter(game => !game.gamePath.includes('Game-')).map(game => game.gameId));
  assert(JSON.stringify(hiddenBefore) === JSON.stringify(hiddenAfter), 'Filtered reorder must preserve hidden games');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await sort.selectOption('added');
  assert((await rowNames())[0] === 'Game 23', 'Date added must use the import timestamp');
  await sort.selectOption('custom');
  await page.getByRole('button', { name: 'Add Beta to favorites', exact: true }).click();
  await page.getByRole('button', { name: 'Remove Beta from favorites', exact: true }).waitFor();
  assert((await rowNames())[0] === 'Beta', 'Default must put favorites first');
  assert(await page.locator('.libraryGroupLabel').count() === 2, 'Default must separate Favorites and Games');
  await sort.selectOption('alphabetical');
  assert((await rowNames()).slice(0, 4).join(',') === 'Alpha,Beta,Game 2,Game 3', 'Alphabetical must use natural ordering without favoriting bias');
  assert(await page.locator('.libraryGroupLabel').count() === 0, 'Other sorts must mix favorites normally');
  assert(await page.getByRole('button', { name: 'Reorder Beta', exact: true }).count() === 0, 'Reorder controls must be hidden outside Default');
  await page.getByRole('searchbox', { name: 'Search games' }).fill('Game-');
  assert((await rowNames()).slice(0, 3).join(',') === 'Game 2,Game 3,Game 4', 'Search must preserve natural alphabetical ordering');
  assert(await sort.inputValue() === 'alphabetical', 'Search must retain the chosen sort');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.getByRole('combobox', { name: 'Show games', exact: true }).selectOption('favorites');
  assert((await rowNames()).join(',') === 'Beta', 'The Favorites filter must show only starred games');
  assert(await sort.inputValue() === 'alphabetical', 'Scope filters must preserve sort');
  await page.getByRole('combobox', { name: 'Show games', exact: true }).selectOption('all');
  await sort.selectOption('recent');
  assert((await rowNames())[0] === 'Beta', 'Last played must reflect the most recent play timestamp');
  await page.getByRole('button', { name: 'Reverse sort direction', exact: true }).click();
  assert((await rowNames())[0] === 'Alpha', 'Never-played games stay last in either direction');
  await page.reload();
  await sort.waitFor();
  assert(await sort.inputValue() === 'recent' && await page.getByRole('button', { name: 'Remove Beta from favorites', exact: true }).count() === 1, 'Favorites and chosen sort must survive a reload');
  await sort.selectOption('custom');
  await page.getByRole('button', { name: 'Remove Beta from favorites', exact: true }).click();
  await select('Alpha').click();

  await page.getByRole('button', { name: 'Select games', exact: true }).click();
  const selected = () => page.locator('.gameCheckbox:checked').count();
  await page.getByRole('checkbox', { name: 'Select Alpha', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Game 3', exact: true }).click({ modifiers: ['Shift'] });
  assert(await selected() === 4, 'Shift click must select a contiguous range in the visible order');
  await page.getByRole('searchbox', { name: 'Search games' }).fill('Game-');
  assert(await selected() === 2, 'Filtering must clear hidden selections');
  await page.getByRole('checkbox', { name: 'Select all visible games', exact: true }).click();
  assert(await selected() === 22, 'Select all must honor current search');
  await page.getByRole('button', { name: 'Select all missing', exact: true }).click();
  assert(await selected() === 2 && await page.locator('.missingLabel').count() === 2, 'Missing selection must use the explicit check result');
  await page.getByRole('searchbox', { name: 'Search games' }).fill('Game-2');
  assert(await selected() === 1, 'Missing selections hidden by search must clear');
  await page.getByRole('button', { name: 'Forget selected', exact: true }).click();
  assert(await page.evaluate(() => window.__libraryTest.calls.find(call => call.method === 'forgetGames').args[0].length) === 1, 'Bulk forget must include only visible selected games');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Game 4', exact: true }).click();
  await page.getByRole('button', { name: 'Move to Trash…', exact: true }).click();
  assert(await called('deleteGames'), 'Bulk trash must use its dedicated confirmed API');
  await page.getByRole('button', { name: 'Finish selecting games', exact: true }).click();
  await page.reload();
  await select('Alpha').click();

  await page.getByRole('searchbox', { name: 'Search games' }).fill('Beta');
  await page.waitForFunction(() => document.querySelector('#game-details-title').textContent === 'Game details');
  assert(!await page.getByRole('button', { name: 'Reorder Beta', exact: true }).isDisabled(), 'Default remains draggable while filtering');
  await page.getByRole('searchbox', { name: 'Search games' }).fill('');
  assert(await title.textContent() === 'Game details', 'Clearing a filter must not resurrect stale selection');
  await select('Alpha').click();
  await page.getByRole('button', { name: 'Show game types', exact: true }).click();
  await page.getByRole('button', { name: 'Deselect all', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#game-details-title').textContent === 'Game details');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  assert(await sort.inputValue() === 'custom', 'Backend filters must retain the chosen sort');
  await page.getByRole('button', { name: 'Hide game types', exact: true }).click();
  await select('Alpha').click();
  await page.setViewportSize({ width: 1440, height: 560 });
  const scrolling = await page.evaluate(() => {
    const list = document.querySelector('.gameList');
    const detail = document.querySelector('.gameDetails');
    list.scrollTop = 120;
    const before = list.scrollTop;
    detail.scrollTop = 180;
    return { before, after: list.scrollTop, detail: detail.scrollTop, bodyHeight: document.documentElement.scrollHeight, viewport: innerHeight };
  });
  assert(scrolling.before > 0 && scrolling.detail > 0 && scrolling.before === scrolling.after, 'List and details must scroll independently');
  assert(scrolling.bodyHeight === scrolling.viewport, 'Wide layout must not grow with detail content');
  for (const width of [900, 760, 620, 400]) {
    await page.setViewportSize({ width, height: 800 });
    const size = await page.evaluate(() => {
      const list = document.querySelector('.libraryPane').getBoundingClientRect();
      const detail = document.querySelector('.detailsPane').getBoundingClientRect();
      return { listBottom: list.bottom, detailTop: detail.top, detailLeft: detail.left, listRight: list.right, overflow: document.documentElement.scrollWidth > innerWidth,
        paneOverflow: document.querySelector('.detailsPane').scrollWidth > document.querySelector('.detailsPane').clientWidth,
        contentOverflow: document.querySelector('.gameDetails').scrollWidth > document.querySelector('.gameDetails').clientWidth };
    });
    assert(!size.overflow && !size.paneOverflow && !size.contentOverflow, `No horizontal overflow at ${width}px`);
    assert(width <= 1080 ? size.detailTop >= size.listBottom : size.detailLeft > size.listRight, `Responsive pane placement failed at ${width}px`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.querySelector('.gameList').scrollTop = 0; document.querySelector('.gameDetails').scrollTop = 0; });
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  assert(!await details.isVisible(), 'Closing the inspector must return the space to the list');
  assert(await select('Alpha').evaluate(button => button === document.activeElement), 'Closing the inspector must return focus to the selected row');
  await page.keyboard.press('Meta+f');
  assert(await page.getByRole('searchbox', { name: 'Search games' }).evaluate(input => input === document.activeElement), 'Cmd+F must focus library search');
  await select('Alpha').click();
  await page.locator('.libraryPane').getByRole('button', { name: 'Forget Alpha', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#game-details-title').textContent === 'Game details');
  assert(await select('Alpha').count() === 0, 'Removing the selection must clear its row and details');
  await page.evaluate(() => window.__libraryTest.broadcast({ recents: [] }));
  await page.getByText('Drop a game to get started', { exact: true }).waitFor();
  assert(await title.textContent() === 'Game details', 'Empty library must retain the detail placeholder');
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  assert(externalRequests.length === 0, `Unexpected network requests: ${externalRequests.join('; ')}`);
  return { passed: true, widths: [1440, 900, 760, 620, 400], checks: ['compact rows', 'row tools', 'favorites and persistent sort', 'layered search and filters', 'Default-only dragging', 'Shift selection and filtered bulk actions', 'explicit missing detection', 'keyboard selection and Cmd+F', 'stable row bounds', 'runtime and module actions', 'modal render isolation', 'save/cheat editing', 'keyboard/drag reordering', 'filter/removal reconciliation', 'collapsible inspector', 'independent scrolling', 'responsive layout', 'offline behavior'] };
};
