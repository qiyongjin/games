function abortError() {
  return new DOMException('本次计算已取消', 'AbortError');
}

/** An asynchronous opponent interface, reusable by a future remote opponent. */
export function createLocalOpponent() {
  let nextId = 0;
  let disposed = false;
  const pending = new Set();

  function requestMove(position, { difficulty = 'beginner', signal, entries = [] } = {}) {
    if (disposed || signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let worker;
      let timer;
      let settled = false;
      const id = ++nextId;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        worker?.terminate();
        pending.delete(cancel);
      };
      const finish = (error, move) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(move);
      };
      const cancel = () => finish(abortError());
      pending.add(cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
        worker.addEventListener('message', event => {
          if (event.data?.id !== id) return;
          if (event.data.error) finish(new Error(event.data.error));
          else finish(null, event.data.result?.move ?? null);
        });
        worker.addEventListener('error', () => finish(new Error('电脑计算暂时失败，请重试。')));
        worker.addEventListener('messageerror', () => finish(new Error('电脑计算结果无法读取，请重试。')));
        // Includes generous allowance for worker startup on slower mobile devices.
        timer = setTimeout(() => finish(new Error('电脑计算超时，请重试。')), difficulty === 'normal' ? 6000 : 5000);
        worker.postMessage({ id, position, difficulty, entries });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  return {
    requestMove,
    dispose() {
      disposed = true;
      for (const cancel of [...pending]) cancel();
    },
  };
}
