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
 const store=new MessageStore(path);
 try {store.registerHistoricalDeliveryContext(id,bot,chat,ids);console.log(JSON.stringify({registered:true,outboxId:id,bot,chat,receipts:ids.length,resent:false}));}finally{store.close();}
} else {
 const db=new Database(path,{readonly:true,fileMustExist:true});
 try {
  const hasContext=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='delivery_context'").get();
  const limit=Math.min(1000,Math.max(1,Number(value('--limit')||100)));
  const rows=db.prepare(`SELECT d.id,d.chat_id,d.delivery_key,d.source_type,d.text_delivered,d.attachment_cursor FROM delivery_outbox d
   WHERE bot_name=? AND status='delivered' ${hasContext?"AND NOT EXISTS(SELECT 1 FROM delivery_context c WHERE c.outbox_id=d.id)":''} ORDER BY d.id LIMIT ?`).all(bot,limit);
  console.log(JSON.stringify({dryRun:true,registered:false,resent:false,requiresIndependentReceiptVerification:true,rows},null,2));
 } finally{db.close();}
}
