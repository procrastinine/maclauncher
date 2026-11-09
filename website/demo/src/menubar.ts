// The demo's menu bar, drawn and tracked like the macOS menu bar.
// - Pressing a title opens its menu. Pressing it again closes the menu.
// - While a menu is open, pointing at another title opens that one.
// - A press can drag onto an item and release to choose it. Releasing
//   outside the menus after such a drag closes the menu.
// - A click anywhere outside the menus closes them without reaching what is
//   under the pointer, the library and window frames included.
// - The arrow keys, Return, Space and Escape work as they do in macOS menus.
// - A chosen item blinks, and the menu fades out before the command runs.
// - Commands the demo cannot carry out are dimmed.

export type MenuItem = {
  label: string;
  shortcut?: string;
  run?: () => void;
  mark?: "check" | "diamond";
  submenu?: boolean;
};
export type MenuEntry = MenuItem | "separator";
export type Menu = { title: string; entries: () => MenuEntry[]; className?: string; icon?: string };

const CHECK = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.6 5.3l2.3 2.3 4.5-5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const DIAMOND = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.6L8.4 5 5 8.4 1.6 5z" fill="currentColor"/></svg>';
const CHEVRON = '<svg viewBox="0 0 6 10" aria-hidden="true"><path d="M1.2 1.2L4.8 5 1.2 8.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const STATUS_ICONS = [
  // Battery
  '<svg class="statusIcon" viewBox="0 0 27 12" aria-hidden="true"><rect x="0.6" y="0.6" width="22.8" height="10.8" rx="3.2" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.1"/><rect x="2.3" y="2.3" width="15.5" height="7.4" rx="1.7"/><path d="M24.9 4.1v3.8c.8-.3 1.4-1 1.4-1.9s-.6-1.6-1.4-1.9z" fill-opacity=".5"/></svg>',
  // Wi-Fi
  '<svg class="statusIcon" viewBox="0 0 16 12" aria-hidden="true"><path d="M8 11.4L5.6 8.8a3.4 3.4 0 0 1 4.8 0z"/><path d="M8 4.9a6 6 0 0 1 4.2 1.7l-1.1 1.2a4.4 4.4 0 0 0-6.2 0L3.8 6.6A6 6 0 0 1 8 4.9z"/><path d="M8 1.2a9.6 9.6 0 0 1 6.8 2.8l-1.1 1.2a8 8 0 0 0-11.4 0L1.2 4A9.6 9.6 0 0 1 8 1.2z"/></svg>',
  // Spotlight
  '<svg class="statusIcon" viewBox="0 0 14 14" aria-hidden="true"><circle cx="5.8" cy="5.8" r="4.4" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9.1 9.1l3.8 3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  // Control Center
  '<svg class="statusIcon" viewBox="0 0 16 14" aria-hidden="true"><rect x="0.8" y="0.8" width="14.4" height="5.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4" cy="3.4" r="1.7"/><rect x="0.8" y="8" width="14.4" height="5.2" rx="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="10.6" r="1.7"/></svg>'
];

function shortcutElement(shortcut: string) {
  const [, modifiers = "", key = shortcut] = shortcut.match(/^([⌃⌥⇧⌘]*)(.+)$/u) || [];
  const element = document.createElement("span");
  element.className = "menuShortcut";
  element.append(Object.assign(document.createElement("span"), { className: "menuModifiers", textContent: modifiers }),
    Object.assign(document.createElement("span"), { className: "menuKey", textContent: key }));
  return element;
}

// The clock reads like the macOS one, for example "Sun Nov 8  10:24 PM", in
// the viewer's language.
function clockParts(now: Date) {
  const date = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).formatToParts(now)
    .filter(part => part.type !== "literal").map(part => part.value.replace(/\.$/, "")).join(" ");
  return [date, new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(now)];
}

type Title = { menu: Menu; root: HTMLElement; name: HTMLButtonElement; list: HTMLElement; items: HTMLElement[]; runs: Array<(() => void) | undefined> };

