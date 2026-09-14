import {
  resolveShortcut,
  buildCheatSheet,
  gateShortcutCommands,
  modLabel,
  CommandName,
  KeyChord,
  ShortcutContext,
} from "../shortcuts";

const chord = (over: Partial<KeyChord>): KeyChord => ({
  key: "",
  meta: false,
  ctrl: false,
  shift: false,
  alt: false,
  ...over,
});

const ctx = (editingText = false): ShortcutContext => ({ editingText });

describe("resolveShortcut — tool switches", () => {
  it.each([
    ["p", "pen"],
    ["e", "eraser"],
    ["t", "text"],
    ["s", "select"],
    ["h", "hand"],
  ])("maps %s → %s tool", (key, tool) => {
    expect(resolveShortcut(chord({ key }), ctx())).toEqual({ type: "tool", tool });
  });

  it("is case-insensitive for single keys", () => {
    expect(resolveShortcut(chord({ key: "P" }), ctx())).toEqual({ type: "tool", tool: "pen" });
  });
});

describe("resolveShortcut — laser pointer (Month 5)", () => {
  it("maps Shift+L to the laser tool", () => {
    expect(resolveShortcut(chord({ key: "L", shift: true }), ctx())).toEqual({
      type: "tool",
      tool: "laser",
    });
  });

  it("leaves bare l (no Shift) mapped to the Line shape, not the laser", () => {
    expect(resolveShortcut(chord({ key: "l" }), ctx())).toEqual({
      type: "shape",
      shape: "line",
    });
  });

  it("suppresses the laser hotkey while editing text, like every other shortcut", () => {
    expect(resolveShortcut(chord({ key: "L", shift: true }), ctx(true))).toBeNull();
  });
});

describe("resolveShortcut — shape switches", () => {
  it.each([
    ["r", "rect"],
    ["o", "ellipse"],
    ["l", "line"],
    ["a", "arrow"],
  ])("maps %s → %s shape", (key, shape) => {
    expect(resolveShortcut(chord({ key }), ctx())).toEqual({ type: "shape", shape });
  });

  it("no longer binds N to the triangle shape (ROADMAP.md:243 gives N to sticky note)", () => {
    // Triangle keeps no key at all under the spec's table, and stays reachable
    // through ShapeOptionsBar's kind row (`KINDS` includes "triangle") and
    // shape recognition — so this removes an undocumented shortcut, not the
    // only route to a primitive.
    const action = resolveShortcut(chord({ key: "n" }), ctx());
    expect(action).not.toEqual({ type: "shape", shape: "triangle" });
    expect(action).not.toMatchObject({ type: "shape" });
  });
});

describe("resolveShortcut — sticky note insert (ROADMAP.md:243)", () => {
  it("maps N to the insert-note COMMAND, not a tool or a shape", () => {
    // A sticky note is an insert action, not a tool mode — `Tool` has no
    // `sticky` member and the toolbar exposes a one-shot `onInsertNote`
    // button, so the spec's "N sticky note" can only be a command.
    expect(resolveShortcut(chord({ key: "n" }), ctx())).toEqual({
      type: "command",
      name: "insertNote",
    });
  });

  it("is case-insensitive like every other single-key binding", () => {
    expect(resolveShortcut(chord({ key: "N" }), ctx())).toEqual({
      type: "command",
      name: "insertNote",
    });
  });

  it("does not fire with Shift/Alt held, or while editing text", () => {
    expect(resolveShortcut(chord({ key: "n", shift: true }), ctx())).toBeNull();
    expect(resolveShortcut(chord({ key: "n", alt: true }), ctx())).toBeNull();
    expect(resolveShortcut(chord({ key: "n" }), ctx(true))).toBeNull();
  });

  it("yields to a Cmd/Ctrl combo the same way the tool keys do", () => {
    // Cmd+N is the browser/OS "new window" chord; the modifier branch runs
    // first and returns null for it rather than inserting a note.
    expect(resolveShortcut(chord({ key: "n", meta: true }), ctx())).toBeNull();
    expect(resolveShortcut(chord({ key: "n", ctrl: true }), ctx())).toBeNull();
  });
});

