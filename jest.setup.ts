// Global test setup.

// Silence the intentional console.warn from the error-reporting seam so test
// output stays readable. Tests that assert on reporting spy on the seam directly.
jest.spyOn(console, "warn").mockImplementation(() => {});
