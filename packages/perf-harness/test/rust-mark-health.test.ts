// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { rustMarkHealth } from '../../../scripts/profile-canvas-rust.mjs';

const identity = { runId: 'run', rendererInstanceId: 'mount', operationId: 1 };
const windowStart = { pid: 7, tid: 8, ts: 1 };
const windowEnd = { pid: 7, tid: 8, ts: 10 };
function mark(edge: string, ts: number, changes: Record<string, unknown> = {}) {
  return { name: 'TimeStamp', pid: 7, tid: 8, ts,
    args: { data: { message: `canvas-profile/1:${JSON.stringify({ ...identity,
      phase: 'rust.upload', edge, ...changes })}` } } };
}

describe('Rust phase mark verifier', () => {
  it('joins only the current tuple and direct renderer thread', () => {
    const trace = [mark('start', 2), mark('end', 3),
      mark('start', 4, { rendererInstanceId: 'other' }),
      { ...mark('start', 5), tid: 9 }];
    expect(rustMarkHealth(trace, windowStart, windowEnd, [identity])).toEqual({
      count: 3, foreign: 1, unjoined: 1, unbalanced: 0, phases: ['upload'],
    });
  });
  it('rejects unmatched and malformed edges', () => {
    const trace = [mark('start', 2), mark('end', 3, { phase: 'rust.prepare' }),
      { ...mark('end', 4), args: { data: { message: 'canvas-profile/1:{bad' } } }];
    expect(rustMarkHealth(trace, windowStart, windowEnd, [identity])).toEqual({
      count: 2, foreign: 0, unjoined: 1, unbalanced: 2, phases: ['prepare', 'upload'],
    });
  });
});
