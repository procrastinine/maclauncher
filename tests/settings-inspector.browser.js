// Run against a local Vite page with createLibraryFixture(). All operations
// use a recording bridge; no Electron, real game writes or downloads occur.
module.exports = async function settingsInspectorBrowserTests(page, fixture) {
  const origin = new URL(page.url()).origin;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.addInitScript(state => {
    const listeners = new Set();
    const test = window.__settingsTest = { state, calls: [] };
    test.broadcast = patch => {
      test.state = { ...test.state, ...patch };
      for (const listener of listeners) listener(test.state);
    };
    const record = (method, result = true) => async (...args) => {
      test.calls.push({ method, args });
      return result;
    };
    const api = {
      getState: async () => test.state,
      onState: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      openUtilityWindow: record("openUtilityWindow"),
      moduleAction: async (gamePath, actionId) => {
        test.calls.push({ method: "moduleAction", args: [gamePath, actionId] });
        if (actionId === "explainDetection") return {
          format: "maclauncher-detection-v1", selectedModuleId: "fixture",
          versions: [{ moduleId: "fixture", value: "1.0", source: "fixture-header", certainty: "exact" }],
          candidates: [], trace: []
        };
        return { ready: true, resolvedVersion: "2.0", value: "Ready" };
      },
      getCheatsPatchStatus: record("getCheatsPatchStatus", { patched: false }),
      getLibsPatchStatus: record("getLibsPatchStatus", { patched: false }),
      getSaveInfo: async gamePath => {
        const game = test.state.recents.find(game => game.gamePath === gamePath);
        return { name: game.name, moduleLabel: game.moduleLabel, saveDir: game.saveDirOverride || game.defaultSaveDir,
          directoryChoices: [{ directory: "/Saves/default", label: "Configured" }, { directory: "/Saves/mirror", label: "Game-local" }],
          canEditJson: true };
      },
      listSaveFiles: async gamePath => {
        test.calls.push({ method: "listSaveFiles", args: [gamePath] });
        const game = test.state.recents.find(game => game.gamePath === gamePath);
        return [{ name: game.saveDirOverride === "/Saves/mirror" ? "mirror.json" : "primary.json", size: 12, mtimeMs: 1700000000000 }];
      },
      selectSaveLocation: async (gamePath, directory) => {
        test.calls.push({ method: "selectSaveLocation", args: [gamePath, directory] });
        test.broadcast({ recents: test.state.recents.map(game => game.gamePath === gamePath ? { ...game, saveDirOverride: directory } : game) });
      },
      setModuleRuntimeSettings: async (moduleId, runtimeId, settings) => {
        test.calls.push({ method: "setModuleRuntimeSettings", args: [moduleId, runtimeId, settings] });
        const current = test.state.moduleSettings[moduleId] || {};
        test.broadcast({ moduleSettings: {
          ...test.state.moduleSettings,
          [moduleId]: { ...current, runtimeSettings: { ...current.runtimeSettings, [runtimeId]: settings } }
        } });
      },
      setModuleSettings: async (moduleId, patch) => test.broadcast({ moduleSettings: {
        ...test.state.moduleSettings, [moduleId]: { ...test.state.moduleSettings[moduleId], ...patch }
      } }),
      setLauncherSettings: async patch => test.broadcast({ launcherSettings: { ...test.state.launcherSettings, ...patch } }),
      setGameNotes: async (gamePath, notes) => {
        test.calls.push({ method: "setGameNotes", args: [gamePath, notes] });
        test.broadcast({ recents: test.state.recents.map(game => game.gamePath === gamePath ? { ...game, notes } : game) });
      },
      openRuntimeSettings: record("openRuntimeSettings"),
      // Native confirmations answer like the confirm stub below.
      confirmAction: async request => window.confirm(request.message)
    };
    window.MacLauncher = { launcher: new Proxy(api, { get(target, key) {
      return key in target ? target[key] : record(String(key), {});
    } }) };
    window.confirm = () => true;
    window.alert = () => {};
  }, fixture);
  await page.goto(origin);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForFunction(() => window.__settingsTest.calls.some(call => call.method === "openUtilityWindow" && call.args[0]?.view === "settings"));
  assert(await page.getByRole("searchbox", { name: "Search games", exact: true }).isVisible(), "Opening Settings must leave the library usable");
  await page.goto(origin + "/?view=settings");
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "FX", exact: true }).click();
  const scale = page.getByRole("spinbutton", { name: "Scale", exact: true });
  await scale.waitFor();
  assert(await page.locator(".modal").count() === 0, "Runtime fields must stay in the plain Settings window");
  assert(await page.getByRole("button", { name: "Close", exact: true }).count() === 0, "Settings uses native window controls");
  assert(await page.getByRole("button", { name: "Back to Library", exact: true }).count() === 0, "Settings is independent of the library window");
  assert(await page.locator(".runtimeSettingsInline").count() === 1, "Runtime fields must be inline");
  await scale.fill("2");
  await page.waitForFunction(() => window.__settingsTest.calls.some(call => call.method === "setModuleRuntimeSettings" && call.args[2]?.scale === 2));
  const saved = await page.evaluate(() => window.__settingsTest.calls.filter(call => call.method === "setModuleRuntimeSettings"));
  assert(saved.length === 1 && saved[0].args[0] === "fixture" && saved[0].args[1] === "managed", "Each edit must autosave once to its module/runtime scope");
  assert(await page.evaluate(() => !window.__settingsTest.calls.some(call => call.method === "openRuntimeSettings")), "Inline settings must not open another window");
  await page.getByRole("button", { name: "Reset to global defaults", exact: true }).click();
  await page.waitForFunction(() => window.__settingsTest.calls.some(call => call.method === "setModuleRuntimeSettings" && call.args[2] === null));
  await page.goto(origin);
  await page.getByRole("button", { name: "Show details for Alpha", exact: true }).click();
  await page.locator("#game-details .cardSubtitle").getByText("Fixture engine · 1.0", { exact: true }).waitFor();
  assert(!(await page.locator("#game-details").getByText("fixture-header", { exact: true }).isVisible()), "Technical provenance must stay under Detection");
  await page.locator("#game-details summary").getByText("Detection", { exact: true }).click();
  const rows = await page.locator("#game-details .detailRow").evaluateAll(rows => rows
    .filter(row => row.querySelector(".detailValue") && ["Engine", "Format", "Version", "Source", "Confidence"].includes(row.querySelector(".detailLabel")?.textContent))
    .map(row => ({ label: row.querySelector(".detailLabel").textContent, value: row.querySelector(".detailValue").textContent })));
  assert(rows.length === 5, "Detection evidence must remain available inside Detection");
  assert(rows.find(row => row.label === "Source").value === "fixture-header", "Version source must be shown directly");
  assert(rows.find(row => row.label === "Confidence").value === "Exact", "Version confidence must be shown directly");
  assert(await page.getByRole("button", { name: "Explain detection", exact: true }).count() === 0, "Direct metadata must replace the Explain button");
  assert(await page.locator("#game-details").getByRole("button", { name: "Edit saves", exact: true }).isVisible(), "Save editing must be available from the inspector");
  assert(await page.getByText("Saved with this game in your library", { exact: true }).count() === 0, "Notes must not add boilerplate");
  await page.locator("#game-details").getByRole("button", { name: "Edit saves", exact: true }).click();
  const saveEditor = page.getByRole("dialog", { name: "Save editor", exact: true });
  await saveEditor.getByText("primary.json", { exact: true }).waitFor();
  await saveEditor.getByRole("combobox", { name: "Save location", exact: true }).selectOption("/Saves/mirror");
  await saveEditor.getByText("mirror.json", { exact: true }).waitFor();
  const locationCall = await page.evaluate(() => window.__settingsTest.calls.find(call => call.method === "selectSaveLocation"));
  assert(locationCall.args[0].includes("/Alpha/") && locationCall.args[1] === "/Saves/mirror", "Known-location selection must refresh this game's file list");
  await saveEditor.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Show details for Beta", exact: true }).click();
  await page.getByRole("button", { name: "Show details for Alpha", exact: true }).click();
  const alphaCalls = await page.evaluate(() => window.__settingsTest.calls.filter(call => call.method === "moduleAction" && call.args[1] === "explainDetection" && call.args[0].includes("/Alpha/")).length);
  assert(alphaCalls === 1, "Cached selected-game diagnostics must not probe repeatedly");

  const alphaNotes = "見つけた鍵 🗝️\nReturn to the café.";
  const revisedAlphaNotes = alphaNotes + "\nDoor opens at midnight.";
  const betaNotes = "Beta reminder\nRésumé: finish level 2.";
  const notes = page.getByRole("textbox", { name: "Notes", exact: true });
  await notes.fill(alphaNotes);
  await notes.press("Meta+s");
  await page.waitForFunction(value => window.__settingsTest.calls.some(call => call.method === "setGameNotes" && call.args[1] === value), alphaNotes);
  await notes.fill(revisedAlphaNotes);
  await page.getByRole("button", { name: "Save notes", exact: true }).click();
  await page.waitForFunction(value => window.__settingsTest.calls.some(call => call.method === "setGameNotes" && call.args[1] === value), revisedAlphaNotes);
  await page.getByRole("button", { name: "Show details for Beta", exact: true }).click();
  assert(await notes.inputValue() === "", "Another game must have independent notes");
  await notes.fill(betaNotes);
  await page.getByRole("searchbox", { name: "Search games", exact: true }).focus();
  await page.waitForFunction(value => window.__settingsTest.calls.some(call => call.method === "setGameNotes" && call.args[1] === value), betaNotes);
  await page.getByRole("button", { name: "Show details for Alpha", exact: true }).click();
  assert(await notes.inputValue() === revisedAlphaNotes, "Saved Unicode and line breaks must survive game switches");
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  await page.getByRole("button", { name: "Show details for Alpha", exact: true }).click();
  assert(await notes.inputValue() === revisedAlphaNotes, "Closing and reopening details must preserve scoped notes");
  const noteCalls = await page.evaluate(() => window.__settingsTest.calls.filter(call => call.method === "setGameNotes"));
  assert(noteCalls.length === 3 && noteCalls[0].args[0].includes("/Alpha/") && noteCalls[1].args[0].includes("/Alpha/") && noteCalls[2].args[0].includes("/Beta/"), "Cmd-S, Save and blur must each save once to the selected game");

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole("button", { name: "Close details", exact: true }).click();
  const alphaItem = page.getByRole("button", { name: "Show details for Alpha", exact: true }).locator("../..");
  for (const edge of ["top", "bottom"]) {
    for (const expectedOpen of [true, false]) {
      await alphaItem.scrollIntoViewIfNeeded();
      const box = await alphaItem.boundingBox();
      await page.mouse.click(box.x + box.width / 2, edge === "top" ? box.y + 2 : box.y + box.height - 3);
      assert(await page.getByRole("button", { name: "Close details", exact: true }).count() === (expectedOpen ? 1 : 0), `Row ${edge} padding must toggle the same game's inspector`);
    }
  }

  await page.evaluate(() => window.__settingsTest.broadcast({ modules: window.__settingsTest.state.modules.map(module =>
    module.id === "fixture" ? { ...module, ui: { ...module.ui, detection: { showVersion: false } } } : module) }));
  await page.getByRole("button", { name: "Show details for Alpha", exact: true }).click();
  await page.locator("#game-details .cardSubtitle").getByText("Fixture engine", { exact: true }).waitFor();
  const detailsSummary = page.locator("#game-details summary").getByText("Detection", { exact: true });
  if (!(await detailsSummary.evaluate(element => element.closest("details").open))) await detailsSummary.click();
  const inapplicableRows = await page.locator("#game-details .detectionDiagnostics .detailLabel").allTextContents();
  assert(!inapplicableRows.includes("Version") && !inapplicableRows.includes("Confidence"), "Modules without version semantics must not show placeholder version/confidence rows");

  await page.goto(origin + "/?view=runtime-settings&scope=module&moduleId=fixture&runtimeId=managed");
  await page.getByRole("spinbutton", { name: "Scale", exact: true }).waitFor();
  assert(await page.locator(".runtimeSettingsPanel").count() === 1 && await page.locator(".modal").count() === 0, "Native runtime settings must have a plain settings panel");
  assert(await page.getByRole("button", { name: "Close", exact: true }).count() === 0, "Native runtime settings must use the window's close control");
  return { passed: true, rows, alphaDetectionCalls: alphaCalls, runtimeAutosaveScope: saved[0].args.slice(0, 2), noteWrites: noteCalls.length, rowPaddingCases: 4, standalonePlainPanel: true, inspectorSaveFolderSelection: true, noVersionPlaceholders: true };
};
