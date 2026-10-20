import { EventEmitter } from 'node:events';
import * as lark from '@larksuiteoapi/node-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('ws',()=>({default:class extends EventEmitter {send(){} close(){}}}));
import { QueuedPresentations } from '../src/queued-presentation.js';
import { LiveStatusController } from '../src/live-status.js';
import { INPUT_DISPLAY_LIMITS, LIVE_CARD_BYTES, hintLabel, type InputHintKind } from '../src/input-status-display.js';
import { FeishuBot } from '../src/feishu-bot.js';
import { harness } from './helpers/reliability-harness.js';

let h:ReturnType<typeof harness>;
const tick=(ms=0)=>vi.advanceTimersByTimeAsync(ms);
const manager=()=>h.bot.queuedPresentations;
const source=(text:string,id:string)=>h.store.insert({chatId:'chat',messageId:id,senderType:'human',senderName:'Fixture user',content:text,timestamp:Date.now()});
const receive=(text:string,id:string,root?:string)=>{const row=source(text,id);const live=manager().receive('chat',row,id,false,root);return {row,live};};
function cards():any[]{
  return [...h.create.mock.calls.map(([request]:any)=>request),...h.bot.client.im.message.patch.mock.calls.map(([request]:any)=>request)]
    .filter((request:any)=>request?.data?.content).map((request:any)=>JSON.parse(request.data.content));
}
const latest=()=>cards().at(-1);
const text=(card:any=latest())=>JSON.stringify(card);
const bodyLines=()=>latest().body.elements.map((element:any)=>element.content || '').join('\n').split('\n');
const uiRows=()=>h.store.listPresentations('Bot','offline-app','chat');
const reconnectManager=()=>{manager().dispose();h.bot.queuedPresentations=new QueuedPresentations(h.store,'Bot','offline-app',(chat,reply)=>h.bot.liveStatusCallbacks(chat,reply),()=>true,()=>h.bot.isEn('chat'));};
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  h=harness();
  h.bot.replyLiveStatusCard=vi.fn((FeishuBot.prototype as any).replyLiveStatusCard.bind(h.bot));
  h.bot.sendLiveStatusCard=vi.fn((FeishuBot.prototype as any).sendLiveStatusCard.bind(h.bot));
  h.bot.patchLiveStatusCard=vi.fn((FeishuBot.prototype as any).patchLiveStatusCard.bind(h.bot));
  h.bot.patchLiveStatusDoneSummary=vi.fn((FeishuBot.prototype as any).patchLiveStatusDoneSummary.bind(h.bot));
  h.bot.client.im.message.patch=vi.fn(async()=>({code:0}));
});
afterEach(async()=>{await h.cleanup();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});

