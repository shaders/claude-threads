import { describe, it, expect, jest, afterEach, mock } from 'bun:test';
import { startLoopStallWatchdog } from './loop-stall.js';

describe('startLoopStallWatchdog', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** A clock the test moves by hand, so a "freeze" needs no real waiting. */
  function fakeClock(start = 1_000_000) {
    let value = start;
    return {
      now: () => value,
      advance: (ms: number) => { value += ms; },
    };
  }

  it('says nothing while ticks arrive on schedule', () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const onStall = mock((_stalledMs: number) => {});
    const timer = startLoopStallWatchdog({ onStall, now: clock.now, sampleMs: 1000, thresholdMs: 30_000 });

    for (let i = 0; i < 10; i++) {
      clock.advance(1000);
      jest.advanceTimersByTime(1000);
    }

    expect(onStall).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('reports the gap when the loop comes back from a freeze', () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const onStall = mock((_stalledMs: number) => {});
    const timer = startLoopStallWatchdog({ onStall, now: clock.now, sampleMs: 1000, thresholdMs: 30_000 });

    // The tick was due after 1s and ran 15 minutes late: the wall clock moved,
    // the loop did not.
    clock.advance(15 * 60_000);
    jest.advanceTimersByTime(1000);

    expect(onStall).toHaveBeenCalledTimes(1);
    // 15min minus the 1s sample we asked for.
    expect(onStall.mock.calls[0][0]).toBe(15 * 60_000 - 1000);
    clearInterval(timer);
  });

  it('ignores jitter below the threshold', () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const onStall = mock((_stalledMs: number) => {});
    const timer = startLoopStallWatchdog({ onStall, now: clock.now, sampleMs: 1000, thresholdMs: 30_000 });

    clock.advance(5_000);
    jest.advanceTimersByTime(1000);

    expect(onStall).not.toHaveBeenCalled();
    clearInterval(timer);
  });

  it('measures each gap on its own, not cumulatively', () => {
    jest.useFakeTimers();
    const clock = fakeClock();
    const onStall = mock((_stalledMs: number) => {});
    const timer = startLoopStallWatchdog({ onStall, now: clock.now, sampleMs: 1000, thresholdMs: 30_000 });

    clock.advance(60_000);
    jest.advanceTimersByTime(1000);
    clock.advance(1000);
    jest.advanceTimersByTime(1000);

    expect(onStall).toHaveBeenCalledTimes(1);
    clearInterval(timer);
  });
});
