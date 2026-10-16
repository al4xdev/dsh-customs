# Antigravity: retry no reset reportado pelo usage até 24 horas

## Pedido e goal
Goal goal-ca9a9885: recuperar automaticamente requests Antigravity no reset exato reportado por usage, aguardando no máximo24h; acima disso mostrar data e encerrar. Não inferir janela nem garantir quota recuperada. R1 investigou API; r2 autorizou forklocal mínimo do executor oficial, com provider bridge e policybudget estáveis. Esta r3 conserva o mesmo escopo e corrige apenas wiring conforme prova do parser real.

## Correção de wiring observada antes da publicação
applyEntryPatches trata `name` como guard de identidade, não troca de módulo; o gate offline rejeitou proposta r2. Nenhuma mudança live foi aplicada. Portanto desativar id nativo `llm-retry` e inserir entrada profile-local id `antigravity-quota-retry` com módulo absoluto plugins/antigravity-quota-retry/index.mjs. Id sem prefixo alex evita ferramentas de activation removerem entrada manual. Exatamente um engine ativo, mesma projection llmRetry e mesmo protocolo/eventos oficiais. Parser/composegate verifica id original disabled, local único e configurações preservadas. Preparação anterior permanece evidência abandonada, usar backup/receipt novo para wiring corrigido.

## Contrato e provider
Opt-in quotaResetRetry enabled/maxWaitMs<=86400000, defaultdisabled; habilitar dsh-tui apenas. Após falha tipada RATE_LIMIT/QUOTA_EXCEEDED consultar usage.snapshot(refresh:true,signal), id nativo exato do request/prepared snapshot. Metadata fresca válida e generation inalterada; fraction ausente é desconhecida, nunca0%. Reset futuro reportado = previsão, não garantia.

Alvo é o mais tardio entre reset e mínimo Retry-After/RetryInfo ancorado na observação da falha. <=24h elegível; >24h data/limite e fail-fast. Não antecipar hint, inventar reset, equivaler modelos ou polling. Sem metadata/reset elegível preservar rate-limit transient retry20min; quota explícita semreset terminal. Auth/billing/policy/aborted/timeout/unknown não entram nessa recuperação.

Bridge request-local/ALS, stream e prepared.stream, modelo congelado, canceled/disposed/epochinvalidated failclosed; usage serviço existente deadline10s/cache/singleflight, sem leitura de secret emdiagnósticos. Não dormir/reenviar dentro adapter. Falha elegível emitida como ANTIGRAVITY_QUOTA_RESET; acima cap ANTIGRAVITY_QUOTA_RESET_LIMIT com datasISO/status/hint safe. Política normal9 registra gatecode uma vez; identidade e contador únicos entrequota/transient. Current selfhealallowlist não recupera novos códigos/status429.

## Executor local e config
plugins/antigravity-quota-retry/index.mjs derivado do oficial instalado comhash/proveniência; imports hostcanonical. Mesma projection/schema/version/policyKey/retryId/budget/events/normal/always/downstream/cancel/dispose. Única extensão: google-antigravity +normal+gatecodepermitido+hintpositivo até maxQuotaWaitMs default24h utiliza capquota separado, sem mudar maxDelayMs20min/policyKey. Gate inválido/acimacap não vira localdelay. Outrosproviders/modealways comportam-se comooriginal. Um timerengine apenas. llm/retry persistido anteswait, llm/retry-started no wake.

Configperfil: original llm-retrydisabled +localidinsert; AntigravityquotaResetRetryenabled24h. Codex9/search/model/selfheal intactos. Sem SDK/node_modules/hostcontract changes, installs, resets de budgets, model/account/route/creditrotation, inferencequotaburn, auto-restarts ou coldresume. Processo/sessão devem permanecer vivos para a espera.

## Gates obrigatórios
Provider puretests reset minutos/horas/exato24h/>24h/passado/ausente/inválido/NaNobserved; fresh/modelmatch/fractionmissing/hintlater/clock. Bridge cancel/lifecycle/epoch/preparedsnapshot/concurrency/secrets. Engine diferencial contraoficial para unaffectedcases ebudgetquota↔transient9, gate/config/max24h/cancel/dispose. Full nativeLoop+Sessions+Projections+Tools+candidatefakeHTTP/fakeclock:429/structuredquota→freshusage→wait→CLIENTdispatch1+sucesso, zeroefeitos failed, exact24h, hintmaislong, >24h semtimer, missingresetfallback5s/permanentquota, ninthtransient20min,mixed9budget,cancel/dispose. SemallegarrecoverGoogletrue.

Standalone source regressions, strictTS/declarations/publicconsumer (skipLibCheck reviewed), frozenesbuildcandidate em.dumps, rootcontracts76/grammar, nativeactualprofile applyEntryPatches econfigschema. Compiler/sourcehashes preserved, generatedlibnãohandedited. DocsEN/ZH deixam comandosmetadata-only e featureopt-in explícitos. Não tocarpublicação paralela task52.

## Promoção e consulta real
Apósgates: somente lib/index.js, declarationsafetadas index/usage/failurebridge/newquotaretry, YAMLperfil; backupdurávelnovo ~/.local/share/dsh-customs-backups, before/new snapshots, source/CASpreflight, renameatômico porarquivo+fsync e receiptpartial/verified. RollbackCASrecusa edits posteriores; newfilesnative trash apóshash. Não prometer atomicidademultifile. Semcommit/push/restart. NovoTUInecessário.

Até3 consultasmetadata-only explícitas usando manageroficial para resetatual, stop429/auth/deadline; OAuthrefreshnormal podepersistirtoken; saídadata/model/fractionsafe. Nenhum inferencelive. Járealizada1consulta semOAuth/inference: Claude reset2026-10-17T23:13:12Z(fractionunknown), >24h; GeminiFlashLowreset2026-10-14T01:09:46Z/fraction~98.25%. Não repetir àtoa.

## Aceite
Request comreseteligível espera e retenta pelo fork mínimo oficial no loop, shared9budget/transient20min; >24h mostra data e encerra. Provider341tests, engine17, native18 e root76+grammar previamenteverdes; regates finalwiringcorrigido, compiledhashes/publicAPI/promoção devem ser coletados antesfechar. Limitesprocessalive/previsãoprovider/recoverrealnãoobservado documentados.