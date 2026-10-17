import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncLocalStorage } from 'node:async_hooks';
import { FeishuBot } from "../src/feishu-bot.js";
import { LiveStatusController, LiveStatusEffectRejectedError, type LiveStatusView } from "../src/live-status.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

// Real per-chat ordering/deadline, no sockets/DB/platform. The optional effect
// context is the live-status-only transport contract; old controller ignores it.
function harness() {
  const bot: any = Object.create(FeishuBot.prototype);
  bot.sendQueue = new Map();
  bot.sendEffectLeases = new AsyncLocalStorage();
  let displayed: LiveStatusView | undefined;
  let createGate: ReturnType<typeof deferred<string>> | undefined;
  let editGate: ReturnType<typeof deferred<void>> | undefined;
  const creates = vi.fn(async (view: LiveStatusView) => {
    const id = createGate ? await createGate.promise : "card";
    displayed = view;
    return id;
  });
  const edits = vi.fn(async (_id: string, view: LiveStatusView) => {
    const gate = editGate; editGate = undefined;
    if (gate) await gate.promise;
    displayed = view;
  });
  const callbacks = {
    create: (view: LiveStatusView, effect?: any) => bot.sendOrdered("chat", () => effect ? effect.run(() => creates(view)) : creates(view)),
    edit: (id: string, view: LiveStatusView, effect?: any) => bot.sendOrdered("chat", () => effect ? effect.run(() => edits(id, view)) : edits(id, view)),
    warn: vi.fn(),
  };
  const live = new LiveStatusController(callbacks, { botName: "GPT", delayMs: 0, tickMs: 1000 });
  return { live, bot, creates, edits, callbacks, view: () => displayed,
    hangCreate: () => (createGate = deferred<string>()),
    hangEdit: () => (editGate = deferred<void>()),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("live card safe concurrency (real sendOrdered)", () => {
  it("coalesces event/tick work and starts terminal after at most the outstanding link deadline", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    h.hangEdit();
    const updates = Array.from({ length: 100 }, (_, i) => h.live.progress(`update ${i}`));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.edits).toHaveBeenCalledTimes(1);
    const done = h.live.complete();
    await vi.advanceTimersByTimeAsync(20_001);
    expect(h.edits.mock.calls.filter(([, view]) => view.state === "running")).toHaveLength(1);
    expect(h.view()?.state).toBe("done");
    await done; await Promise.all(updates);
    expect(h.edits).toHaveBeenCalledTimes(2);
  });

  it("keeps only the latest pending event rather than replaying obsolete intermediate views", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const gate = h.hangEdit();
    const a = h.live.progress({ kind: "tool", name: "read", phase: "start", text: "one" });
    await vi.advanceTimersByTimeAsync(0);
    const updates = Array.from({ length: 50 }, (_, i) => h.live.progress({ kind: "tool", name: "exec", phase: "start", text: `step ${i}` }));
    await vi.advanceTimersByTimeAsync(0);
    gate.resolve(); await a; await Promise.all(updates);
    expect(h.edits).toHaveBeenCalledTimes(2);
    expect(h.view()?.lines.at(-1)?.text).toBe("exec: step 49");
    h.live.dispose();
  });

  it("reconciles a late old progress success after done without replaying progress", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = h.hangEdit(); const update = h.live.progress("old work");
    await vi.advanceTimersByTimeAsync(30_001); await update;
    await h.live.complete(); expect(h.view()?.state).toBe("done");
    old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.view()?.state).toBe("done");
    expect(h.edits.mock.calls.map(([, v]) => v.state)).toEqual(["running", "done", "done"]);
  });

  it("adopts late create receipt and terminally reconciles the same ID with no second create", async () => {
    const h = harness(); const create = h.hangCreate();
    h.live.start(); await vi.advanceTimersByTimeAsync(30_001);
    await h.live.noReply();
    create.resolve("late-card"); await vi.advanceTimersByTimeAsync(0);
    expect(h.live.id).toBe("late-card");
    expect(h.creates).toHaveBeenCalledTimes(1);
    expect(h.edits).toHaveBeenLastCalledWith("late-card", expect.objectContaining({ state: "done", noReply: true }));
    expect(h.view()?.state).toBe("done"); expect(vi.getTimerCount()).toBe(0);
  });

  it("fences a queued progress SDK invocation after terminal supersession", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const blocker = deferred<void>(); const blocked = h.bot.sendOrdered("chat", () => blocker.promise);
    const update = h.live.progress("must never patch running"); await vi.advanceTimersByTimeAsync(0);
    const done = h.live.complete(); blocker.resolve(); await blocked;
    await update; await done;
    expect(h.edits.mock.calls.map(([, v]) => v.state)).toEqual(["done"]);
  });

  it("fences a queued create after a fast completion before the SDK starts", async () => {
    const h = harness(); const blocker = deferred<void>(); const blocked = h.bot.sendOrdered("chat", () => blocker.promise);
    h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const done = h.live.complete(); blocker.resolve(); await blocked; await done;
    expect(h.creates).not.toHaveBeenCalled(); expect(h.live.id).toBeUndefined();
  });

  it("does not blind-retry an unknown terminal effect, then reconciles when its late receipt arrives", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const terminal = h.hangEdit(); const done = h.live.complete();
    await vi.advanceTimersByTimeAsync(35_000); await done;
    expect(h.edits).toHaveBeenCalledTimes(1);
    terminal.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.view()?.state).toBe("done"); expect(h.edits).toHaveBeenCalledTimes(1);
  });

  it("does not retry unknown progress while the SDK remains unresolved", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = h.hangEdit(); const update = h.live.progress("old work");
    await vi.advanceTimersByTimeAsync(120_000); await update;
    expect(h.edits).toHaveBeenCalledTimes(1);
    old.resolve(); await vi.advanceTimersByTimeAsync(1000);
    expect(h.edits.mock.calls.length).toBeGreaterThan(1); h.live.dispose();
  });

  it.each(["showWaitingForResult", "pauseForUnconfirmedResult"] as const)("reconciles late progress to %s without inventing completion", async method => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = h.hangEdit(); const update = h.live.progress("old work");
    await vi.advanceTimersByTimeAsync(30_001); await update;
    await h.live[method]("awaiting exact result"); const title = h.view()?.title;
    old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.view()?.title).toBe(title); expect(h.view()?.state).toBe("running");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not emit progress after prepareTerminalDelivery hands the card to outbox", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const blocker = deferred<void>(); const blocked = h.bot.sendOrdered("chat", () => blocker.promise);
    const update = h.live.progress("obsolete"); await vi.advanceTimersByTimeAsync(0);
    const meta = await h.live.prepareTerminalDelivery(true);
    blocker.resolve(); await blocked; await update;
    expect(meta?.messageId).toBe("card"); expect(h.edits).not.toHaveBeenCalled();
  });
});

