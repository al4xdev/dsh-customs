import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './fixtures.mjs';
import { createProfileController } from './profile-controller.mjs';
import { parseProfileArgs, profileParameters } from './profile-contracts.mjs';
import { preparationHash } from './profile-protocol.mjs';
import { hash } from './contracts.mjs';
import { resolveHost } from '../common.mjs';
const {validateJsonSchemaValue}=await import(resolveHost('@deepseek-ai/dsh-tools'));

async function setup() {
  const f=await fixture(),host={bridgeId:randomUUID(),pid:123,startTime:'fixture',capabilities:{createProfile:{available:true,profile:'dsh-tui',preset:'standard'}}};
  const calls={discover:0,prepare:0,execute:0},model={provider:'destination-fixture',model:'target-model',reasoningEffort:'medium'};
  let records=[host];
  const client={
    async discover(){calls.discover++;return {records,hosts:records.map(r=>({host_id:r.bridgeId,profile:'dsh-tui',preset:'standard'})),unavailable_bridges:0,discovery_errors:0};},
    async prepare(record,proposal){calls.prepare++;if(proposal.model&&hash(proposal.model)!==hash(model))return {ok:false,error:{code:'model_unavailable'}};
      const preparation={id:randomUUID(),expiresAt:Date.now()+120000,proposal,binding:{profile:'dsh-tui',preset:'standard',model,permission:{name:'danger-full-access',sandbox:'danger-full-access',approval:'never'},policy:{mode:'danger-full-access',workspaceRoot:proposal.cwd,approval:'never'}}};preparation.hash=preparationHash(preparation);return {ok:true,preparation};},
    async execute(record,preparation){calls.execute++;assert.ok(f.effects.asks>0,'dispatch follows native gate');const p=preparation.proposal;return {ok:true,receipt:{status:'completed',profile:'dsh-tui',preset:'standard',session_id:p.session_id,request_id:p.request_id,effects:{projects_parent:{state:'not_started'},directory:{state:'not_started'},project:{state:'not_started'},session:{state:'confirmed',id:p.session_id,created:true},association:{state:'not_started'},submission:p.delivery.mode==='submit'?{state:'confirmed',accepted:true}:{state:'not_started'}}}};},
  };
  const controller=createProfileController(f.ctx,{authority:f.authority,store:f.store,client});
  const run=(request={},exec=f.exec())=>controller.execute({operation:'create',request:{version:1,owner_intent:'Explicit fixture request',...request}},exec);
  return {...f,controller,run,host,calls,client,model,setRecords:value=>{records=value;}};
}

test('profile contract selects dsh-tui standard and rejects Companion or invented host authority',()=>{
  const input={operation:'create',request:{version:1,owner_intent:'Create empty'}};
  assert.equal(parseProfileArgs(input).request.profile,'dsh-tui');assert.equal(parseProfileArgs(input).request.preset,'standard');
  assert.deepEqual(validateJsonSchemaValue(profileParameters,input),[]);
  for(const patch of [{preset:'companion'},{profile:'companion'},{host_id:'pid:1'},{confirmed:true}])assert.throws(()=>parseProfileArgs({...input,request:{...input.request,...patch}}));
});

test('empty creation dispatches to target after disclosure; never creates another Companion',async()=>{
  const f=await setup();let reason;
  f.ctx.answer=async request=>{reason=request.reason;assert.equal(f.calls.execute,0);return 'allowed-once';};
  const result=await f.run();
  assert.equal(result.status,'completed');assert.equal(result.destination.profile,'dsh-tui');assert.equal(result.destination.model.model,'target-model');
  assert.equal(f.effects.create,0);assert.equal(f.effects.submit,0);assert.equal(f.effects.model,0);assert.equal(f.effects.saveDefault,0);assert.equal(f.calls.execute,1);
  assert.equal(result.effects.submission.state,'not_started');assert.equal(result.completed,false);
  assert.match(reason,/danger-full-access/);assert.match(reason,/never/);assert.match(reason,/target-model/);assert.match(reason,/standard/);
  assert.equal(JSON.stringify(result).includes('preparationHash'),false);
});

