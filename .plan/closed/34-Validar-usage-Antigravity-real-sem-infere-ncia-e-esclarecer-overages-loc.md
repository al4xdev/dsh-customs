# Validar usage Antigravity real sem inferência e esclarecer overages locais

## Pedido e limite de autorização
Usuário autorizou consumir quota Claude/Opus para testar saldo vazio e confirmou Never, depois esclareceu que configuração Overages é LOCAL ao cliente, não kill-switch de conta. A autorização vale quota; não autoriza AIcredits pagos ou bypass. Usoquota task33 aprovado segue independente. Investigar mecanismo no fork e documentação pública; comparar Claude/Gemini via subagente offline. **Não realizar inference/esgotamento enquanto não houver prova baseline-only ou nova decisão explícita do dono sobre risco financeiro.**

## Execução autorizada aqui
Após serviço/task33 candidato verde, realizar uma validação read-only de metadata usage contra conta atual Antigravity através do credential provider/manager oficial existente, em processo isolado sem alterar perfil ou reiniciar agentes. Consultar apenas fetchAvailableModels, não streamGenerateContent/search/login/onboarding/overage/prompt. Até duas consultas metadata (cache/force ou verificação dupla), timeout10s/callerlifetime bounded, resposta limitada. Manager pode renovar/persistir token via fluxo oficial se expirado; sem ler valores com readtool ou imprimir/gravar tokens/projectId/clientsecret/email/rawbody/headers. Armazenar somente DTO allowlisted produzido parserusage em .dumps, com frações/reset/source/idade/status/windowunknown. Comando/policy startup sem chamadas paid; garantir hostinit credentialbackend não reconfigura contas/perfis e log silencioso. Se acesso ao credential service não puder ser feito sem boot mutável ou não houver credential, registrar limitação e entregar comando para usuário invocar; não inventar quota nem reautorizar login.

## Safety Overages
Revisar docs oficiais Google CLI/plans e forkrequestbody. Fonte comunitária indica root enabledCreditTypes:[GOOGLE_ONE_AI] como opt-in; isso não é contrato oficial garantido. Registrar que fork atual não solicita esse campo e que Never de IDE/CLI não prova que terceiro provider herdou regra. Nenhuma mudança em inferencepayload/billing/config de créditos aqui; requer task separada revisada se implementarbaseline-only.

## Teste de quota vazia
Se metadata real já mostrar remainingFraction0 para Claude, registrar evidência sem consumir quota extra e sem inferir janela5h. Se saldo positivo ou schemaunknown, não esgotar automaticamente por riscooverage: registrar que pedido de liveburn está condicionado à clarificaçãobaseline-only/aceitação explícita do risco, além de budget/deadline finitos numa revisão posterior. Não alternar conta/modelo/endpoint para contornar limitações. Gemini é comparador metadata e fixtures, não alvo de esgotamento.

## Comparação provider/modelo
Delegação offline read-only encontra diferenças de requests/tool schema/signatures/stop/errors entre Claude e Gemini no mesmo provider. Reportar sharedpolicy vs wirecontracts distintos, matriz e falhaspré-existentes reais. Não modificar inference/resiliência durante usage task33 nem alegar certificação provider geral a partir de um modelo.

## Aceite
Relatórios billing/modelcomparison entregues, uso real metadata com DTO sanitizado ou limitação explícita, sem inferência/quota burn/credits/rotação/restarts. Registrar cenárioquotaempty observado só se real; mocks continuam separados. Incluir próximos passos: usagefresh confirmedzero do bucketcorreto e resetconfiável podem orientar espera futura; 429 isolado/unknown/stale não.