import { parseArgs, requestSchema, parameters as legacyParameters, freeze, fail } from './contracts.mjs';
export const DESTINATION_PROFILE='dsh-tui';
export const DESTINATION_PRESET='standard';
export function parseProfileArgs(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('invalid_request');
  for(const key of Reflect.ownKeys(input)) {
    const descriptor=Object.getOwnPropertyDescriptor(input,key);
    if(typeof key!=='string'||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)fail('unknown_field');
  }
  if(input.operation!=='create')return parseArgs(input);
  const request=input.request;
  if(!request||typeof request!=='object'||Array.isArray(request)||![Object.prototype,null].includes(Object.getPrototypeOf(request)))fail('invalid_request');
  for(const key of Reflect.ownKeys(request)) {
    const descriptor=Object.getOwnPropertyDescriptor(request,key);
    if(typeof key!=='string'||!Object.hasOwn(descriptor,'value')||!descriptor.enumerable)fail('unknown_field');
  }
  const {profile,preset,host_id,...rest}=request;
  if(profile!==undefined&&profile!==DESTINATION_PROFILE)fail('profile_unavailable');
  if(preset!==undefined&&preset!==DESTINATION_PRESET)fail('preset_unavailable','Destination preset is standard in the dsh-tui host, not companion');
  if(host_id!==undefined&&(typeof host_id!=='string'||!/^[a-f0-9-]{36}$/i.test(host_id)))fail('invalid_host_id');
  const parsed=parseArgs({...input,request:{...rest,preset:'companion'}});
  return freeze({...parsed,request:{...parsed.request,profile:DESTINATION_PROFILE,preset:DESTINATION_PRESET,...(host_id===undefined?{}:{host_id})}});
}
const destinationRequest=structuredClone(requestSchema);
destinationRequest.properties.preset={type:'string',const:DESTINATION_PRESET};
destinationRequest.properties.profile={type:'string',const:DESTINATION_PROFILE,description:'Real destination profile; never silently replaced by Companion.'};
destinationRequest.properties.host_id={type:'string',description:'Exact compatible host ID from capabilities; mandatory if multiple dsh-tui hosts are available.'};
destinationRequest.properties.target.description='Current workspace or existing approved project. new_project is retained for explicit compatibility errors but currently unavailable: no proven exclusive destination registry creation.';
destinationRequest.properties.model.description='Optional assertion of the destination host default route, not the calling Companion model. No global defaults are changed.';
for(const field of Object.values(destinationRequest.properties.model.properties))field.description='Must match the prepared destination host effective selection.';
export const profileParameters={...legacyParameters,properties:{...legacyParameters.properties,request:destinationRequest}};
