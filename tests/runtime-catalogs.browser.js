// Recording bridge checks interaction and layout. Actual game/native proofs
// run separately and are never counted here.
module.exports = async function runtimeCatalogBrowserTests(page, fixture) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.addInitScript(state => {
    const listeners = new Set();
    const test = window.__runtimeTest = { state, calls: [], pending: [] };
    test.broadcast = patch => { test.state = { ...test.state, ...patch }; for (const listener of listeners) listener(test.state); };
    test.finish = () => { const pending = test.pending.shift(); pending.resolve({ version: pending.args[2]?.version || "2024.0.0.32" }); };
    const api = {
      getState: async () => test.state,
      onState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      onOpenSettings: () => () => {},
      runtimeAction: (...args) => { test.calls.push({ method: "runtimeAction", args }); return new Promise((resolve, reject) => test.pending.push({ args, resolve, reject })); },
      moduleAction: async (...args) => ({ selectedModuleId: "fixture", versions: [{ moduleId: "fixture", value: "1.0", source: "file", certainty: "exact" }], candidates: [], trace: [] }),
      getCheatsPatchStatus: async () => ({ patched: false }), getLibsPatchStatus: async () => ({ patched: false })
    };
    window.MacLauncher = { launcher: new Proxy(api, { get(target, key) { return key in target ? target[key] : async (...args) => { test.calls.push({ method: String(key), args }); return {}; }; } }) };
  }, fixture);
  await page.goto("http://127.0.0.1:5186");
  await page.getByRole("button", { name: "Runtimes", exact: true }).click();
  assert(await page.getByRole("button", { name: "Load versions", exact: true }).count() === 0, "Reload must stay an icon for empty catalogs");
  const reload = page.getByRole("button", { name: "Reload versions", exact: true });
  await reload.click();
  assert(await reload.count() === 0 && await page.getByRole("button", { name: "Refreshing versions", exact: true }).isDisabled(), "Reload must respond immediately and disable repeated clicks");
  const call = await page.evaluate(() => window.__runtimeTest.calls.at(-1));
  assert(call.args[2].latestOnly === false, "Ordinary Reload must request full history");
  await page.evaluate(() => window.__runtimeTest.finish());
  await page.getByText(/Versions updated at/).waitFor();
  assert(await page.getByRole("button", { name: "All versions", exact: true }).count() === 0, "Ordinary releases must not have a second All versions button");
  const group = page.getByRole("navigation", { name: "Runtime groups", exact: true });
  await group.getByRole("button", { name: "GameMaker", exact: true }).click();
  assert(await group.getByRole("button", { name: "Butterscotch", exact: true }).count() === 0, "Butterscotch belongs under GameMaker");
  await page.getByRole("tab", { name: "Butterscotch", exact: true }).click();
  await page.getByRole("tab", { name: "OpenGMK", exact: true }).click();
  await page.getByRole("tab", { name: "Official", exact: true }).click();
  const importHelp = page.getByRole("button", { name: "About importing runtimes", exact: true });
  if (await importHelp.count()) {
    await importHelp.click();
    await importHelp.press("Escape");
    assert(await page.getByRole("dialog", { name: "Runtimes", exact: true }).isVisible(), "Closing help must keep the Runtimes panel open");
  }
  await page.getByRole("button", { name: "Import runtime directory…", exact: true }).click();
  assert(await page.getByRole("button", { name: "Reload versions", exact: true }).isDisabled(), "Reload must not silently ignore clicks while importing");
  assert((await page.evaluate(() => window.__runtimeTest.calls.at(-1))).args[1] === "import", "Import must route to the selected global manager without a game");
  await page.evaluate(() => window.__runtimeTest.finish());
  await page.getByRole("button", { name: "Install Igor", exact: true }).click();
  assert(await page.getByRole("button", { name: "Reload versions", exact: true }).isDisabled(), "Igor setup must expose the manager's busy state");
  const setup = await page.evaluate(() => window.__runtimeTest.calls.at(-1));
  assert(setup.args[1] === "setup" && setup.args[2].setupActionId === "installIgor" && setup.args[2].toolVersion === "2024.0.0.32", "Igor setup must use its independent explicit version");
  await page.evaluate(() => window.__runtimeTest.finish());
  await page.evaluate(managerId => {
    const test = window.__runtimeTest;
    const manager = test.state.runtimeManagers[managerId];
    const tool = manager.setupActions[0];
    test.broadcast({ runtimeManagers: { ...test.state.runtimeManagers, [managerId]: { ...manager,
      setupActions: [{ ...tool, versions: ["2024.0.0.32", "2024.13.1.242"], installed: true,
        installedVersion: "2024.0.0.32", selectedVersion: "2024.0.0.32", installedVersions: ["2024.0.0.32", "2024.13.1.242"] }] } } });
  }, setup.args[0]);
  await page.getByRole("combobox", { name: "Igor version", exact: true }).selectOption("2024.13.1.242");
  await page.getByRole("button", { name: "Use version", exact: true }).click();
  assert((await page.evaluate(() => window.__runtimeTest.calls.at(-1))).args[2].toolVersion === "2024.13.1.242", "An installed Igor version must be selectable independently of the runner");
  await page.evaluate(() => window.__runtimeTest.finish());
  await group.getByRole("button", { name: "AliceSoft", exact: true }).click();
  assert(await page.getByRole("link", { name: "Setup instructions", exact: true }).count() === 0, "Bundled AliceSoft installation needs no setup instructions");
  const versions = await page.locator(".runtimeRemote select").first().locator("option").allTextContents();
  assert(new Set(versions).size === versions.length, "Available versions must be unique");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  return { passed: true, ordinaryRefreshFull: true, refreshFeedback: true, gameMakerGrouped: true, globalImport: true, explicitIgorVersion: true, noAliceSetupLinks: true };
};