test('no compatible host and ambiguous hosts fail before approval without local fallback',async()=>{
  const f=await setup();f.setRecords([]);
  assert.equal((await f.run()).code,'destination_host_unavailable');assert.equal(f.effects.asks,0);assert.equal(f.effects.create,0);
  const second={...f.host,bridgeId:randomUUID()};f.setRecords([f.host,second]);
  assert.equal((await f.run()).code,'destination_host_ambiguous');assert.equal(f.effects.asks,0);
  const result=await f.run({host_id:second.bridgeId});assert.equal(result.status,'completed');assert.equal(result.destination.host_id,second.bridgeId);
});

test('rejected, unavailable, and blanket allowed approvals never sign or dispatch',async()=>{
  for(const answer of ['rejected','unavailable','allowed']){
    const f=await setup();f.ctx.answer=async()=>answer;
    const result=await f.run();assert.match(result.code,/^approval_/);assert.equal(f.calls.execute,0);assert.equal(f.effects.create,0);
  }
});

test('caller configuration drift after approval stops before dispatch',async()=>{
  const f=await setup();f.ctx.answer=async()=>{f.ctx.agentDefaultModel.currentSelection=()=>({provider:'other',model:'changed'});f.caller.options={provider:'other',model:'changed'};return 'allowed-once';};
  assert.equal((await f.run()).code,'configuration_changed');assert.equal(f.calls.execute,0);
});

test('destination preparation hash and requested model are checked before approval',async()=>{
  const f=await setup();const real=f.client.prepare;
  f.client.prepare=async(...args)=>{const reply=await real(...args);reply.preparation.binding.policy.mode='changed-after-hash';return reply;};
  assert.equal((await f.run()).code,'destination_preparation_invalid');assert.equal(f.effects.asks,0);
  f.client.prepare=real;
  assert.equal((await f.run({model:{provider:'wrong',model:'wrong'}})).code,'model_unavailable');assert.equal(f.effects.asks,0);
  const result=await f.run({model:{provider:f.model.provider,model:f.model.model,reasoning_effort:'medium'}});assert.equal(result.status,'completed');
});

test('submit literal is fully disclosed and idempotency does not repeat dispatch',async()=>{
  const f=await setup(),text='Test "quoted"\nUnicode ação\u202eEND';let approved;
  f.ctx.answer=async request=>{approved=JSON.parse(request.reason.slice(request.reason.indexOf('\n')+1));return 'allowed-once';};
  const request={idempotency_key:'one',delivery:{mode:'submit',text}};
  const first=await f.run(request),second=await f.run(request);
  assert.equal(approved.initial_text_full,text);assert.equal(first.status,'completed');assert.equal(second.session_id,first.session_id);assert.equal(f.calls.execute,1);assert.equal(f.effects.asks,1);
  assert.equal((await f.run({...request,delivery:{mode:'submit',text:'different'}})).code,'idempotency_conflict');
});

test('lost reply leaves durable UNKNOWN; same key and status never retry',async()=>{
  const f=await setup();f.client.execute=async()=>{f.calls.execute++;return {ok:false,error:{code:'creation_unknown'}};};
  const input={idempotency_key:'unknown'};
  const result=await f.run(input);assert.equal(result.status,'unknown');assert.equal(result.recovery_required,true);assert.equal(result.effects.session.state,'unknown');
  const again=await f.run(input);assert.equal(again.status,'unknown');assert.equal(f.calls.execute,1);
  const status=await f.controller.execute({operation:'status',operation_id:result.operation_id},f.exec());assert.equal(status.status,'unknown');assert.equal(f.calls.execute,1);
});

test('foreign or malformed ACK cannot report successful target creation',async()=>{
  const f=await setup();f.client.execute=async()=>({ok:true,receipt:{status:'completed',profile:'companion',preset:'companion',session_id:'other',request_id:'other',effects:{}}});
  assert.equal((await f.run()).status,'unknown');assert.equal(f.effects.create,0);
});

test('unsupported new project is explicit and never requests approval or dispatch',async()=>{
  const f=await setup();assert.equal(f.controller.capabilities().new_project,false);
  const result=await f.run({target:{kind:'new_project',name:'NotCreated'}});
  assert.equal(result.code,'new_project_unavailable');assert.equal(result.effect,'none');
  assert.equal(f.effects.asks,0);assert.equal(f.calls.prepare,0);assert.equal(f.calls.execute,0);assert.equal(f.effects.project,0);
});

test('profile parser rejects root accessors without executing them',()=>{
  let accessed=false;
  assert.throws(()=>parseProfileArgs({get operation(){accessed=true;return 'create';}}));
  assert.equal(accessed,false);
});
