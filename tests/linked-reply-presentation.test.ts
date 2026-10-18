import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('ws', () => ({ default: class extends EventEmitter { send() {} close() {} } }));
import { FeishuBot } from '../src/feishu-bot.js';
import { harness } from './helpers/reliability-harness.js';

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
const ROOT = 'associated-root';
let h: ReturnType<typeof harness>, dir: string, db: string, cardSeq: number;
const rows = () => h.store.listPresentations('Bot', 'offline-app', 'chat');
const manager = () => h.bot.queuedPresentations;
const wire = (event: string, payload: any) => h.client.ws.emit('message', Buffer.from(JSON.stringify({
  type: 'event', event, payload: { sessionKey: h.key, sessionId: 'generation-1', ...payload },
})));
async function setup() {
  h = harness(db);
  h.client.ensureModel = vi.fn(async () => false);
  h.bot.ensureSession = (FeishuBot.prototype as any).ensureSession.bind(h.bot);
  h.bot.replyLiveStatusCard = vi.fn(async () => `card-${++cardSeq}`);
  const connection = h.client._doConnect();
  h.client.ws.emit('message', Buffer.from(JSON.stringify({ type: 'res', ok: true, payload: { type: 'hello-ok', protocol: 4 } })));
  await connection;
  await h.bot.ensureSession('chat');
}
beforeEach(async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-18T08:02:57.563Z'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'lma-linked-reply-')); db = join(dir, 'messages.db'); cardSeq = 0;
  await setup();
});
afterEach(async () => {
  await h.cleanup(); vi.clearAllTimers(); rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers(); vi.restoreAllMocks();
});
async function acceptedInput(id = 'B', root = ROOT) {
  const start = Date.now();
  const row = h.store.insert({ chatId: 'chat', messageId: id, senderType: 'human', senderName: 'fixture-user', content: '收到请回复 OK', timestamp: start });
  h.store.markPendingTrigger('Bot', 'chat', row);
  manager().receive('chat', row, id);
  await tick(900);
  h.store.saveInsertion('Bot', 'chat', row, `sdk-${id}`, 'accepted', {
    messageId: id, text: '收到请回复 OK', sessionKey: h.key, sessionId: 'generation-1', expectedRunId: root, stopEpoch: 0, attempted: true,
  });
  h.store.clearPendingTrigger('Bot', 'chat', row);
  h.store.setReactionIntent('Bot', 'chat', row, { messageId: id, desired: 'Get', shown: 'Get', runId: root, stopEpoch: 0 });
  await manager().insertionAccepted('chat', row, root);
  return { row, start, card: rows().find((record: any) => record.triggerIds.includes(row)) };
}
function assertBusinessUnchanged(row: number) {
  expect(h.store.getInsertion('Bot', 'chat', row)).toMatchObject({ state: 'accepted', attempted: true, expectedRunId: ROOT });
  expect(h.store.getReactionIntent('Bot', 'chat', row).desired).toBe('Get');
  expect(h.store['db'].prepare('SELECT COUNT(*) n FROM message_sync WHERE message_row_id=?').get(row)?.n).toBe(0);
  expect(h.store.hasDeliveredReply('Bot', 'chat', row)).toBe(false);
  expect(h.sends).toHaveLength(0);
}
async function publish(root = ROOT, text = 'OK') {
  wire('chat', { runId: root, state: 'final', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }] } });
  await tick(200);
}
async function storedReply(root = ROOT) {
  return h.bot.enqueueAndDispatchDelivery('chat', 'assistant_visible', 'stored-reply', 'OK', [], undefined, 'proactive:stored-reply', undefined,
    { sessionKey: h.key, sessionId: 'generation-1', runId: root, final: true });
}

