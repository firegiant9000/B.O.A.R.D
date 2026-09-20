import { review, INITIAL_CARD, MIN_EASE } from "../sm2";

const T = 1_760_000_000_000;
const DAY = 86_400_000;

describe("SM-2", () => {
  it("schedules a first successful review one day out", () => {
    const c = review(INITIAL_CARD, 5, T);
    expect(c.repetitions).toBe(1);
    expect(c.intervalDays).toBe(1);
    expect(c.dueAtMs).toBe(T + DAY);
  });

  it("schedules the second successful review six days out", () => {
    const c = review(review(INITIAL_CARD, 5, T), 5, T);
    expect(c.repetitions).toBe(2);
    expect(c.intervalDays).toBe(6);
  });

  it("multiplies by the ease factor from the third review on", () => {
    let c = review(review(review(INITIAL_CARD, 5, T), 5, T), 5, T);
    expect(c.repetitions).toBe(3);
    expect(c.intervalDays).toBe(Math.round(6 * c.easeFactor));
  });

  it("resets repetitions and interval on a failed review", () => {
    const good = review(review(INITIAL_CARD, 5, T), 5, T);
    const bad = review(good, 2, T);
    expect(bad.repetitions).toBe(0);
    expect(bad.intervalDays).toBe(1);
  });

  it("keeps the ease factor when a card is failed but does not raise it", () => {
    const good = review(INITIAL_CARD, 5, T);
    expect(review(good, 2, T).easeFactor).toBeLessThanOrEqual(good.easeFactor);
  });

  it("never lets the ease factor fall below the floor", () => {
    let c = INITIAL_CARD;
    for (let i = 0; i < 20; i++) c = review(c, 3, T);
    expect(c.easeFactor).toBeGreaterThanOrEqual(MIN_EASE);
  });

  it("raises the ease factor on a perfect review", () => {
    expect(review(INITIAL_CARD, 5, T).easeFactor).toBeGreaterThan(INITIAL_CARD.easeFactor);
  });

  it("rejects a quality outside 0-5", () => {
    expect(() => review(INITIAL_CARD, 6 as never, T)).toThrow();
    expect(() => review(INITIAL_CARD, -1 as never, T)).toThrow();
  });

  it("computes dueAtMs correctly on a second review", () => {
    const c = review(review(INITIAL_CARD, 5, T), 5, T);
    expect(c.dueAtMs).toBe(T + 6 * DAY);
  });

  it("computes dueAtMs correctly on a third review with ease factor multiplier", () => {
    let c = review(review(review(INITIAL_CARD, 5, T), 5, T), 5, T);
    expect(c.dueAtMs).toBe(T + c.intervalDays * DAY);
  });

  it("rejects NaN quality", () => {
    expect(() => review(INITIAL_CARD, NaN, T)).toThrow();
  });

  it("rejects Infinity quality", () => {
    expect(() => review(INITIAL_CARD, Infinity as never, T)).toThrow();
  });

  it("rejects non-integer quality", () => {
    expect(() => review(INITIAL_CARD, 3.5 as never, T)).toThrow();
  });
});
