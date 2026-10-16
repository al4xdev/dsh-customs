import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { apis, prefixes, suffixes, sha } from './generalized-failure-categories.mjs';
const here=dirname(fileURLToPath(import.meta.url));
/** Offline SDK gate, not real adapter/controller acceptance or promotion authorization. */
export async function checkGeneralizedFailureCandidate(manifestPath, reportPath) {
  manifestPath=resolve(manifestPath);reportPath=resolve(reportPath);
  const bytes=await readFile(manifestPath),manifest=JSON.parse(bytes),output=dirname(manifestPath);
  assert.equal(manifest.kind,'generalized-failure-categories-candidate');assert.equal(manifest.promoted,false);
  assert.equal(manifest.candidate,join(output,'package'));
  assert.deepEqual(manifest.apis,apis);
  assert.deepEqual(manifest.generated.map(f=>f.path).sort(),prefixes.flatMap(p=>suffixes.map(s=>p+s)).sort());
  assert.equal(manifest.sourceDigest,sha(JSON.stringify(manifest.sourceFiles.map(({path,beforeSha256,afterSha256})=>({path,beforeSha256,afterSha256})).sort((a,b)=>a.path.localeCompare(b.path)))));
  async function protection() {
    for(const file of manifest.sourceFiles)assert.equal(sha(await readFile(join(output,'source/packages/ai',file.path))),file.afterSha256);
    for(const file of manifest.generated){assert.equal(sha(await readFile(join(manifest.candidate,file.path))),file.afterSha256);assert.equal(sha(await readFile(join(output,'source/packages/ai',file.path))),file.afterSha256);assert.equal(sha(await readFile(join(manifest.installedRoot,file.path))),file.beforeSha256);}
    for(const file of manifest.protectedFiles){assert.equal(sha(await readFile(join(manifest.candidate,file.path))),file.sha256);assert.equal(sha(await readFile(join(manifest.installedRoot,file.path))),file.sha256);}
  }
  await protection();
  const testPath=join(here,'generalized-failure-categories.test.mjs');
  const result=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd:resolve(here,'../..'),env:{...process.env,GENERALIZED_FAILURE_CANDIDATE:manifest.candidate},encoding:'utf8',maxBuffer:16*1024*1024});
  const log=(result.stdout??'')+(result.stderr??'');
  const logPath=reportPath+'.tap';await writeFile(logPath,log,{flag:'wx'});
  assert.equal(result.status,0,`SDK fixtures failed; inspect ${logPath}`);
  const count=key=>Number(log.match(new RegExp(`^# ${key} (\\d+)$`,'m'))?.[1]??NaN);
  assert(count('tests')>300);assert.equal(count('fail'),0);assert.equal(count('pass'),count('tests'));
  const require=createRequire(join(manifest.dependencyRoot,'package.json'));
  const {build}=require('esbuild');
  const browser=join(output,'browser');await mkdir(browser,{recursive:true});
  const helperPath=join(manifest.candidate,'dist/utils/provider-failure.js'),helper=await readFile(helperPath,'utf8');
  assert(!helper.includes('node:')&&!helper.includes('AsyncLocalStorage')&&!helper.includes('require('));
  await build({entryPoints:[helperPath],outfile:join(browser,'provider-failure.js'),bundle:true,platform:'browser',format:'esm',target:'es2022',logLevel:'silent'});
  await protection();
  const report={schema:1,kind:'generalized-failure-sdk-offline-gate',manifestSha256:sha(bytes),candidate:manifest.candidate,sourceDigest:manifest.sourceDigest,passed:true,exitCode:0,offline:true,liveCalls:0,tests:{total:count('tests'),pass:count('pass'),fail:0},apis,generated:manifest.generated.length,changed:manifest.generated.filter(f=>f.changed).length,protectedFiles:manifest.protectedFiles.length,installedUnchanged:true,browserBundle:true,
    hashes:{manifest:sha(bytes),tests:sha(await readFile(testPath)),recipe:sha(await readFile(join(here,'generalized-failure-categories.mjs'))),check:sha(await readFile(fileURLToPath(import.meta.url))),capabilities:sha(await readFile(join(here,'generalized-failure-capabilities.json'))),baseline:sha(await readFile(join(here,'generalized-failure-baseline.json'))),helperSource:sha(await readFile(join(here,'provider-failure.ts'))),log:sha(log),browser:sha(await readFile(join(browser,'provider-failure.js')))},
    qualifications:['SDK evidence only; parent must prove real adapter+controller candidate graph and full gates','Google ApiError hides named quota/body and response headers: status only, no invented quota/id/hint','pi-messages wire terminal error has display text only; unknown stays unknown; explicit cancellation retained','Existing Task38 prepromotion verifier is intentionally stale after its already-completed rollout; pins unchanged']};
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert.equal(process.argv.length,4,'Usage: node generalized-failure-check.mjs manifestPath reportPath');console.log(JSON.stringify(await checkGeneralizedFailureCandidate(process.argv[2],process.argv[3]),null,2));}
