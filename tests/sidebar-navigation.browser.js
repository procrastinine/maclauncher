// Run against a local renderer preview with createEngineLibraryFixture() and registry UI metadata.
// The recording bridge keeps all runtime and settings actions inside this page.
module.exports = async function sidebarNavigationBrowserTests(page, fixture, outputDirectory) {
  const origin = 'http://127.0.0.1:5187';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [], requests = [], report = { layouts: [], searches: [] };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(origin) && !request.url().startsWith('data:')) requests.push(request.url()); });
  await page.addInitScript(state => {
    const listeners = new Set(), calls = [];
    const test = window.__sidebarTest = { state, calls };
    test.broadcast = patch => {
      test.state = { ...test.state, ...patch };
      for (const listener of listeners) listener(test.state);
    };
    const record = method => async (...args) => { calls.push({ method, args }); return {}; };
    window.MacLauncher = { launcher: {
      getState: async () => test.state,
      onState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      moduleAction: record('moduleAction'), runtimeAction: record('runtimeAction'),
      openExternal: record('openExternal'), cancelDownload: record('cancelDownload'),
      setLauncherSettings: async patch => { calls.push({ method: 'setLauncherSettings', args: [patch] }); test.broadcast({ launcherSettings: { ...test.state.launcherSettings, ...patch } }); },
      setModuleSettings: async (id, patch) => { calls.push({ method: 'setModuleSettings', args: [id, patch] }); test.broadcast({ moduleSettings: { ...test.state.moduleSettings, [id]: { ...test.state.moduleSettings[id], ...patch } } }); }
    } };
  }, fixture);
  const navigate = async (view, width, height, managerId) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${origin}/?view=${view}${managerId ? `&managerId=${managerId}` : ''}`);
    await page.getByRole('heading', { name: view === 'runtimes' ? 'Runtimes' : 'Settings', exact: true }).waitFor();
  };
  const layout = async (view, width, height) => {
    const dimensions = await page.evaluate(() => {
      const sidebar = document.querySelector('.launcherSidebar').getBoundingClientRect();
      const content = document.querySelector('.launcherSidebarLayout > :last-child').getBoundingClientRect();
      const sidebarSearch = document.querySelector('.launcherSidebarSearch input').getBoundingClientRect();
      const choices = document.querySelector('.launcherSidebarChoices').getBoundingClientRect();
      return { sidebar: { x: sidebar.x, right: sidebar.right, top: sidebar.top, bottom: sidebar.bottom },
        content: { x: content.x, right: content.right, top: content.top, bottom: content.bottom },
        searchBottom: sidebarSearch.bottom, choicesTop: choices.top,
        scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
    });
    assert(dimensions.sidebar.right <= dimensions.content.x + 1, `${view}: sidebar must not overlap content`);
    assert(dimensions.content.right <= width + 1 && dimensions.scrollWidth <= dimensions.clientWidth, `${view}: window must not overflow horizontally`);
    assert(dimensions.searchBottom <= dimensions.choicesTop, `${view}: search must stay above scrolling choices`);
    report.layouts.push({ view, width, height, ...dimensions });
  };
  const searchAllChoices = async search => {
    const choices = await page.locator('.launcherSidebarItem').evaluateAll(items => items.map(item => ({ label: item.textContent, title: item.title })));
    const panel = await page.locator('.launcherSidebarLayout [role=region]').first().getAttribute('id');
    for (const item of choices) {
      await search.fill(item.title);
      assert(await page.locator('.launcherSidebarItem').filter({ hasText: item.label }).count() > 0, `Full metadata label must match: ${item.title}`);
      assert(await page.locator('.launcherSidebarLayout [role=region]').first().getAttribute('id') === panel, 'Filtering must preserve the current panel');
    }
    await search.fill('');
    report.searches.push({ count: choices.length, fullLabels: choices.map(item => item.title) });
  };

  await navigate('settings', 1040, 740);
  const settingsSearch = page.getByRole('searchbox', { name: 'Search settings' });
  const settingsNav = page.getByRole('navigation', { name: 'Settings sections' });
  await layout('settings', 1040, 740);
  await searchAllChoices(settingsSearch);
  await settingsSearch.fill('Mac.apk');
  assert(await settingsNav.getByRole('button', { name: 'Android', exact: true }).count() === 1, 'Settings search must find Mac.apk by runtime name');
  assert(await page.getByRole('checkbox', { name: 'Show game icons' }).isVisible(), 'Search must retain Launcher content');
  await settingsSearch.press('Enter');
  await page.locator('#settings-panel-android').waitFor();
  await page.screenshot({ path: `${outputDirectory}/settings-wide.png` });
  const androidRuntimeTab = page.getByRole('tab', { name: 'Mac.apk', exact: true });
  if (await androidRuntimeTab.count()) {
    await androidRuntimeTab.click();
    assert(await androidRuntimeTab.getAttribute('aria-selected') === 'true', 'Settings runtime sub-tabs must remain operable');
  }
  await page.getByRole('tab', { name: 'AIM', exact: true }).click();
  const aimPanel = page.getByRole('tabpanel', { name: 'AIM', exact: true });
  assert(await aimPanel.getByText(/Pixel Tablet display/).isVisible(), 'Schema-free runtime tab must show its device description');
  assert(await aimPanel.getByText(/Applications run offline without Google account integration/).isVisible(), 'AIM must show its offline account boundary');
  assert(await aimPanel.getByRole('button', { name: 'Sign in to Google' }).count() === 0, 'AIM must not show another runtime account panel');
  await page.getByRole('combobox', { name: 'Default runtime', exact: true }).selectOption('aim');
  assert(await page.getByRole('tab', { name: 'AIM', exact: true }).getAttribute('aria-selected') === 'true', 'AIM default choice must retain its own selected information tab');
  await page.screenshot({ path: `${outputDirectory}/settings-aim-wide.png` });
  await settingsSearch.fill('no-matching-engine-23847');
  await page.getByRole('status').filter({ hasText: 'No matching sections.' }).waitFor();
  assert(await page.locator('#settings-panel-android').isVisible(), 'No-results must preserve selected Settings panel');
  assert(await page.locator('#settings-panel-android').getAttribute('aria-label'), 'Filtered Settings panel must retain its own accessible name');
  await page.screenshot({ path: `${outputDirectory}/settings-no-results.png` });
  await settingsSearch.press('Escape');
  assert(await settingsSearch.inputValue() === '', 'Escape must clear sidebar search');
  await page.getByRole('button', { name: 'Android', exact: true }).focus();
  await page.keyboard.press('Meta+f');
  assert(await settingsSearch.evaluate(input => input === document.activeElement), 'Cmd-F must focus Settings search');
  const fullscreenPreserved = await page.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true, bubbles: true, cancelable: true }); window.dispatchEvent(event); return !event.defaultPrevented; });
  assert(fullscreenPreserved, 'Control-Cmd-F must remain available for native fullscreen');
  await settingsSearch.press('ArrowDown');
  assert(await settingsNav.getByRole('button', { name: 'Launcher', exact: true }).evaluate(button => button === document.activeElement), 'ArrowDown from search must focus the first result');
  await page.keyboard.press('End');
  assert(await settingsNav.locator('button').last().getAttribute('aria-current') === 'page', 'End must select the last sidebar choice');
  await page.keyboard.press('Home');
  assert(await settingsNav.getByRole('button', { name: 'Launcher', exact: true }).getAttribute('aria-current') === 'page', 'Home must return to first sidebar choice');
  await page.getByRole('checkbox', { name: 'Show game icons' }).uncheck();
  assert(await page.evaluate(() => window.__sidebarTest.calls.some(call => call.method === 'setLauncherSettings' && call.args[0].showIcons === false)), 'Settings controls must retain their backend callback');
  await page.setViewportSize({ width: 700, height: 480 });
  await layout('settings', 700, 480);
  await page.screenshot({ path: `${outputDirectory}/settings-narrow.png` });
  assert(!await page.evaluate(() => window.__sidebarTest.calls.some(call => call.method === 'runtimeAction')), 'Settings navigation/search must not request catalogs');

  await navigate('runtimes', 1100, 760, 'macapk');
  const runtimeSearch = page.getByRole('searchbox', { name: 'Search runtimes' });
  const runtimeNav = page.getByRole('navigation', { name: 'Runtime groups' });
  await page.getByText('Mac.apk', { exact: true }).waitFor();
  assert(await runtimeNav.getByRole('button', { name: 'Android', exact: true }).getAttribute('aria-current') === 'page', 'Deep-linked Mac.apk must select Android');
  await searchAllChoices(runtimeSearch);
  await runtimeSearch.fill('Mac.apk');
  assert(await runtimeNav.getByRole('button', { name: 'Android', exact: true }).count() === 1, 'Runtimes search must match runtime names');
  await runtimeSearch.fill('Sikarugir Wine');
  assert(await runtimeNav.getByRole('button', { name: 'Sikarugir', exact: true }).count() === 1, 'Search must match full Sikarugir runtime name');
  assert(await page.getByText('Mac.apk', { exact: true }).isVisible(), 'Filtered runtime panel must retain the actual runtime title');
  await runtimeSearch.fill('none-23947');
  await page.getByRole('status').filter({ hasText: 'No matching sections.' }).waitFor();
  assert(await page.getByRole('region', { name: 'Android', exact: true }).isVisible(), 'No-results must retain accessible runtime content');
  await page.screenshot({ path: `${outputDirectory}/runtimes-no-results.png` });
  await page.evaluate(() => window.__sidebarTest.broadcast({ utilityWindow: { view: 'runtimes', managerId: 'sikarugir-graphics-bridge', revision: 1 } }));
  await page.getByRole('tab', { name: 'Graphics bridge', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('input[aria-label="Search runtimes"]').value === '');
  assert(await runtimeNav.getByRole('button', { name: 'Sikarugir', exact: true }).getAttribute('aria-current') === 'page', 'Explicit runtime navigation must reveal selected group');
  assert(await page.getByRole('tab', { name: 'Graphics bridge', exact: true }).getAttribute('aria-selected') === 'true', 'Deep link must open the exact requested runtime sub-tab');
  await runtimeSearch.fill('no-matching-runtime-572');
  await page.evaluate(() => window.__sidebarTest.broadcast({ utilityWindow: { view: 'runtimes', managerId: 'sikarugir-graphics-bridge', revision: 2 } }));
  await page.waitForFunction(() => document.querySelector('input[aria-label="Search runtimes"]').value === '');
  assert(await page.getByRole('tab', { name: 'Graphics bridge', exact: true }).getAttribute('aria-selected') === 'true', 'Repeating a deep link must reveal its current selection');
  await runtimeNav.getByRole('button', { name: 'GameMaker', exact: true }).click();
  await page.getByRole('tab', { name: 'Butterscotch', exact: true }).click();
  await runtimeNav.getByRole('button', { name: 'Sikarugir', exact: true }).click();
  assert(await page.getByRole('tab', { name: 'Graphics bridge', exact: true }).getAttribute('aria-selected') === 'true', 'Group navigation must preserve remembered runtime sub-tab');
  await runtimeNav.getByRole('button', { name: 'GameMaker', exact: true }).click();
  assert(await page.getByRole('tab', { name: 'Butterscotch', exact: true }).getAttribute('aria-selected') === 'true', 'Returning to GameMaker must restore Butterscotch');
  await layout('runtimes', 1100, 760);
  await page.screenshot({ path: `${outputDirectory}/runtimes-wide.png` });
  await page.setViewportSize({ width: 760, height: 480 });
  await layout('runtimes', 760, 480);
  await page.screenshot({ path: `${outputDirectory}/runtimes-narrow.png` });
  await page.keyboard.press('Meta+f');
  assert(await runtimeSearch.evaluate(input => input === document.activeElement), 'Cmd-F must focus Runtimes search');
  await runtimeSearch.fill('Mac.apk');
  await page.getByRole('button', { name: 'Clear search runtimes', exact: true }).click();
  assert(await runtimeSearch.inputValue() === '' && await runtimeSearch.evaluate(input => input === document.activeElement), 'Clear must reveal all choices and retain search focus');
  assert(!await page.evaluate(() => window.__sidebarTest.calls.some(call => call.method === 'runtimeAction')), 'Runtime search, deep links and sub-tabs must not load catalogs');
  await page.getByRole('button', { name: 'Reload versions', exact: true }).click();
  assert(await page.evaluate(() => window.__sidebarTest.calls.some(call => call.method === 'runtimeAction' && call.args[1] === 'refreshCatalog')), 'Explicit Reload must retain catalog callback');

  await page.setViewportSize({ width: 900, height: 740 });
  await page.goto(`${origin}/?view=credits`);
  await page.getByRole('heading', { name: 'Credits', exact: true }).waitFor();
  await page.screenshot({ path: `${outputDirectory}/credits.png` });
  assert(!requests.length, `Utility windows must not issue external requests: ${requests.join(', ')}`);
  assert(!errors.length, `Utility windows must not raise renderer errors: ${errors.join(', ')}`);
  return { ...report, rendererErrors: errors, externalRequests: requests, checked: ['metadata search', 'retained panels', 'no results', 'Cmd-F', 'native fullscreen shortcut', 'sidebar keys', 'Settings controls', 'deep links', 'revealed external selection', 'remembered runtime sub-tabs', 'explicit catalog reload'] };
};
