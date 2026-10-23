// Status reads from polling and explicit refreshes share one pending IPC call.
export function createStatusReader<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(read);
      void pending.then(() => { pending = null; }, () => { pending = null; });
    }
    return pending;
  };
}

export function startStatusPolling<T>({ read, onValue, onError,
  schedule = callback => window.setTimeout(callback, 1500),
  cancel = timer => window.clearTimeout(timer)
}: {
  read: () => Promise<T>; onValue: (value: T) => void; onError: (error: unknown) => void;
  schedule?: (callback: () => void) => number; cancel?: (timer: number) => void;
}): () => void {
  let stopped = false;
  let timer: number | undefined;
  async function poll() {
    timer = undefined;
    try {
      const value = await read();
      if (!stopped) onValue(value);
    } catch (error) { if (!stopped) onError(error); }
    finally { if (!stopped) timer = schedule(() => { void poll(); }); }
  }
  timer = schedule(() => { void poll(); });
  return () => {
    stopped = true;
    if (timer !== undefined) cancel(timer);
  };
}
