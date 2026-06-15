import { throttle } from "../throttle";

jest.useFakeTimers();

beforeEach(() => {
  jest.clearAllTimers();
});

describe("throttle", () => {
  it("invokes immediately on the leading edge", () => {
    const fn = jest.fn();
    const t = throttle(fn, 100);
    t("a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith("a");
  });

  it("coalesces calls within the window to a single trailing call with the latest args", () => {
    const fn = jest.fn();
    const t = throttle(fn, 100);
    t("a"); // leading
    t("b");
    t("c");
    expect(fn).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("c"); // latest-wins
  });

  it("allows another leading call after the window elapses", () => {
    const fn = jest.fn();
    const t = throttle(fn, 100);
    t("a");
    jest.advanceTimersByTime(150);
    t("b");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
  });

  it("cancel() drops a pending trailing call", () => {
    const fn = jest.fn();
    const t = throttle(fn, 100);
    t("a"); // leading
    t("b"); // pending trailing
    t.cancel();
    jest.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("flush() fires a pending trailing call immediately", () => {
    const fn = jest.fn();
    const t = throttle(fn, 100);
    t("a"); // leading
    t("b"); // pending trailing
    t.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
  });
});
