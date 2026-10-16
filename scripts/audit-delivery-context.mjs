#!/usr/bin/env node
// Default is a genuinely read-only preview (no schema migration, no transport).
import Database from 'better-sqlite3';
import {MessageStore} from '../dist/message-store.js';
const args=process.argv.slice(2);
const value=flag=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
const path=value('--db'),bot=value('--bot');
if(!path || !bot) throw new Error('Usage: --db <explicit LMA messages.db> --bot <name> [--limit 100] [--register --outbox <id> --chat <id> --verified-message-id <actual id> ...]');
if(args.includes('--register')) {
 const id=Number(value('--outbox')),chat=value('--chat');
 const ids=args.flatMap((x,i)=>x==='--verified-message-id'?[args[i+1]]:[]);
 if(!Number.isSafeInteger(id)||id<=0||!chat||!ids.length||ids.some(x=>!x))throw new Error('Registration requires exact bot/chat/outbox and independently verified actual platform message IDs. It never sends.');
 // Refuse a wrong/non-LMA database BEFORE constructing a writable store or
 // running any migration. Registration is for an existing exact delivered row.
 const check=new Database(path,{readonly:true,fileMustExist:true});
 try {
  const identity=check.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lma_database_identity'").get();
  if(!identity || check.prepare('SELECT owner FROM lma_database_identity WHERE id=1').get()?.owner!=='openclaw-lark-multi-agent:messages:v1')throw new Error('Not an owned LMA messages database; refusing all writes');
  const required={
    messages:['id','chat_id','message_id','sender_type','sender_name','content','timestamp'],
    delivery_outbox:['id','session_key','bot_name','chat_id','delivery_key','source_type','source_id','content_hash','content','attachments_json','delivery_meta_json','text_delivered','attachment_cursor','status','attempts','created_at','updated_at'],
    delivery_operations:['outbox_id','operation_key','state','record_json'],
    delivery_context:['outbox_id','stage','message_row_id'],
    delivery_receipt_custody:['outbox_id','operation_key','record_json'],
    platform_message_aliases:['message_id','message_row_id'],
  };
  for(const [table,columns] of Object.entries(required)) {
    const schema=check.prepare(`PRAGMA table_info(${table})`).all();
    if(columns.some(column=>!schema.some(c=>c.name===column)) || !schema.some(c=>c.pk>0))throw new Error('Incomplete LMA schema; refusing all writes');
  }
  const row=check.prepare("SELECT id FROM delivery_outbox WHERE id=? AND bot_name=? AND chat_id=? AND (status='delivered' OR EXISTS(SELECT 1 FROM delivery_operations o WHERE o.outbox_id=delivery_outbox.id AND o.state IN ('attempted','unknown')))").get(id,bot,chat);
  if(!row)throw new Error('Exact LMA bot/chat/outbox custody not found; refusing all writes');
 }finally{check.close();}
 const store=new MessageStore(path,{existingOnly:true});
 try {store.registerHistoricalDeliveryContext(id,bot,chat,ids);console.log(JSON.stringify({registered:true,outboxId:id,bot,chat,receipts:ids.length,resent:false}));}finally{store.close();}
} else {
 const db=new Database(path,{readonly:true,fileMustExist:true});
 try {
  const hasContext=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_context'").get();
  const limit=Math.min(1000,Math.max(1,Number(value('--limit')||100)));
  const rows=db.prepare(`SELECT d.id,d.chat_id,d.delivery_key,d.source_type,d.text_delivered,d.attachment_cursor FROM delivery_outbox d
   WHERE bot_name=? AND (status='delivered' ${hasContext?"AND NOT EXISTS(SELECT 1 FROM delivery_context c WHERE c.outbox_id=d.id)":''} OR EXISTS(SELECT 1 FROM delivery_operations o WHERE o.outbox_id=d.id AND o.state IN ('attempted','unknown'))) ORDER BY d.id LIMIT ?`).all(bot,limit);
  console.log(JSON.stringify({dryRun:true,registered:false,resent:false,requiresIndependentReceiptVerification:true,rows},null,2));
 } finally{db.close();}
}
