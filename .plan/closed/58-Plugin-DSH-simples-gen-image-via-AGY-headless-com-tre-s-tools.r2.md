# Plugin DSH gen_image via CLI AGY

## Objetivo aprovado
Criar plugin novo `plugins/gen-image/`, separado do provider AGY, com exatamente `gen_image({tmp_path,description})`, `gen_image_list({id?})`, `gen_image_tail({id,lines?})`. Wrapper CLI oficial `agy --print`, model `gemini-3.8-flash-low`, output stream-json. Goal ativo guia execução; finalizar somente com evidências.

## Contrato e minimalismo
Gen lança assíncrono, devolve jobUUID/sessionDSH/paths/state; tmp_path estritamente relativo ao diretório privado `/tmp/dsh-gen-image-*`, PNG/JPEG/WebP, semfakeplaceholder/overwrite/escape/symlink. List/tail scoped à sessionreal, IDnãoPID, conversation_idAGY comoextra. Tailmax200linhas, logsbounded/sanitizados/dadosnãoconfiáveis. Somente3tools, nenhum multivendorSDK/providerimage novo. Arquivooriginal fica na tmp, sempreviewadicionalnoMVP.

Usar native Harness subprocess para argv literal/ambientescrubbed/rangeTERM-KILL e attachments.validateImage para validar arquivo. CLIstdout é event:init/step_update/result e SUCCESSresultado nãoequivale imagemexistente. Sucesso exige CLIexit0+terminalSUCCESS+regularimageexata/MIME/tamanho/full decode. Para softdeniedcommandexit0 semimage, statefailed. Gen sódangerfull nativo; não inventarconfinamentofull deagentexterno usando cwd/CLIterminalsandbox. Read-only/workspace-write nãoautorizados. `--sandbox`, semdangerouspermissionoverride, semalterar globalsettings/OAuth/billing, semcreditoptin/retryautomático/fallbackpago.

Job lifetime transferido ao plugin ao retornar gen, timeoutconfigdefault10min, hostconcurrency2, logs128KiB, boundedmetadata128jobs(terminalsmaisantigospodemevict), cadaarquivo<=20MiB. Jobs/logs emmemória, semresume apósrestart; deixararquivosparausuário/SOcleanup. Cancellationdurantelaunch/agentdisposed/pluginshutdown/policyrevocation terminamrange eawaitquiescence; não declararfinished antesdeprocessrangecleanup/validfile. Sem toolcancelnova.

## Arquivos e ativação
Runtime/index/tests/README emplugins/gen-image. Manifestactivation.json addalex-gen-image somente dsh-tui; npm focusedtestscript epluginsREADME targetededits. NãoeditarAGYrepo, rootforeignchanges oucommitar/push.

**Refinamento de ativação, revisão2:** dryrun `node tools/activate.mjs --profile dsh-tui --json` mostrou driftpreexistente: generator reintroduziria `alex-session-bridge` no hostglobal, enquanto profile atual já tem presetstandard separado. Exit1 foi investigado, não normalizado cegamente. Para preservar trabalho de task47/companion, NÃO executar fullmanagedblocks regeneration nesta task. Registrar manifest e inserir apenas alex-gen-image na profilepatchlocal viaediçãodirecionada, snapshotbackup+bytecomparison e verificaçãoYAML composition. Documentar driftpreexistente e não mudar placementdabridge/standardplugins. Overlayrepoopcional seguefora da ativaçãoespecífica; não reemitir para contornardrift. Futuregeneratorfix é tarefaindependente. Isso substitui o método broadactivateplanejado emr1, sem alterar entrega funcional.

## Gates
Unit/runtimefakeCLI:argvmodel/pathownership/limits/logs/protocolevents/missinginvalidimage/exiterror/signal/timeout/dispose/cancellation/policyrevocation/symlinkescape. Native realCordis tools+Agents/Sessions+subprocess-local+attachment-local fakeexecutable, schemas exatamente3 tools, output canonicalvalidation, sessionownership, startreturnsbeforeexit and callerabortaftertransferignored. Nãoinstalar deps.

Uma smoke limited UMA imagemPNGsimples comCLIoficialcachedaccount, timeout<=10min, sembillingoptin oupermissionoverride éautorizada para comprovação; não repetir automaticamente apósfailure. Gerar somente jobtmp, logs/resultreceipt em .dumps localgitignored; não usar rawcloudcodeendpoint/fingerprintspoof. Se acesso/tool/CLIpermitirem não produzirarquivo, reportar claramente falhalive separadosdosgates fakeCLI, sem alegargeracaofuncional.

## Bases verificadas
Local `agy --help` ELFconfirmado, models listagemmetadataexit0 Gemini3.8Flashlow/medium/high. Docs https://antigravity.google/docs/cli/headless.md, https://antigravity.google/docs/permissions.md, https://antigravity.google/docs/sandbox.md. CLIflags reais têmprecedência(defaultlocalprinttimeout0 mas wrapperdefine10min). Não reiniciar TUI automaticamentenemexpor credenciais.