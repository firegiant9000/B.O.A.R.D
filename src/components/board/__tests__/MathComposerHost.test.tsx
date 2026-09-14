import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import MathComposerHost, { mathErrorMessage } from "../MathComposerHost";

/**
 * MathComposerHost.test.tsx — Month 6 math elements.
 *
 * The composer's BEHAVIOUR, which is the part worth testing: a malformed
 * expression must keep the sheet open with TeX's own message showing (closing
 * it would throw away what the user typed at the exact moment they need to
 * correct it), a success must close it, and the two entry points — insert and
 * edit — must route to different writes.
 *
 * The screen (`app/board/[id].tsx`) holds only "is it open" and "which id";
 * everything asserted here lives in this component precisely so it can be
 * render-tested, which a screen under `app/` cannot be in this Jest setup.
 */

function setup(
  over: Partial<React.ComponentProps<typeof MathComposerHost>> = {}
) {
  const onCreate = jest.fn().mockResolvedValue("m-new");
  const onUpdate = jest.fn().mockResolvedValue(undefined);
  const onClose = jest.fn();
  const utils = render(
    <MathComposerHost
      visible
      editingId={null}
      initialLatex={null}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onClose={onClose}
      {...over}
    />
  );
  return { onCreate, onUpdate, onClose, ...utils };
}

function type(latex: string) {
  fireEvent.changeText(screen.getByTestId("math-composer-latex"), latex);
}

function submit() {
  fireEvent.press(screen.getByTestId("math-composer-submit"));
}