describe("resolveShortcut — modifier commands", () => {
  it("Cmd+Z is undo, Cmd+Shift+Z is redo", () => {
    expect(resolveShortcut(chord({ key: "z", meta: true }), ctx())).toEqual({
      type: "command",
      name: "undo",
    });
    expect(resolveShortcut(chord({ key: "z", meta: true, shift: true }), ctx())).toEqual({
      type: "command",
      name: "redo",
    });
  });

  it("Ctrl+Y is redo (Windows convention)", () => {
    expect(resolveShortcut(chord({ key: "y", ctrl: true }), ctx())).toEqual({
      type: "command",
      name: "redo",
    });
  });

  it("Cmd/Ctrl combos map to their commands", () => {
    expect(resolveShortcut(chord({ key: "a", meta: true }), ctx())).toEqual({
      type: "command",
      name: "selectAll",
    });
    expect(resolveShortcut(chord({ key: "c", ctrl: true }), ctx())).toEqual({
      type: "command",
      name: "copy",
    });
    expect(resolveShortcut(chord({ key: "v", meta: true }), ctx())).toEqual({
      type: "command",
      name: "paste",
    });
    expect(resolveShortcut(chord({ key: "d", meta: true }), ctx())).toEqual({
      type: "command",
      name: "duplicate",
    });
    expect(resolveShortcut(chord({ key: "]", meta: true }), ctx())).toEqual({
      type: "command",
      name: "bringToFront",
    });
    expect(resolveShortcut(chord({ key: "[", meta: true }), ctx())).toEqual({
      type: "command",
      name: "sendToBack",
    });
  });

  it("modifier wins over the bare tool key (Cmd+A is not the arrow tool)", () => {
    expect(resolveShortcut(chord({ key: "a", meta: true }), ctx())).toEqual({
      type: "command",
      name: "selectAll",
    });
  });

  it("zoom combos", () => {
    expect(resolveShortcut(chord({ key: "0", meta: true }), ctx())).toEqual({
      type: "command",
      name: "zoom100",
    });
    expect(resolveShortcut(chord({ key: "=", meta: true }), ctx())).toEqual({
      type: "command",
      name: "zoomIn",
    });
    expect(resolveShortcut(chord({ key: "+", ctrl: true }), ctx())).toEqual({
      type: "command",
      name: "zoomIn",
    });
    expect(resolveShortcut(chord({ key: "-", meta: true }), ctx())).toEqual({
      type: "command",
      name: "zoomOut",
    });
  });

  it("returns null for an unbound modifier combo", () => {
    expect(resolveShortcut(chord({ key: "q", meta: true }), ctx())).toBeNull();
  });
});

describe("resolveShortcut — bare special keys", () => {
  it("Delete and Backspace delete the selection", () => {
    expect(resolveShortcut(chord({ key: "Delete" }), ctx())).toEqual({
      type: "command",
      name: "delete",
    });
    expect(resolveShortcut(chord({ key: "Backspace" }), ctx())).toEqual({
      type: "command",
      name: "delete",
    });
  });

  it("Escape deselects", () => {
    expect(resolveShortcut(chord({ key: "Escape" }), ctx())).toEqual({
      type: "command",
      name: "deselect",
    });
  });

  it("? opens help, Shift+1 fits, Shift+0 resets to 100%", () => {
    expect(resolveShortcut(chord({ key: "?", shift: true }), ctx())).toEqual({
      type: "command",
      name: "help",
    });
    expect(resolveShortcut(chord({ key: "1", shift: true }), ctx())).toEqual({
      type: "command",
      name: "zoomFit",
    });
    expect(resolveShortcut(chord({ key: "0", shift: true }), ctx())).toEqual({
      type: "command",
      name: "zoom100",
    });
  });
});

describe("resolveShortcut — suppression", () => {
  it("returns null for everything while editing text", () => {
    expect(resolveShortcut(chord({ key: "p" }), ctx(true))).toBeNull();
    expect(resolveShortcut(chord({ key: "z", meta: true }), ctx(true))).toBeNull();
    expect(resolveShortcut(chord({ key: "Delete" }), ctx(true))).toBeNull();
  });

  it("does not switch tools when Shift/Alt is held", () => {
    expect(resolveShortcut(chord({ key: "p", shift: true }), ctx())).toBeNull();
    expect(resolveShortcut(chord({ key: "r", alt: true }), ctx())).toBeNull();
  });
});

