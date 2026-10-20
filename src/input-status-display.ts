/** Display-only references. Never read by admission, routing, reactions or replay. */
export type InputHintKind = 'received' | 'queued' | 'submitting' | 'append_queued' | 'accepted' | 'processing'
  | 'waiting' | 'paused' | 'unconfirmed' | 'delivery_pending' | 'partial' | 'completed' | 'no_reply' | 'replied' | 'failed' | 'blocked';
export type InputHint = { rowId?: number; messageId?: string; kind: InputHintKind; detail?: string; at: number; preview?: string; previewSource?: 'visible' };
export type InputStatusContext = {
  botName?: string; appId?: string; chatId?: string; stopEpoch?: number;
  items: InputHint[]; note?: InputHint;
};
export type InputHintChange = { kind: InputHintKind; detail?: string; ids?: number[]; at: number };
export type InputDisplayLimits = { preview: number; members: number; activity: number };
export const LIVE_CARD_BYTES = 30_000;
export const INPUT_DISPLAY_LIMITS: InputDisplayLimits[] = [
  {preview:160,members:12,activity:180},{preview:96,members:10,activity:120},
  {preview:48,members:6,activity:80},{preview:20,members:2,activity:24},
];
const labels: Record<InputHintKind,[string,string]> = {
  received:['📥 已收件','📥 Received'],queued:['⏳ 本地排队','⏳ Queued'],submitting:['📨 提交待确认','📨 Submission pending'],
  append_queued:['⏳ 追加排队','⏳ Append queued'],accepted:['✅ 已接收','✅ Accepted'],processing:['⚙️ 处理中','⚙️ Processing'],
  waiting:['⏳ 等待后续','⏳ Waiting'],paused:['⏸️ 等待暂停','⏸️ Wait paused'],unconfirmed:['❔ 结果待确认','❔ Result unconfirmed'],
  delivery_pending:['📨 投递待确认','📨 Delivery pending'],partial:['⚠️ 部分确认','⚠️ Partial'],completed:['✅ 本轮结束','✅ Round ended'],
  no_reply:['💤 无正文','💤 No content'],replied:['💬 关联已回复','💬 Linked reply'],failed:['⚠️ 执行中断','⚠️ Interrupted'],blocked:['⛔ 尚未提交','⛔ Not submitted'],
};
const details: Partial<Record<InputHintKind,[string,string]>> = {
  received:['尚未确认 Gateway 接收','Gateway acceptance unconfirmed'],queued:['等待提交确认','Waiting for admission'],
  submitting:['已开始提交；Gateway 接收尚未确认','Submission started; Gateway acceptance unconfirmed'],
  append_queued:['实际接收方、提交及处理结果未确认','Actual receiver, commitment and result unconfirmed'],
  accepted:['Gateway 已接收；等待执行活动','Gateway accepted; waiting for activity'],
  partial:['root 结果仅覆盖普通输入；追加输入提交及处理仍未确认，不重放','Root result covers ordinary inputs only; appended commitment/result remain unconfirmed, no replay'],
  waiting:['保留后续结果观察；不自动重发输入','Continuing result observation; no input replay'],
  paused:['仅暂停等待；未因此停止任务或重发输入','Waiting paused only; no task stop or input replay'],
  unconfirmed:['最终结果尚未确认','Final result unconfirmed'],delivery_pending:['平台投递回执尚未确认；不重复发送','Platform receipt unconfirmed; no duplicate send'],
  completed:['本轮结果仅覆盖实际普通输入','This round covers only its ordinary inputs'],
  no_reply:['本轮未产生用户可见正文','No user-visible content this round'],
  replied:['关联轮次回复已送达；不据此确认追加输入提交','Linked run reply delivered; input commitment remains separate'],
  failed:['本轮执行中断；不据此归因用户停止','Execution interrupted; no user-stop attribution'],
  blocked:['保留原输入；不迁移或自动重发','Input retained; no migration or automatic replay'],
};
export function hintLabel(kind:InputHintKind,en:boolean):string { return `【${(labels[kind] || labels.unconfirmed)[en?1:0]}】`; }
export function hintDetail(kind:InputHintKind,en:boolean):string { return details[kind]?.[en?1:0] || ''; }
export function displayClip(value:string,max:number):string {
  // Code-point safe, including malformed isolated surrogates; no split emoji
  // surrogate, JSON fragment or half a UTF-8 sequence is emitted.
  const points=Array.from(String(value),ch=>{const n=ch.codePointAt(0)!;return n>=0xd800&&n<=0xdfff?'�':ch;});
  return points.length>max ? points.slice(0,Math.max(0,max-1)).join('')+'…' : points.join('');
}
/** Explicit visible human ingress: escaping/clipping only. Never infer media or
 * generated prompts from text that merely looks like a system annotation. */
export function visibleInputPreview(content:string,max:number,en:boolean):string {
  const text=String(content || '').replace(/\s+/g,' ').trim();
  return displayClip(text || (en?'[Message body unavailable]':'[消息正文暂不可用]'),max);
}

/** Legacy stored/hydrated body fallback; explicit visible ingress never uses it. */
export function inputPreview(content:string,max:number,en:boolean):string {
  const filename=(value:string)=>value.trim().split(/[\\/]/).at(-1) || (en?'file':'文件');
  const raw=String(content || '').trim();
  if(raw==='请回复上面最近一条用户消息。')return en?'[Message body unavailable]':'[消息正文暂不可用]';
  const text=raw
    .replace(/\n\n\[飞书文档已由 LMA 用机器人权限读取并转换为 Markdown 附件，OpenClaw 可直接读取附件内容。\][\s\S]*$/,'')
    .replace(/\[(?:Image|Audio|Sticker)(?::[^\]]*)?\]/gi,match=>/^\[Image/i.test(match)?(en?'[Image]':'[图片]'):/^\[Audio/i.test(match)?(en?'[Audio]':'[语音]'):(en?'[Sticker]':'[贴纸]'))
    .replace(/\[File:\s*([^\]]*)\]/gi,(_all,value:string)=>`[${en?'File':'文件'}: ${filename(value.split(/\s+->\s+|\s+- download failed/)[0])}]`)
    .replace(/\[(?:FeishuDoc|Attachment):[^\]]*\]/gi,en?'[Document]':'[文档]')
    .replace(/\s+/g,' ').trim();
  return displayClip(text || (en?'[Message body unavailable]':'[消息正文暂不可用]'),max);
}
/** Use the existing markdown component as inert text, not as a user-authored
 * card/mention/link language. Entity introducers/platform tags are neutralized
 * before markdown punctuation is escaped. No media or URL is fetched. */
export function inertInputText(value:string):string {
  return value.replace(/&/g,'＆').replace(/</g,'＜').replace(/>/g,'＞').replace(/[\\`*_{}\[\]()#+!|~]/g,'\\$&');
}
export function selectInputHints(items:InputHint[],max:number):InputHint[] {
  if(items.length<=max)return items;
  const first=Math.max(1,Math.floor(max/3));
  return [...items.slice(0,first),...items.slice(-(max-first))];
}
