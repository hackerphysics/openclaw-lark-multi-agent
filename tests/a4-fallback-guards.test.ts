import {EventEmitter} from 'node:events';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import {harness} from './helpers/reliability-harness.js';

// A4 regression (2026-10-17 protocol audit): the 60s bounded fallback in
// reconcileCurrentInputActivity must rescue ONLY genuinely-unknown states.
// Positive gateway assertions — archived session, incompatible session
// generation, busy-without-injectable-owner — stay retained with a
// blocker-noting reason for field diagnosis; ordinary admission is not
// authoritative for them. Unknown-state behavior is unchanged: it still
// falls back to ordinary admission after 60s.
let h:ReturnType<typeof harness>,runtime:any,dispatch:any;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const recordUnbound=(name:string,ageMs=61_000)=>{
  const row=h.store.insert({chatId:'chat',messageId:name,senderType:'human',senderName:'fixture-user',content:name,timestamp:Date.now()});
  h.store.markPendingTrigger('Bot','chat',row);
  h.store.saveInsertion('Bot','chat',row,`fixture-${name}`,'pending',{
    messageId:name,text:name,stopEpoch:0,sessionKey:h.bot.getSessionKey('chat'),sessionId:'generation-1',
    expectedRunId:'',activityUnbound:true,attempted:false,unboundSince:Date.now()-ageMs,
  },0);
  return row;
};
beforeEach(async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
  vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});
  h=harness();
  h.client.ensureModel=vi.fn(async()=>false);
  // Client overrides (A4): public activity edges are pinned per scenario; the
  // real Client -> FeishuBot -> SQLite admission chain stays intact.
  h.client.getSessionRuntimeStatus=vi.fn(async()=>runtime);
  h.client.getSessionDispatchStatus=vi.fn(async()=>dispatch);
  vi.spyOn(h.client,'steer');
  const connected=h.client._doConnect();
  h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));
  await connected;
});
afterEach(async()=>{
  await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();
});
describe('A4: 60s bounded fallback fires only for genuinely-unknown state',()=>{
  it.each([
    ['archived-status',{sessionId:'generation-1',running:false,archived:true,idleConfirmed:false},{idleConfirmed:false,sessionId:'generation-1',archived:false},'retained: archived'],
    ['archived-activity',{sessionId:'generation-1',running:false,archived:false,idleConfirmed:false},{idleConfirmed:false,sessionId:'generation-1',archived:true},'retained: archived'],
    ['generation-conflict',{sessionId:'generation-1',running:false,archived:false,idleConfirmed:false},{idleConfirmed:false,sessionId:'generation-2',archived:false},'retained: generation-conflict'],
    ['positively-busy',{sessionId:'generation-1',running:false,archived:false,idleConfirmed:false},{idleConfirmed:false,sessionId:'generation-1',archived:false,busyConfirmed:true},'retained: positively-busy'],
  ])('%s + 61s keeps the never-attempted input retained, never ordinary',async(_mode,rt,dp,marker)=>{
    runtime=rt;dispatch=dp;
    const row=recordUnbound('a4-blocked');
    const first=h.bot.reconcileInsertions('chat');await tick(100);await first;
    const item=h.store.getInsertion('Bot','chat',row);
    expect(item.state).toBe('pending');
    expect(item.activityUnbound).toBe(true);
    expect(item.attempted).toBe(false);
    expect(item.reason).toContain(marker);
    expect(h.sends).toHaveLength(0);
    expect(h.client.steer).not.toHaveBeenCalled();
    // The blocker is durable across further paced re-checks: still >60s unbound,
    // still positively blocked, so it must STILL not become ordinary.
    h.store['db'].prepare('UPDATE insertion_custody SET next_check_at=0').run();
    const second=h.bot.reconcileInsertions('chat');await tick(100);await second;
    const again=h.store.getInsertion('Bot','chat',row);
    expect(again.state).toBe('pending');
    expect(again.attempted).toBe(false);
    expect(again.reason).toContain(marker);
    expect(h.sends).toHaveLength(0);
    expect(h.client.steer).not.toHaveBeenCalled();
  });
  it('genuinely unknown + 61s still falls back to ordinary admission exactly once (existing behavior preserved)',async()=>{
    runtime={idleConfirmed:false};dispatch={idleConfirmed:false};
    const row=recordUnbound('a4-unknown');
    const r=h.bot.reconcileInsertions('chat');await tick(100);await r;
    expect(h.store.getInsertion('Bot','chat',row)?.state).toBe('ordinary');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0].message).toContain('a4-unknown');
    expect(h.client.steer).not.toHaveBeenCalled();
    h.final('r1','a4 ordinary fallback final');await tick(400);
    expect(h.sends).toHaveLength(1);
  });
  it('positive blocker within the 60s window is retained without the blocker yet overriding unknown retention',async()=>{
    // Under 60s the pre-A4 behavior was already retain-as-unknown; A4 must not
    // change that, only label positive blockers. Sanity-check the boundary.
    runtime={sessionId:'generation-1',running:false,archived:false,idleConfirmed:false};
    dispatch={idleConfirmed:false,sessionId:'generation-1',archived:false,busyConfirmed:true};
    const row=recordUnbound('a4-young-blocked',30_000);
    const r=h.bot.reconcileInsertions('chat');await tick(100);await r;
    const item=h.store.getInsertion('Bot','chat',row);
    expect(item.state).toBe('pending');
    expect(item.attempted).toBe(false);
    expect(item.reason).toContain('retained: positively-busy');
    expect(h.sends).toHaveLength(0);
  });
});
