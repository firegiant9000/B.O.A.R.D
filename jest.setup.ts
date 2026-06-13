// Global test setup.

// The error-reporting seam imports the native Sentry SDK at module load. Mock it
// so Jest (no native runtime) can load any module that routes through the seam.
jest.mock("@sentry/react-native", () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  wrap: (component: unknown) => component,
}));

// Silence the intentional console.warn from the error-reporting seam so test
// output stays readable. Tests that assert on reporting spy on the seam directly.
jest.spyOn(console, "warn").mockImplementation(() => {});
