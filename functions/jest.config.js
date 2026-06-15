// Unit tests for the Cloud Functions AI gateway (Month 4, Phase 1). Runs in a
// plain Node environment via ts-jest — independent of the root jest-expo config
// and the emulator-backed rules tests. Tests target the pure pieces (prompt
// assembly, rate-limit math) so they need no emulator or network.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: __dirname,
  testMatch: ["**/__tests__/**/*.test.ts"],
  testTimeout: 15000,
};
