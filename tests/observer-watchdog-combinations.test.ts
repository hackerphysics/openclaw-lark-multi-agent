import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('ws', () => ({ default: class extends EventEmitter { send() {} close() {} } }));
import { OpenClawClient, CollectorStalledError } from '../src/openclaw-client.js';
import { FeishuBot } from '../src/feishu-bot.js';
import { harness, event } from './helpers/reliability-harness.js';

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const disposers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  vi.clearAllTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const wire = (h: ReturnType<typeof harness>, channel: string, payload: any) => {
  h.client.ws.emit('message', Buffer.from(JSON.stringify({ type: 'event', event: channel, payload: { sessionKey: h.key, ...payload } })));
};
const final = (h: ReturnType<typeof harness>, runId: string, text: string) => {
  const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] };
  wire(h, 'chat', { runId, state: 'final', message });
  wire(h, 'session.message', { runId, message });
  wire(h, 'agent', { runId, stream: 'lifecycle', data: { phase: 'end' } });
};
async function setup(dbPath?: string) {
  const h = harness(dbPath);
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await h.cleanup(); } };
  disposers.push(close);
  h.client.ensureModel = vi.fn(async () => false);
  h.bot.ensureSession = (FeishuBot.prototype as any).ensureSession.bind(h.bot);
  const connecting = h.client._doConnect();
  h.client.ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', ok: true, payload: { type: 'hello-ok', protocol: 4 } })));
  await connecting;
  await h.bot.ensureSession('chat');
  return { ...h, close };
}
async function detach(h: Awaited<ReturnType<typeof setup>>) {
  const read = h.client.getSessionRuntimeStatus.bind(h.client);
  h.client.getSessionRuntimeStatus = (...args: any[]) => h.sends.length ? new Promise(() => {}) : read(...args);
  const input = h.bot.handleMessage(event('ordinary A', 'original-A'));
  await tick(100);
  expect(h.sends).toHaveLength(1);
  await tick(10 * 60_000 + 30_100);
  await input;
  expect(h.bot.queueRuns.has('chat')).toBe(false);
  expect(h.client.ownedDeliveryRuns.has('r1')).toBe(false);
  expect(h.store.getPendingTriggerIds('Bot', 'chat').size).toBe(0);
  return input;
}

