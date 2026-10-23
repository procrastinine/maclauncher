type Waiter<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };
type Write<T> = { value: T; waiters: Waiter<T>[] };
export type QueuedWriter<T> = { readonly busy: boolean; save: (value: T) => Promise<T> };

export function createQueuedWriter<T>(write: (value: T) => Promise<void>): QueuedWriter<T> {
  let active: Write<T> | null = null;
  let pending: Write<T> | null = null;
  let draining = false;
  async function drain() {
    draining = true;
    while (pending) {
      const current: Write<T> = pending;
      pending = null;
      active = current;
      try {
        await write(current.value);
        for (const waiter of current.waiters) waiter.resolve(current.value);
      } catch (error) {
        for (const waiter of current.waiters) waiter.reject(error);
      }
      active = null;
    }
    draining = false;
  }
  return {
    get busy() { return draining; },
    save(value: T): Promise<T> {
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        if (active && Object.is(active.value, value) && !pending) active.waiters.push(waiter);
        else {
          if (pending) { pending.value = value; pending.waiters.push(waiter); }
          else pending = { value, waiters: [waiter] };
          if (!draining) void drain();
        }
      });
    }
  };
}
