import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFileCatalog } from './file-catalog.mjs';
import { createFileEventReader, presentEvent, searchEvents } from './file-events.mjs';
import { cursorCodec, publicHeader, redact } from './contracts.mjs';
import { parseFileRequest, fileError } from './file-contracts.mjs';

const MAX_STATES = 24, MAX_STATE_BYTES = 64 * 1024 * 1024, TTL = 15 * 60 * 1000;
const visible = event => ['user/message','assistant/message','tool/call','tool/result','turn/end','session/title','approval/asked','approval/decided'].includes(event.type) || event.type.startsWith('subagent/');
const signature = candidate => JSON.stringify(candidate.signature);
const projectMatches = (header,args) => (!args.project || header.cwd===args.project) && (!args.projectPrefix || header.cwd===args.projectPrefix || header.cwd?.startsWith(args.projectPrefix.replace(/\/$/,'')+'/'));

/** Recent-file navigation is separate from bridge intervention and legacy source locators. */
export function createFileController({ root, evidence = async () => new Map() }) {
  const catalog = createFileCatalog({root});
  const reader = createFileEventReader({root});
  const codec = cursorCodec(), states = new Map();
  let stateBytes=0;
  function remove(key) { const old=states.get(key); if(old) stateBytes-=old.bytes; states.delete(key); }
  function put(state) {
    for(const [key,old] of states) if(Date.now()-old.at>TTL) remove(key);
    const bytes=Buffer.byteLength(JSON.stringify(state));
    if(bytes>MAX_STATE_BYTES) throw fileError('read_budget','Snapshot exceeds navigation budget');
    while(states.size>=MAX_STATES || stateBytes+bytes>MAX_STATE_BYTES) remove(states.keys().next().value);
    const key=randomUUID(); states.set(key,{value:state,bytes,at:Date.now()}); stateBytes+=bytes; return key;
  }
  function fingerprint(args) { const {cursor,limit,maxBytes,revision,...filters}=args; return codec.revision(filters); }
  function resume(args) {
    if(!args.cursor) return null;
    let decoded; try {decoded=codec.decode(args.cursor,fingerprint(args));} catch {throw fileError('cursor_invalid');}
    const record=states.get(decoded.ref);
    if(!record || Date.now()-record.at>TTL) throw fileError('cursor_expired','Navigation snapshot expired; restart this operation');
    record.at=Date.now();
    return {state:record.value,ref:decoded.ref,offset:decoded.offset};
  }
  const token=(args,ref,offset)=>codec.encode({id:fingerprint(args),ref,offset});
  function base(args,state) {return {operation:args.operation,observedAt:new Date().toISOString(),untrustedData:true,effect:'none',backend:'recent-files',selectionAt:state.selectionAt,ordering:'mtime-desc,path-asc'};}
  function bounded(value,maxBytes) {
    if(Buffer.byteLength(JSON.stringify(value))>maxBytes) throw fileError('output_budget','Response metadata exceeds maxBytes; increase maxBytes');
    return value;
  }
  async function describe(candidate,args,signal,counters) {
    try {
      const item=await catalog.describe(candidate,{signal});
      if(item.classification!=='main') { counters[item.classification]=(counters[item.classification]??0)+1; return null; }
      if(!projectMatches(item.header,args)) {counters.project=(counters.project??0)+1;return null;}
      return item;
    } catch(error) {signal?.throwIfAborted(); counters.unreadable=(counters.unreadable??0)+1;return null;}
  }
  async function currentCandidates(signal) {
    const found=await catalog.discover({signal});
    return {...found,byPath:new Map(found.candidates.map(c=>[c.path,c]))};
  }
  async function exact(id,signal) {
    const found=await currentCandidates(signal);
    const segments=new Set([id,`session-${id}`,encodeURIComponent(id),`session-${encodeURIComponent(id)}`]);
    const likely=found.candidates.filter(c=>segments.has(path.basename(c.sessionDir)));
    for(const candidate of likely.length?likely:found.candidates) {
      let entry;try{entry=await catalog.describe(candidate,{signal});}catch(error){signal?.throwIfAborted();if(likely.length)throw error;continue;}
      if(entry.header?.id!==id)continue;
      if(entry.classification==='companion')throw fileError('session_excluded','Companion conversations are excluded');
      if(entry.classification==='unreadable')throw fileError('session_unavailable');
      return entry;
    }
    throw fileError('not_found','Session not found in configured file root');
  }
  async function makeRow(entry,signal) {
    const row={header:publicHeader(entry.header),classification:entry.classification,modifiedAt:new Date(entry.mtimeMs).toISOString(),mtimeMs:entry.mtimeMs};
    try {
      const snapshot=await reader.load(entry,{signal});
      const title=snapshot.title;
      row.title=title?.title?redact(title.title).slice(0,512):null;
      row.titleSource=title?.source;
      row.titleComplete=snapshot.titleComplete!==false&&!snapshot.partial;
      const own=snapshot.events; // Physical logs include inherited context; preview is explicitly the captured tail.
      const lastUser=own.findLast(e=>e.type==='user/message');
      const lastAssistant=own.findLast(e=>e.type==='assistant/message');
      row.hasConversation=Boolean(lastUser||lastAssistant);
      row.preview={...(lastUser?{user:presentEvent(lastUser,{textLimit:180}).text}:{}),...(lastAssistant?{assistant:presentEvent(lastAssistant,{textLimit:180}).text}:{})};
      row.lastMessageAt=Math.max(lastUser?.time??0,lastAssistant?.time??0)||null;
      row.partial=snapshot.partial;
    }catch(error){signal?.throwIfAborted();row.partial=true;row.readError=redact(error.message).slice(0,160);}
    return row;
  }
  async function list(args,signal) {
    const restored=resume(args), found=await currentCandidates(signal);
    const state=restored?.state??{kind:'list',selectionAt:new Date().toISOString(),candidates:found.candidates,discoveryTruncated:found.truncated};
    const ref=restored?.ref??put(state); let position=restored?.offset??0;
    const rows=[],skipped={},start=Date.now();
    while(position<state.candidates.length&&rows.length<args.limit) {
      signal?.throwIfAborted();
      const batch=[];
      while(position<state.candidates.length&&batch.length<args.limit-rows.length) {
        const at=position++, original=state.candidates[at], candidate=found.byPath.get(original.path);
        if(!candidate){skipped.removed=(skipped.removed??0)+1;continue;}
        const entry=await describe(candidate,args,signal,skipped);
        if(entry)batch.push({entry,at});
      }
      const live=await evidence(batch.map(x=>({header:x.entry.header})),signal);
      for(const {entry,at} of batch) {
        const observed=live.get(entry.header.id)??{state:'unknown'};
        if(args.state&&observed.state!==args.state||args.writer&&observed.writerOwnership?.state!==args.writer)continue;
        const row={...await makeRow(entry,signal),...observed};
        if(row.hasConversation===false&&!row.title&&!row.partial){skipped.empty=(skipped.empty??0)+1;continue;}
        // Byte-shortened pages resume at the omitted candidate, never silently drop it.
        const proposed={...base(args,state),sessions:[...rows,row],skipped,nextCursor:token(args,ref,position),truncated:true};
        if(Buffer.byteLength(JSON.stringify(proposed))>args.maxBytes-256) {
          if(rows.length){position=at;break;}
          delete row.preview; row.title=typeof row.title==='string'?row.title.slice(0,120):row.title;row.previewOmitted=true;
        }
        rows.push(row);
      }
      if(Date.now()-start>10000||rows.length>=args.limit)break;
      // An output-budget break must return now rather than reselect its candidate.
      if(batch.some(x=>x.at===position))break;
    }
    const more=position<state.candidates.length;
    return bounded({...base(args,state),sessions:rows,skipped,totalCandidates:state.candidates.length,discoveryTruncated:state.discoveryTruncated,coverage:more||state.discoveryTruncated?'partial':'complete-selection',nextCursor:more?token(args,ref,position):null,truncated:more||Boolean(state.discoveryTruncated)},args.maxBytes);
  }
  async function selectSearch(args,signal) {
    if(args.sessionId) {const entry=await exact(args.sessionId,signal);if(!projectMatches(entry.header,args))throw fileError('not_found');return {candidates:[entry],skipped:{},discoveryTruncated:false};}
    const found=await currentCandidates(signal),candidates=[],skipped={};
    for(const candidate of found.candidates) {const entry=await describe(candidate,args,signal,skipped);if(entry)candidates.push(entry);if(candidates.length>=args.maxFiles)break;}
    return {candidates,skipped,discoveryTruncated:found.truncated};
  }
  async function find(args,signal) {
    const restored=resume(args);
    const state=restored?.state??{kind:'find',selectionAt:new Date().toISOString(),...await selectSearch(args,signal)};
    let ref=restored?.ref??put(state), pendingSnapshot=null;
    // Cursor offset addresses a sparse (file,event) space without pinning every decoded file.
    let fileIndex=Math.floor((restored?.offset??0)/100000000),eventIndex=(restored?.offset??0)%100000000;
    const found=await currentCandidates(signal),hits=[],errors=[];let filesRead=0,finished=false;const started=Date.now();
    while(fileIndex<state.candidates.length&&filesRead<args.candidateBudget&&Date.now()-started<args.durationMs) {
      signal?.throwIfAborted();
      filesRead++; // Failed files also consume the per-call work budget.
      const original=state.candidates[fileIndex], candidate=found.byPath.get(original.path);
      const pinned=state.pendingSnapshot?.fileIndex===fileIndex?state.pendingSnapshot.snapshot:null;
      if(!candidate&&!pinned){errors.push({sessionId:original.header.id,code:'removed'});fileIndex++;eventIndex=0;continue;}
      // Each file is captured independently; appends do not invalidate unrelated files/pages.
      let snapshot,entry;
      try {entry=pinned?original:await catalog.describe(candidate,{signal});if(entry.classification==='companion'||!args.sessionId&&entry.classification!=='main')throw fileError('session_excluded');snapshot=pinned??await reader.load(entry,{signal});}
      catch(error){signal?.throwIfAborted();errors.push({sessionId:original.header.id,code:error.code??'unreadable'});fileIndex++;eventIndex=0;continue;}
      const matches=searchEvents(snapshot,{query:args.query,signal,scope:args.scope,section:'event',caseSensitive:args.caseSensitive,offset:0,limit:100000000}).matches;
      for(;eventIndex<matches.length;eventIndex++) {
        const match=matches[eventIndex],event=snapshot.events.find(e=>e.seq===match.seq);
        if(!event)continue;
        const preview=presentEvent(event,{section:'event',format:'json',textOffset:Math.max(0,(match.matchOffset??0)-80),textLimit:400});
        const hit={sessionId:entry.header.id,title:snapshot.title?.title?.slice(0,512)??null,seq:event.seq,type:event.type,time:event.time,...preview};
        if(Buffer.byteLength(JSON.stringify({...base(args,state),hits:[...hits,hit],nextCursor:token(args,ref,fileIndex*100000000+eventIndex)}))>args.maxBytes-512) {if(!hits.length){hit.text=hit.text.slice(0,100);hit.previewTruncated=true;hit.cutoff=true;hit.nextTextOffset=hit.textOffset+hit.text.length<hit.textLength?hit.textOffset+hit.text.length:null;}else{finished=true;break;}}
        hits.push(hit);
        if(hits.length>=args.limit){eventIndex++;finished=true;break;}
      }
      if(eventIndex>=matches.length){fileIndex++;eventIndex=0;}
      else if(finished)pendingSnapshot={fileIndex,snapshot};
      if(snapshot.partial)errors.push({sessionId:entry.header.id,code:'partial_file'});
      if(finished)break;
    }
    const more=fileIndex<state.candidates.length;
    // Pin only the currently paginated file, within the same bounded state budget.
    if(more)ref=put({...state,pendingSnapshot});
    return bounded({...base(args,state),engine:'literal-recent-files',scope:args.scope,selectedFiles:state.candidates.length,maxFiles:args.maxFiles,filesRead,skipped:state.skipped,errors:errors.slice(0,3),hits,coverage:more||errors.length||state.discoveryTruncated?'partial':'complete-selected-files',nextCursor:more?token(args,ref,fileIndex*100000000+eventIndex):null,truncated:more||errors.length>0||Boolean(state.discoveryTruncated)},args.maxBytes);
  }
  function render(event,args,budget) {
    let limit=args.textLimit, row=presentEvent(event,{...args,textLimit:limit});
    while(Buffer.byteLength(JSON.stringify(row))>budget&&limit>1){limit=Math.max(1,Math.floor(limit/2));row=presentEvent(event,{...args,textLimit:limit});}
    return row;
  }
  async function read(args,signal) {
    const restored=resume(args);let state,ref,start;
    if(restored){({state,ref}=restored);start=restored.offset;}
    else {
      const entry=await exact(args.sessionId,signal);
      if(!projectMatches(entry.header,args))throw fileError('not_found');
      const revision=codec.revision(signature(entry));
      if(args.revision===revision)return {operation:args.operation,sessionId:args.sessionId,revision,unchanged:true,events:[],nextCursor:null,untrustedData:true,effect:'none'};
      const snapshot=await reader.load(entry,{signal});
      const all=snapshot.events.filter(visible);
      let events=all;
      if(args.seq!==undefined) {
        const index=snapshot.events.findIndex(e=>e.seq===args.seq);
        if(index<0)throw fileError(snapshot.partial?'event_outside_capture':'event_not_found');
        events=snapshot.events.slice(Math.max(0,index-(args.before??0)),index+1+(args.after??0));
      } else if(args.operation==='context'&&(args.anchor??'both')==='both') {
        const half=Math.max(1,Math.floor(args.limit/2));events=[...new Map([...all.slice(0,half),...all.slice(-half)].map(e=>[e.seq,e])).values()];
      }
      const selection=args.operation==='context'&&(args.anchor??'both')==='both'&&args.seq===undefined?{mode:'head-and-tail',middleOmitted:all.length>events.length}:{mode:args.seq!==undefined?'event-neighborhood':'event-page'};
      state={kind:'read',selectionAt:new Date().toISOString(),header:entry.header,revision,selection,snapshot:{...snapshot,events}};
      ref=put(state);
      const tail=(args.view??args.anchor??(args.operation==='inspect'?'head':'tail'))==='tail';
      start=args.offset!==undefined?Math.max(0,events.findIndex(e=>e.seq>=args.offset)):tail?Math.max(0,events.length-args.limit):0;
      if(args.offset!==undefined&&!events.some(e=>e.seq>=args.offset))start=events.length;
      if(args.seq!==undefined)start=0;
    }
    const events=state.snapshot.events,rows=[];
    const result={...base(args,state),sessionId:state.header.id,header:publicHeader(state.header),title:state.snapshot.title?.title?.slice(0,512)??null,revision:state.revision,selection:state.selection,snapshotPartial:state.snapshot.partial,titleComplete:state.snapshot.titleComplete,tailComplete:state.snapshot.tailComplete,format:args.format,section:args.section,events:rows,previousCursor:start>0?token(args,ref,Math.max(0,start-args.limit)):null,nextCursor:null,truncated:false,warnings:(state.snapshot.warnings??[]).slice(0,2).map(w=>redact(typeof w==='string'?w:JSON.stringify(w)).slice(0,160))};
    let position=start;
    for(;position<events.length&&rows.length<args.limit;position++) {
      const row=render(events[position],args,Math.max(128,args.maxBytes-Buffer.byteLength(JSON.stringify(result))-350));
      rows.push(row);result.nextCursor=position+1<events.length?token(args,ref,position+1):null;
      if(Buffer.byteLength(JSON.stringify(result))>args.maxBytes){rows.pop();if(!rows.length)throw fileError('output_budget','Event metadata exceeds maxBytes');break;}
    }
    result.nextCursor=position<events.length?token(args,ref,position):null;
    result.nextSeq=events[position]?.seq??null;
    result.truncated=Boolean(result.nextCursor||state.snapshot.partial||rows.some(r=>r.nextTextOffset!==null&&r.nextTextOffset!==undefined));
    return bounded(result,args.maxBytes);
  }
  return {async execute(raw,exec={}) {const args=parseFileRequest(raw);exec.signal?.throwIfAborted();if(args.operation==='list')return list(args,exec.signal);if(['find','search'].includes(args.operation))return find(args,exec.signal);return read(args,exec.signal);},clear(){states.clear();stateBytes=0;catalog.clear();reader.clearCache();}};
}
