# Keyboard shortcuts

The board canvas is fully keyboard-drivable (Phase 11). Bindings resolve through a
single pure table (`src/lib/shortcuts.ts`); the in-app `?` cheat sheet is rendered
from the same source, so it can't drift from what's wired.

| Keys | Action |
| --- | --- |
| `P` `E` `T` `S` `H` | Pen · Eraser · Text · Select · Hand (pan) |
| `R` `O` `L` `A` | Rectangle · Oval · Line · Arrow (switches to the shape tool) |
| `N` | Insert a sticky note (hidden, and inert, for a session that can't edit) |
| `⌘/Ctrl` + `Z` / `⇧Z` (or `Y`) | Undo / Redo (paths only — see limits) |
| `⌘/Ctrl` + `A` `C` `V` `D` | Select all · Copy · Paste · Duplicate |
| `⌘/Ctrl` + `]` / `[` | Bring to front / Send to back |
| `Delete` / `Backspace` | Delete selection |
| `Esc` | Deselect |
| `⇧` + `1` / `⌘/Ctrl` + `0` | Zoom to fit / Zoom to 100% |
| `⌘/Ctrl` + `+` / `−` | Zoom in / out |
| `Space` + drag | Temporary pan (the Hand tool is the persistent equivalent) |
| `?` | Toggle the shortcuts cheat sheet |

Triangle has no key of its own — pick it from the shape tool's kind row, or draw
one and accept the "perfect it?" offer.

Shortcuts are suppressed while editing a text element so the field gets normal
keystrokes. On web they bind to DOM keyboard events (Cmd/Ctrl+V flows through the
browser's `paste` event so an OS-clipboard image is still caught).

### Keyboard shortcuts (native)

Bluetooth-keyboard support on iOS/Android uses
[`react-native-key-command`](https://github.com/Expensify/react-native-key-command),
which needs native hooks forwarded from the app shell. The Expo config plugin
`plugins/withHardwareKeyCommands.js` injects them automatically during prebuild
**for the Objective-C / Java app templates** documented by the library. Expo SDK 55
generates a **Swift `AppDelegate` and Kotlin `MainActivity`**, for which the plugin
logs a warning and leaves the files untouched (so it never breaks a prebuild) — add
the forwarding by hand on those templates:

- iOS (`AppDelegate.swift`): expose `keyCommands` / `handleKeyCommand(_:)` →
  `HardwareShortcuts.sharedInstance()`.
- Android (`MainActivity.kt`): forward `onKeyDown` →
  `KeyCommandModule.getInstance().onKeyDownEvent(keyCode, event)`.

Native key capture and OS-clipboard image paste (`expo-clipboard`) require a real
build + a hardware keyboard to verify; they cannot be exercised in Jest or on web.
