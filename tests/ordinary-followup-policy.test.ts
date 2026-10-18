import {EventEmitter} from 'node:events';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter{send(){}close(){}}}));
import {harness} from './helpers/reliability-harness.js';
let h:ReturnType<typeof harness>;
beforeEach(async()=>{vi.useFakeTimers();vi.spyOn(console,'log').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});h=harness();const p=h.client._doConnect();h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'res',ok:true,payload:{type:'hello-ok',protocol:4}})));await p;});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
it('ordinary admission explicitly chooses serialized followup and never inherits stored interrupt/steer',async()=>{
 const p=h.client.chatSend({sessionKey:h.key,message:'ordinary user request'});void p.catch(()=>{});await vi.advanceTimersByTimeAsync(100);
 const request=h.sends[0];expect(h.sends).toHaveLength(1);
 const wire=(event:string,payload:any)=>h.client.ws.emit('message',Buffer.from(JSON.stringify({type:'event',event,payload:{sessionKey:h.key,...payload}})));
 wire('chat',{runId:'r1',state:'final',message:{role:'assistant',content:[{type:'text',text:'exact ordinary final'}],stopReason:'stop'}});
 wire('agent',{runId:'r1',stream:'lifecycle',data:{phase:'end',livenessState:'working'}});
 await vi.advanceTimersByTimeAsync(100);expect(await p).toBe('exact ordinary final');
 expect(request.deliver).toBe(false);expect(request.queueMode).toBe('followup');
});
