// Runs through the existing headless CLI against a local Vite server. The
// supplied state uses real module metadata and an in-memory recording bridge.
module.exports = async function runtimeSettingVisibilityBrowserTests(page, state) {
  const origin = await page.evaluate(() => location.origin);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.addInitScript(state => {
    const listeners = new Set(), test = window.__visibilityTest = { state, calls: [] };
    const broadcast = () => { for (const listener of listeners) listener(test.state); };
    const choices = async (moduleId, action, runtimeId) => {
      test.calls.push({ method: 'choices', action });
      const fields = test.state.modules.find(module => module.id === moduleId)?.runtime.entries[runtimeId]?.settings.fields || [];
      return Object.fromEntries(fields.filter(field => field.optionsAction === action).map(field => [field.optionsKey || field.key,
        [...(field.options || []), ...(field.key === 'vulkanRuntime' ? [{ value: 'saved-driver', label: 'Saved driver' }] : [])]]));
    };
    const api = {
      getState: async () => test.state,
      onState: listener => { listeners.add(listener);return () => listeners.delete(listener); },
      setModuleRuntimeSettings: async (moduleId, runtimeId, values) => {
        test.calls.push({ method: 'module', values });
        const previous = test.state.moduleSettings[moduleId] || {};
        test.state = { ...test.state, moduleSettings: { ...test.state.moduleSettings,
          [moduleId]: { ...previous, runtimeSettings: { ...previous.runtimeSettings, [runtimeId]: values } } } };broadcast();
      },
      setGameRuntimeSettings: async (gamePath, runtimeId, values) => {
        test.calls.push({ method: 'game', values });
        test.state = { ...test.state, recents: test.state.recents.map(game => game.gamePath === gamePath
          ? { ...game, runtimeSettings: { ...game.runtimeSettings, [runtimeId]: values } } : game) };broadcast();
      },
      moduleSettingsAction: (moduleId, action, { runtimeId }) => choices(moduleId, action, runtimeId),
      moduleAction: (gamePath, action) => {
        const game = test.state.recents.find(game => game.gamePath === gamePath);
        return choices(game.moduleId, action, game.runtimeId);
      }
    };
    window.MacLauncher = { launcher: api };
  }, state);
  const field = name => page.getByLabel(name, { exact: true });
  const open = async (moduleId, runtimeId, scope = 'module') => {
    const query = Object.entries({ view: 'runtime-settings', scope, moduleId, runtimeId,
      ...(scope === 'game' ? { gamePath: state.recents[0].gamePath } : {}) })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
    await page.goto(origin + '/?' + query);
    await page.locator('.settingsStack').waitFor();
  };
  await page.setViewportSize({ width: 440, height: 700 });
  await open('android', 'klepton');
  assert(await field('Execution').inputValue() === 'jvm', 'Default execution must be JVM');
  assert(await page.locator('.settingsRow select').first().getAttribute('aria-label') === 'Execution', 'Execution must be first');
  assert(await field('Vulkan implementation').count() === 0, 'Metal must hide Vulkan implementation');
  assert(!await page.evaluate(() => window.__visibilityTest.calls.some(call => call.action === 'listVulkanRuntimes')), 'Hidden providers must not load');
  await field('OpenGL ES backend').selectOption('vulkan');
  await field('Vulkan implementation').selectOption('saved-driver');
  await field('OpenGL ES backend').selectOption('metal');
  assert(await field('Vulkan implementation').count() === 0, 'Changing backend must hide the field');
  await field('OpenGL ES backend').selectOption('vulkan');
  assert(await field('Vulkan implementation').inputValue() === 'saved-driver', 'Hidden saved driver must return');
  await field('Execution').selectOption('art');
  await page.waitForFunction(() => window.__visibilityTest.calls.some(call => call.method === 'module' && call.values?.execution === 'art' && call.values?.vulkanRuntime === 'saved-driver'));
  await page.getByRole('button', { name: 'About this runtime', exact: true }).click();
  const help = page.locator('.helpPopover:popover-open');
  assert(await help.isVisible(), 'Runtime help must open');
  assert((await help.innerText()).includes('switching preserves it'), 'Data notice must remain available');
  const bounds = await help.boundingBox();assert(bounds.x >= 0 && bounds.x + bounds.width <= 441, 'Help must fit narrow settings');
  await page.keyboard.press('Escape');assert(await help.count() === 0, 'Escape must close help');
  await open('android', 'klepton', 'game');
  await field('Joystick center X (%)').fill('42');
  await field('Keyboard touch joystick').selectOption('off');
  assert(await field('Joystick center X (%)').count() === 0, 'Off must hide joystick geometry');
  await field('Keyboard touch joystick').selectOption('wasd');
  assert(await field('Joystick center X (%)').inputValue() === '42', 'Joystick geometry must be retained');
  assert(await field('microG account').count() === 0, 'Disabled microG must hide account choice');
  await field('Use microG').check();await field('microG account').waitFor();
  await open('rgss', 'mkxpz');
  assert(await field('MJIT max cache').count() === 0, 'Disabled MJIT must hide tuning');
  await field('Enable MJIT').check();await field('MJIT max cache').fill('300');
  await field('Enable MJIT').uncheck();assert(await field('MJIT max cache').count() === 0, 'Disabled MJIT must hide tuning again');
  await field('Enable MJIT').check();assert(await field('MJIT max cache').inputValue() === '300', 'MJIT tuning must be retained');
  await open('ios', 'playcover');
  await field('Window mode').selectOption('native');assert(await field('Window width').count() === 0, 'Native sizing must hide fixed dimensions');
  await field('Window mode').selectOption('fixed');await field('Window width').fill('1600');
  await field('Window mode').selectOption('native');await field('Window mode').selectOption('fixed');
  assert(await field('Window width').inputValue() === '1600', 'Fixed dimensions must be retained');
  for (const width of [440, 760]) {
    await page.setViewportSize({ width, height: 700 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Settings overflow at ${width}px`);
  }
  assert(await page.locator('[role="alert"], .error').count() === 0, 'Settings must remain error-free');
  return { passed: true, cases: ['backend', 'execution', 'joystick', 'microG', 'MJIT', 'fixed-size', 'help'], widths: [440, 760] };
};