describe("live card precedence under overlapping lifecycle callbacks", () => {
  it("preserves a late real outcome after an unconfirmed UI pause", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    await h.live.pauseForUnconfirmedResult("not confirmed");
    expect(h.view()?.state).toBe("running");
    await h.live.complete(); expect(h.view()?.state).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("lets a real terminal outcome supersede an unknown frozen-card edit", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = h.hangEdit(); const frozen = h.live.showWaitingForResult("waiting");
    await vi.advanceTimersByTimeAsync(30_001); await frozen;
    await h.live.complete(); expect(h.view()?.state).toBe("done");
    old.resolve(); await vi.advanceTimersByTimeAsync(0); expect(h.view()?.state).toBe("done");
  });

  it("does not let an older waiting callback enqueue its view after a concurrent complete", async () => {
    const h = harness(); const create = h.hangCreate();
    h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const frozen = h.live.showWaitingForResult("waiting"); const done = h.live.complete();
    create.resolve("card"); await frozen; await done;
    expect(h.edits.mock.calls.every(([, v]) => v.state === "done")).toBe(true);
    expect(h.view()?.state).toBe("done");
  });

  it("retains first terminal outcome instead of allowing fail to undo done", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    await h.live.complete(); await h.live.fail(); await h.live.noReply();
    expect(h.view()?.state).toBe("done"); expect(h.view()?.noReply).toBe(false);
    expect(h.edits).toHaveBeenCalledTimes(1);
  });

  it("does not repeat an unknown terminal while an old progress receipt requests reconciliation", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = h.hangEdit(); const update = h.live.progress("old");
    await vi.advanceTimersByTimeAsync(30_001); await update;
    const terminal = h.hangEdit(); const done = h.live.complete();
    await vi.advanceTimersByTimeAsync(30_001); await done;
    old.resolve(); await vi.advanceTimersByTimeAsync(30_000);
    expect(h.edits).toHaveBeenCalledTimes(2);
    terminal.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.view()?.state).toBe("done"); expect(h.edits).toHaveBeenCalledTimes(3);
  });

  it("releases unknown custody on a late definitive rejection without replaying the old view", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const old = h.hangEdit(); const update = h.live.progress("old");
    await vi.advanceTimersByTimeAsync(30_001); await update;
    await h.live.complete(); old.reject(new LiveStatusEffectRejectedError("code=2200"));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.view()?.state).toBe("done"); expect(h.edits).toHaveBeenCalledTimes(2);
  });

  it("treats an ordinary callback exception as unknown, not proof a terminal patch is safe to retry", async () => {
    const edit = vi.fn(async () => { throw new Error("socket closed after write"); });
    const live = new LiveStatusController({ create: async () => "card", edit }, { botName: "GPT", delayMs: 0 });
    live.start(); await vi.advanceTimersByTimeAsync(0);
    const done = live.complete(); await vi.advanceTimersByTimeAsync(5000); await done;
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it("keeps a definitive receipt when an outer deadline error is observed just after it", async () => {
    const old = deferred<void>();
    let count = 0;
    const edit = vi.fn(async (_id: string, view: LiveStatusView, effect: any) => {
      count++;
      const work = effect.run(async () => { if (view.state === "running") await old.promise; });
      if (count === 1) { void work.catch(() => {}); throw new Error("outer deadline"); }
      await work;
      if (count === 2) throw new Error("outer race had already selected deadline");
    });
    const live = new LiveStatusController({ create: async () => "card", edit }, { botName: "GPT", delayMs: 0 });
    live.start(); await vi.advanceTimersByTimeAsync(0); await live.progress("old");
    await live.complete(); old.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(edit).toHaveBeenCalledTimes(3);
    expect(edit.mock.calls.at(-1)?.[1].state).toBe("done");
  });

  it("does not patch after dispose while queued behind another send", async () => {
    const h = harness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const gate = deferred<void>(); const blocked = h.bot.sendOrdered("chat", () => gate.promise);
    const update = h.live.progress("obsolete"); await vi.advanceTimersByTimeAsync(0);
    h.live.dispose(); gate.resolve(); await blocked; await update;
    expect(h.edits).not.toHaveBeenCalled();
  });
});

