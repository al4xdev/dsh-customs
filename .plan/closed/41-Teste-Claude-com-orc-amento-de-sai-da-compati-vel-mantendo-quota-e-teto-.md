# Teste Claude com orçamento de saída compatível, mantendo quota e teto acumulado

## Goal/pedido
Reusar goal4132625b revisão5 ativo. Dono reafirmou que consumir cota de assinatura não é problema e quer resiliência/self-healing. Task36r1 limitou live8192tokens/90s; não ultrapassar silenciosamente esses limites. Este artifact autoriza exclusivamente diagnóstico live ajustado, não mudança de provider/conta/permissões/créditos/policy de produção.

## Evidência
9POSTs totais consumidos, metadata15/OAuth2, Claudequota69,24192% no último snapshot. Smoke7² sucesso. Código sintético falhou3x com4096 e3x com8192, sempre EMPTY_RESPONSE e uso exato do teto; retryoficial5/10s funcionou mas idêntica requisição não produziu conteúdo acionável. Isso sustenta testar hipótese de orçamento insuficiente para reasoning high; não prova backendcorreto nem causa definitiva. Nenhum429real observado. Histórico preservar original/V2/smoke/coding/coding-budget safeJSON.

## Alteração limitada
Uma nova fase no mesmo script guardado, modeloexato claude-opus-5-5-high, reasoninghigh, tarefas legítimas Python puras semtools/dados/prompt pessoais. MAXOUTPUT16384 e deadlineowned240s nesta fase apenas (SDKdefault600s; não alterarwatchdog300s). Esforço/tarefa/modelo/headers/rota/créditos continuamiguais para testar um knob por hipótese mais prazo correspondente; sourceproviderV3 congelada262tests22native/pubtypes. TotalPOST32inclusivehistorical9/retries/fallback, metadata40inclusive15, OAuth4inclusive2, activewall45min acumulado com fases anteriores e sem contar debugging/build semrequests. Uma chamada porvez, same-sessionfollowupcurto só após primeiro sucesso real confirma replay; todoscontam. Não expandir total32/wall/meta/OAuth sequota não esgotar. Outputguard inspect finalserialized payload MAX16k nesta fase, enabledCreditTypes[] sempre; allowlist URLs/no redirect/no paid/nonemptyopt-in.

Stop qualquer nova falha/primeiro429/quota0/permanent/cancel/orçamento. Pedido corrente pode ter no máximo2retriesoficiais5/10s, realhints cap20min/permanentfailfast; todosPOSTcontados. Falhasnãoforjadas porwrapper, status200+EMPTY não reporta429. Se16kaindaempty, encerrar teste ajustado com evidência, não ampliar de novo. Não repetir benchmark bloqueado96JSON/quota wording, nenhuma paráfrase de conteúdo rejeitado; é o mesmo benchmark de código legítimo cuja falha eraEMPTY nãoSAFETY.

## Ledger e deliverables
Novo output exclusivo live-coding-compatible-v3.json referencia live-coding-budget-v3.json e carrega counters/budgetsactivewall desde9calls, não reusar fase guardada/zerar orçamento. Captura só status/código/knownphase/nativeenum/usagecounts/quotaDTO/retryevents/counters; nunca raw bodies/COT/response text/headers/cause/token/project/account. Não fazeraccount/modelrotation, package install/restart/commit/push.

Principalexecuta processo novo com candidatoV3 e loop/retryoficial, não daemonprod, aguardaevidencejobcollectantesrelatório. Task36sourcepromo separado combackup/CAS; task39selfhealimplement/test independente sem ligar neste burn até seu própriogate. Não prometer recovery dequota se observar sófailfast nemLTS overnight; ausência429/depletion dentro32 éresultadohonesto.
