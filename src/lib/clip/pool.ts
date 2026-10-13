/** Run `task` with a concurrency cap and a minimum gap between starts. */
export async function mapStaggered<T, R>(
  items: readonly T[],
  concurrency: number,
  gapMs: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  let active = 0;
  let nextSlot = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let failed = false;
  const waiters: Array<(granted: boolean) => void> = [];

  function pump() {
    if (timer || failed) return;
    if (active >= limit || waiters.length === 0) return;
    const delay = Math.max(0, nextSlot - Date.now());
    if (delay > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, delay);
      return;
    }
    nextSlot = Date.now() + gapMs;
    active += 1;
    const resume = waiters.shift();
    resume?.(true);
    pump();
  }

  function cancel() {
    failed = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    while (waiters.length) waiters.shift()?.(false);
  }

  function acquire(): Promise<boolean> {
    return new Promise((resolve) => {
      waiters.push(resolve);
      pump();
    });
  }

  async function worker(): Promise<void> {
    while (!failed) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const granted = await acquire();
      if (!granted || failed) {
        if (granted) active -= 1;
        return;
      }
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        cancel();
        throw error;
      } finally {
        active -= 1;
        if (!failed) pump();
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