describe('actual Card2 SDK boundary identifies each input delivery hint',()=>{
  it('UI1R: reaction lookup cannot block exact copied-preview invalidation',async()=>{
    const body='REACTIONBLOCKEDPREVIEW',messageId='om_recall_held_reaction';
    const row=source(body,messageId);
    manager().receive('chat',row,messageId,false,undefined,{source:'visible',text:body});await tick(900);
    await manager().insertionAccepted('chat',row,'root');await tick(30);
    expect(text()).toContain(body);
    h.bot.botOpenId='ou_synthetic_reaction_owner';
    h.bot.removeReaction=(FeishuBot.prototype as any).removeReaction.bind(h.bot);
    let release!:(value:any)=>void;
    h.bot.client.im.messageReaction={list:vi.fn(()=>new Promise(resolve=>{release=resolve;}))};
    h.bot.pendingAckMessages.set('chat',[{rowId:row,messageId,emoji:'Get'}]);
    const recalled=h.bot.handleMessageRecalled({message_id:messageId,chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});
    await tick(100);
    expect(h.bot.client.im.messageReaction.list).toHaveBeenCalledOnce();
    expect(h.store.isMessageRecalled(messageId)).toBe(true);
    const displayedBeforeReaction=text().includes(body),cachedBeforeReaction=JSON.stringify(uiRows()).includes(body);
    release({code:0,data:{items:[],has_more:false}});await recalled;await tick(100);
    expect(text()).not.toContain(body);expect(text()).toContain('消息已撤回');
    expect(displayedBeforeReaction).toBe(false);expect(cachedBeforeReaction).toBe(false);
    expect(h.create).toHaveBeenCalledOnce();expect(h.sends).toHaveLength(0);
  });

  it('UIR1: actual recall redacts an already created frozen waiting card',async()=>{
    const input=receive('REVOKEDVISIBLEINPUTBODY','om_recall_after_create');await tick(900);
    await manager().insertionAccepted('chat',input.row,'root');await tick(30);
    expect(text()).toContain('REVOKEDVISIBLEINPUTBODY');const card=uiRows()[0].cardId;
    await h.bot.handleMessageRecalled({message_id:'om_recall_after_create',chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});
    await tick(2500);
    expect(text()).not.toContain('REVOKEDVISIBLEINPUTBODY');expect(text()).toContain('消息已撤回');
    expect(h.create).toHaveBeenCalledOnce();expect(h.bot.client.im.message.patch.mock.calls.at(-1)[0].path.message_id).toBe(card);
  });

  it.each(['请回复上面最近一条用户消息。','请解释 [Image: USERLITERALIMAGETOKEN]'])('UIR2: actual text ingress preserves literal body %s',async body=>{
    h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});
    void h.bot.handleMessage({message:{chat_id:'chat',chat_type:'p2p',message_type:'text',message_id:'om_literal_text',content:JSON.stringify({text:body}),mentions:[]},sender:{sender_type:'user',sender_id:{open_id:'synthetic-human'}}});
    await tick(900);
    expect(text()).toContain(body.startsWith('请解释')?'USERLITERALIMAGETOKEN':body);
    expect(text()).not.toMatch(/Message body unavailable|消息正文暂不可用/);expect(h.sends).toHaveLength(0);
  });

  it.each(['fail','complete','noReply','prepareTerminalDelivery'] as const)('UI2: no admitted run cannot acquire terminal hint from %s',async method=>{
    const input=receive('NEVERADMITTEDORIGINALBODY','om_never_admitted');await tick(900);
    manager().claim('chat',[input.row],'owner','batch');
    expect(uiRows()[0].runId).toBeUndefined();
    await input.live[method]();await tick(30);
    expect(text()).toContain('NEVERADMITTEDORIGINALBODY');
    expect(text()).not.toMatch(/【⚠️ 执行中断】|【✅ 本轮结束】|【💤 无正文】|【📨 投递待确认】|root 结果/);
    expect(bodyLines().some((line:string)=>line.includes('【⏳ 本地排队】 NEVERADMITTEDORIGINALBODY'))).toBe(true);
    expect(uiRows()[0].runId).toBeUndefined();expect(h.sends).toHaveLength(0);
  });

  it('UI2: attempted submission without an admitted root retains submission-unconfirmed truth',async()=>{
    const input=receive('SUBMISSIONNOTCONFIRMEDBODY','om_submission_unknown');await tick(900);
    manager().claim('chat',[input.row],'owner','batch');manager().attempted(input.live,'submission-only','owner','batch');
    await input.live.fail();await tick(30);
    expect(bodyLines().some((line:string)=>line.includes('【📨 提交待确认】 SUBMISSIONNOTCONFIRMEDBODY'))).toBe(true);
    expect(text()).not.toMatch(/执行中断|本轮结束|root 结果/);expect(uiRows()[0].runId).toBeUndefined();expect(h.sends).toHaveLength(0);
  });

  it.each(['running','waiting','done','failed','replied'] as const)('UIR1: recall refreshes a known %s card without changing its phase',async state=>{
    const body='EXACTRECALLEDSOURCEBODY';const row=source(body,'om_recall_phase');
    const live=manager().receive('chat',row,'om_recall_phase',false,undefined,{source:'visible',text:body});await tick(900);
    if(state==='waiting')await manager().insertionAccepted('chat',row,'root');
    else {manager().claim('chat',[row],'owner','batch');await manager().admit(live,'root','owner','batch');
      if(state==='running')await live.progress({kind:'tool',name:'read',phase:'start',text:'read synthetic.log'});
      if(state==='done')await live.complete();if(state==='failed')await live.fail();if(state==='replied')await live.linkedReplyDelivered(Date.now());}
    const before=uiRows()[0];expect(text()).toContain(body);
    await h.bot.handleMessageRecalled({message_id:'om_recall_phase',chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});await tick(100);
    expect(text()).not.toContain(body);expect(text()).toContain('消息已撤回');expect(h.create).toHaveBeenCalledOnce();
    expect(uiRows()[0].view).toMatchObject({state:before.view.state,phase:before.view.phase,title:before.view.title});
    expect(JSON.stringify(uiRows())).not.toContain(body);expect(h.sends).toHaveLength(0);
  });

  it.each(['waiting','done','failed','replied'] as const)('UIR1: a restored %s owner redacts its existing known card',async state=>{
    const input=receive('RESTOREDRECALLEDSOURCE','om_restored_recall');await tick(900);
    if(state==='waiting')await manager().insertionAccepted('chat',input.row,'root');
    else {manager().claim('chat',[input.row],'owner','batch');await manager().admit(input.live,'root','owner','batch');
      if(state==='done')await input.live.complete();if(state==='failed')await input.live.fail();if(state==='replied')await input.live.linkedReplyDelivered(Date.now());}
    const card=uiRows()[0].cardId;const phase=uiRows()[0].view.phase;reconnectManager();
    await h.bot.handleMessageRecalled({message_id:'om_restored_recall',chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});await tick(100);
    expect(text()).not.toContain('RESTOREDRECALLEDSOURCE');expect(text()).toContain('消息已撤回');
    expect(h.create).toHaveBeenCalledOnce();expect(h.bot.client.im.message.patch.mock.calls.at(-1)[0].path.message_id).toBe(card);
    expect(uiRows()[0].view.phase).toBe(phase);expect(h.sends).toHaveLength(0);
  });

  it.each(['create','edit'] as const)('UIR1: unknown %s fences SDK effects while recall scrubs persisted previews',async mode=>{
    let unresolved:Promise<any>=new Promise(()=>{});
    if(mode==='create')h.create.mockImplementationOnce(()=>unresolved);
    const body='UNKNOWNRECALLEDPREVIEW';const row=source(body,'om_unknown_recall');
    const live=manager().receive('chat',row,'om_unknown_recall',false,undefined,{source:'visible',text:body});await tick(900);
    if(mode==='edit'){h.bot.client.im.message.patch.mockImplementationOnce(()=>unresolved);void live.pauseForUnconfirmedResult('Synthetic waiting');await tick(30_001);}
    const creates=h.create.mock.calls.length,edits=h.bot.client.im.message.patch.mock.calls.length;
    await h.bot.handleMessageRecalled({message_id:'om_unknown_recall',chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});await tick(100);
    expect(JSON.stringify(uiRows())).not.toContain(body);
    expect(h.create).toHaveBeenCalledTimes(creates);expect(h.bot.client.im.message.patch).toHaveBeenCalledTimes(edits);
    reconnectManager();await manager().refreshRecalledInput('chat',row,'om_unknown_recall');await tick(100);
    expect(h.create).toHaveBeenCalledTimes(creates);expect(h.bot.client.im.message.patch).toHaveBeenCalledTimes(edits);
    expect(h.sends).toHaveLength(0);
  });

  it('UIR1: a late known create receipt can redact that exact card, never recreate while unknown',async()=>{
    let accept!:(value:any)=>void;h.create.mockImplementationOnce(()=>new Promise<any>(yes=>{accept=yes;}));
    const body='LATECREATEPRIVACYBODY';const row=source(body,'om_late_recall');
    manager().receive('chat',row,'om_late_recall',false,undefined,{source:'visible',text:body});await tick(900);
    await h.bot.handleMessageRecalled({message_id:'om_late_recall',chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});await tick(100);
    expect(h.create).toHaveBeenCalledOnce();expect(h.bot.client.im.message.patch).not.toHaveBeenCalled();
    accept({code:0,data:{message_id:'late-known-status-card',chat_id:'chat'}});await tick(100);
    expect(h.create).toHaveBeenCalledOnce();expect(h.bot.client.im.message.patch).toHaveBeenCalledOnce();
    expect(h.bot.client.im.message.patch.mock.calls[0][0].path.message_id).toBe('late-known-status-card');
    expect(text()).not.toContain(body);expect(text()).toContain('消息已撤回');
  });

  it('UIR1: a late known edit receipt releases only its own privacy refresh fence',async()=>{
    const body='LATEEDITPRIVACYBODY';const row=source(body,'om_late_edit');
    const live=manager().receive('chat',row,'om_late_edit',false,undefined,{source:'visible',text:body});await tick(900);
    let accept!:(value:any)=>void;h.bot.client.im.message.patch.mockImplementationOnce(()=>new Promise<any>(yes=>{accept=yes;}));
    void live.pauseForUnconfirmedResult('Synthetic waiting');await tick(30_001);
    await h.bot.handleMessageRecalled({message_id:'om_late_edit',chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});await tick(100);
    expect(h.bot.client.im.message.patch).toHaveBeenCalledOnce();expect(JSON.stringify(uiRows())).not.toContain(body);
    accept({code:0});await tick(100);
    expect(h.create).toHaveBeenCalledOnce();expect(h.bot.client.im.message.patch).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain(body);expect(text()).toContain('消息已撤回');
  });

  it('UIR1: same-card business-answer payload is not overwritten by recall redaction',async()=>{
    const input=receive('BUSINESSPROTECTEDSOURCE','om_protected');await tick(900);
    const row=uiRows()[0];h.store.savePresentation('Bot','offline-app','chat',row.id,{...row,linkedReply:{runId:'root',outboxId:42,deliveredAt:Date.now(),rendered:'reply_payload'}});
    const before=h.bot.client.im.message.patch.mock.calls.length;
    await h.bot.handleMessageRecalled({message_id:'om_protected',chat_id:'chat',recall_time:Date.now(),recall_type:'fixture_owner'});await tick(100);
    expect(h.bot.client.im.message.patch).toHaveBeenCalledTimes(before);expect(h.create).toHaveBeenCalledOnce();
    expect(uiRows()[0].linkedReply.rendered).toBe('reply_payload');expect(h.store.getMessageByRowId(input.row)?.content).toBe('BUSINESSPROTECTEDSOURCE');
  });

  it.each(['Inspect [File: A -> B] literally.','Keep [FeishuDoc: visible title] words.','Keep [Attachment: literal words] unchanged.','原始文字 😀 [Image: 蓝屏检查]'])('UIR3: actual ordinary text remains literal %s',async body=>{
    h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});
    void h.bot.handleMessage({message:{chat_id:'chat',chat_type:'p2p',message_type:'text',message_id:'om_literal_extra',content:JSON.stringify({text:body}),mentions:[]},sender:{sender_type:'user',sender_id:{open_id:'synthetic-human'}}});await tick(900);
    const visible=bodyLines().join('\n').replace(/\\([\\`*_{}\[\]()#+!|~])/g,'$1').replace(/＞/g,'>');
    expect(visible).toContain(body);expect(h.sends).toHaveLength(0);
  });

  it('UIR3: structured rich-post media is typed while media-like caption text stays literal',async()=>{
    h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});h.bot.downloadResource=vi.fn(async()=>'/server/PRIVATE_MEDIA/image.bin');
    const content={content:[[{tag:'text',text:'Literal [Image: USERPOSTLITERALTOKEN]'},{tag:'img',image_key:'PRIVATE_MEDIA_KEY'}]]};
    void h.bot.handleMessage({message:{chat_id:'chat',chat_type:'p2p',message_type:'post',message_id:'om_post_literal',content:JSON.stringify(content),mentions:[]},sender:{sender_type:'user',sender_id:{open_id:'synthetic-human'}}});await tick(900);
    expect(text()).toContain('USERPOSTLITERALTOKEN');expect(text()).toContain('图片');expect(text()).not.toMatch(/PRIVATE_MEDIA|\/server\//);
  });

  it('local receipt shows a brief state followed by the exact input body',async()=>{
    receive('请检查这次部署结果','om_fixture_A');await tick(900);
    expect(text()).toContain('【📥 已收件】');expect(text()).toContain('请检查这次部署结果');
    expect(h.create.mock.calls[0][0]).toMatchObject({path:{message_id:'om_fixture_A'},data:{msg_type:'interactive'}});
    expect(h.sends).toHaveLength(0);
  });

  it('append queue receipt identifies its own body, without claiming commitment',async()=>{
    const b=receive('追加检查错误日志','om_fixture_B');await tick(900);
    await manager().insertionAccepted('chat',b.row,'fixture-root');await tick();
    expect(text()).toContain('【⏳ 追加排队】');expect(text()).toContain('追加检查错误日志');
    expect(text()).toContain('实际接收方、提交及处理结果未确认');expect(h.sends).toHaveLength(0);
  });

  it('A processing, B enqueued and C local receipt remain individually recognizable',async()=>{
    const a=receive('第一条：检查服务','om_fixture_A');await tick(900);
    manager().claim('chat',[a.row],'fixture-owner','fixture-batch');
    await manager().admit(a.live,'fixture-root','fixture-owner','fixture-batch');
    await a.live.progress({kind:'tool',name:'read',phase:'start',text:'read synthetic.log'});
    const b=receive('第二条：检查日志','om_fixture_B','fixture-root');
    receive('第三条：保留现场','om_fixture_C','fixture-root');
    await manager().insertionAccepted('chat',b.row,'fixture-root');await tick(100);
    const body=text();
    expect(body).toMatch(/【⚙️ 处理中】[^\n]*第一条：检查服务/);
    expect(body).toMatch(/【⏳ 追加排队】[^\n]*第二条：检查日志/);
    expect(body).toMatch(/【📥 已收件】[^\n]*第三条：保留现场/);
    expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();expect(h.sends).toHaveLength(0);
  });

  it.each(['received','queued','submitting','append_queued','accepted','processing','waiting','paused','unconfirmed','delivery_pending','completed','no_reply','replied','failed','blocked'] as InputHintKind[])('actual SDK card inventories %s with its exact source body',async kind=>{
    const input=receive('这条输入需要明确标识','om_inventory');await tick(900);
    if(!['received','append_queued'].includes(kind))manager().claim('chat',[input.row],'owner','batch');
    if(!['received','queued','submitting','append_queued'].includes(kind))await manager().admit(input.live,'root','owner','batch');
    if(kind==='submitting')manager().attempted(input.live,'submission','owner','batch');
    if(kind==='append_queued')await manager().insertionAccepted('chat',input.row,'root');
    if(kind==='processing')await input.live.progress({kind:'tool',phase:'start',name:'read',text:'read synthetic.log'});
    if(kind==='waiting')await input.live.showWaitingForResult('Wait for the exact result');
    if(['paused','unconfirmed','delivery_pending','blocked'].includes(kind))await input.live.pauseForUnconfirmedResult('Synthetic status qualification',undefined,kind);
    if(kind==='completed')await input.live.complete();
    if(kind==='no_reply')await input.live.noReply();
    if(kind==='failed')await input.live.fail();
    if(kind==='replied')await input.live.linkedReplyDelivered(Date.now());
    await tick(20);
    expect(bodyLines().some((line:string)=>line.includes(hintLabel(kind,false)) && line.includes('这条输入需要明确标识'))).toBe(true);
    expect(h.sends).toHaveLength(0);expect(h.store.getDispatchCustody('Bot','chat')).toBeNull();
  });

  it('partial completion lists cohort members without upgrading B/C receipt states',async()=>{
    const a=receive('ordinary A','om_A');await tick(900);
    manager().claim('chat',[a.row],'owner','batch');await manager().admit(a.live,'root','owner','batch');
    const b=receive('append B','om_B','root');receive('local C','om_C','root');
    await manager().insertionAccepted('chat',b.row,'root');await a.live.complete();await tick(20);
    const lines=bodyLines();
    expect(lines.some((line:string)=>line.includes('【✅ 本轮结束】 ordinary A'))).toBe(true);
    expect(lines.some((line:string)=>line.includes('【⏳ 追加排队】 append B'))).toBe(true);
    expect(lines.some((line:string)=>line.includes('【📥 已收件】 local C'))).toBe(true);
    expect(lines.some((line:string)=>line.includes('【⚠️ 部分确认】') && line.includes('ordinary A') && line.includes('append B') && line.includes('local C'))).toBe(true);
    expect(text()).toContain('追加输入提交及处理仍未确认');
    expect(h.store.hasDeliveredReply('Bot','chat',b.row)).toBe(false);expect(h.sends).toHaveLength(0);
  });

  it('merged ordinary admission identifies every selected input',async()=>{
    const a=receive('merged alpha','om_A');const b=receive('merged beta','om_B');await tick(900);
    manager().claim('chat',[a.row,b.row],'owner','batch');await manager().admit(a.live,'root','owner','batch');
    expect(bodyLines().filter((line:string)=>line.includes('【✅ 已接收】'))).toHaveLength(2);
    expect(text()).toContain('merged alpha');expect(text()).toContain('merged beta');expect(h.sends).toHaveLength(0);
  });

  it('legacy persisted views restore per-row association without latest-message backfill or another create',async()=>{
    const a=receive('old original body','om_old');await tick(900);
    manager().claim('chat',[a.row],'owner','batch');await manager().admit(a.live,'root','owner','batch');
    await a.live.progress({kind:'tool',name:'read',phase:'start',text:'read original.log'});
    const old=uiRows()[0];delete old.inputStates;delete old.inputMessageIds;delete old.inputPreviews;delete old.view.inputStatus;
    h.store.savePresentation('Bot','offline-app','chat',old.id,old);
    reconnectManager();receive('new independent body','om_new','root');await tick(50);
    expect(h.create).toHaveBeenCalledOnce();
    expect(bodyLines().some((line:string)=>line.includes('【⚙️ 处理中】 old original body'))).toBe(true);
    expect(bodyLines().some((line:string)=>line.includes('【📥 已收件】 new independent body'))).toBe(true);
  });

  it.each(['missing','wrong-chat','bot-source'])('%s source cannot disclose a cached or neighboring body',async mode=>{
    receive('safe original','om_A');await tick(900);const snapshot=uiRows()[0].view;
    const foreign=h.store.insert({chatId:mode==='wrong-chat'?'other-chat':'chat',messageId:'om_foreign',senderType:mode==='bot-source'?'bot':'human',senderName:'Private fixture',content:'DO_NOT_LEAK_NEIGHBOR_BODY',timestamp:Date.now()});
    snapshot.inputStatus.items=[{rowId:mode==='missing'?999999:foreign,messageId:'om_foreign',kind:'received',at:0,preview:'DO_NOT_LEAK_CACHED_PREVIEW'}];
    await h.bot.patchLiveStatusCard('status',snapshot,'chat');
    expect(text()).toContain('消息正文暂不可用');expect(text()).not.toContain('DO_NOT_LEAK');expect(h.sends).toHaveLength(0);
  });

  it('recalled input is checked at the SDK boundary after an ordered create was held',async()=>{
    let release!:()=>void;const blocker=new Promise<void>(yes=>{release=yes;});void h.bot.sendOrdered('chat',()=>blocker);
    receive('RECALLED_BODY_MUST_NOT_APPEAR','om_recalled');await tick(900);
    h.store.markMessageRecalled('om_recalled','chat',Date.now(),'fixture_owner');release();await tick(30);
    expect(text()).toContain('消息已撤回');expect(text()).not.toContain('RECALLED_BODY_MUST_NOT_APPEAR');
  });

  it.each(['app','epoch','chat'])('%s scope mismatch renders no original input body',async scope=>{
    receive('SCOPED_BODY_MUST_NOT_APPEAR','om_scoped');await tick(900);const view=uiRows()[0].view;
    if(scope==='app')h.bot.config.appId='other-app';if(scope==='epoch')h.store.bumpStopGeneration('Bot','chat');
    await h.bot.patchLiveStatusCard('status',view,scope==='chat'?'other-chat':'chat');
    expect(text()).toContain('消息正文暂不可用');expect(text()).not.toContain('SCOPED_BODY_MUST_NOT_APPEAR');
  });

  it('legacy human source fallback removes generated document instructions and private hydration metadata',async()=>{
    receive('原始可见文档标题\n\n[飞书文档已由 LMA 用机器人权限读取并转换为 Markdown 附件，OpenClaw 可直接读取附件内容。]\n[FeishuDoc: PRIVATE_HYDRATION_TITLE -> /server/PRIVATE_MEDIA/doc.md]','om_legacy_doc');await tick(900);
    expect(text()).toContain('原始可见文档标题');expect(text()).not.toMatch(/PRIVATE_|机器人权限读取|OpenClaw 可直接读取/);
  });

  it('English input statuses use the same original source association',async()=>{
    h.store.setChatLocale('chat','en');const input=receive('Please inspect this exact input.','om_english');await tick(900);
    await manager().insertionAccepted('chat',input.row,'root');await tick();
    expect(text()).toContain('【⏳ Append queued】 Please inspect this exact input.');expect(text()).toContain('Actual receiver, commitment and result unconfirmed');
  });

  it('long multibyte cohorts retain newest input and fit every complete serialized outer SDK request',async()=>{
    for(let i=0;i<80;i++)receive(`${i===79?'LatestCurrentInput':'older-'+i} ${'中文😀\\\"'.repeat(300)}`,`om_long_${i}`);
    await tick(900);expect(text()).toContain('LatestCurrentInput');expect(text()).toContain('未展开');expect(text()).toContain('…');
    for(const [request] of [...h.create.mock.calls,...h.bot.client.im.message.patch.mock.calls] as any[]){
      expect(Buffer.byteLength(JSON.stringify(request),'utf8')).toBeLessThanOrEqual(LIVE_CARD_BYTES);
      const card=JSON.parse(request.data.content);expect(JSON.stringify(card)).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
    expect(INPUT_DISPLAY_LIMITS.at(-1)!.members).toBeGreaterThanOrEqual(2);
  });

  it('input markdown, tags, entities, images and card-shaped JSON stay inert text',async()=>{
    receive('<at id=all>@all</at> &lt;at user_id="all"&gt; [click](javascript:evil) ![image](https://invalid/image) {"tag":"action","actions":[{"tag":"button"}]}','om_inert');await tick(900);const card=latest();
    expect(text()).not.toContain('<at');expect(text()).not.toContain('&lt;');
    expect(card.body.elements.every((element:any)=>['markdown','hr'].includes(element.tag))).toBe(true);
    expect(card.body.elements.some((element:any)=>element.actions || element.img_key || element.url)).toBe(false);
    expect(text()).toContain('＜at');expect(h.sends).toHaveLength(0);
  });

  it.each(['image','audio','file','sticker','post','share_doc'])('actual %s ingress uses a visible caption/type/name, never a media key/server path',async messageType=>{
    h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});h.bot.downloadResource=vi.fn(async()=>'/server/PRIVATE_MEDIA/download.bin');
    const content=messageType==='post'?{content:[[{tag:'text',text:'用户图片说明'},{tag:'img',image_key:'PRIVATE_MEDIA_KEY'}]]}:messageType==='share_doc'?{title:'用户文档标题'}:{image_key:'PRIVATE_MEDIA_KEY',file_key:'PRIVATE_MEDIA_KEY',file_name:'原始文件.pdf',caption:'原始媒体说明'};
    void h.bot.handleMessage({message:{chat_id:'chat',chat_type:'p2p',message_type:messageType,message_id:'om_media',content:JSON.stringify(content),mentions:[]},sender:{sender_type:'user',sender_id:{open_id:'synthetic-human'}}});await tick(900);
    expect(text()).not.toMatch(/PRIVATE_MEDIA|\/server\//);expect(text()).toContain(messageType==='image'?'图片':messageType==='audio'?'语音':messageType==='file'?'原始文件.pdf':messageType==='sticker'?'贴纸':messageType==='share_doc'?'用户文档标题':'用户图片说明');expect(h.sends).toHaveLength(0);
    if(!['post','sticker','share_doc'].includes(messageType))expect(text()).toContain('原始媒体说明');
  });

  it('a repeated local receipt never downgrades the known input receipt/activity state',async()=>{
    const a=receive('original still processing','om_repeat');await tick(900);
    manager().claim('chat',[a.row],'owner','batch');await manager().admit(a.live,'root','owner','batch');
    await a.live.progress({kind:'tool',phase:'start',name:'read',text:'read original.log'});
    manager().receive('chat',a.row,'om_repeat',false,'root');await tick(30);
    expect(bodyLines().some((line:string)=>line.includes('【⚙️ 处理中】 original still processing'))).toBe(true);
    expect(bodyLines().some((line:string)=>line.includes('【📥 已收件】 original still processing'))).toBe(false);
  });

  it('unknown UI create cannot be retried by another input or a restored manager',async()=>{
    h.create.mockRejectedValueOnce(new Error('Synthetic SDK outcome unknown'));receive('first body','om_first');await tick(900);receive('second body','om_second');await tick(50);
    reconnectManager();receive('third body','om_third');await tick(5000);
    expect(h.create).toHaveBeenCalledOnce();expect(h.bot.client.im.message.patch).not.toHaveBeenCalled();expect(h.sends).toHaveLength(0);
  });

  it('legacy controller/terminal cleanup without an exact source uses an explicit unavailable marker',async()=>{
    const live=new LiveStatusController(h.bot.liveStatusCallbacks('chat'),{botName:'Bot',delayMs:0});live.start('Background discussion round');await tick();await live.pauseForUnconfirmedResult('Result unconfirmed');
    expect(text()).toContain('消息正文暂不可用');
    await h.bot.patchLiveStatusDoneSummary('legacy-card',{messageId:'legacy-card',toolCalls:1,elapsed:'0:02',locale:'zh'},'chat');
    expect(text()).toContain('【✅ 本轮结束】');expect(text()).toContain('消息正文暂不可用');live.dispose();
  });

  it('separate sealed cohorts keep parallel ACK/progress bodies on their own known cards',async()=>{
    const a=receive('parallel alpha','om_parallel_A');await tick(900);
    manager().claim('chat',[a.row],'owner-A','batch-A');manager().attempted(a.live,'submission-A','owner-A','batch-A');
    const b=receive('parallel beta','om_parallel_B');await tick(900);
    manager().claim('chat',[b.row],'owner-B','batch-B');await manager().admit(b.live,'root-B','owner-B','batch-B');
    await manager().admit(a.live,'root-A','owner-A','batch-A');await a.live.progress({kind:'tool',phase:'start',name:'read',text:'read root-A.log'});
    const requests=h.bot.client.im.message.patch.mock.calls.map(([request]:any)=>request);
    const aCard=JSON.stringify(JSON.parse(requests.filter((request:any)=>request.path.message_id===a.live.id).at(-1).data.content));
    const bCard=JSON.stringify(JSON.parse(requests.filter((request:any)=>request.path.message_id===b.live.id).at(-1).data.content));
    expect(aCard).toContain('parallel alpha');expect(aCard).not.toContain('parallel beta');
    expect(bCard).toContain('parallel beta');expect(bCard).not.toContain('parallel alpha');expect(h.create).toHaveBeenCalledTimes(2);expect(h.sends).toHaveLength(0);
  });

  it('original mention-only body is not replaced by the synthetic model routing prompt',async()=>{
    h.bot.getUnhealthySessionStatus=()=>new Promise(()=>{});
    void h.bot.handleMessage({message:{chat_id:'chat',chat_type:'p2p',message_type:'text',message_id:'om_mention',content:JSON.stringify({text:'@_user_1'}),mentions:[{key:'@_user_1',name:'Fixture bot',id:{app_id:'offline-app'}}]},sender:{sender_type:'user',sender_id:{open_id:'synthetic-human'}}});
    await tick(900);expect(text()).toContain('@Fixture bot');expect(text()).not.toContain('请回复上面最近一条用户消息');
  });

  it('terminal cleanup carries exact source refs while replacing only pending ordinary delivery display',async()=>{
    const a=receive('terminal ordinary source','om_terminal');await tick(900);
    manager().claim('chat',[a.row],'owner','batch');await manager().admit(a.live,'root','owner','batch');
    const meta=await a.live.prepareFinalDelivery();expect(meta.inputStatus.items[0].kind).toBe('delivery_pending');
    await h.bot.patchLiveStatusDoneSummary(a.live.id,meta,'chat');
    expect(bodyLines().some((line:string)=>line.includes('【✅ 本轮结束】 terminal ordinary source'))).toBe(true);
    expect(h.store.hasDeliveredReply('Bot','chat',a.row)).toBe(false);expect(h.sends).toHaveLength(0);
  });

  it('stop retires a pending UI effect without displaying a later source body or creating a replacement',async()=>{
    let release!:()=>void;void h.bot.sendOrdered('chat',()=>new Promise<void>(yes=>{release=yes;}));
    receive('old stopped body','om_stop');await tick(900);h.store.bumpStopGeneration('Bot','chat');manager().retire('chat');
    release();await tick(30);expect(h.create).not.toHaveBeenCalled();expect(h.bot.client.im.message.patch).not.toHaveBeenCalled();expect(h.sends).toHaveLength(0);
  });

  it('real SDK HTTP serialization retains the inert Card2 body and full request byte bound',async()=>{
    const requests:any[]=[];
    const request=async(options:any)=>{
      if(String(options.url).includes('tenant_access_token'))return {code:0,tenant_access_token:'synthetic-token',expire:7200};
      requests.push({url:options.url,method:options.method,data:options.data,params:options.params});
      return {code:0,data:{message_id:'om_synthetic_http_card'}};
    };
    const transport:any={request};
    for(const method of ['get','delete','head','options'])transport[method]=(url:string,options:any)=>request({...options,method,url});
    for(const method of ['post','put','patch'])transport[method]=(url:string,data:any,options:any)=>request({...options,method,url,data});
    h.bot.client=new lark.Client({appId:'cli_synthetic_card_transport',appSecret:'synthetic-secret',appType:lark.AppType.SelfBuild,httpInstance:transport});
    receive('HTTP fixture <at id=all>not active</at>','om_http');await tick(900);
    const payload=requests.find(value=>value.data?.content);expect(payload).toBeDefined();
    const card=JSON.parse(payload.data.content);expect(JSON.stringify(card)).toContain('【📥 已收件】');expect(JSON.stringify(card)).not.toContain('<at');
    expect(Buffer.byteLength(JSON.stringify(payload),'utf8')).toBeLessThanOrEqual(LIVE_CARD_BYTES);expect(h.sends).toHaveLength(0);
  });

  it('oversized outer addressing is rejected locally without any SDK call/fallback',async()=>{
    const view={title:'Fixture',lines:[],elapsed:'0:00',toolCalls:0,noReply:false,state:'queued'};
    await expect(h.bot.replyLiveStatusCard('x'.repeat(40_000),view,'chat')).rejects.toThrow(/outer JSON byte budget/);
    expect(h.create).not.toHaveBeenCalled();expect(h.bot.client.im.message.patch).not.toHaveBeenCalled();
  });
});
