// Pass a page with the recording bridge from library-layout.browser.js and a fixture
// containing real manifests. This checks actual geometry, not CSS implementation details.
module.exports = async function libraryLayoutVisualTests(page, fixture) {
  const results = [];
  const measure = () => {
    const selectors = ['.libraryPane', '.detailsPane', '.gameDetails', '.gameRow', '.detailRow',
      '.modal', '.modalBody', '.settingsRow', '.saveRow', '.formGrid'];
    const overflow = selectors.flatMap(selector => [...document.querySelectorAll(selector)]
      .filter(el => el.getBoundingClientRect().width > 0 && el.scrollWidth > el.clientWidth + 1)
      .map(el => ({ selector, text: el.textContent.slice(0, 80), width: el.clientWidth, scroll: el.scrollWidth })));
    const overlap = [...document.querySelectorAll('.gameRow,.detailRow,.libraryToolbarControls,.settingsRow')].flatMap(row => {
      const rects = [...row.children].filter(el => getComputedStyle(el).display !== 'none')
        .map(el => ({ el, r: el.getBoundingClientRect() }));
      return rects.flatMap((a, i) => rects.slice(i + 1).filter(b => a.r.width && b.r.width &&
        Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left) > 1 &&
        Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top) > 1)
        .map(b => ({ text: row.textContent.slice(0, 80), first: a.el.className, second: b.el.className })));
    });
    return { overflow, overlap, bodyOverflow: document.documentElement.scrollWidth > innerWidth };
  };
  await page.evaluate(state => window.__libraryTest.broadcast(state), fixture);
  await page.setViewportSize({ width: 1440, height: 900 });
  const search = await page.getByRole('searchbox', { name: 'Search games' }).boundingBox();
  if (search.width < 600 || search.height < 40) throw new Error('Desktop search must have generous width and height');
  const alignment = await page.locator('.libraryToolbarControls').evaluate(toolbar => {
    const centers = [...toolbar.children].map(element => {
      const box = element.getBoundingClientRect(); return box.top + box.height / 2;
    });
    return Math.max(...centers) - Math.min(...centers);
  });
  if (alignment > 1) throw new Error('Desktop toolbar controls must share a baseline');
  for (const width of [1440, 1280, 1100, 1080, 900, 760, 620, 400]) {
    await page.setViewportSize({ width, height: 800 });
    for (const game of fixture.recents) {
      await page.getByRole('button', { name: `Show details for ${game.name}`, exact: true }).click();
      results.push({ width, engine: game.moduleId, ...await page.evaluate(measure) });
    }
  }
  await page.setViewportSize({ width: 400, height: 560 });
  for (const surface of ['Settings', 'Runtimes', 'Credits']) {
    await page.getByRole('button', { name: surface, exact: true }).click();
    results.push({ width: 400, surface, ...await page.evaluate(measure) });
    if (surface === 'Settings') {
      const tabList = page.getByRole('tablist', { name: 'Settings sections' });
      await tabList.getByRole('tab', { name: 'Launcher', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      if (await tabList.getByRole('tab', { selected: true }).count() !== 1) throw new Error('Settings must have one selected tab');
      for (const module of fixture.modules) {
        await tabList.getByRole('tab', { name: module.shortLabel || module.label || module.id, exact: true }).click();
        const panel = page.locator('#settings-panel-' + module.id);
        if (!await panel.isVisible()) throw new Error('Settings tabs must show the matching backend');
        results.push({ width: 400, surface: 'Settings ' + module.id, ...await page.evaluate(measure) });
      }
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
  }
  for (const game of fixture.recents.filter(game => game.moduleSupports.cheats || game.moduleSupports.saveEditing || game.moduleSupports.saveLocation)) {
    const row = page.getByRole('button', { name: `Show details for ${game.name}`, exact: true }).locator('..');
    for (const surface of [game.moduleSupports.cheats ? 'Cheats' : null, game.moduleSupports.saveEditing || game.moduleSupports.saveLocation ? 'Saves' : null].filter(Boolean)) {
      await row.getByRole('button', { name: surface, exact: true }).click();
      results.push({ width: 400, engine: game.moduleId, surface, ...await page.evaluate(measure) });
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    }
  }
  await page.getByRole('button', { name: 'Select games', exact: true }).click();
  results.push({ width: 400, surface: 'Selection', ...await page.evaluate(measure) });
  await page.getByRole('button', { name: 'Finish selecting games', exact: true }).click();
  const failures = results.filter(result => result.bodyOverflow || result.overflow.length || result.overlap.length);
  if (failures.length) throw new Error(JSON.stringify(failures));
  return { passed: true, cases: results.length, engines: fixture.modules.map(module => module.id) };
};
