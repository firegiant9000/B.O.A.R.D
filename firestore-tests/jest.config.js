// Standalone Jest config for the emulator-backed Firestore rules tests (Phase 2).
// Kept separate from the root jest-expo config: these run in a plain Node
// environment against the Firestore emulator (via `firebase emulators:exec`),
// not React Native, and must NOT pick up the firebase/firestore manual mock the
// service tests use. Plain CommonJS — no babel transform needed on Node 20.
module.exports = {
  testEnvironment: "node",
  rootDir: __dirname,
  testMatch: ["**/*.test.js"],
  transform: {},
  testTimeout: 20000,
};