export function createMenuBar(bar: HTMLElement, menus: Menu[]) {
  bar.setAttribute("role", "menubar");
  // While a menu is open, this layer sits over everything but the menu bar,
  // so a click outside only closes the menu.
  const scrim = Object.assign(document.createElement("div"), { className: "menuScrim", hidden: true });
  document.body.append(scrim);

  const titles: Title[] = [];
  let open: Title | null = null, openedByPress = false, active = -1, choosing = false, fadeTimer = 0;
  let press: Title | null = null;

  const shown = () => titles.filter(title => title.root.offsetParent !== null);
  const roving = (title: Title) => titles.forEach(each => { each.name.tabIndex = each === title ? 0 : -1; });

  function build(title: Title) {
    title.items = [];
    title.runs = [];
    const children: HTMLElement[] = [];
    for (const entry of title.menu.entries()) {
      if (entry === "separator") {
        const separator = Object.assign(document.createElement("div"), { className: "menuSeparator" });
        separator.setAttribute("role", "separator");
        children.push(separator);
        continue;
      }
      const item = Object.assign(document.createElement("div"), { className: "menuItem", tabIndex: -1 });
      item.setAttribute("role", entry.mark === "check" ? "menuitemcheckbox" : "menuitem");
      if (entry.mark === "check") item.setAttribute("aria-checked", "true");
      if (!entry.run) item.setAttribute("aria-disabled", "true");
      const mark = Object.assign(document.createElement("span"), { className: "menuMark" });
      if (entry.mark) mark.innerHTML = entry.mark === "check" ? CHECK : DIAMOND;
      item.append(mark, Object.assign(document.createElement("span"), { className: "menuLabel", textContent: entry.label }));
      if (entry.shortcut) item.append(shortcutElement(entry.shortcut));
      if (entry.submenu) item.append(Object.assign(document.createElement("span"), { className: "menuChevron", innerHTML: CHEVRON }));
      const index = title.items.length;
      title.items.push(item);
      title.runs.push(entry.run);
      item.addEventListener("pointerenter", () => { if (!choosing) setActive(entry.run ? index : -1); });
      item.addEventListener("pointerup", event => { if (event.button === 0 && entry.run && !choosing) { setActive(index); choose(); } });
      children.push(item);
    }
    title.list.replaceChildren(...children);
  }

  // A menu stays inside the menu bar's width.
  function place(title: Title) {
    title.list.style.left = "0px";
    const bounds = bar.getBoundingClientRect(), rect = title.list.getBoundingClientRect();
    const overflow = rect.right - (bounds.right - 4);
    if (overflow > 0) title.list.style.left = `${-Math.min(overflow, rect.left - bounds.left - 4)}px`;
  }

  function setActive(index: number, focus = false) {
    if (!open) return;
    open.items.forEach((item, at) => item.classList.toggle("active", at === index));
    active = index;
    if (focus) (index >= 0 ? open.items[index] : open.name).focus({ preventScroll: true });
  }

  function show(title: Title, keyboard: boolean) {
    window.clearTimeout(fadeTimer);
    for (const other of titles) if (other !== title) {
      other.list.hidden = true;
      other.list.classList.remove("closing");
      other.root.classList.remove("open");
      other.name.setAttribute("aria-expanded", "false");
    }
    build(title);
    title.list.classList.remove("closing");
    title.list.hidden = false;
    title.root.classList.add("open");
    title.name.setAttribute("aria-expanded", "true");
    place(title);
    open = title;
    active = -1;
    scrim.hidden = false;
    roving(title);
    if (keyboard) setActive(title.runs.findIndex(Boolean), true);
  }

  function close(fade: boolean) {
    const title = open;
    if (!title) return;
    open = null;
    active = -1;
    press = null;
    scrim.hidden = true;
    title.root.classList.remove("open");
    title.name.setAttribute("aria-expanded", "false");
    if (!fade) { title.list.hidden = true; return; }
    title.list.classList.add("closing");
    fadeTimer = window.setTimeout(() => { title.list.hidden = true; title.list.classList.remove("closing"); }, 200);
  }

  function choose() {
    if (!open || active < 0 || !open.runs[active]) return;
    const item = open.items[active], run = open.runs[active]!;
    choosing = true;
    item.classList.remove("active");
    window.setTimeout(() => item.classList.add("active"), 60);
    window.setTimeout(() => { choosing = false; close(true); run(); }, 130);
  }

  for (const menu of menus) {
    const root = Object.assign(document.createElement("div"), { className: ["menuTitle", menu.className].filter(Boolean).join(" ") });
    const name = Object.assign(document.createElement("button"), { type: "button", className: "menuName", tabIndex: titles.length ? -1 : 0 });
    name.setAttribute("role", "menuitem");
    name.setAttribute("aria-haspopup", "menu");
    name.setAttribute("aria-expanded", "false");
    if (menu.icon) { name.innerHTML = menu.icon; name.setAttribute("aria-label", menu.title); } else name.textContent = menu.title;
    const list = Object.assign(document.createElement("div"), { className: "menuList", hidden: true });
    list.setAttribute("role", "menu");
    list.setAttribute("aria-label", menu.title);
    list.addEventListener("pointerleave", () => { if (!choosing) setActive(-1); });
    root.append(name, list);
    bar.append(root);
    const title: Title = { menu, root, name, list, items: [], runs: [] };
    titles.push(title);

    name.addEventListener("pointerdown", event => {
      if (event.button !== 0 || choosing) return;
      event.preventDefault();
      // A second press on a menu opened by a press closes it. A press on a
      // menu opened by pointing at its title keeps it open.
      if (open === title && openedByPress) { close(true); return; }
      if (open !== title) show(title, false);
      openedByPress = true;
      press = title;
    });
    name.addEventListener("pointerenter", () => {
      if (open && open !== title && !choosing) { show(title, false); openedByPress = false; }
    });
    name.addEventListener("keydown", event => {
      if (open) return;
      const visible = shown(), at = visible.indexOf(title);
      if (["ArrowDown", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        show(title, true);
        openedByPress = true;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const next = visible[(at + (event.key === "ArrowRight" ? 1 : visible.length - 1)) % visible.length];
        roving(next);
        next.name.focus();
      }
    });
  }

  const status = Object.assign(document.createElement("div"), { className: "menuStatus", innerHTML: STATUS_ICONS.join("") });
  status.setAttribute("aria-hidden", "true");
  const clock = Object.assign(document.createElement("span"), { className: "menuClock" });
  const date = document.createElement("span"), time = document.createElement("span");
  clock.append(date, time);
  status.append(clock);
  bar.append(status);
  const tick = () => { [date.textContent, time.textContent] = clockParts(new Date()); };
  tick();
  window.setInterval(tick, 10_000);

  // Narrow bars drop the status icons, then the clock, then the less used menus.
  const overflows = () => {
    const style = getComputedStyle(bar);
    const needed = [...bar.children].reduce((sum, child) => sum + (child as HTMLElement).offsetWidth, 0);
    return needed + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) > bar.clientWidth;
  };
  const fit = () => {
    if (open) return;
    bar.classList.remove("hideStatus", "hideClock", "hideExtra");
    for (const name of ["hideStatus", "hideClock", "hideExtra"]) {
      if (!overflows()) break;
      bar.classList.add(name);
    }
  };
  new ResizeObserver(fit).observe(bar);

  scrim.addEventListener("pointerdown", event => {
    event.preventDefault();
    close(true);
    // The layer stays until the press ends so the release reaches nothing below.
    scrim.hidden = false;
  });
  bar.addEventListener("pointerdown", event => {
    if (open && !(event.target as Element).closest(".menuTitle")) close(true);
  });
  window.addEventListener("pointerup", event => {
    const pressed = press;
    press = null;
    if (!open) { scrim.hidden = true; return; }
    if (!pressed || choosing) return;
    const target = event.target as Element;
    // Releasing on an item chooses it, and elsewhere in the menu or on a title
    // the menu stays open. Releasing anywhere else after a drag closes it.
    if (open.list.contains(target) || target.closest?.(".menuName")) return;
    close(true);
  }, true);
  window.addEventListener("pointercancel", () => { press = null; if (!open) scrim.hidden = true; }, true);
  window.addEventListener("blur", () => close(false));
  document.addEventListener("keydown", event => {
    if (!open || choosing) return;
    const current: Title = open;
    const enabled = current.runs.flatMap((run, index) => run ? [index] : []);
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!enabled.length) return;
        const at = enabled.indexOf(active), down = event.key === "ArrowDown";
        setActive(enabled[at < 0 ? (down ? 0 : enabled.length - 1) : (at + (down ? 1 : enabled.length - 1)) % enabled.length], true);
        break;
      }
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        const visible = shown(), at = visible.indexOf(current);
        show(visible[(at + (event.key === "ArrowRight" ? 1 : visible.length - 1)) % visible.length], true);
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        if (active >= 0) choose(); else close(true);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        current.name.focus();
        break;
      case "Tab":
        close(false);
        break;
    }
  });
}
