import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react-native";
import CodeComposerHost, { codeErrorMessage } from "../CodeComposerHost";

/**
 * CodeComposerHost.test.tsx — Month 6 code elements.
 *
 * Mirrors MathComposerHost.test.tsx's shape exactly (both entry points, a
 * failure keeping the sheet open, busy-state double-submit protection) with
 * one deliberate difference: there is no TeX-typo-equivalent case here, so
 * `codeErrorMessage`'s own tests are just "pass the message through, with a
 * safe fallback" — see `codeService`'s header for why neither write path can
 * fail on the content itself.
 *
 * The screen (`app/board/[id].tsx`) holds only "is it open" and "which id";
 * everything asserted here lives in this component precisely so it can be
 * render-tested, which a screen under `app/` cannot be in this Jest setup.
 */

function setup(over: Partial<React.ComponentProps<typeof CodeComposerHost>> = {}) {
  const onCreate = jest.fn().mockResolvedValue("c-new");
  const onUpdate = jest.fn().mockResolvedValue(undefined);
  const onClose = jest.fn();
  const utils = render(
    <CodeComposerHost
      visible
      editingId={null}
      initialCode={null}
      initialLanguage={null}
      onCreate={onCreate}
      onUpdate={onUpdate}
      onClose={onClose}
      {...over}
    />
  );
  return { onCreate, onUpdate, onClose, ...utils };
}

function type(code: string) {
  fireEvent.changeText(screen.getByTestId("code-composer-source"), code);
}

function submit() {
  fireEvent.press(screen.getByTestId("code-composer-submit"));
}

describe("CodeComposerHost — insert (Month 6)", () => {
  it("creates the code element and closes on success", async () => {
    const { onCreate, onUpdate, onClose } = setup();
    type("const x = 1;");
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("const x = 1;", "ts"));
    expect(onUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("defaults to CODE_DEFAULT_LANGUAGE (ts) when nothing is picked", async () => {
    const { onCreate } = setup();
    type("print(1)");
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("print(1)", "ts"));
  });

  it("submits the language selected from the chip row", async () => {
    const { onCreate } = setup();
    type("print(1)");
    fireEvent.press(screen.getByTestId("code-composer-lang-py"));
    submit();
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("print(1)", "py"));
  });

  it("will not submit empty or whitespace-only source", async () => {
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

describe("CodeComposerHost — a write failure keeps the sheet open (Month 6)", () => {
  it("shows the failure message inline and does NOT close", async () => {
    const onCreate = jest.fn().mockRejectedValue(new Error("That code element is no longer on the board."));
    const { onClose } = setup({ onCreate });
    type("const x = 1;");
    submit();

    expect(await screen.findByTestId("code-composer-error")).toHaveTextContent(
      "That code element is no longer on the board."
    );
    expect(onClose).not.toHaveBeenCalled();
    // What they typed is still there to correct/copy elsewhere.
    expect(screen.getByTestId("code-composer-source").props.value).toBe("const x = 1;");
  });

  it("clears a previous failure when the next attempt succeeds", async () => {
    const onCreate = jest
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce("c-new");
    const { onClose } = setup({ onCreate });

    type("const x = 1;");
    submit();
    expect(await screen.findByTestId("code-composer-error")).toBeTruthy();

    submit();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByTestId("code-composer-error")).toBeNull();
  });

  it("disables the submit button while a write is in flight", async () => {
    let release!: (id: string) => void;
    const onCreate = jest.fn(() => new Promise<string>((r) => (release = r)));
    setup({ onCreate });
    type("const x = 1;");
    submit();

    await waitFor(() => expect(screen.getByTestId("code-composer-busy")).toBeTruthy());
    // A second press must not fire a second write.
    submit();
    expect(onCreate).toHaveBeenCalledTimes(1);

    await act(async () => {
      release("c-new");
    });
  });
});

describe("CodeComposerHost — edit (Month 6)", () => {
  it("seeds the field from the element and routes to onUpdate, not onCreate", async () => {
    const { onCreate, onUpdate } = setup({
      editingId: "c1",
      initialCode: "let a = 1;",
      initialLanguage: "js",
    });
    expect(screen.getByTestId("code-composer-source").props.value).toBe("let a = 1;");

    type("let a = 2;");
    submit();
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith("c1", "let a = 2;", "js"));
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("labels itself as an edit rather than an insert", () => {
    setup({ editingId: "c1", initialCode: "let a = 1;", initialLanguage: "js" });
    expect(screen.getByText("Edit code")).toBeTruthy();
    expect(screen.queryByText("New code block")).toBeNull();
  });

  it("labels itself as an edit even when the existing element's code is empty", () => {
    // The trap this guards against: deriving "am I editing" from the seeded
    // text (`initialCode`) instead of the id would mislabel this as an
    // insert, because an existing element can legitimately have empty code
    // (see `CodeElement`'s type comment). `editingId` is the only reliable
    // signal, and it must also still route to `onUpdate`, not `onCreate`.
    const { onCreate, onUpdate } = setup({ editingId: "c1", initialCode: "", initialLanguage: "ts" });
    expect(screen.getByText("Edit code")).toBeTruthy();
    expect(screen.queryByText("New code block")).toBeNull();
    submit(); // empty field: canSubmit is false, so this just proves no crash
    expect(onCreate).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("re-seeds when a DIFFERENT element is opened", () => {
    const { rerender, onCreate, onUpdate, onClose } = setup({
      editingId: "c1",
      initialCode: "let a = 1;",
      initialLanguage: "js",
    });
    rerender(
      <CodeComposerHost
        visible
        editingId="c2"
        initialCode="print(2)"
        initialLanguage="py"
        onCreate={onCreate}
        onUpdate={onUpdate}
        onClose={onClose}
      />
    );
    // Showing the previous element's source over a different element is how
    // an edit silently overwrites the wrong thing.
    expect(screen.getByTestId("code-composer-source").props.value).toBe("print(2)");
  });

  it("does not carry a failure from one element over to the next", async () => {
    const onCreate = jest.fn();
    const onUpdate = jest.fn().mockRejectedValue(new Error("nope"));
    const onClose = jest.fn();
    const { rerender } = render(
      <CodeComposerHost
        visible
        editingId="c1"
        initialCode="let a = 1;"
        initialLanguage="js"
        onCreate={onCreate}
        onUpdate={onUpdate}
        onClose={onClose}
      />
    );
    type("let a = 2;");
    submit();
    expect(await screen.findByTestId("code-composer-error")).toBeTruthy();

    rerender(
      <CodeComposerHost
        visible
        editingId="c2"
        initialCode="print(2)"
        initialLanguage="py"
        onCreate={onCreate}
        onUpdate={onUpdate}
        onClose={onClose}
      />
    );
    expect(screen.queryByTestId("code-composer-error")).toBeNull();
  });
});

describe("codeErrorMessage — passes a write-path rejection through (Month 6)", () => {
  it("passes a readable message through verbatim", () => {
    expect(codeErrorMessage(new Error("That code element is no longer on the board."))).toBe(
      "That code element is no longer on the board."
    );
  });

  it("falls back to a readable sentence for a message-less failure", () => {
    expect(codeErrorMessage(null)).toBe("Couldn't save that code block.");
    expect(codeErrorMessage({})).toBe("Couldn't save that code block.");
  });
});
