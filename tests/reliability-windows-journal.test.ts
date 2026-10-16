import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setActiveEmbeddedRun,clearActiveEmbeddedRun} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {resolveStateDir} from 'openclaw/plugin-sdk/state-paths';
import {registerSteer} from '../plugins/lma-core/src/steer.js';

const calls=vi.hoisted(()=>({file:0,directory:0,failDirectory:false,failFile:false,renames:0,writableFileOpens:0}));
vi.mock('node:fs',async importOriginal=>{
 const fs=await importOriginal<typeof import('node:fs')>();
 return {...fs,fsyncSync:(fd:number)=>{
  if(fs.fstatSync(fd).isDirectory()){
   calls.directory++;
   // Actual Windows Node24 readonly probe: open succeeds, fsync => EPERM.
   if(calls.failDirectory)throw Object.assign(new Error('Windows directory fsync unsupported'),{code:'EPERM',syscall:'fsync'});
  }else{calls.file++;if(calls.failFile)throw Object.assign(new Error('file fsync failure'),{code:'EIO'});}
  return fs.fsyncSync(fd);
 },openSync:(path:any,flags:any,mode?:any)=>{if(String(path).endsWith('.tmp')){expect(flags).toBe('r+');calls.writableFileOpens++;}return fs.openSync(path,flags,mode);},renameSync:(from:any,to:any)=>{calls.renames++;return fs.renameSync(from,to);}};
});
const KEY='agent:main:windows-platform';
let dir:string,dispose:()=>void,handle:Parameters<typeof setActiveEmbeddedRun>[1],queueCalls:number;
let methods:Map<string,any>,platform:PropertyDescriptor;
beforeEach(()=>{
 dir=mkdtempSync(join(tmpdir(),'lma-platform-'));vi.stubEnv('OPENCLAW_STATE_DIR',dir);
 platform=Object.getOwnPropertyDescriptor(process,'platform')!;
 Object.assign(calls,{file:0,directory:0,renames:0,writableFileOpens:0,failDirectory:false,failFile:false});queueCalls=0;
 handle={kind:'embedded',runId:'windows-run',isStreaming:()=>true,isCompacting:()=>false,isStopped:()=>false,abort:()=>{},supportsTranscriptCommitWait:true,
  queueMessage:async(_text,options)=>{queueCalls++;options?.onQueueAccepted?.(true);}};
 setActiveEmbeddedRun('windows-session',handle,KEY);
 methods=new Map();dispose=registerSteer({registerGatewayMethod:(name:string,fn:any)=>methods.set(name,fn)});
});
afterEach(()=>{Object.defineProperty(process,'platform',platform);dispose();clearActiveEmbeddedRun('windows-session',handle,KEY);vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
const invoke=()=>{
 let result:any;
 methods.get('lma.steer')({params:{sessionKey:KEY,text:'real queue input',insertionId:'windows-insertion',expectedRunId:'windows-run',expectedSessionId:'windows-session',stopEpoch:0},
  respond:(ok:boolean,value:any,error:any)=>{result={ok,value,error};}});
 return result;
};
it('Windows EPERM directory API fixture: durable file+rename reaches real SDK queue exactly once and callback journal stays accepted',()=>{
 Object.defineProperty(process,'platform',{...platform,value:'win32'});calls.failDirectory=true;
 expect(invoke()).toMatchObject({ok:true,value:{status:'accepted',attempted:true}});
 expect(queueCalls).toBe(1);expect(calls.file).toBeGreaterThanOrEqual(2);expect(calls.renames).toBeGreaterThanOrEqual(2);expect(calls.directory).toBe(0);expect(calls.writableFileOpens).toBe(calls.file);
 const path=join(dir,'lma-core','steer-custody');
 expect(JSON.parse(readFileSync(join(path,readdirSync(path).find(x=>x.endsWith('.json'))!),'utf8')).status).toBe('accepted');
 expect(invoke()).toMatchObject({ok:true,value:{status:'accepted'}});expect(queueCalls).toBe(1);
});
it('Linux still fsyncs its parent directory after every durable file rename',()=>{
 expect(invoke()).toMatchObject({ok:true,value:{status:'accepted'}});
 expect(calls.directory).toBe(calls.renames);expect(calls.file).toBe(calls.renames);expect(queueCalls).toBe(1);
});
it('a real file fsync failure is not swallowed on Windows and cannot queue input',()=>{
 Object.defineProperty(process,'platform',{...platform,value:'win32'});calls.failFile=true;
 expect(invoke()).toMatchObject({ok:false});expect(calls.renames).toBe(0);expect(queueCalls).toBe(0);
});
it('custody uses the public profile-aware state resolver',()=>{
 expect(resolveStateDir()).toBe(dir);
 expect(invoke()).toMatchObject({ok:true});expect(readdirSync(join(resolveStateDir(),'lma-core','steer-custody')).some(x=>x.endsWith('.json'))).toBe(true);
});