it('obsolete pause A returning after guard B starts cannot rearm or disable guard B', async () => {
  const client: any = new OpenClawClient({ baseUrl: 'ws://offline', token: 'offline' });
  disposers.push(async () => { client.revokeSessionCollectors('s1', 'cleanup'); await client.disconnect(); });
  client.rpc = vi.fn(async () => ({}));
  client.agentEvents.set('agent:main:s1', []);
  let statusCalls = 0;
  client.getSessionRuntimeStatus = () => ++statusCalls === 1 ? Promise.resolve({ running: true, status: 'running' }) : new Promise(() => {});
  let releasePause!: () => void;
  const reply = client.collectReply('r1', 1_000, 's1', { onWaitPaused: () => new Promise<void>(resolve => { releasePause = resolve; }) });
  const rejected = expect(reply).rejects.toBeInstanceOf(CollectorStalledError);
  await tick(1_100);
  expect(releasePause).toBeTypeOf('function');
  client.agentEvents.get('agent:main:s1').push({ sessionKey: 'agent:main:s1', runId: 'r1', stream: 'tool', data: { phase: 'start', name: 'read', toolCallId: 'fresh' } });
  await tick(1_100);
  expect(statusCalls).toBe(2);
  releasePause();
  await tick(30_100);
  await rejected;
  expect(client.eventCollectors.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('final plus transcript mirror in the guard-expiry stack reaches the original platform once', async () => {
  const h = await setup();
  const read = h.client.getSessionRuntimeStatus.bind(h.client);
  let stall = true;
  h.client.getSessionRuntimeStatus = (...args: any[]) => stall && h.sends.length ? new Promise(() => {}) : read(...args);
  const release = h.client.releasePausedWait.bind(h.client);
  let injected = false;
  vi.spyOn(h.client, 'releasePausedWait').mockImplementation((runId: string) => {
    release(runId);
    if (!injected && runId === 'r1') {
      injected = true;
      stall = false; // Only the already-issued watchdog query remains hung.
      // Synchronous reentry: before CollectorStalledError Promise unwind.
      final(h, 'r1', 'exact same-stack result');
    }
  });
  const handled = h.bot.handleMessage(event('ordinary A', 'original-A'));
  await tick(10 * 60_000 + 31_000);
  await handled;
  await tick(100);
  expect(injected).toBe(true);
  expect(h.sends).toHaveLength(1);
  expect(h.store.getDeliveryByKey('Bot', 'chat', 'trigger:1')?.content).toBe('exact same-stack result');
  expect(h.create).toHaveBeenCalledTimes(1);
  expect(h.store.getRecent('chat').filter(row => row.senderType === 'bot')).toHaveLength(1);
});

describe('detached watchdog obligation survives SQLite reopen without a WS final', () => {
  it.each(['visible', 'silent', 'empty', 'error'])('recovers exact %s terminal without replaying the input', async disposition => {
    const dir = mkdtempSync(join(tmpdir(), 'lma-watchdog-reopen-'));
    dirs.push(dir);
    const dbPath = join(dir, 'messages.db');
    const old = await setup(dbPath);
    await detach(old);
    expect(old.store.runObservationState(old.key, 'r1')).toBe('observing');
    await old.close();
    const h = await setup(dbPath);
    const base = h.client.rpc;
    h.client.rpc = vi.fn(async (method: string, params: any) => method === 'agent.wait' ? {
      runId: 'r1', status: disposition === 'error' ? 'error' : 'ok', endedAt: Date.now(),
      ...(disposition === 'error' ? { error: 'authentication rejected' } : { terminalReply: { disposition, ...(disposition === 'visible' ? { text: 'durably recovered answer' } : {}) } }),
    } : base(method, params));
    h.store['db'].prepare('UPDATE run_observations SET next_check_at=0 WHERE run_id=?').run('r1');
    await h.client.recoverExactRuns();
    await tick(150);
    expect(h.sends).toHaveLength(0);
    expect(old.sends).toHaveLength(1);
    expect(h.store.getPendingTriggerIds('Bot', 'chat').size).toBe(0);
    if (disposition === 'visible') {
      expect(h.store.getDeliveryByKey('Bot', 'chat', 'trigger:1')?.content).toBe('durably recovered answer');
      expect(h.create).toHaveBeenCalledTimes(1);
    } else {
      expect(h.store.runObservationState(h.key, 'r1')).toBe('settled');
      expect(h.store.getRecent('chat').filter(row => row.senderType === 'bot').some(row => row.content === 'durably recovered answer')).toBe(false);
    }
  });
  it('stop while exact terminal lookup is pending fences its late result after reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lma-watchdog-stop-reopen-'));
    dirs.push(dir);
    const dbPath = join(dir, 'messages.db');
    const old = await setup(dbPath);
    await detach(old);
    await old.close();
    const h = await setup(dbPath);
    let release!: (value: any) => void;
    const base = h.client.rpc;
    h.client.rpc = vi.fn((method: string, params: any) => method === 'agent.wait' ? new Promise(resolve => { release = resolve; }) : base(method, params));
    h.store['db'].prepare('UPDATE run_observations SET next_check_at=0 WHERE run_id=?').run('r1');
    const recovering = h.client.recoverExactRuns();
    await tick();
    expect(release).toBeTypeOf('function');
    await h.bot.handleStopCommand('chat', 'stop-after-query');
    const platformBefore = h.create.mock.calls.length;
    release({ runId: 'r1', status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'visible', text: 'must never escape stopped run' } });
    await recovering;
    await tick(100);
    expect(h.store.runObservationState(h.key, 'r1')).toBe('stopped');
    expect(h.create.mock.calls.length).toBe(platformBefore);
    expect(h.sends).toHaveLength(0);
  });
});

it('old card receipt after watchdog detach, stop and new owner cannot mutate new card or ACK', async () => {
  const h = await setup();
  let releaseCard!: (id: string) => void;
  h.bot.replyLiveStatusCard = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { releaseCard = resolve; })).mockResolvedValue('card-B');
  await detach(h);
  expect(releaseCard).toBeTypeOf('function');
  await h.bot.handleStopCommand('chat', 'stop-A');
  h.client.getSessionRuntimeStatus = vi.fn(async () => ({ sessionId: 'generation-1', status: 'done', running: false, idleConfirmed: true }));
  h.client.getSessionDispatchStatus = vi.fn(async () => ({ sessionId: 'generation-1', idleConfirmed: true }));
  const b = h.bot.handleMessage(event('ordinary B', 'new-B'));
  await tick(1_000);
  expect(h.sends).toHaveLength(2);
  const rowB = h.store.getMessageId('new-B')!;
  const ackB = h.store.getReactionIntent('Bot', 'chat', rowB);
  const cardB = h.store.listPresentations('Bot', 'offline-app', 'chat').find((row: any) => row.runId === 'r2');
  const patches = h.bot.patchLiveStatusCard.mock.calls.length;
  releaseCard('late-card-A');
  await tick(1_000);
  expect(h.store.getReactionIntent('Bot', 'chat', rowB)).toEqual(ackB);
  expect(h.store.listPresentations('Bot', 'offline-app', 'chat').find((row: any) => row.runId === 'r2')).toMatchObject({ cardId: 'card-B', lease: cardB.lease, runId: 'r2' });
  expect(h.bot.patchLiveStatusCard.mock.calls.slice(patches).some((args: any[]) => args[0] === 'late-card-A')).toBe(false);
  final(h, 'r2', 'B real answer');
  await tick(400);
  await b;
  expect(h.store.getDeliveryByKey('Bot', 'chat', `trigger:${rowB}`)?.content).toBe('B real answer');
});
