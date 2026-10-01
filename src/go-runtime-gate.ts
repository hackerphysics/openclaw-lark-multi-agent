/** Pure adapter contract. Independent queries are observations, not a global atomic snapshot. */
export type GoRuntimeSnapshot = {
  sessionKey: string; sessionId: string; goalId: string; goalRevision: number;
  executorRunIds: string[]; checkerRunId: string;
  complete: boolean; archived: boolean; independent?: boolean; queryAvailable?: boolean; running?: boolean; atomicSnapshot?: boolean;
  queuedInputs: number; recoverableInputs: number; pendingDeliveries: number;
  tasks: Array<{taskId:string;runId:string;parentTaskId:string|null;state:string;deliveryState:string}>;
};
export function goSnapshotBlocked(s: GoRuntimeSnapshot, expected: {
  sessionKey:string;sessionId:string;goalId:string;goalRevision:number;executorRunIds:string[];
}): string | null {
  if (!s.independent && (!s.checkerRunId || !expected.executorRunIds.length || expected.executorRunIds.some(id=>!id))) return "missing run identity";
  if (s.independent ? !s.queryAvailable : !s.complete) return "incomplete snapshot";
  if(s.independent && s.queuedInputs!==0) return "pending or unknown input/delivery";
  if(s.independent && s.running!==false) return "active or unknown session";
  if (s.archived || s.sessionKey!==expected.sessionKey || s.sessionId!==expected.sessionId || (!s.independent && (s.goalId!==expected.goalId || s.goalRevision!==expected.goalRevision))) return "identity/version changed";
  if (!s.independent && [s.queuedInputs,s.recoverableInputs,s.pendingDeliveries].some(n=>!Number.isSafeInteger(n)||n!==0)) return "pending or unknown input/delivery";
  if (!s.independent && (new Set(s.executorRunIds).size!==s.executorRunIds.length || s.executorRunIds.length!==expected.executorRunIds.length || expected.executorRunIds.some(id=>!s.executorRunIds.includes(id)))) return "run association changed";
  const byId=new Map(s.tasks.map(t=>[t.taskId,t]));
  if (byId.size!==s.tasks.length) return "duplicate task identity";
  for (const task of s.tasks) {
    const visited=new Set<string>(); let cursor: typeof task | undefined=task;
    while(cursor) {
      if(visited.has(cursor.taskId)) return "cyclic task ancestry";
      visited.add(cursor.taskId); cursor=cursor.parentTaskId ? byId.get(cursor.parentTaskId) : undefined;
    }
  }
  const related=new Set(s.tasks.filter(t=>expected.executorRunIds.includes(t.runId)).map(t=>t.taskId));
  // Fixed point, not ordering/prefix inference. Exclude no task just because its text says checker.
  let changed=true;
  while(changed){ changed=false; for(const t of s.tasks) if(t.parentTaskId && related.has(t.parentTaskId) && !related.has(t.taskId)){related.add(t.taskId);changed=true;} }
  for(const t of s.tasks){
    if(t.parentTaskId && !byId.has(t.parentTaskId)) return "missing ancestor";
    if(!related.has(t.taskId) && !s.independent) continue;
    if(t.runId===s.checkerRunId) return "checker/executor association conflict";
    if(!["completed","failed","cancelled"].includes(t.state)) return "active or unknown task";
    if(!["delivered","not_required"].includes(t.deliveryState)) return "pending or unknown task return";
  }
  // Each root run needs explicit terminal state evidence; absence is never idle.
  if(!s.independent && expected.executorRunIds.some(id=>!s.tasks.some(t=>t.runId===id))) return "missing root run";
  return null;
}
