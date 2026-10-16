# APK12 — etapa conjunta de ativação e push real

## Estado entregue
Task101/preparação concluída: APK12 `0.12.0-goals`,42.329.922bytes, SHA256 `ab948dc43a78abbf92b8008fa75620334e4b3989c606bec1631ae883a27e84da`; package/cert/API34 preservados,190/190 Android em duas execuções,82 protocolo+422 JVM/1liveignorado,99 backend incluindo28 SDK/boot declarativo,lint0. Evidências `.dumps/tasks/task101-parent-evidence.md`. Telefone permanece APK11; sem cloud/login/FCM real ou ativação dos novos módulos.

## Decisão do dono antes de executar
Confirmar uma janela da instância Companion3081. Não foi possível provar ociosidade por endpoint nativo mínimo: session/control retorna projeções completas e session/list inclui cold metadata/projection hints; não alargar a leitura para outras conversas nem usar SIGTERM como probe. Com o dono presente, concluir/pausar o trabalho relevante e obter confirmação da janela, ou autorização explícita para uma parada controlada ciente de que dispose cancela agentes. Não reiniciar TUI/frontend/global.

## Execução futura somente após aprovação em tasks
1. Revalidar hashes/configuração/SDK e novo gate, backup privado e executor exclusivo. Baseline profile e850a4d8...123linhas/3910bytes; AGENTS2b11b5...29linhas/3953bytes. Candidato offline665f3f106e3dcd2174f263df767abf3864dac4ab3dedf10d927b5ed1965d96cb132linhas/4207bytes: somente TODO SDK4linhas+HOST ROOT5, PUSH AUSENTE. Não montar A/D diretamente no preset nem inventar keys/realms. FREEZE2 prova startup staging/AppReady/Loader.await+audit público/HMR fail-closed; fontes/hashes em task101-composition-freeze2-*.
2. Aplicar apenas na janela aprovada; verificar RPC real/native projection e controles com alvo próprio legitimamente autorizado. Prova SDK isolada não é prova3081. Não criar goal ativo via `/goal objective` e correr para pausar: isso pode despachar modelo. Sem nova fixture/API/route/modelhack; se não houver alvo legítimo, registrar o limite e combinar teste com o dono.
3. Fazer login juntos e escolher/criar projeto/app Firebase próprios do Companion, package dev.alex.dsh.companion, sem Analytics/Crashlytics/Firestore/Functions nem reuse Casa. Obter metadados Android públicos; arquivo local ignorado companion-push.local.properties. Esses dados são de build: reconstruir APK após configuração.
4. Sender próprio aprovado, privilégio mínimo firebasecloudmessaging.admin e arquivo0600 fora do repo, Android/server com mesmo configDigest. Revisar habilitação push separadamente, sem expor token/chave/cookie ou usar credenciais Casa/HA. Até lá push ausente/default disabled.
5. Somente com nova autorização instalar no telefone preservando package/cert/dados. Opt-in/POST_NOTIFICATIONS/registro nativo autenticado; testar conclusão fresca, entrega real em foreground/background/reinício, dedup, revogação e toque/backstack. HTTP aceito não significa exibido. Declarar FCM E2E apenas após essa prova.

## Guardas e itens fora desta janela
Preservar Settings/modelo openai-codex/gpt-6-sol/low, índice memory/openAt never, plugin99/mock, histórias e TUI. Fonte fria desconhecida não é idle. SDK não tem evento síncrono público para toda mutação trusted de preset fora do Loader; não permitir esse caminho com host ativo. Patch de help session compartilhado permanece offline; qualquer aplicação exige janela/avaliação TUI separada. Sem commit/push/HAdeploy ou grant implícito por este registro em para-o-dono.

Guia técnico: android/companion/NOTIFICATIONS.md. Este artefato registra o trabalho conjunto de amanhã, não autoriza executá-lo enquanto o dono está ausente.