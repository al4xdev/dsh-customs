import { randomUUID } from 'node:crypto';
import { hash, fail, freeze } from './contracts.mjs';
import { parseProfileArgs } from './profile-contracts.mjs';
import { callerKey, prepare, revalidate } from './preflight.mjs';
import { displayJson } from './approval.mjs';
import { publicResult } from './operation-store.mjs';
import { profileClient } from './profile-client.mjs';
import { preparationHash } from './profile-protocol.mjs';

const states=new Set(['completed','partial','unknown','not_started']);
function publicReceipt(record) {
  return {...publicResult(record),destination:record.approved_intent.destination,host_receipt:record.host_receipt??null};
}
function unavailable(error,operationId) {
  return {code:error.code??'create_unavailable',reason:String(error.message??'Destination unavailable').slice(0,240),effect:'none',retry_safe:false,...(operationId?{operation_id:operationId}:{})};
}
function validatePreparation(value,proposal) {
  if(!value||typeof value.id!=='string'||typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||preparationHash(value)!==value.hash||hash(value.proposal)!==hash(proposal)||value.binding?.profile!=='dsh-tui'||value.binding?.preset!=='standard'||typeof value.binding.model?.provider!=='string'||typeof value.binding.model?.model!=='string'||!value.binding.policy)fail('destination_preparation_invalid');
}
export function createProfileController(ctx,{authority,store,bridgeRoot,client=profileClient}) {
  let tail=Promise.resolve(),phase='idle';
  const capabilities=()=>({tool:'session_create',version:2,request_version:1,operations:['help','capabilities','status','create'],destination_profile:'dsh-tui',preset:'standard',requires_live_host:true,delivery_default:'empty',target_default:'current',new_project:false,new_project_reason:'Destination registry create-or-reuse cannot prove exclusive new-project ownership; use current or an existing project',projects_root:`${authority.root}/projects`,approval:'native allowed-once in Companion; exact destination policies are displayed separately',model_selection:'destination-host-default; optional exact assertion',default_model_changes:false,retry:'No automatic retry; same key returns receipt only',cold_resume_authority:false,ui_switch:false});
  async function discover(signal) {
    const found=await client.discover({root:bridgeRoot,signal});signal?.throwIfAborted();return found;
  }
  async function select(request,signal) {
    const found=await discover(signal);
    const records=request.host_id?found.records.filter(record=>record.bridgeId===request.host_id):found.records;
    if(!records.length)fail('destination_host_unavailable','Open/reload a dsh-tui host with the updated creation bridge; no Companion session was created');
    if(records.length!==1)fail('destination_host_ambiguous','Multiple dsh-tui hosts are available; choose an exact host_id from capabilities');
    return records[0];
  }
  async function create(request,exec) {
    exec.signal.throwIfAborted();
    if(typeof exec.callId!=='string'||!exec.callId)return unavailable({code:'caller_unavailable'});
    const caller=callerKey(exec),requestHash=hash(request),operationId=store.operationId(caller,request.idempotency_key??`call:${exec.callId}`);
    let lease;
    try {
      phase='readonly-ledger';
      const prior=await store.read(operationId,caller);exec.signal.throwIfAborted();
      if(prior)return prior.request_hash===requestHash?publicReceipt(prior):unavailable({code:'idempotency_conflict'},operationId);
      if(request.target.kind==='new_project')fail('new_project_unavailable','Create within the current workspace or an existing approved project; new-project ownership is not proven by the destination API');
      phase='readonly-caller-preflight';
      // Retain the caller's existing authority/path checks, not its execution profile/model.
      const local=await prepare(ctx,{...request,preset:'companion',model:undefined},exec,authority,{operation_id:operationId,session_id:`session-${randomUUID()}`,request_id:randomUUID()});
      const record=await select(request,exec.signal);
      const proposal={operation_id:operationId,session_id:local.session_id,request_id:local.request_id,profile:'dsh-tui',preset:'standard',cwd:local.cwd,delivery:request.delivery,...(request.model?{model:{provider:request.model.provider,model:request.model.model,...(request.model.reasoning_effort===undefined?{}:{reasoningEffort:request.model.reasoning_effort})}}:{}),target:local.target,directory:local.directory,create_projects_parent:local.create_projects_parent,project:local.project,facts:local.facts};
      phase='readonly-destination-preflight';
      const prepared=await client.prepare(record,proposal,exec.signal);exec.signal.throwIfAborted();
      if(!prepared?.ok)fail(prepared?.error?.code??'destination_unavailable',prepared?.error?.message??'Destination preparation failed');
      validatePreparation(prepared.preparation,proposal);
      const preparation=freeze(structuredClone(prepared.preparation));
      const destination={host_id:record.bridgeId,profile:'dsh-tui',preset:'standard',model:preparation.binding.model,policy:preparation.binding.policy,permission:preparation.binding.permission};
      const {intent_hash:oldHash,...localBody}=local;
      const intent=freeze({...localBody,destination,preparation_id:preparation.id,preparation_hash:preparation.hash,model_binding:'destination-host-live-pinned; no cold-resume promise',intent_hash:hash({...localBody,destination,preparation_id:preparation.id,preparation_hash:preparation.hash})});
      phase='native-approval';
      const reason=`Criar sessão no perfil dsh-tui — permitir uma vez\n${displayJson({operation_id:operationId,intent_hash:intent.intent_hash,caller:local.binding.caller,owner_intent:request.owner_intent,host:{bridgeId:record.bridgeId,pid:record.pid,startTime:record.startTime},destination:preparation.binding,cwd:intent.cwd,target:intent.target,directory:intent.directory,create_projects_parent:intent.create_projects_parent,new_session_id:intent.session_id,delivery:request.delivery.mode,initial_text_full:request.delivery.mode==='submit'?request.delivery.text:null,notice:request.delivery.mode==='submit'?'CRIAR E ENVIAR AGORA: o agente poderá executar a tarefa e consumir quota.':'CRIAR VAZIA: sem prompt, draft, execução de modelo ou mudança da aba ativa.',policy_notice:'As políticas exibidas são as do destino. danger-full-access/never significa acesso amplo e execução futura sem aprovação de ferramentas; a aprovação desta criação não muda essas políticas nem os defaults globais.',limitations:'Sem fallback para Companion, retry automático ou rollback destrutivo. Falha/desconexão pode deixar efeitos parciais. Criação/admissão não significa conclusão da tarefa.'})}`;
      const outcome=await ctx.approval.request(Object.freeze({agent:exec.agent,toolName:'session_create',callId:exec.callId,reason,signal:exec.signal}));
      exec.signal.throwIfAborted();
      if(outcome!=='allowed-once')fail(`approval_${['rejected','cancelled','unavailable'].includes(outcome)?outcome:'unavailable'}`);
      await revalidate(ctx,exec,authority,local,local.facts);
      if(preparation.expiresAt<=Date.now())fail('destination_preparation_expired');
      phase='durable-dispatch';
      lease=await store.begin(intent,requestHash);
      let remote;
      await lease.stage('session',async()=>{
        // Once dispatched, interruption cannot prove that the target did not create/admit.
        const reply=await client.execute(record,preparation,exec.signal);
        if(!reply?.receipt||!states.has(reply.receipt.status)||reply.receipt.session_id!==intent.session_id||reply.receipt.request_id!==intent.request_id||reply.receipt.profile!=='dsh-tui'||reply.receipt.preset!=='standard'||!reply.receipt.effects)fail(reply?.error?.code??'creation_unknown');
        remote=reply.receipt;
        return {id:intent.session_id,remote_receipt_received:true};
      });
      lease.record.host_receipt=remote;
      // An authenticated target receipt supersedes the transport-level pending marker.
      lease.record.effects=structuredClone(remote.effects);
      await lease.finish(remote.status,remote.code??undefined);
      return publicReceipt(lease.record);
    } catch(error) {
      if(lease){await lease.finish('unknown',error.code??'creation_unknown').catch(()=>{});return publicReceipt(lease.record);}
      return unavailable(error,operationId);
    } finally {await lease?.release();phase='idle';}
  }
  return {
    capabilities,diagnostics:()=>({phase}),
    async execute(input,exec) {
      const args=parseProfileArgs(input);
      if(['help','capabilities'].includes(args.operation)) {
        try{const found=await discover(exec.signal);return {...capabilities(),hosts:found.hosts,available:found.hosts.length>0,unavailable_bridges:found.unavailable_bridges,discovery_errors:found.discovery_errors};}
        catch(error){exec.signal?.throwIfAborted();return {...capabilities(),available:false,hosts:[],code:error.code??'discovery_unavailable'};}
      }
      if(args.operation==='status') {
        const record=await store.read(args.operation_id,callerKey(exec));exec.signal.throwIfAborted();
        return record?publicReceipt(record):{code:'operation_not_found',effect:'none'};
      }
      const result=tail.then(()=>create(args.request,exec));tail=result.catch(()=>{});return result;
    },async drain(){await tail;},
  };
}
