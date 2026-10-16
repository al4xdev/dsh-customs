import { isAbsolute } from 'node:path';
export const FILE_OPERATIONS = ['list', 'find', 'search', 'read', 'inspect', 'context'];
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'integer', description });
const paging = { cursor: str('Opaque continuation from this operation; keep filters unchanged.'), limit: num('Rows per call: list defaults to 10; other operations 20; maximum 100.'), maxBytes: num('Output JSON byte limit: 1024..32768, default 16384.') };
const target = { sessionId: str('Exact session ID. Rename changes title, never this identity.'), sourceId: str('Optional identity from sources; the configured source must still match.') };
const filters = { project: str('Exact header cwd.'), projectPrefix: str('Absolute cwd prefix, with directory component boundaries.') };
const detail = { ...target, ...paging, view: {type:'string',enum:['head','tail']}, offset: num('Logical event sequence to begin at; not a physical line.'), seq: num('Exact event to inspect; with before/after, inspect its neighborhood.'), before: num('Events before seq, maximum 50.'), after: num('Events after seq, maximum 50.'), format: {type:'string',enum:['text','json'],description:'text gives readable previews; json gives redacted, paginatable JSON text for selected events.'}, section: {type:'string',enum:['summary','arguments','result','event'],description:'Deepen one event: arguments, result or complete allowed event JSON. No reasoning/request envelopes or attachment bodies.'}, textOffset: num('Character offset in the redacted event content; use an exact seq.'), textLimit: num('Characters per event: default 2048, maximum 16384; follow nextTextOffset.'), revision: str('Previous file revision for polling, without cursor or offset.') };
export const FILE_SCHEMAS = {
  list: {...paging,...filters,sourceId:target.sourceId, state:{type:'string',enum:['alive','ended','waiting','unknown']},writer:{type:'string',enum:['held','not-observed','unknown']}},
  find: {...target,...paging,...filters,query:str('Literal text, not regex or SQL; maximum 512 characters.'),maxFiles:num('Search scope: latest 100 main sessions by default, maximum 1000, after classification.'),scope:{type:'string',enum:['messages','tools','all'],description:'Default all: messages plus allowed tool arguments/results. Internal/private envelopes excluded.'},caseSensitive:{type:'boolean'},candidateBudget:num('Maximum files inspected in this call, default 10, maximum 100.'),durationMs:num('Cooperative work budget per call, default 5000, maximum 30000.')},
  read:detail,
  inspect:detail,
  context:{...detail,anchor:{type:'string',enum:['head','tail','seq','both']},...filters},
};
FILE_SCHEMAS.search = {...FILE_SCHEMAS.find,mode:{type:'string',enum:['literal','substring','phrase'],description:'Compatibility aliases; all use literal matching in the file reader.'}};
export function fileError(code, message = code) { return Object.assign(new Error(message), {code,sessionReadError:true}); }
export function isFileRequest(args) { return FILE_OPERATIONS.includes(args?.operation); }
export function parseFileDescription(input) {
  if(input?.operation!=='describe'||!Object.hasOwn(FILE_SCHEMAS,input.targetOperation)||Object.keys(input).some(key=>!['operation','targetOperation'].includes(key))) throw fileError('invalid_argument');
  return input;
}
export function parseFileRequest(input) {
  const schema = Object.hasOwn(FILE_SCHEMAS,input?.operation)?FILE_SCHEMAS[input.operation]:null;
  if (!schema || !input || typeof input !== 'object' || Array.isArray(input)) throw fileError('invalid_argument');
  for (const [key,value] of Object.entries(input)) {
    if(key==='operation') continue;
    const field=schema[key]; if(!field) throw fileError('invalid_argument',`unexpected argument: ${key}`);
    if(value===undefined) continue;
    if(field.type==='string' && (typeof value!=='string'||!value.length||/[\0\r\n]/.test(value)||value.length>4096)) throw fileError('invalid_argument',`invalid ${key}`);
    if(field.type==='integer' && (!Number.isSafeInteger(value)||value<0)) throw fileError('invalid_argument',`invalid ${key}`);
    if(field.type==='boolean'&&typeof value!=='boolean') throw fileError('invalid_argument',`invalid ${key}`);
    if(field.enum&&!field.enum.includes(value)) throw fileError('invalid_argument',`invalid ${key}`);
  }
  for(const key of ['project','projectPrefix']) if(input[key]!==undefined&&!isAbsolute(input[key])) throw fileError('invalid_argument',`${key} must be absolute`);
  if(['read','inspect','context'].includes(input.operation)&&!input.sessionId) throw fileError('invalid_argument','sessionId required');
  if(['find','search'].includes(input.operation)&&(!input.query?.trim()||Array.from(input.query).length>512)) throw fileError('invalid_argument','query must contain 1..512 characters');
  if(input.offset!==undefined&&(input.cursor!==undefined||input.revision!==undefined||input.seq!==undefined)) throw fileError('invalid_argument','offset conflicts with cursor/revision/seq');
  if(input.revision!==undefined&&input.cursor!==undefined) throw fileError('invalid_argument','revision conflicts with cursor');
  if((input.before!==undefined||input.after!==undefined)&&input.seq===undefined) throw fileError('invalid_argument','before/after require seq');
  if(input.anchor==='seq'&&input.seq===undefined) throw fileError('invalid_argument','anchor:seq requires seq');
  const out={...input,limit:input.limit??(input.operation==='list'?10:20),maxBytes:input.maxBytes??16384,textLimit:input.textLimit??2048,textOffset:input.textOffset??0,maxFiles:input.maxFiles??100,candidateBudget:input.candidateBudget??10,durationMs:input.durationMs??5000,format:input.format??'text',section:input.section??'summary',scope:input.scope??'all'};
  for(const [key,min,max] of [['limit',1,100],['maxBytes',1024,32768],['textLimit',1,16384],['maxFiles',1,1000],['candidateBudget',1,100],['durationMs',1,30000],['before',0,50],['after',0,50]]) if(out[key]!==undefined&&(out[key]<min||out[key]>max)) throw fileError('invalid_argument',`${key} must be ${min}..${max}`);
  if(out.textOffset>0&&out.seq===undefined&&out.offset===undefined) throw fileError('invalid_argument','textOffset requires exact seq or offset');
  return out;
}
