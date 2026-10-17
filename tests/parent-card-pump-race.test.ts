import {afterEach,it,expect,vi} from 'vitest';
import {AsyncLocalStorage} from 'node:async_hooks';
import {LiveStatusController} from '../src/live-status.js';
import {FeishuBot} from '../src/feishu-bot.js';
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();});
const later=(depth:number,fn:()=>void)=>depth>0?queueMicrotask(()=>later(depth-1,fn)):fn();
it('parent review: no terminal request is lost between edit pump loop exit and finally',async()=>{
 vi.useFakeTimers();const lost:any[]=[];
 for(const ordered of [false,true])for(let depth=1;depth<=35;depth++){
  let live:LiveStatusController;let first=true,completed=false;const states:string[]=[];
  const bot:any=Object.create(FeishuBot.prototype);bot.sendQueue=new Map();bot.sendEffectLeases=new AsyncLocalStorage();
  const send=(fn:()=>Promise<any>)=>ordered?bot.sendOrdered('chat',fn):fn();
  live=new LiveStatusController({create:(_v,e)=>send(()=>e.run(async()=> 'card')),edit:(_id,v,e)=>send(()=>e.run(async()=>{
   states.push(v.state);
   if(first){first=false;later(depth,()=>{void live.complete().then(()=>completed=true);});}
  }))},{botName:'review',delayMs:0,tickMs:1e9});
  live.start();await vi.advanceTimersByTimeAsync(0);void live.progress('first');
  for(let turn=0;turn<100;turn++)await Promise.resolve();
  if(!completed || states.at(-1)!=='done')lost.push({ordered,depth,completed,states,pending:(live as any).pendingEdit?.view?.state,pump:!!(live as any).editPump});
  live.dispose();
 }
 expect(lost).toEqual([]);
});

for (const [ordered, depth] of [[false, 2], [false, 3], [true, 5], [true, 6]] as const) {
 it(`terminal completion waits for handed-off effect (ordered=${ordered}, depth=${depth})`, async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const terminalEffect = new Promise<void>(resolve => { release = resolve; });
  let first = true, completed = false;
  const states: string[] = [];
  const bot: any = Object.create(FeishuBot.prototype); bot.sendQueue = new Map(); bot.sendEffectLeases = new AsyncLocalStorage();
  const send = (fn: () => Promise<any>) => ordered ? bot.sendOrdered('chat', fn) : fn();
  const live = new LiveStatusController({
   create: (_view, effect) => send(() => effect.run(async () => 'card')),
   edit: (_id, view, effect) => send(() => effect.run(async () => {
    states.push(view.state);
    if (view.state === 'done') await terminalEffect;
    if (first) {
     first = false;
     later(depth, () => { void live.complete().then(() => { completed = true; }); });
    }
   })),
  }, {botName:'review', delayMs:0, tickMs:1e9});
  live.start(); await vi.advanceTimersByTimeAsync(0); void live.progress('first');
  for (let turn = 0; turn < 150; turn++) await Promise.resolve();
  expect(states).toEqual(['running', 'done']);
  expect(completed).toBe(false);
  release();
  for (let turn = 0; turn < 150; turn++) await Promise.resolve();
  expect(completed).toBe(true);
  live.dispose();
 });
}

it('blocked unknown terminal work does not restart flights in a microtask loop', async () => {
 vi.useFakeTimers();
 let release!: () => void;
 const raw = new Promise<void>(resolve => { release = resolve; });
 const bot: any = Object.create(FeishuBot.prototype); bot.sendQueue = new Map(); bot.sendEffectLeases = new AsyncLocalStorage();
 let effects = 0;
 const live = new LiveStatusController({
  create: (_view, effect) => bot.sendOrdered('chat', () => effect.run(async () => 'card')),
  edit: (_id, _view, effect) => bot.sendOrdered('chat', () => effect.run(async () => { effects++; await raw; })),
 }, {botName:'review', delayMs:0, tickMs:1e9});
 live.start(); await vi.advanceTimersByTimeAsync(0);
 const done = live.complete();
 await vi.advanceTimersByTimeAsync(30_001); await done;
 // Advancing timers itself must finish: an unconditional finally->flush on an
 // unknown blocker would endlessly schedule microtasks and never reach here.
 await vi.advanceTimersByTimeAsync(60_000);
 expect(effects).toBe(1);
 release(); await vi.advanceTimersByTimeAsync(0);
 expect(effects).toBe(1);
 live.dispose();
});
