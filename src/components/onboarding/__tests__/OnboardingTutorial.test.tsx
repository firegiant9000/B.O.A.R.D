jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  return { Ionicons: ({ name }: { name: string }) => <Text>{name}</Text> };
});

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import OnboardingTutorial from "../OnboardingTutorial";
import { ONBOARDING_STEPS } from "../steps";

describe("OnboardingTutorial — visibility", () => {
  it("renders nothing when not visible", () => {
    render(<OnboardingTutorial visible={false} onDismiss={jest.fn()} />);
    expect(screen.queryByText("Skip")).toBeNull();
  });
});

describe("OnboardingTutorial — is skippable at every step (Month 5, ROADMAP item 4)", () => {
  // Walks EVERY one of the six steps (draw → shape → invite → schedule
  // session → end session → see AI summary), not just the first: each
  // iteration mounts a fresh instance, advances to that exact step via the
  // real "Next" control, then asserts the Skip control is present AND that
  // pressing it actually fires onDismiss. If Skip were only wired on step 1
  // (or its onPress silently stopped doing anything past some step), the
  // iterations for the later steps would fail to find it or fail the
  // onDismiss assertion — a test that only checked step 1 could not catch
  // either regression.
  ONBOARDING_STEPS.forEach((step, index) => {
    it(`step ${index + 1} of ${ONBOARDING_STEPS.length} ("${step.title}") exposes a working Skip control`, () => {
      const onDismiss = jest.fn();
      render(<OnboardingTutorial visible={true} onDismiss={onDismiss} />);

      // Advance from step 1 to this step using the real Next control.
      for (let i = 0; i < index; i++) {
        fireEvent.press(screen.getByText(/^(Next|Done)$/));
      }

      // Confirm we actually reached the intended step before testing Skip on it.
      expect(screen.getByText(step.title)).toBeTruthy();

      const skip = screen.getByText("Skip");
      expect(skip).toBeTruthy();
      fireEvent.press(skip);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  it("stepping through Next to the final step, then pressing Done, also dismisses", () => {
    const onDismiss = jest.fn();
    render(<OnboardingTutorial visible={true} onDismiss={onDismiss} />);

    for (let i = 0; i < ONBOARDING_STEPS.length - 1; i++) {
      fireEvent.press(screen.getByText("Next"));
    }
    expect(screen.getByText(ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1].title)).toBeTruthy();

    fireEvent.press(screen.getByText("Done"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
