// A single active action, with no retry after native outcome uncertainty.
export function createGroundSession(startWorker, timeoutMs = 420000) {
  let worker;
  let busy = false;
  let closed = false;
  let rejectPending;
  function stop() {
    if (closed) return;
    closed = true;
    rejectPending?.(new Error('Private session closed'));
    worker?.stop();
  }
  async function call(action, signal) {
    if (closed || busy || signal?.aborted)
      return { success: false, error: 'Session unavailable or another operation is running' };
    busy = true;
    let timeout;
    const abort = () => stop();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      worker ??= startWorker();
      const result = await Promise.race([
        worker.call(action),
        new Promise((_, reject) => {
          rejectPending = reject;
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Private session timed out')), timeoutMs);
        }),
      ]);
      if (closed || signal?.aborted)
        return { success: false, error: 'Session cancelled; check the selected output path' };
      if ((action === 'publish' || action === 'publish_delete') && result.success === true) stop();
      return result;
    } catch {
      stop();
      return {
        success: false,
        error:
          'Private operation failed or timed out. Session closed; original never overwritten. Check the selected output path.',
      };
    } finally {
      rejectPending = undefined;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      busy = false;
    }
  }
  return { call, stop };
}
