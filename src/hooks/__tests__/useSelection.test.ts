import { renderHook, act } from "@testing-library/react-native";
import { useSelection } from "../useSelection";

describe("useSelection", () => {
  it("starts empty", () => {
    const { result } = renderHook(() => useSelection());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectedId).toBeNull();
    expect(result.current.isSelected("a")).toBe(false);
  });

  it("select replaces the selection with a single id", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.select("a"));
    expect(result.current.selectedId).toBe("a");
    act(() => result.current.select("b"));
    expect(result.current.selectedIds.size).toBe(1);
    expect(result.current.isSelected("b")).toBe(true);
    expect(result.current.isSelected("a")).toBe(false);
  });

  it("toggle adds and removes without disturbing the rest", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.toggle("a"));
    act(() => result.current.toggle("b"));
    expect(result.current.selectedIds.size).toBe(2);
    // selectedId is null when more than one is selected.
    expect(result.current.selectedId).toBeNull();
    act(() => result.current.toggle("a"));
    expect(result.current.isSelected("a")).toBe(false);
    expect(result.current.selectedId).toBe("b");
  });

  it("clear empties the selection", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.select("a"));
    act(() => result.current.clear());
    expect(result.current.selectedIds.size).toBe(0);
    expect(result.current.selectedId).toBeNull();
  });

  it("records the anchor passed to select", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.select("a", "region"));
    expect(result.current.anchor).toBe("region");
  });

  it("setMany replaces the selection with an id set (marquee / select-all)", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.select("z"));
    act(() => result.current.setMany(["a", "b", "c"]));
    expect(result.current.count).toBe(3);
    expect(result.current.isSelected("z")).toBe(false);
    expect(result.current.isSelected("b")).toBe(true);
    expect(result.current.anchor).toBe("region");
  });

  it("addMany unions ids into the current selection", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.setMany(["a"]));
    act(() => result.current.addMany(["b", "c"]));
    expect(result.current.count).toBe(3);
    expect(result.current.isSelected("a")).toBe(true);
  });

  it("remove drops a single id and leaves the rest", () => {
    const { result } = renderHook(() => useSelection());
    act(() => result.current.setMany(["a", "b"]));
    act(() => result.current.remove("a"));
    expect(result.current.isSelected("a")).toBe(false);
    expect(result.current.selectedId).toBe("b");
  });

  it("count tracks the selection size", () => {
    const { result } = renderHook(() => useSelection());
    expect(result.current.count).toBe(0);
    act(() => result.current.setMany(["a", "b", "c"]));
    expect(result.current.count).toBe(3);
  });
});
