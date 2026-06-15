// Leading + trailing throttle (Month 4, Phase 6). Invokes immediately on the
// first call, then at most once per `intervalMs`, always delivering the most
// recent arguments on the trailing edge. Used to cap cursor write frequency
// (~20Hz) without dropping the final resting position.
export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /** Drop any pending trailing call. */
  cancel(): void;
  /** Fire any pending trailing call now. */
  flush(): void;
}

export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number
): Throttled<A> {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const invoke = (args: A) => {
    last = Date.now();
    fn(...args);
  };

  const throttled = ((...args: A) => {
    const remaining = intervalMs - (Date.now() - last);
    pending = args;
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke(args);
      pending = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          invoke(pending);
          pending = null;
        }
      }, remaining);
    }
  }) as Throttled<A>;

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) {
      invoke(pending);
      pending = null;
    }
  };

  return throttled;
}
