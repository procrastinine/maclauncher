// User-assigned graphics shortcuts. The launcher registers them as global hot
// keys only while a game with graphics runs, so an assignment must never take
// a native macOS shortcut: it needs Control together with two of Option, Shift
// and Command, which standard macOS and app menu commands leave free, and the
// few system shortcuts in that space are rejected by name.

export const ACTIONS = Object.freeze({
  bypass: "Bypass graphics effects",
  screenshot: "Save processed screenshot",
  windowPointer: "Toggle pointer in window graphics",
  windowGraphics: "Toggle Graphics for Front App"});

const MODIFIERS = Object.freeze({control: "Control", ctrl: "Control", option: "Option", alt: "Option", shift: "Shift", command: "Command", cmd: "Command"});
const ORDER = ["Control", "Option", "Shift", "Command"];
const NAMED_KEYS = Object.freeze(["Space", "Tab", "Backspace", "Delete", "Return", "Enter", "Escape", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Insert", "Plus"]);
const PUNCTUATION = ",.;'/\\[]-=`";
// System shortcuts that use Control with two other modifiers.
const RESERVED = Object.freeze({
  "Control+Shift+Command+3": "Copies a screenshot of the screen",
  "Control+Shift+Command+4": "Copies a screenshot of a selection",
  "Control+Shift+Command+5": "Opens Screenshot",
  "Control+Option+Command+8": "Inverts display colors",
  "Control+Option+Command+,": "Reduces display contrast",
  "Control+Option+Command+.": "Increases display contrast",
  "Control+Option+Command+Escape": "Reserved by macOS",
  "Control+Option+Command+Space": "Reserved by macOS"});

function key(value) {
  if (/^[a-z0-9]$/i.test(value)) return value.toUpperCase();
  if (/^f([1-9]|1[0-9]|20)$/i.test(value)) return value.toUpperCase();
  if (value.length === 1 && PUNCTUATION.includes(value)) return value;
  const named = NAMED_KEYS.find(name => name.toLowerCase() === value.toLowerCase());
  return named === "Enter" ? "Return" : named || null;
}

/** Parses an Electron-style accelerator into its canonical form, or returns null. */
export function parse(accelerator) {
  if (typeof accelerator !== "string" || accelerator.length > 64) return null;
  const parts = accelerator.split("+");
  // "Plus" names the + key; a literal trailing "+" is not accepted.
  if (parts.some(part => !part.trim())) return null;
  const modifiers = new Set();let main = null;
  for (const part of parts.map(part => part.trim())) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (modifier) { if (modifiers.has(modifier)) return null;modifiers.add(modifier);continue; }
    if (main) return null;
    main = key(part);if (!main) return null;
  }
  if (!main) return null;
  return {modifiers: ORDER.filter(name => modifiers.has(name)), key: main, accelerator: [...ORDER.filter(name => modifiers.has(name)), main].join("+")};
}

/** The Electron accelerator for a canonical shortcut. */
export function electronAccelerator(accelerator) {
  const parsed = parse(accelerator);
  return parsed ? parsed.accelerator.replace("Option", "Alt") : null;
}

/**
 * Checks one assignment against native shortcuts and the other assignments.
 * `assigned` maps action IDs to their current accelerators.
 */
export function validate(action, accelerator, assigned = {}) {
  if (!Object.hasOwn(ACTIONS, action)) return {ok: false, reason: "Choose a graphics shortcut action."};
  if (accelerator === null || accelerator === "") return {ok: true, accelerator: null};
  const parsed = parse(accelerator);
  if (!parsed) return {ok: false, reason: "Press a key together with modifier keys."};
  const modifiers = new Set(parsed.modifiers);
  if (!modifiers.has("Control") || modifiers.size < 3)
    return {ok: false, reason: "Use Control with two of Option, Shift and Command. macOS and most apps leave these combinations free."};
  if (RESERVED[parsed.accelerator]) return {ok: false, reason: `${parsed.accelerator.replaceAll("+", "-")} is a macOS shortcut: ${RESERVED[parsed.accelerator]}.`};
  for (const [other, value] of Object.entries(assigned))
    if (other !== action && value && parse(value)?.accelerator === parsed.accelerator)
      return {ok: false, reason: `This shortcut is already assigned to ${ACTIONS[other] || other}.`};
  return {ok: true, accelerator: parsed.accelerator};
}

/** Keeps only valid, distinct assignments of known actions. */
export function normalize(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const action of Object.keys(ACTIONS)) {
    const checked = validate(action, value[action], result);
    if (checked.ok && checked.accelerator) result[action] = checked.accelerator;
  }
  return result;
}

/** The accelerator for a keyboard event from a shortcut recorder, or null while only modifiers are held. */
export function fromKeyboardEvent(event) {
  const code = String(event.code || "");
  const main = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit[0-9]$/.test(code) ? code.slice(5) : /^F([1-9]|1[0-9]|20)$/.test(code) ? code
    : {Space: "Space", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Enter: "Return", Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down",
      ArrowLeft: "Left", ArrowRight: "Right", Comma: ",", Period: ".", Semicolon: ";", Quote: "'", Slash: "/", Backslash: "\\", BracketLeft: "[",
      BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`"}[code];
  if (!main) return null;
  return [event.ctrlKey && "Control", event.altKey && "Option", event.shiftKey && "Shift", event.metaKey && "Command", main].filter(Boolean).join("+");
}

// Shared help for the window actions in Settings and session inspectors.
export const ACTION_HELP = Object.freeze({
  windowGraphics: "Applies graphics to the frontmost app's window, or stops that app's window graphics when already running. Assign the keyboard shortcut in Settings.",
  windowPointer: "Shows or hides the drawn pointer in the frontmost app's scaled window graphics while they run. It does not change the saved Show pointer in picture setting."
});
