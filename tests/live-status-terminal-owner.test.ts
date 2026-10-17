import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from 'node:async_hooks';
import { FeishuBot } from "../src/feishu-bot.js";
import { LiveStatusController, type LiveStatusView } from "../src/live-status.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const bot: any = Object.create(FeishuBot.prototype);
  bot.sendQueue = new Map();
  bot.sendEffectLeases = new AsyncLocalStorage();
  const createSDK = vi.fn(async (): Promise<string> => "card");
  const editSDK = vi.fn(async (_id: string, _view: LiveStatusView) => {});
  const owner = { onReconcileNeeded: vi.fn(async (_meta: unknown) => {}) };
  const live = new LiveStatusController({
    create: (_view, effect) => bot.sendOrdered("chat", () => effect.run(createSDK)),
    edit: (id, view, effect) => bot.sendOrdered("chat", () => effect.run(() => editSDK(id, view))),
    warn: vi.fn(),
  }, { botName: "GPT", delayMs: 0, tickMs: 1000 });
  return { bot, live, createSDK, editSDK, owner };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("explicit terminal presentation custody for B2/outbox integration", () => {
  it("does not convert prepare metadata or a stale progress receipt into delivery-success patch authority", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = deferred<void>(); h.editSDK.mockImplementationOnce(() => old.promise);
    const progress = h.live.progress("old progress");
    await vi.advanceTimersByTimeAsync(30_001); await progress;
    const meta = await h.live.prepareTerminalDelivery(true, h.owner);
    expect(meta).toMatchObject({ messageId: "card", noReply: true });
    expect(h.owner.onReconcileNeeded).not.toHaveBeenCalled();
    expect(h.editSDK.mock.calls.map(([, view]) => view.state)).toEqual(["running"]);
    old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.onReconcileNeeded).toHaveBeenCalledExactlyOnceWith(meta);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.editSDK).toHaveBeenCalledTimes(1); // owner must decide receipt-safe repair
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands late create identity to the external owner without creating or patching again", async () => {
    const h = harness(); const create = deferred<string>();
    h.createSDK.mockImplementationOnce(() => create.promise);
    h.live.start(); await vi.advanceTimersByTimeAsync(30_001);
    expect(await h.live.prepareTerminalDelivery(true, h.owner)).toBeUndefined();
    create.resolve("late-owned-card"); await vi.advanceTimersByTimeAsync(0);
    expect(h.live.id).toBe("late-owned-card");
    expect(h.owner.onReconcileNeeded).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ messageId: "late-owned-card", noReply: true }));
    expect(h.createSDK).toHaveBeenCalledTimes(1); expect(h.editSDK).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences a queued controller done effect when presentation custody transfers before invocation", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const gate = deferred<void>(); const blocked = h.bot.sendOrdered("chat", () => gate.promise);
    const done = h.live.complete(); await vi.advanceTimersByTimeAsync(0);
    const meta = await h.live.prepareFinalDelivery(h.owner);
    expect(meta?.messageId).toBe("card");
    gate.resolve(); await blocked; await done;
    expect(h.editSDK).not.toHaveBeenCalled();
    expect(h.owner.onReconcileNeeded).not.toHaveBeenCalled(); // no old effect occurred
  });

  it("keeps prepare metadata serializable and delegates late success after an already-started done effect", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = deferred<void>(); h.editSDK.mockImplementationOnce(() => old.promise);
    const done = h.live.complete(); await vi.advanceTimersByTimeAsync(30_001); await done;
    const meta = await h.live.prepareFinalDelivery(h.owner);
    expect(JSON.parse(JSON.stringify(meta))).toMatchObject({ messageId: "card", locale: "zh", noReply: false });
    old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.onReconcileNeeded).toHaveBeenCalledExactlyOnceWith(meta);
    expect(h.editSDK).toHaveBeenCalledTimes(1);
  });
});
