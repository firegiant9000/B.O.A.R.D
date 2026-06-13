import {
  resolveShortcut,
  buildCheatSheet,
  modLabel,
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

describe("resolveShortcut — shape switches", () => {
  it.each([
    ["r", "rect"],
    ["o", "ellipse"],
    ["l", "line"],
    ["a", "arrow"],
    ["n", "triangle"],
  ])("maps %s → %s shape", (key, shape) => {
    expect(resolveShortcut(chord({ key }), ctx())).toEqual({ type: "shape", shape });
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
});
