// Root Jest config.
//
// Moved out of package.json (Month 6 — code elements) so `transform` can be
// EXTENDED rather than retyped: shiki + its `@shikijs/*` grammar/theme
// packages ship pure ESM `.mjs` files (see src/lib/codeRender.ts's header),
// and jest-expo's own babel-jest transform entry is scoped to the extension
// pattern `\.[jt]sx?$` — it never matches `.mjs`, so those files would reach
// Jest's plain CommonJS loader untransformed and throw "Cannot use import
// statement outside a module", the same class of problem `@firebase/util`'s
// ESM already required `transformIgnorePatterns` to admit (below), but this
// one additionally needs a transform entry for the extension. Spreading the
// preset's own `transform` (rather than hand-copying its three entries as
// literal strings) keeps this in sync with jest-expo instead of silently
// drifting from it on a future upgrade.
const jestExpoPreset = require("jest-expo/jest-preset");

module.exports = {
  preset: "jest-expo",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  modulePathIgnorePatterns: ["<rootDir>/node_modules/react-native-key-command/"],
  testPathIgnorePatterns: [
    "<rootDir>/node_modules/",
    "<rootDir>/firestore-tests/",
    "<rootDir>/functions/",
  ],
  transformIgnorePatterns: [
    // shiki (Month 6 — code elements) is pure ESM, like firebase/@firebase
    // above, so it needs the same admission. Unlike firebase, importing even
    // shiki's tokens-only `core` entry statically pulls in its HTML/HAST
    // serialization stack (`@shikijs/core`'s single built file exports
    // `codeToHtml` etc. from the same module `codeToTokens` lives in — see
    // codeRender.ts's header), so the unist/mdast/hast/micromark packages
    // that stack depends on need admitting too, or the ones actually reached
    // at import time fail the same "Cannot use import statement outside a
    // module" way shiki itself would. Grouped by their shared prefixes
    // (`*-util-*`) rather than named one-by-one so a patch bump that adds
    // another package in the same families doesn't silently regress this.
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|firebase|@firebase/.*|rbush|quickselect|shiki|@shikijs/.*|ccount|character-entities-html4|character-entities-legacy|comma-separated-tokens|dequal|devlop|hast-util-.*|html-void-elements|mdast-util-to-hast|micromark-util-.*|oniguruma-parser|oniguruma-to-es|property-information|regex|regex-recursion|regex-utilities|space-separated-tokens|stringify-entities|trim-lines|unist-util-.*|vfile|vfile-message|zwitch))",
  ],
  transform: {
    ...jestExpoPreset.transform,
    "^.+\\.mjs$": "babel-jest",
  },
  collectCoverageFrom: ["src/services/**/*.ts", "!src/services/**/__tests__/**"],
  coverageThreshold: {
    global: {
      lines: 60,
      statements: 60,
    },
  },
};