describe('platform-linked reply closes only the legacy insertion presentation', () => {
  it('real WS/Bot/outbox receipt reproduces the screenshot, compacts the same card and leaves business custody untouched', async () => {
    const b = await acceptedInput();
    expect(rows()[0].view).toMatchObject({ state: 'queued', phase: 'waiting' });
    expect(rows()[0].runId).toBeUndefined();
    await tick(b.start + 42_000 - Date.now());
    await publish();
    const row = rows()[0];
    expect(row).toMatchObject({ cardId: b.card.cardId, view: { state: 'replied', phase: 'replied', elapsed: '0:42' } });
    expect(row.runId).toBeUndefined(); // expected root is not an actual receiver witness
    expect(row.linkedReply).toMatchObject({ runId: ROOT, rendered: 'summary' });
    expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
    expect(h.bot.patchLiveStatusCard).toHaveBeenCalledWith(b.card.cardId, expect.objectContaining({ state: 'replied', elapsed: '0:42' }), 'chat');
    const card = h.bot.buildLiveStatusCard(row.view, 'chat');
    expect(card.header).toBeUndefined();
    expect(JSON.stringify(card)).toContain('关联轮次已回复');
    expect(JSON.stringify(card)).not.toContain('✅');
    expect(h.create).toHaveBeenCalledTimes(1); // the original actual OK reply, not a regenerated answer
    assertBusinessUnchanged(b.row);
    const edits = h.bot.patchLiveStatusCard.mock.calls.length;
    await tick(120_000); await h.bot.reconcileInsertions('chat'); await tick(100);
    expect(rows()[0].view.state).toBe('replied');
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits);
    assertBusinessUnchanged(b.row);
  });
  it('late acceptance receipt after the real reply still closes the known card without another model or body send', async () => {
    const b = await acceptedInput();
    h.store.saveInsertion('Bot', 'chat', b.row, `sdk-B`, 'unknown', { ...h.store.getInsertion('Bot', 'chat', b.row), attempted: true });
    await publish();
    expect(rows()[0].view.state).not.toBe('replied');
    h.store.saveInsertion('Bot', 'chat', b.row, `sdk-B`, 'accepted', { ...h.store.getInsertion('Bot', 'chat', b.row), attempted: true });
    await h.bot.reconcileInsertions('chat'); await tick(100);
    expect(rows()[0].view.state).toBe('replied');
    expect(h.create).toHaveBeenCalledTimes(1); assertBusinessUnchanged(b.row);
  });
  it('restart recovers an existing queued card from the durable original-group receipt, using delivery time rather than repair time', async () => {
    const b = await acceptedInput();
    await tick(b.start + 42_000 - Date.now()); await storedReply();
    expect(rows()[0].view.state).toBe('queued'); // persisted old-version incident
    await h.cleanup(); await tick(19 * 60_000); await setup();
    await h.bot.reconcileInsertions('chat'); await tick(100);
    expect(rows()[0]).toMatchObject({ cardId: b.card.cardId, view: { state: 'replied', elapsed: '0:42' } });
    expect(h.bot.replyLiveStatusCard).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);
    assertBusinessUnchanged(b.row);
  });
  it('a new C cannot be coalesced into the closing B card, and duplicate ingress never creates a second B card', async () => {
    const b = await acceptedInput(); await publish();
    manager().receive('chat', b.row, 'B'); await tick(100);
    expect(h.bot.replyLiveStatusCard).toHaveBeenCalledTimes(1);
    const c = h.store.insert({ chatId: 'chat', messageId: 'C', senderType: 'human', senderName: 'fixture-user', content: 'new C', timestamp: Date.now() });
    manager().receive('chat', c, 'C'); await tick(900);
    expect(rows()).toHaveLength(2);
    expect(rows().find((row: any) => row.triggerIds.includes(c))).toMatchObject({ view: { state: 'queued' } });
    expect(rows().find((row: any) => row.triggerIds.includes(c))?.cardId).not.toBe(b.card.cardId);
    assertBusinessUnchanged(b.row);
  });
  it('zero-SDK edit checkpoint failure leaves a recoverable UI obligation, not a permanently frozen desired state', async () => {
    const b = await acceptedInput();
    const save = h.store.savePresentation.bind(h.store); let failed = false;
    vi.spyOn(h.store, 'savePresentation').mockImplementation((bot: any, app: any, chat: any, id: any, record: any) => {
      if (!failed && record.view?.state === 'replied' && Object.values(record.editEffects || {}).includes('attempted')) {
        failed = true; throw Object.assign(new Error('pre-effect UI checkpoint failure'), { code: 'SQLITE_BUSY' });
      }
      return save(bot, app, chat, id, record);
    });
    const edits = h.bot.patchLiveStatusCard.mock.calls.length;
    await publish(); expect(failed).toBe(true);
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits);
    expect(rows()[0].linkedReply.rendered).toBeUndefined();
    // The existing recovery worker is paced in five-second checks; allow its
    // next due observation after the independent one-minute UI backoff.
    await tick(70_000); await h.bot.reconcileInsertions('chat'); await tick(200);
    expect(rows()[0].linkedReply.rendered).toBe('summary');
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits + 1);
    expect(h.create).toHaveBeenCalledTimes(1); assertBusinessUnchanged(b.row);
  });
  it('combined desired and pre-effect write outage retries a sealed UI obligation without restarting', async () => {
    const b = await acceptedInput();
    const save = h.store.savePresentation.bind(h.store); let block = true;
    vi.spyOn(h.store, 'savePresentation').mockImplementation((bot: any, app: any, chat: any, id: any, record: any) => {
      if (block && (record.view?.state === 'replied' || Object.values(record.editEffects || {}).includes('attempted')))
        throw Object.assign(new Error('desired and pre-effect outage'), { code: 'SQLITE_BUSY' });
      return save(bot, app, chat, id, record);
    });
    const edits = h.bot.patchLiveStatusCard.mock.calls.length;
    await publish();
    expect(rows()[0].view.state).toBe('queued');
    expect(rows()[0].linkedReply.rendered).toBeUndefined();
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits);
    block = false; await tick(70_000); await h.bot.reconcileInsertions('chat'); await tick(200);
    expect(rows()[0].linkedReply.rendered).toBe('summary');
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits + 1);
    expect(h.create).toHaveBeenCalledTimes(1); assertBusinessUnchanged(b.row);
  });
  it('a later cohort staging read outage owns earlier flight rejections without an unhandled process error', async () => {
    const one = await acceptedInput('B1');
    const first = rows()[0];
    h.store.savePresentation('Bot', 'offline-app', 'chat', first.id, { ...first, submissionId: 'sealed-first-cohort' });
    const two = await acceptedInput('B2'); await storedReply();
    const get = h.store.getPresentation.bind(h.store); let outage = false;
    const probe = vi.spyOn(h.store, 'getPresentation').mockImplementation((bot: any, app: any, chat: any, id: any) => {
      if (id === two.card.id) outage = true;
      if (outage) throw Object.assign(new Error('later staging and earlier flight read outage'), { code: 'SQLITE_BUSY' });
      return get(bot, app, chat, id);
    });
    await expect(manager().reconcileDeliveredReply('chat', ROOT)).rejects.toThrow('read outage');
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    probe.mockRestore(); await tick(100);
    // Vitest additionally fails the test run if the earlier flight escapes as
    // an unhandled rejection, even when the parent rejection was caught.
    expect(manager().replyFlights.size).toBe(0);
    assertBusinessUnchanged(one.row); assertBusinessUnchanged(two.row);
  });
  it('a crash after desired replied checkpoint but before SDK invocation can retry that known card after reopen', async () => {
    const b = await acceptedInput(); await tick(10_000); await storedReply();
    const proof = h.store.getDeliveredRunReply('Bot', 'offline-app', 'chat', ROOT, 0)!;
    const row = rows()[0];
    h.store.savePresentation('Bot', 'offline-app', 'chat', row.id, { ...row,
      linkedReply: { runId: ROOT, outboxId: proof.outboxId, deliveredAt: proof.deliveredAt },
      view: { ...row.view, state: 'replied', phase: 'replied' }, editEffects: {},
    });
    await h.cleanup(); await setup();
    await h.bot.reconcileInsertions('chat'); await tick(200);
    expect(rows()[0]).toMatchObject({ cardId: b.card.cardId, linkedReply: { rendered: 'summary' } });
    expect(h.bot.patchLiveStatusCard).toHaveBeenCalledTimes(1);
    expect(h.create).not.toHaveBeenCalled(); assertBusinessUnchanged(b.row);
  });
  it('successful card SDK receipt survives a failing rendered-marker checkpoint without another SDK send', async () => {
    const b = await acceptedInput();
    const save = h.store.savePresentation.bind(h.store); let block = true;
    vi.spyOn(h.store, 'savePresentation').mockImplementation((bot: any, app: any, chat: any, id: any, record: any) => {
      if (block && record.linkedReply?.rendered === 'summary') throw Object.assign(new Error('post-SDK UI journal failure'), { code: 'SQLITE_BUSY' });
      return save(bot, app, chat, id, record);
    });
    const edits = h.bot.patchLiveStatusCard.mock.calls.length;
    await publish(); expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits + 1);
    block = false; await tick(4000);
    expect(rows()[0].linkedReply.rendered).toBe('summary');
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits + 1);
    expect(h.create).toHaveBeenCalledTimes(1); assertBusinessUnchanged(b.row);
  });
  it('all matching cohorts seal before the first SDK await; new C cannot join a later cohort from a stale snapshot', async () => {
    const one = await acceptedInput('B1');
    const firstRow = rows()[0];
    h.store.savePresentation('Bot', 'offline-app', 'chat', firstRow.id, { ...firstRow, submissionId: 'sealed-first-cohort' });
    const two = await acceptedInput('B2');
    expect(rows()).toHaveLength(2); await storedReply();
    let release!: () => void;
    h.bot.patchLiveStatusCard = vi.fn((id: string, view: any) => id === one.card.cardId && view.state === 'replied' ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve());
    const closing = manager().settleRun('chat', ROOT); await tick();
    expect(release).toBeTypeOf('function');
    const c = h.store.insert({ chatId: 'chat', messageId: 'C', senderType: 'human', senderName: 'fixture-user', content: 'C', timestamp: Date.now() });
    manager().receive('chat', c, 'C');
    expect(rows()).toHaveLength(3);
    expect(rows().find((row: any) => row.triggerIds.includes(two.row))?.triggerIds).not.toContain(c);
    release(); await tick(1000); await closing;
    expect(rows().find((row: any) => row.triggerIds.includes(one.row))?.view.state).toBe('replied');
    expect(rows().find((row: any) => row.triggerIds.includes(two.row))?.view.state).toBe('replied');
    expect(rows().find((row: any) => row.triggerIds.includes(c))?.view.state).toBe('queued');
    assertBusinessUnchanged(one.row); assertBusinessUnchanged(two.row);
  });
  it('an attempted/unknown terminal UI edit is not blindly retried during accepted-input recovery', async () => {
    const b = await acceptedInput();
    const edits = h.bot.patchLiveStatusCard.mock.calls.length;
    h.bot.patchLiveStatusCard.mockImplementation(() => new Promise(() => {}));
    await publish(); await tick(31_000);
    expect(rows()[0].linkedReply.rendered).toBeUndefined();
    expect(Object.values(rows()[0].editEffects || {})).toContain('unknown');
    await tick(61_000); await h.bot.reconcileInsertions('chat'); await tick(100);
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(edits + 1);
    expect(h.create).toHaveBeenCalledTimes(1); assertBusinessUnchanged(b.row);
  });
  it('does not replace a card that already contains the actual business reply', async () => {
    const b = await acceptedInput();
    h.create.mockResolvedValue({ code: 0, data: { message_id: b.card.cardId, chat_id: 'chat' } });
    const before = h.bot.patchLiveStatusCard.mock.calls.length;
    await publish();
    expect(rows()[0].view.state).toBe('replied');
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(before);
    assertBusinessUnchanged(b.row);
  });
});

