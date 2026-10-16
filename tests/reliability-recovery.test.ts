import {describe,it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {MessageStore} from '../src/message-store.js';
const KEY='agent:main:recovery';
describe('LMA-owned recovery boundaries and explicit historical repair',()=>{
 it.each(['reserved','dispatching','unknown'])('only proven-unsubmitted %s may restore human pending custody',state=>{
  const dir=mkdtempSync(join(tmpdir(),'lma-unsent-'));const store=new MessageStore(join(dir,'db'));
  try {
   const ids=['A','B'].map(content=>store.insert({chatId:'chat',messageId:content,senderType:'human',senderName:'u',content,timestamp:1}));
   store.bindDeliveryRun('Bot','chat','submission',{triggerId:ids[1],triggerIds:ids,stopGeneration:0});store.saveAdmission(KEY,'submission',state,{});
   expect(store.recoverUnsentReservations('Bot')).toBe(state==='reserved'?2:0);
   expect(store.getPendingTriggerIds('Bot','chat').size).toBe(state==='reserved'?2:0);
   expect(store.recoverUnsentReservations('Bot')).toBe(0);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('stop generation prevents restoring old unsubmitted input after restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lma-unsent-stop-'));const store=new MessageStore(join(dir,'db'));
  try {const id=store.insert({chatId:'chat',messageId:'A',senderType:'human',senderName:'u',content:'A',timestamp:1});store.bindDeliveryRun('Bot','chat','submission',{triggerId:id,triggerIds:[id],stopGeneration:0});store.saveAdmission(KEY,'submission','reserved',{});store.bumpStopGeneration('Bot','chat');expect(store.recoverUnsentReservations('Bot')).toBe(0);expect(store.getPendingTriggerIds('Bot','chat').size).toBe(0);}finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('candidate upgrade restores only explicitly never-attempted blocked inputs',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lma-insertion-migrate-')),path=join(dir,'db');let store=new MessageStore(path);
  try {
   store.saveInsertion('Bot','chat',1,'never','capability_blocked',{attempted:false});
   store.saveInsertion('Bot','chat',2,'uncertain','capability_blocked',{attempted:true});
   store.saveInsertion('Bot','chat',3,'unknown','unknown',{attempted:true});store.close();store=new MessageStore(path);
   expect(store.getInsertion('Bot','chat',1).state).toBe('pending');expect(store.getInsertion('Bot','chat',2).state).toBe('capability_blocked');
   expect(store.getInsertion('Bot','chat',3).state).toBe('unknown');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
 });
 it('historical registration refuses a non-LMA database before migrations or writes',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lma-wrong-db-')),path=join(dir,'not-lma.db');const db=new Database(path);db.exec('CREATE TABLE unrelated_state(value TEXT)');db.close();
  try {const before=readFileSync(path);expect(()=>execFileSync(process.execPath,[resolve('scripts/audit-delivery-context.mjs'),'--db',path,'--bot','Bot','--register','--outbox','1','--chat','chat','--verified-message-id','id'],{encoding:'utf8',stdio:'pipe'})).toThrow();expect(readFileSync(path)).toEqual(before);}finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('historical preview is read-only; explicit exact registration is idempotent and has no transport',()=>{
  const dir=mkdtempSync(join(tmpdir(),'lma-history-preview-')),path=join(dir,'db');let store=new MessageStore(path);
  try {
   const id=store.enqueueDelivery({sessionKey:KEY,chatId:'chat',botName:'Bot',sourceType:'assistant_visible',sourceId:'old',deliveryKey:'proactive:old',contentHash:'x',content:'historical visible result',attachmentsJson:'[]',replyToMessageId:''})!;store.markDeliveryTextDelivered(id);store.markDeliveryDelivered(id);store.close();
   const before=readFileSync(path);const script=resolve('scripts/audit-delivery-context.mjs');
   const output=JSON.parse(execFileSync(process.execPath,[script,'--db',path,'--bot','Bot'],{encoding:'utf8'}));expect(output).toMatchObject({dryRun:true,registered:false,resent:false});expect(output.rows[0].id).toBe(id);expect(readFileSync(path)).toEqual(before);
   const args=[script,'--db',path,'--bot','Bot','--register','--outbox',String(id),'--chat','chat','--verified-message-id','actual-platform-id'];
   expect(JSON.parse(execFileSync(process.execPath,args,{encoding:'utf8'}))).toMatchObject({registered:true,resent:false});execFileSync(process.execPath,args,{encoding:'utf8'});
   store=new MessageStore(path);expect(store.getRecent('chat')).toHaveLength(1);expect(store.getMessageId('actual-platform-id')).toBe(store.getRecent('chat')[0].id);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
 });
});