describe("cheat sheet", () => {
  it("uses ⌘ on Apple and Ctrl elsewhere", () => {
    expect(modLabel(true)).toBe("⌘");
    expect(modLabel(false)).toBe("Ctrl");
  });

  it("builds sections covering tools, shapes, edit and view", () => {
    const sheet = buildCheatSheet("Ctrl");
    expect(sheet.map((s) => s.title)).toEqual(["Tools", "Shapes", "Edit", "View"]);
    const undo = sheet
      .find((s) => s.title === "Edit")!
      .items.find((i) => i.label === "Undo")!;
    expect(undo.keys).toEqual(["Ctrl", "Z"]);
  });

  // `ShortcutsCheatSheet.tsx` renders `buildCheatSheet()` directly, so asserting
  // against this table IS asserting against the `?` modal users read — not a
  // copy of it that could drift.
  it("advertises N as the sticky note, and no longer as Triangle", () => {
    const sheet = buildCheatSheet("Ctrl");
    const nItems = sheet.flatMap((s) => s.items).filter((i) => i.keys.join("") === "N");
    expect(nItems).toHaveLength(1);
    expect(nItems[0].label).toMatch(/sticky note/i);

    expect(sheet.flatMap((s) => s.items).map((i) => i.label)).not.toContain("Triangle");
  });

  it("every single-letter chord it advertises actually resolves to something", () => {
    // The regression this guards: the cheat sheet is the one user-visible
    // description of the bindings, and a row for a key nothing is bound to is
    // a false claim shipped to users. Drives both directions off the real
    // resolver rather than a hand-listed expectation.
    const singles = buildCheatSheet("Ctrl")
      .flatMap((s) => s.items)
      .filter((i) => i.keys.length === 1 && /^[A-Z]$/.test(i.keys[0]));
    expect(singles.length).toBeGreaterThan(0);
    for (const item of singles) {
      expect(resolveShortcut(chord({ key: item.keys[0] }), ctx())).not.toBeNull();
    }
  });
});

describe("gateShortcutCommands — the permission surface behind the shortcuts", () => {
  // Every command name, so the gate can be asserted by absence rather than by
  // a hand-maintained list of what should survive.
  const handlers = (): Record<CommandName, () => void> => ({
    undo: jest.fn(),
    redo: jest.fn(),
    selectAll: jest.fn(),
    copy: jest.fn(),
    paste: jest.fn(),
    duplicate: jest.fn(),
    insertNote: jest.fn(),
    delete: jest.fn(),
    deselect: jest.fn(),
    bringToFront: jest.fn(),
    sendToBack: jest.fn(),
    zoomIn: jest.fn(),
    zoomOut: jest.fn(),
    zoom100: jest.fn(),
    zoomFit: jest.fn(),
    help: jest.fn(),
  });

  it("passes every command through when the session may both edit and create", () => {
    const h = handlers();
    const gated = gateShortcutCommands(h, { canEdit: true, canCreateContent: true });
    for (const name of Object.keys(h) as CommandName[]) {
      expect(gated[name]).toBe(h[name]);
    }
  });

  it("drops insertNote for a session that may not edit — the toolbar button's own condition", () => {
    // Toolbar.tsx returns its read-only row before the insert group is ever
    // reached (`if (!canEdit)`), so the note button is hidden for a viewer, a
    // commenter, a member locked out by an active presenter, and a view-scope
    // embed alike. A keystroke that inserted a note anyway would be a real
    // permission bypass, so the same boolean gates both.
    const h = handlers();
    const gated = gateShortcutCommands(h, { canEdit: false, canCreateContent: true });
    expect(gated.insertNote).toBeUndefined();
    expect("insertNote" in gated).toBe(false);
    // Navigation/selection commands a read-only viewer legitimately has stay.
    expect(gated.zoomIn).toBe(h.zoomIn);
    expect(gated.deselect).toBe(h.deselect);
    expect(gated.selectAll).toBe(h.selectAll);
  });

  it("drops paste/duplicate while a presentation locks content creation, keeping insertNote's gate separate", () => {
    const h = handlers();
    const gated = gateShortcutCommands(h, { canEdit: true, canCreateContent: false });
    expect(gated.paste).toBeUndefined();
    expect(gated.duplicate).toBeUndefined();
    expect(gated.insertNote).toBe(h.insertNote);
  });

  it("drops every content-creating command when the session can do neither", () => {
    const gated = gateShortcutCommands(handlers(), {
      canEdit: false,
      canCreateContent: false,
    });
    expect(gated.paste).toBeUndefined();
    expect(gated.duplicate).toBeUndefined();
    expect(gated.insertNote).toBeUndefined();
  });

  it("an N keystroke resolved end-to-end is a no-op for a viewer who may not insert", () => {
    // The full path the screen runs: resolveShortcut → the gated table →
    // `table[name]?.()`. Proves the gate holds for the actual chord, not just
    // for the command name in isolation.
    const h = handlers();
    const gated = gateShortcutCommands(h, { canEdit: false, canCreateContent: true });
    const action = resolveShortcut(chord({ key: "n" }), ctx());
    expect(action).toEqual({ type: "command", name: "insertNote" });

    gated[(action as { type: "command"; name: CommandName }).name]?.();
    expect(h.insertNote).not.toHaveBeenCalled();

    const allowed = gateShortcutCommands(h, { canEdit: true, canCreateContent: true });
    allowed[(action as { type: "command"; name: CommandName }).name]?.();
    expect(h.insertNote).toHaveBeenCalledTimes(1);
  });
});
