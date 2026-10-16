import { discoverBridges } from '../session/bridge-client.mjs';
import { exchange } from '../session/bridge-transport.mjs';
import { readKey } from '../session/bridge-security.mjs';
import { signCreateGrant } from './profile-protocol.mjs';

export async function discoverProfileHosts({root,signal}={}) {
  const discovery=await discoverBridges({...(root?{root}:{}),signal});
  signal?.throwIfAborted();
  const records=(discovery.bridges??[]).filter(record=>record.capabilities?.createProfile?.available===true&&record.capabilities.createProfile.version===1&&record.capabilities.createProfile.profile==='dsh-tui'&&record.capabilities.createProfile.preset==='standard');
  return {records,hosts:records.map(record=>({host_id:record.bridgeId,profile:'dsh-tui',preset:'standard',new_project:false,sessions:(record.agents??[]).map(agent=>({session_id:agent.sessionId,cwd:agent.cwd}))})),unavailable_bridges:(discovery.bridges?.length??0)-records.length,discovery_errors:(discovery.errors??[]).length};
}
export async function prepareProfileCreate(record,proposal,signal) {
  return exchange(record,{operation:'prepare-create',proposal},signal,{timeoutMs:30000});
}
/** Only the native owner controller calls this after allowed-once approval and revalidation. */
export async function executeProfileCreate(record,preparation,signal) {
  signal?.throwIfAborted();
  const key=await readKey(record.root);
  const grant=signCreateGrant(preparation,record,key);
  signal?.throwIfAborted();
  return exchange(record,{operation:'create-session',preparationId:preparation.id,preparationHash:preparation.hash,grant},signal,{timeoutMs:30000});
}
export const profileClient={discover:discoverProfileHosts,prepare:prepareProfileCreate,execute:executeProfileCreate};
