import { describe, expect, it, vi } from "vitest";
import { LiveStatusController } from "../src/live-status.js";

describe("LiveStatusController", () => {
  it("does not let a late progress edit overwrite a finalized message", async () => {
    vi.useFakeTimers();
    const edits: string[] = [];
    const live = new LiveStatusController({
      create: vi.fn(async () => "msg1"),
      edit: vi.fn(async (_id, text) => { edits.push(text); }),
    }, { botName: "Claude", delayMs: 0, throttleMs: 0 });

    live.start("starting");
    await vi.advanceTimersByTimeAsync(0);
    await live.finalize("final answer");
    await live.progress("late progress");

    expect(edits).toEqual(["final answer"]);
    vi.useRealTimers();
  });
});
