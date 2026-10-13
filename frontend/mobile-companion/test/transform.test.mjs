import test from 'node:test';
import assert from 'node:assert/strict';
import { composeMobileGraph, readBootGraph } from '../server/transform-html.mjs';
const p = name => `@deepseek-ai/${name}`;
const required = ['dsh-client-modules','dsh-client-ui-layout','dsh-client-ui-chat','dsh-client-ui-conversation','dsh-client-ui-approval','dsh-client-ui-user-questions','dsh-client-ui-tool','dsh-client-ui-jobs','dsh-client-ui-attachment'];
const manifest = { workspace: { id: p('dsh-client-ui-workspace'),url:'/mobile-assets/workspace.js',rev:'replacement',inject:[p('dsh-api-workspace-controller')] }, mobile: { id:'@alex/mobile-companion',url:'/mobile-assets/mobile.js',rev:'mobile' } };
const graph = {rev:'original',entries:[...required.map(name=>({id:p(name),url:'/plugins/'+name,rev:'native',inject:name==='dsh-client-ui-conversation'?[p('dsh-client-ui-workspace')]:[]})),{id:p('dsh-client-ui-workspace'),url:'/plugins/unsafe-workspace',rev:'old',inject:[p('dsh-client-ui-sidebar')]},{id:p('dsh-api-workspace-controller'),url:'/plugins/workspaces',rev:'api'},{id:p('dsh-client-ui-sidebar'),url:'/plugins/sidebar',rev:'sidebar'},{id:p('dsh-client-ui-model-selection'),url:'/plugins/model',rev:'model'}],batches:[]};

test('real globalThis bracket boot and legacy window dot syntax parse without eval',()=>{
 for(const assignment of ['globalThis["__DSH_BOOT__"]','window.__DSH_BOOT__']) assert.deepEqual(readBootGraph(`<script>${assignment} = ${JSON.stringify(graph)};</script>`),graph);
 assert.throws(()=>readBootGraph('<html>login</html>'),/bootstrap/);
});
test('mobile closure replaces workspace before traversing dependencies and excludes desktop selectors',()=>{
 const mobile=composeMobileGraph(graph,manifest);
 assert.deepEqual(mobile.entries.find(row=>row.id===manifest.workspace.id),manifest.workspace);
 assert.ok(!mobile.entries.some(row=>row.id===p('dsh-client-ui-sidebar')));
 assert.ok(!mobile.entries.some(row=>row.id===p('dsh-client-ui-model-selection')));
 assert.ok(mobile.entries.some(row=>row.id===p('dsh-client-ui-approval')));
 assert.ok(mobile.entries.some(row=>row.id===p('dsh-client-ui-user-questions')));
 assert.ok(mobile.entries.some(row=>row.id===manifest.mobile.id));
 assert.equal(graph.entries.find(row=>row.id===manifest.workspace.id).rev,'old');
});