describe('linked reply evidence is narrow, never a root-completion shortcut', () => {
  it('a foreign root reply with identical text cannot close this card', async () => {
    const b = await acceptedInput(); await publish('unrelated-root');
    expect(rows()[0].view.phase).toBe('waiting'); assertBusinessUnchanged(b.row);
  });
  it('lifecycle end, including exact empty completion, is not a platform reply receipt', async () => {
    const b = await acceptedInput();
    const base = h.client.rpc;
    h.client.rpc = vi.fn(async (method: string, params: any) => method === 'agent.wait' ? { runId: params.runId, status: 'ok', endedAt: Date.now(), terminalReply: { disposition: 'empty' } } : base(method, params));
    await manager().settleRun('chat', ROOT); await tick(100);
    expect(rows()[0].view.phase).toBe('waiting'); assertBusinessUnchanged(b.row);
  });
  it.each(['no-receipt', 'unknown-operation', 'nonfinal', 'wrong-app', 'wrong-epoch', 'wrong-session', 'error-notice', 'verbose-transcript'])('%s cannot authorize replied UI', async mode => {
    const b = await acceptedInput();
    const id = h.store.enqueueDelivery({ sessionKey: h.key, botName: 'Bot', chatId: 'chat', sourceType: mode === 'error-notice' ? 'run_error' : mode === 'verbose-transcript' ? 'verbose_transcript' : 'assistant_visible', sourceId: mode, deliveryKey: 'proactive:' + mode,
      contentHash: mode, content: 'OK', attachmentsJson: '[]', replyToMessageId: '', deliveryMetaJson: JSON.stringify({ botIdentity: mode === 'wrong-app' ? 'other-app' : 'offline-app', deliveryStopEpoch: mode === 'wrong-epoch' ? 99 : 0, provenance: { sessionKey: h.key, sessionId: mode === 'wrong-session' ? 'generation-2' : 'generation-1', runId: ROOT, final: mode !== 'nonfinal' } }) })!;
    if (mode !== 'no-receipt') h.store.saveDeliveryOperation(id, 'outbox:body:0', mode === 'unknown-operation' ? 'unknown' : 'accepted', { result: { code: 0, data: { message_id: 'possible-reply' } }, operation: 'create', payload: { msg_type: 'text' } });
    h.store.markDeliveryTextDelivered(id); h.store.markDeliveryDelivered(id);
    await manager().settleRun('chat', ROOT); await tick(100);
    expect(rows()[0].view.phase).toBe('waiting'); assertBusinessUnchanged(b.row);
  });
  it('a prior reply before this input cannot close a newer queued card', async () => {
    await storedReply(); await tick(1000); const b = await acceptedInput();
    await manager().settleRun('chat', ROOT); await tick(100);
    expect(rows()[0].view.phase).toBe('waiting'); assertBusinessUnchanged(b.row);
  });
  it.each(['pending', 'unknown', 'accepted-other-root'])('a coalesced %s C prevents closing the whole B/C cohort', async state => {
    const b = await acceptedInput();
    const c = h.store.insert({ chatId: 'chat', messageId: 'C', senderType: 'human', senderName: 'fixture-user', content: 'C', timestamp: Date.now() });
    manager().receive('chat', c, 'C');
    h.store.saveInsertion('Bot', 'chat', c, 'sdk-C', state === 'accepted-other-root' ? 'accepted' : state, { messageId: 'C', sessionKey: h.key, sessionId: 'generation-1', expectedRunId: state === 'accepted-other-root' ? 'other-root' : ROOT, stopEpoch: 0, attempted: state !== 'pending' });
    await publish();
    expect(rows()[0].triggerIds).toContain(c);
    expect(rows()[0].view.state).not.toBe('replied'); assertBusinessUnchanged(b.row);
  });
  it('an accepted C coalesced after the old reply cannot be closed by the cohort earlier start time', async () => {
    const b = await acceptedInput(); await storedReply(); await tick(1000);
    const c = h.store.insert({ chatId: 'chat', messageId: 'C', senderType: 'human', senderName: 'fixture-user', content: 'later C', timestamp: Date.now() });
    manager().receive('chat', c, 'C');
    h.store.saveInsertion('Bot', 'chat', c, 'sdk-C', 'accepted', { messageId: 'C', sessionKey: h.key, sessionId: 'generation-1', expectedRunId: ROOT, stopEpoch: 0, attempted: true });
    await manager().insertionAccepted('chat', c, ROOT);
    await manager().settleRun('chat', ROOT); await tick(100);
    expect(rows()[0].triggerIds).toContain(c);
    expect(rows()[0].view.state).not.toBe('replied'); assertBusinessUnchanged(b.row);
  });
  it('old epoch reply cannot retire or patch a fresh C card after stop', async () => {
    const b = await acceptedInput(); await storedReply();
    await h.bot.handleStopCommand('chat', 'stop');
    const c = h.store.insert({ chatId: 'chat', messageId: 'C', senderType: 'human', senderName: 'fixture-user', content: 'C', timestamp: Date.now() });
    manager().receive('chat', c, 'C'); await tick(900);
    const before = h.bot.patchLiveStatusCard.mock.calls.length;
    await manager().settleRun('chat', ROOT); await tick(100);
    expect(rows().find((row: any) => !row.retired)?.view.state).toBe('queued');
    expect(h.bot.patchLiveStatusCard.mock.calls.length).toBe(before);
    expect(h.store.getInsertion('Bot', 'chat', b.row).state).toBe('stopped');
    expect(h.sends).toHaveLength(0);
  });
});