function sdkHarness(replyTo?: string) {
  const bot: any = Object.create(FeishuBot.prototype);
  bot.sendQueue = new Map(); bot.sendEffectLeases = new AsyncLocalStorage(); bot.config = { name: "GPT" };
  bot.isEn = () => true;
  bot.store = { clearBotUnavailableInChat: vi.fn() };
  let displayed = "";
  const apply = (params: any) => { displayed = params.data.content; return { code: 0 }; };
  const patch = vi.fn(async (params: any): Promise<any> => apply(params));
  const create = vi.fn(async (): Promise<any> => ({ code: 0, data: { message_id: "sdk-card" } }));
  const reply = vi.fn(async (): Promise<any> => ({ code: 0, data: { message_id: "sdk-reply-card" } }));
  bot.client = { im: { message: { create, reply, patch } } };
  const live = new LiveStatusController({ ...bot.liveStatusCallbacks("chat", replyTo), warn: vi.fn() }, { botName: "GPT", delayMs: 0 });
  return { live, bot, create, reply, patch, apply, displayed: () => displayed };
}

describe("production Feishu live-status adapter and real SDK boundaries", () => {
  it.each([undefined, "parent-message"])("adopts a late SDK create receipt for replyTo=%s", async replyTo => {
    const h = sdkHarness(replyTo); const gate = deferred<any>();
    (replyTo === undefined ? h.create : h.reply).mockImplementationOnce(() => gate.promise);
    h.live.start(); await vi.advanceTimersByTimeAsync(30_001); await h.live.complete();
    gate.resolve({ code: 0, data: { message_id: "late-sdk-card" } }); await vi.advanceTimersByTimeAsync(0);
    expect(h.live.id).toBe("late-sdk-card"); expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch.mock.calls[0][0].path.message_id).toBe("late-sdk-card");
    expect(h.displayed()).toContain("✅"); expect(h.create.mock.calls.length + h.reply.mock.calls.length).toBe(1);
  });

  it("repairs late progress success through the production adapter after done", async () => {
    const h = sdkHarness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const gate = deferred<void>();
    h.patch.mockImplementationOnce(async params => {
      await gate.promise;
      // A realistic delayed SDK effect: the old running view applies LAST.
      return h.apply(params);
    });
    const progress = h.live.progress("work"); await vi.advanceTimersByTimeAsync(30_001); await progress;
    await h.live.complete(); gate.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(h.patch).toHaveBeenCalledTimes(3);
    expect(h.displayed()).toContain("✅");
    expect(h.patch.mock.calls[2][0].data.content).toContain("✅");
  });

  it.each(["network", "missing-code"])("does not retry an ambiguous %s terminal patch", async mode => {
    const h = sdkHarness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    h.patch.mockImplementation(async () => { if (mode === "network") throw new Error("ECONNRESET"); return {}; });
    const done = h.live.complete(); await vi.advanceTimersByTimeAsync(5000); await done;
    expect(h.patch).toHaveBeenCalledTimes(1);
  });

  it("retries a definitively rejected terminal response instead of mistaking code=2200 for success", async () => {
    const h = sdkHarness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    h.patch.mockResolvedValueOnce({ code: 2200 });
    const done = h.live.complete(); await vi.advanceTimersByTimeAsync(1000); await done;
    expect(h.patch).toHaveBeenCalledTimes(2); expect(h.displayed()).toContain("✅");
  });

  it("does not invoke a queued SDK patch after newer terminal ownership", async () => {
    const h = sdkHarness(); h.live.start(); await vi.advanceTimersByTimeAsync(0);
    const gate = deferred<void>(); const blocked = h.bot.sendOrdered("chat", () => gate.promise);
    const update = h.live.progress("obsolete"); await vi.advanceTimersByTimeAsync(0);
    const done = h.live.complete(); gate.resolve(); await blocked; await update; await done;
    expect(h.patch).toHaveBeenCalledTimes(1); expect(h.displayed()).toContain("✅");
  });
});
