function createModuleHostAccountActions({ getModule, managers } = {}) {
  function descriptor(moduleId, action) {
    const actions = getModule(moduleId)?.settingsHostAccountActions;
    return actions && Object.hasOwn(actions, action) ? actions[action] : null;
  }
  return {
    handles: (moduleId, action) => !!descriptor(moduleId, action),
    run(moduleId, action, payload) {
      const entry = descriptor(moduleId, action), manager = entry && managers[entry.manager];
      if (!manager || !Object.hasOwn(manager, entry.action) || typeof manager[entry.action] !== "function")
        throw new Error("Module account management is unavailable.");
      return manager[entry.action]({ ...(payload || {}), provider: entry.provider });
    }
  };
}
module.exports = { createModuleHostAccountActions };
