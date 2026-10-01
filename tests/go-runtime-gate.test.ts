import {it,expect} from "vitest";
import {goSnapshotBlocked, type GoRuntimeSnapshot} from "../src/go-runtime-gate.js";
const expected={sessionKey:"agent:main:exec",sessionId:"s",goalId:"g",goalRevision:1,executorRunIds:["r"]};
const base:GoRuntimeSnapshot={...expected,checkerRunId:"checker",complete:true,archived:false,queuedInputs:0,recoverableInputs:0,pendingDeliveries:0,tasks:[{taskId:"root",runId:"r",parentTaskId:null,state:"completed",deliveryState:"delivered"}]};
it("requires complete terminal identity and delivery snapshot",()=>{
  expect(goSnapshotBlocked(base,expected)).toBeNull();
  for(const patch of [{complete:false},{goalRevision:2},{pendingDeliveries:1},{recoverableInputs:-1},{executorRunIds:["other"]},{tasks:[]}])expect(goSnapshotBlocked({...base,...patch},expected)).not.toBeNull();
});
it("gates exact descendants and pending return independent of task order",()=>{
  const child={taskId:"child",runId:"unrelated-looking-id",parentTaskId:"root",state:"completed",deliveryState:"session_queued"};
  expect(goSnapshotBlocked({...base,tasks:[child,...base.tasks]},expected)).toContain("return");
  expect(goSnapshotBlocked({...base,tasks:[{...child,state:"running",deliveryState:"delivered"},...base.tasks]},expected)).toContain("task");
});
it("unrelated success does not cover missing root or hide failed root",()=>{
  const other={taskId:"other",runId:"r-similar",parentTaskId:null,state:"completed",deliveryState:"delivered"};
  expect(goSnapshotBlocked({...base,tasks:[other]},expected)).toBe("missing root run");
  expect(goSnapshotBlocked({...base,tasks:[...base.tasks,other]},expected)).toBeNull();
});
it("rejects incomplete association and checker identity conflict",()=>{
  expect(goSnapshotBlocked({...base,tasks:[{...base.tasks[0],parentTaskId:"missing"}]},expected)).toBe("missing ancestor");
  expect(goSnapshotBlocked({...base,checkerRunId:"r"},expected)).toContain("conflict");
});
it("rejects cyclic ancestry rather than treating it as terminal",()=>{
  expect(goSnapshotBlocked({...base,tasks:[{...base.tasks[0],parentTaskId:"root"}]},expected)).toContain("cyclic");
});
