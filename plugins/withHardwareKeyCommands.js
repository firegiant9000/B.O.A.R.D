/**
 * Expo config plugin — wires react-native-key-command's native hooks during
 * prebuild (Phase 11). The library needs:
 *   - iOS: `keyCommands` + `handleKeyCommand:` forwarded from AppDelegate to
 *     `HardwareShortcuts`.
 *   - Android: `onKeyDown` forwarded from MainActivity to `KeyCommandModule`.
 *
 * The library's README documents the Objective-C / Java app templates. Expo SDK
 * 55 generates a Swift AppDelegate and a Kotlin MainActivity, for which the
 * forwarding differs. Every injection below is GUARDED: if the expected anchor
 * isn't found (e.g. a Swift/Kotlin template, or an already-patched file), the
 * file is left unchanged and a warning is logged instead of throwing — so adding
 * this plugin can never break a prebuild. On Swift/Kotlin templates the hooks
 * must currently be added by hand; see README "Keyboard shortcuts (native)".
 */
const { withAppDelegate, withMainActivity, createRunOncePlugin } = require("@expo/config-plugins");

const pkg = { name: "with-hardware-key-commands", version: "1.0.0" };

function warn(msg) {
  // eslint-disable-next-line no-console
  console.warn(`[withHardwareKeyCommands] ${msg}`);
}

function patchAppDelegateObjC(contents) {
  if (contents.includes("HardwareShortcuts")) return contents; // already patched
  let out = contents;
  // import
  if (!out.includes("#import <HardwareShortcuts.h>")) {
    out = out.replace(
      /(#import\s+"AppDelegate\.h".*?\n)/s,
      `$1#import <HardwareShortcuts.h>\n`
    );
  }
  // methods, injected just before the final @end of the implementation
  const methods = `
- (NSArray *)keyCommands {
  return [HardwareShortcuts sharedInstance].keyCommands;
}

- (void)handleKeyCommand:(UIKeyCommand *)keyCommand {
  [[HardwareShortcuts sharedInstance] handleKeyCommand:keyCommand];
}

`;
  const lastEnd = out.lastIndexOf("@end");
  if (lastEnd === -1) {
    warn("iOS: could not find @end in AppDelegate; skipped.");
    return contents;
  }
  return out.slice(0, lastEnd) + methods + out.slice(lastEnd);
}

function patchMainActivityJava(contents) {
  if (contents.includes("KeyCommandModule")) return contents;
  let out = contents;
  if (!out.includes("import android.view.KeyEvent;")) {
    out = out.replace(
      /(package .*?;\n)/s,
      `$1\nimport android.view.KeyEvent;\nimport com.expensify.reactnativekeycommand.KeyCommandModule;\n`
    );
  }
  const method = `
  @Override
  public boolean onKeyDown(int keyCode, KeyEvent event) {
    KeyCommandModule.getInstance().onKeyDownEvent(keyCode, event);
    return super.onKeyDown(keyCode, event);
  }
`;
  // inject before the final closing brace of the class
  const lastBrace = out.lastIndexOf("}");
  if (lastBrace === -1) {
    warn("Android: could not find class body in MainActivity; skipped.");
    return contents;
  }
  return out.slice(0, lastBrace) + method + out.slice(lastBrace);
}

const withHardwareKeyCommands = (config) => {
  config = withAppDelegate(config, (cfg) => {
    const lang = cfg.modResults.language;
    if (lang === "objc" || lang === "objcpp") {
      cfg.modResults.contents = patchAppDelegateObjC(cfg.modResults.contents);
    } else {
      warn(
        `iOS AppDelegate is ${lang}; add keyCommands/handleKeyCommand: by hand (see README "Keyboard shortcuts (native)").`
      );
    }
    return cfg;
  });

  config = withMainActivity(config, (cfg) => {
    const lang = cfg.modResults.language;
    if (lang === "java") {
      cfg.modResults.contents = patchMainActivityJava(cfg.modResults.contents);
    } else {
      warn(
        `Android MainActivity is ${lang}; add onKeyDown forwarding by hand (see README "Keyboard shortcuts (native)").`
      );
    }
    return cfg;
  });

  return config;
};

module.exports = createRunOncePlugin(withHardwareKeyCommands, pkg.name, pkg.version);
