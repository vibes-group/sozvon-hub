import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReconnectScheduler } from './reconnect';

const DELAYS = [1000, 2000, 4000] as const;

function flush(): Promise<void> {
  return Promise.resolve();
}

describe('createReconnectScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the first attempt after the first delay', async () => {
    const onAttempt = vi.fn().mockResolvedValue(undefined);
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted: vi.fn(),
      isLeaving: () => false,
    });

    s.schedule();
    expect(onAttempt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(onAttempt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith(0);
  });

  it('walks the backoff schedule on repeated failures', async () => {
    const onAttempt = vi.fn().mockRejectedValue(new Error('fail'));
    const onExhausted = vi.fn();
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted,
      isLeaving: () => false,
    });

    s.schedule();

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(onAttempt).toHaveBeenLastCalledWith(0);

    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(onAttempt).toHaveBeenLastCalledWith(1);

    await vi.advanceTimersByTimeAsync(4000);
    await flush();
    expect(onAttempt).toHaveBeenLastCalledWith(2);

    // Three delay slots, three attempts — no fourth attempt is ever fired,
    // and the failing third attempt hands off to onExhausted.
    expect(onAttempt).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('calls onExhausted after the last delay slot fails', async () => {
    const onAttempt = vi.fn().mockRejectedValue(new Error('fail'));
    const onExhausted = vi.fn();
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted,
      isLeaving: () => false,
    });

    s.schedule();
    for (const d of DELAYS) {
      await vi.advanceTimersByTimeAsync(d);
      await flush();
    }

    expect(onAttempt).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('resets the attempt counter after a successful attempt', async () => {
    const onAttempt = vi.fn().mockResolvedValue(undefined);
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted: vi.fn(),
      isLeaving: () => false,
    });

    s.schedule();
    expect(s.attemptIndex).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(s.attemptIndex).toBe(0);

    // A fresh schedule starts from the first delay again.
    s.schedule();
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(onAttempt).toHaveBeenLastCalledWith(0);
  });

  it('does not double-schedule while a timer is pending', async () => {
    const onAttempt = vi.fn().mockResolvedValue(undefined);
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted: vi.fn(),
      isLeaving: () => false,
    });

    s.schedule();
    s.schedule();
    s.schedule();
    expect(s.attemptIndex).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(onAttempt).toHaveBeenCalledTimes(1);
  });

  it('does nothing when isLeaving() is true at schedule time', () => {
    const onAttempt = vi.fn();
    const onExhausted = vi.fn();
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted,
      isLeaving: () => true,
    });

    s.schedule();
    vi.advanceTimersByTime(10000);
    expect(onAttempt).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it('skips a fired attempt when the user leaves before it runs', async () => {
    let leaving = false;
    const onAttempt = vi.fn().mockResolvedValue(undefined);
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted: vi.fn(),
      isLeaving: () => leaving,
    });

    s.schedule();
    leaving = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(onAttempt).not.toHaveBeenCalled();
  });

  it('reset() cancels the pending timer and clears the counter', async () => {
    const onAttempt = vi.fn().mockResolvedValue(undefined);
    const s = createReconnectScheduler({
      delays: DELAYS,
      onAttempt,
      onExhausted: vi.fn(),
      isLeaving: () => false,
    });

    s.schedule();
    expect(s.attemptIndex).toBe(1);
    s.reset();
    expect(s.attemptIndex).toBe(0);

    await vi.advanceTimersByTimeAsync(10000);
    expect(onAttempt).not.toHaveBeenCalled();
  });
});