describe("MathComposerHost — insert (Month 6)", () => {
  it("creates the equation and closes on success", async () => {
    const { onCreate, onUpdate, onClose } = setup();
    type("x^2");
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("x^2"));
    expect(onUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("trims the source before writing it", async () => {
    const { onCreate } = setup();
    type("   x^2   ");
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("x^2"));
  });

  it("will not submit an empty or whitespace-only expression", async () => {
    const { onCreate } = setup();
    submit();
    type("   ");
    submit();
    // No await needed for a call that never happens; flush anyway so a
    // late resolution can't hide a real call.
    await act(async () => {});
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("MathComposerHost — a typo keeps the sheet open (Month 6)", () => {
  it("shows TeX's own message inline and does NOT close", async () => {
    const onCreate = jest.fn().mockRejectedValue(new Error("Missing close brace"));
    const { onClose } = setup({ onCreate });
    type("\\frac{");
    submit();

    expect(await screen.findByTestId("math-composer-error")).toHaveTextContent(
      "Missing close brace"
    );
    expect(onClose).not.toHaveBeenCalled();
    // What they typed is still there to correct.
    expect(screen.getByTestId("math-composer-latex").props.value).toBe("\\frac{");
  });

  it("clears a previous failure when the next attempt succeeds", async () => {
    const onCreate = jest
      .fn()
      .mockRejectedValueOnce(new Error("Missing close brace"))
      .mockResolvedValueOnce("m-new");
    const { onClose } = setup({ onCreate });

    type("\\frac{");
    submit();
    expect(await screen.findByTestId("math-composer-error")).toBeTruthy();

    type("\\frac{a}{b}");
    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByTestId("math-composer-error")).toBeNull();
  });

  it("disables the submit button while a render is in flight", async () => {
    let release!: (id: string) => void;
    const onCreate = jest.fn(() => new Promise<string>((r) => (release = r)));
    setup({ onCreate });
    type("x^2");
    submit();

    await waitFor(() => expect(screen.getByTestId("math-composer-busy")).toBeTruthy());
    // A second press must not fire a second render.
    submit();
    expect(onCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      release("m-new");
    });
  });
});

describe("MathComposerHost — edit (Month 6)", () => {
  it("seeds the field from the element and routes to onUpdate, not onCreate", async () => {
    const { onCreate, onUpdate } = setup({ editingId: "m1", initialLatex: "a+b" });
    expect(screen.getByTestId("math-composer-latex").props.value).toBe("a+b");

    type("a+b+c");
    submit();
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("m1", "a+b+c"));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("labels itself as an edit rather than an insert", () => {
    setup({ editingId: "m1", initialLatex: "a+b" });
    expect(screen.getByText("Edit equation")).toBeTruthy();
    expect(screen.queryByText("New equation")).toBeNull();
  });

  it("labels itself as an edit even when the existing equation's latex is empty", () => {
    // The trap this guards against: deriving "am I editing" from the seeded
    // text (`initialLatex`) instead of the id would mislabel this as an
    // insert, because an existing element can legitimately have empty/null
    // latex (see `latexOfMathElement`). `editingId` is the only reliable
    // signal, and it must also still route to `onUpdate`, not `onCreate`.
    const { onCreate, onUpdate } = setup({ editingId: "m1", initialLatex: "" });
    expect(screen.getByText("Edit equation")).toBeTruthy();
    expect(screen.queryByText("New equation")).toBeNull();
    submit(); // empty field: canSubmit is false, so this just proves no crash
    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("re-seeds when a DIFFERENT element is opened", () => {
    const { rerender, onCreate, onUpdate, onClose } = setup({
      editingId: "m1",
      initialLatex: "a+b",
    });
    rerender(
      <MathComposerHost
        visible
        editingId="m2"
        initialLatex="y^2"
        onCreate={onCreate}
        onUpdate={onUpdate}
        onClose={onClose}
      />
    );
    // Showing the previous equation's source over a different element is how
    // an edit silently overwrites the wrong thing.
    expect(screen.getByTestId("math-composer-latex").props.value).toBe("y^2");
  });

  it("does not carry a failure from one element over to the next", async () => {
    const onCreate = jest.fn();
    const onUpdate = jest.fn().mockRejectedValue(new Error("Missing close brace"));
    const onClose = jest.fn();
    const { rerender } = render(
      <MathComposerHost
        visible
        editingId="m1"
        initialLatex="a+b"
        onCreate={onCreate}
        onUpdate={onUpdate}
        onClose={onClose}
      />
    );
    type("\\frac{");
    submit();
    expect(await screen.findByTestId("math-composer-error")).toBeTruthy();

    rerender(
      <MathComposerHost
        visible
        editingId="m2"
        initialLatex="y^2"
        onCreate={onCreate}
        onUpdate={onUpdate}
        onClose={onClose}
      />
    );
    expect(screen.queryByTestId("math-composer-error")).toBeNull();
  });
});

describe("mathErrorMessage — a typo reads differently from a refusal (Month 6)", () => {
  it("passes a TeX message through verbatim", () => {
    // No `code` — mathService is explicit that a malformed expression comes
    // back as a plain Error, and TeX's own wording is the most useful thing
    // anyone could say about it.
    expect(mathErrorMessage(new Error("Missing close brace"))).toBe("Missing close brace");
    expect(mathErrorMessage(new Error("Undefined control sequence \\foo"))).toBe(
      "Undefined control sequence \\foo"
    );
  });

  it("says 'wait', never 'upgrade', for the rate bucket", () => {
    // This callable has NO plan quota — MathJax runs in-process with no
    // provider cost — so an upsell here would be flatly wrong. The server
    // states the reason rather than leaving it to be inferred from the plan.
    const err = Object.assign(new Error("Too many equations at once."), {
      code: "functions/resource-exhausted",
      details: { reason: "rate-limit" },
    });
    const message = mathErrorMessage(err);
    expect(message).toMatch(/wait a moment/i);
    expect(message).not.toMatch(/upgrade|plan/i);
  });

  it("handles a resource-exhausted rejection carrying no details at all", () => {
    const err = Object.assign(new Error("nope"), { code: "functions/resource-exhausted" });
    expect(mathErrorMessage(err)).toMatch(/wait a moment/i);
  });

  it("explains a permission denial rather than echoing the raw code", () => {
    const err = Object.assign(new Error("permission-denied"), {
      code: "functions/permission-denied",
    });
    expect(mathErrorMessage(err)).toMatch(/permission/i);
  });

  it("falls back to a readable sentence for a message-less failure", () => {
    expect(mathErrorMessage(null)).toBe("Couldn't render that equation.");
    expect(mathErrorMessage({})).toBe("Couldn't render that equation.");
  });
});
