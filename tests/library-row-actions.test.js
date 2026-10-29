const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
let GameActions;
test.before(async () => {
  const { build } = require("vite"), Module = require("node:module");
  const result = await build({ configFile: false, logLevel: "silent", build: {
    ssr: path.join(__dirname, "../src/renderer/src/ui/components/GameActions.tsx"), write: false,
    rollupOptions: { external: id => /^react(?:-dom)?(?:\/|$)/.test(id), output: { format: "cjs" } }
  } });
  const compiled = new Module(path.join(__dirname, "library-row-actions.cjs"), module); compiled.paths = module.paths;
  compiled._compile(result.output.find(row => row.type === "chunk").code, compiled.id);
  GameActions = compiled.exports.GameActions;
});
test("library row has only Play, Shortcut and Forget in tab order across capabilities", () => {
  for (const supports of [{ cheats: true, saveEditing: true }, { cheats: false, saveEditing: false }]) {
    const markup = renderToStaticMarkup(React.createElement(GameActions, {
      g: { name: "Game", gamePath: "/game", moduleSupports: supports }, actions: {}, isRunning: false
    }));
    assert.equal((markup.match(/<button/g) || []).length, 3);
    assert.match(markup, /aria-label="Play Game"[\s\S]*>Shortcut<\/button>[\s\S]*aria-label="Forget Game"/);
    assert.doesNotMatch(markup, /Saves|Cheats|actionSlot|tabindex="-1"/);
  }
});
test("inspector save and cheat actions remain enabled and invoke their existing handlers", () => {
  const calls = [], g = { name: "Game", gamePath: "/game", moduleSupports: { cheats: true, saveEditing: true } };
  const tree = GameActions.type({ g, actions: { onOpenSaveTools: game => calls.push(["saves", game]), openCheats: game => calls.push(["cheats", game]) }, isRunning: false, inspector: true });
  for (const title of ["Save tools", "Cheats"]) {
    const button = tree.props.children.find(child => child?.props?.title === title);
    assert.equal(Boolean(button.props.disabled), false);
    button.props.onClick();
  }
  assert.deepEqual(calls, [["saves", g], ["cheats", g]]);
});
