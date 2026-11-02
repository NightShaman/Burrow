import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserPipe } from './browser-pipe.mjs';

function fakeBrowser() {
  const browser = new EventEmitter();
  browser.pid = 123;
  browser.stdout = new EventEmitter();
  browser.stderr = new EventEmitter();
  browser.stdio = [null, browser.stdout, browser.stderr, new EventEmitter(), new EventEmitter()];
  browser.stdio[3].write = vi.fn((_data, callback) => callback?.());
  const transport = browserPipe(browser, { binary: '/fake/chrome' });
  const sent = () => browser.stdio[3].write.mock.calls.map(([s]) => JSON.parse(s.slice(0, -1)));
  const reply = (id, result) =>
    browser.stdio[4].emit('data', JSON.stringify({ id, result }) + '\0');
  return { browser, transport, sent, reply };
}
afterEach(() => vi.useRealTimers());

describe('browser startup CDP pipe (no browser process)', () => {
  it('waits for a valid version response and records readiness without creating a target', async () => {
    const { transport, sent, reply } = fakeBrowser();
    const ready = transport.ready();
    expect(sent()).toEqual([{ id: 1, method: 'Browser.getVersion', params: {} }]);
    const version = { product: 'Chrome/Synthetic', protocolVersion: '1.3' };
    reply(1, version);
    await expect(ready).resolves.toEqual(version);
    expect(transport.snapshot().version).toEqual(version);
    expect(transport.snapshot().receivedMessages).toBe(1);
    expect(transport.snapshot().receivedBytes).toBeGreaterThan(0);
    expect(transport.snapshot().lifecycle.map((e) => e.event)).toEqual([
      'handshake-start',
      'handshake-ready',
    ]);
  });
  it('allows startup up to 60 seconds but keeps interactions at 15 seconds; no retries', async () => {
    vi.useFakeTimers();
    const { transport, sent, reply } = fakeBrowser();
    const ready = transport.ready();
    await vi.advanceTimersByTimeAsync(59000);
    expect(sent()).toHaveLength(1);
    reply(1, { product: 'Synthetic', protocolVersion: '1.3' });
    await ready;
    const failure = expect(transport.call('Target.createTarget')).rejects.toThrow('after 15000ms');
    await vi.advanceTimersByTimeAsync(15000);
    await failure;
    expect(sent()).toHaveLength(2);
  });
  it('fails the single handshake at its bounded 60 second deadline', async () => {
    vi.useFakeTimers();
    const { transport, sent } = fakeBrowser();
    const failure = expect(transport.ready()).rejects.toThrow('Browser.getVersion after 60000ms');
    await vi.advanceTimersByTimeAsync(60000);
    await failure;
    expect(sent()).toHaveLength(1);
    expect(transport.snapshot().pipes.pendingMethods).toEqual([]);
  });
  it.each(['error', 'exit', 'pipe-close', 'pipe-end', 'pipe-error'])(
    'rejects immediately on %s and retains diagnostics',
    async (event) => {
      const { browser, transport } = fakeBrowser();
      const failure = expect(transport.ready()).rejects.toThrow();
      browser.stdout.emit('data', 'synthetic stdout');
      browser.stderr.emit('data', 'synthetic stderr');
      if (event === 'error') browser.emit('error', new Error('spawn failed'));
      if (event === 'exit') browser.emit('exit', 9, null);
      if (event === 'pipe-close') browser.stdio[4].emit('close');
      if (event === 'pipe-end') browser.stdio[4].emit('end');
      if (event === 'pipe-error') browser.stdio[3].emit('error', new Error('broken pipe'));
      await failure;
      expect(transport.snapshot()).toMatchObject({
        binary: '/fake/chrome',
        pid: 123,
        stdout: 'synthetic stdout',
        stderr: 'synthetic stderr',
      });
      expect(transport.snapshot().pipes.pendingMethods).toEqual([]);
      await expect(transport.call('Target.createTarget')).rejects.toThrow();
    },
  );
  it('rejects protocol error, malformed payload and invalid readiness response', async () => {
    for (const payload of [
      JSON.stringify({ id: 1, error: { message: 'unsupported' } }),
      'not json',
      JSON.stringify({ id: 1, result: {} }),
    ]) {
      const { browser, transport } = fakeBrowser();
      const failure = expect(transport.ready()).rejects.toThrow();
      browser.stdio[4].emit('data', payload + '\0');
      await failure;
    }
  });
});
