import { describe, it, expect } from "vitest";
import { checkTool, parseBindings } from "../plugins/lma-go/src/policy.js";
const b = {checkerSessionKey:"agent:main:checker",checkerSessionId:"cs",executorSessionKey:"agent:main:executor",executorSessionId:"es",goalId:"g"};
describe("Go runtime tool enforcement", () => {
  it("denies every checker tool including wrappers and read access", () => {
    for (const toolName of ["exec","write","read","tool_call","sessions_spawn","update_goal","message","unknown"])
      expect(checkTool([b], {toolName,params:{}}, {sessionKey:b.checkerSessionKey,sessionId:"cs"})?.block).toBe(true);
  });
  it("fails closed for missing or replaced checker generations", () => {
    expect(checkTool([b],{toolName:"exec",params:{}},{sessionKey:b.checkerSessionKey})?.block).toBe(true);
    expect(checkTool([b],{toolName:"exec",params:{}},{sessionKey:b.checkerSessionKey,sessionId:"new"})?.block).toBe(true);
  });
  it("does not affect prefix-similar unrelated sessions", () => {
    expect(checkTool([b],{toolName:"exec",params:{}},{sessionKey:b.checkerSessionKey+"other",sessionId:"other"})).toBeUndefined();
  });
  it("blocks managed executor goal mutation, not normal work", () => {
    expect(checkTool([b],{toolName:"update_goal",params:{status:"complete"}},{sessionId:"es"})?.block).toBe(true);
    expect(checkTool([b],{toolName:"exec",params:{}},{sessionId:"es"})).toBeUndefined();
  });
  it("rejects ambiguous and noncanonical bindings", () => {
    expect(() => parseBindings([{...b,checkerSessionId:"es"}])).toThrow();
    expect(() => parseBindings([{...b,checkerSessionKey:"checker"}])).toThrow();
    expect(() => parseBindings([b,b])).toThrow();
  });
});
