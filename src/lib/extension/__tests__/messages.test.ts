import { validateExtensionMessage, PAGE_METADATA_MESSAGE } from "../messages";

describe("validateExtensionMessage", () => {
  it("accepts a well-formed page-metadata message with an image", () => {
    const result = validateExtensionMessage({
      type: PAGE_METADATA_MESSAGE,
      url: "https://example.com/",
      title: "Example",
      image: "https://example.com/og.png",
    });
    expect(result).toEqual({
      type: PAGE_METADATA_MESSAGE,
      url: "https://example.com/",
      title: "Example",
      image: "https://example.com/og.png",
    });
  });

  it("accepts a well-formed message with no image", () => {
    const result = validateExtensionMessage({
      type: PAGE_METADATA_MESSAGE,
      url: "https://example.com/",
      title: "Example",
    });
    expect(result).toEqual({
      type: PAGE_METADATA_MESSAGE,
      url: "https://example.com/",
      title: "Example",
    });
  });

  it("rejects null, undefined, and non-object input", () => {
    expect(validateExtensionMessage(null)).toBeNull();
    expect(validateExtensionMessage(undefined)).toBeNull();
    expect(validateExtensionMessage("a string")).toBeNull();
    expect(validateExtensionMessage(42)).toBeNull();
  });

  it("rejects a message of an unknown type", () => {
    expect(
      validateExtensionMessage({ type: "SOMETHING_ELSE", url: "https://example.com/", title: "x" })
    ).toBeNull();
  });

  it("rejects a message missing url or with an empty url", () => {
    expect(validateExtensionMessage({ type: PAGE_METADATA_MESSAGE, title: "x" })).toBeNull();
    expect(
      validateExtensionMessage({ type: PAGE_METADATA_MESSAGE, url: "", title: "x" })
    ).toBeNull();
  });

  it("rejects a message missing title", () => {
    expect(
      validateExtensionMessage({ type: PAGE_METADATA_MESSAGE, url: "https://example.com/" })
    ).toBeNull();
  });

  it("rejects a non-string title even though it's present", () => {
    expect(
      validateExtensionMessage({
        type: PAGE_METADATA_MESSAGE,
        url: "https://example.com/",
        title: 123,
      })
    ).toBeNull();
  });

  it("rejects a non-string or empty image field rather than silently dropping it", () => {
    expect(
      validateExtensionMessage({
        type: PAGE_METADATA_MESSAGE,
        url: "https://example.com/",
        title: "x",
        image: 123,
      })
    ).toBeNull();
    expect(
      validateExtensionMessage({
        type: PAGE_METADATA_MESSAGE,
        url: "https://example.com/",
        title: "x",
        image: "",
      })
    ).toBeNull();
  });

  it("does not pass extra unexpected fields through", () => {
    const result = validateExtensionMessage({
      type: PAGE_METADATA_MESSAGE,
      url: "https://example.com/",
      title: "x",
      evil: "payload",
    });
    expect(result).toEqual({ type: PAGE_METADATA_MESSAGE, url: "https://example.com/", title: "x" });
    expect(result).not.toHaveProperty("evil");
  });
});
