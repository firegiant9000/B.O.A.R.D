jest.mock("../../lib/errorReporting", () => ({
  captureException: jest.fn(),
}));

import React from "react";
import { Text } from "react-native";
import { render, screen, fireEvent } from "@testing-library/react-native";
import ErrorBoundary from "../ErrorBoundary";
import { captureException } from "../../lib/errorReporting";

function Boom(): React.ReactElement {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // React prints the caught error to console.error; silence it for clean output.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <Text>healthy</Text>
      </ErrorBoundary>
    );
    expect(screen.getByText("healthy")).toBeTruthy();
  });

  it("renders the fallback and reports the error when a child throws", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((captureException as jest.Mock).mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("offers a recovery action", () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    // The button exists and is pressable (re-render path); we don't assert recovery
    // here because the child throws unconditionally.
    expect(() => fireEvent.press(screen.getByText("Try again"))).not.toThrow();
  });
});
