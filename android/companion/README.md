# Companion — Android 14

Cliente Kotlin/Jetpack Compose/Material3, sem WebView ou React. O DSH continua no
PC para observar as sessões desse PC. Aplicação independente de CasaTequila.

## APK14 — contexto opcional corrigido no telefone (task109)

`0.14.0-context-fix` (versionCode14), **instalado e validado no telefone real**
ZY22F2395W/user0 após autorização de depuração. Update-r preservou UID10318,
CEinode899458, firstInstallTime e permissões. APK local
`.dumps/tasks/dsh-companion-0.14.0-context-fix.apk`,42047426bytes,
SHA256 `1a0cd2daca1d32bf794a0bafacb7de75ef4886228480cec4c5356741265039bd`.

- Corrige a lacuna real do13: `agent-instructions`, catálogos/invocações de skills,
  clock/tmux agora acompanham a opção, além dos três produtores já reconhecidos.
  Classificação por formatos/metadados públicos comprovados do SDK, não por XML
  no texto. Baseline+delta AGENTS com vários blocos TEXT também coberto.
- Humanos com rpcId/timezone, ferramentas, anexos, avisos, relay/recall e fontes
  desconhecidas continuam visíveis. Hooks sem discriminador público entre contexto
  inicial e bloqueio de segurança **não** são ocultados cegamente. Goal round
  automático positivo segue oculto inclusive em debugON; input do modelo intacto.
- Prova física **OFF→ON→OFF** na mesma conversa original identificada por metadados
  exatos: desligado mostra humano+resposta; ligado mostra instruções e runtime;
  desligado novamente remove. Telefone deixado nessa conversa, opção OFF. Nenhuma
  mensagem, prompt ou controle de goal enviado; perfil de trabalho intocado.
- Regressão: protocolo88PASS; app468PASS+1live-opt-inignorado; lint0; suiteAndroid
  **198/198PASS em duas execuções**. Capturas reais/recibo e limites em
  `.dumps/tasks/task109-final-evidence.md`. Pausar/Continuar real da Task104 ainda
  não foi exercitado por este debug; não confundir com prova do contexto.

### Continuação sem celular (task110)

O dono retomou o aparelho e pediu testes sem ele: validação física de Pausar/Continuar
**adiada, não PASS**. Novas suites:649PASS+1live-opt-inignorado, incluindo quatro casos
SDK isolados com admissão HUMAN genuína (10controles positivos/12recusas), sem driver
de continuação ou provedor externo. Não são controle de goal da produção nem UI física.

Diagnosticada retirada intencional da API após alteração Loader em quente. Um restart
controlado recuperou o catálogo NativeGoals real na3081 (PID901294, frontend841
preservado), sem alterar código/profile/LOW ou os novos plugins legítimos;82hashes
pré/PID0/pós idênticos. Sem novo APK ou acesso ao celular. Evidências e limites:
`.dumps/tasks/task110-final-evidence.md`. A proteção fail-closed continua preservada.

### Prova física posterior de Pausar/Continuar (task111)

Após nova autorização **celular contedo todo seu vou tomar um banho**, os dois botões
nativos foram comprovados no telefone real/instância real, usando goal de teste
**já existente** da conversa9b0165b1: **r2PAUSED/DISARMED140 → r3ACTIVE/ARMED →
r4PAUSED/DISARMED145**, cap256. Um toque Continuar e um Pausar, sem confirmação
incerta/erro de controle; não se criou goal ou enviou texto. Houve cinco novas
rodadas iniciadas, não alegação de cinco respostas bem-sucedidas ou zero modelo.

Segunda observação no app e duas leituras independentes do backend confirmaram
**PAUSED/DISARMED145**, responding=false/goalRunning=false. Telefone deixado pausado,
forward temporário de inspeção removido; sem instalação/config/restart. Prova e
capturas reais em `.dumps/tasks/task111-final-evidence.md`. O adiamento110 acima é
histórico, não a situação posterior à111. Contexto109 permanece prova separada.

## APK13 — correções de goal e contexto opcional (tasks104/106)

`0.13.0-goal-fixes` (versionCode13), testado no emulador API34 e **instalado no
telefone na Task108**, após autorização fresca **Sim, só instalar**. Update-r/user0
Success no ZY22F2395W, UID10318/CEinode899458/firstInstallTime preservados; app não
aberto nem tocado na instalação. POST_NOTIFICATIONS já concedida e assim ficou;
PackageManager normalizou flags USER_SENSITIVE, sem grant/revoke do agente.
Recibo `.dumps/tasks/task108-install-receipt.json` e metadata before/after.

**Regressão real corrigida no APK14/Task109 acima:** dono abriu o app e mostrou contexto
`agent-instructions`/AGENTS.md apesar de debugOFF. Captura ADB física autorizada
`.dumps/tasks/apk13-phone-debug-off-20261015.png` comprova lacuna da whitelist13;
os testes sintéticos abaixo não cobriam todos os produtores SDK. Depuração física
posteriormente autorizada pelo dono; não confundir com o escopo só-instalar108.

- A confirmação nativa acompanha um sufixo completo do journal sem descartar a
  leitura só porque chegou output irrelevante. Mudança de goal/rodada, gap ou
  autoridade incompatível continuam retirando o permit; ref/CAS/generation intactos.
- Continuações automáticas `source.kind=goal`, round positivo e formato canônico
  não aparecem como mensagens. Texto humano/assistant citado, anexos e metadata
  incompleta não são filtrados por substring. Journal/follow/paginação intactos.
- Não há Atualizar no painel saudável; recuperação **Tentar novamente** aparece
  somente em erro/incerteza/indisponibilidade e faz leitura, não repete controle.
- Nova conversa é um rascunho RAM sem SID, sessão remota ou admissão fictícios.
  Abrir/voltar não persiste entrada. O primeiro Enviar humano cria uma sessão real,
  verifica ownership e espera streams prontos antes do pipeline normal de envio.
  Falhas incertas não repetem POST. Create+prompt não são atômicos: depois de Enviar,
  uma falha pode deixar a sessão criada sem mensagem; ela não é apagada por palpite.
- Configurações → Depuração → **Mostrar contexto do modelo**, local e persistente,
  **desligado por padrão**. Alternar reprojeta sem novo evento nem alterar input ou
  Settings do SDK. Contexto reconhecido system/runtime/tool-registry é opcional;
  avisos de segurança, conteúdo desconhecido/misto e mensagens humanas permanecem.
  **Rodadas internas de goal continuam ocultas mesmo com depuração ligada.**

Backend Companion ativo na3081, host/TODO reais ativos e push ausente. Corrigido o
self-wait de startup `acquireScope → diagnóstico → Loader.await`: a primeira lease
é adiada até commit público, sem enfraquecer as fences HMR. Somente Companion foi
reiniciado, como expressamente autorizado; frontend841, Fonte99, SDK e modelo/LOW
preservados. Perfil recebe apenas TODO no preset e host como sibling ROOT.

Validação: **88 protocolo +460 JVM app PASS**, um live opt-in ignorado; lint zero
issues; **198 testes Android PASS nas duas últimas execuções completas**, além de
comparações visuais off/on/off e rascunho local. Uma repetição anterior revelou
lookup sem aguardar montagem Markdown no teste legado de copiar; o harness agora
aguarda readiness e encerramento do menu nativo, sem repetir gestos. **87 testes
canônicos backend PASS**, incluindo14 host+2 regressões full-preset SDK; a matriz
offline adicional de30 tem sobreposição e não deve ser somada aos87.
API real: catálogo/leitura, recusa de controle obsoleto e restauração cold por follow
da própria fixture vazia. Também lido o goal COMPLETEr7 da própria sessão Task99:
ref nativa positiva, disarmed, TODO null e permit ausente corretos; sem novos modelos
ou mutações de goal. HUMAN pause positivo no SDK isolado
é evidência separada: **pausa/retomada positiva na conversa física não foi validada**.
O alvo real do print não tem SID conhecido; não foram lidos corpos de outras conversas
nem criado goal ativo para tentar pausá-lo antes de uma rodada.
FCM/Firebase reais continuam não configurados, sem token/init/network no startup.

APK `.dumps/tasks/dsh-companion-0.13.0-goal-fixes.apk`,42.350.750bytes, SHA256
`6b33efd6b05b2275db87b96f36d1d93d291200fb3a1b7c31945db291f01e1538`.
Mesmo package `dev.alex.dsh.companion`, min/targetAPI34 e certificadoSHA256
`1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d`.
Logs: `.dumps/tasks/task106-gradle-r2.log`, `task106-native-full-r3.log`,
`task106-native-full-r4.log`, `task104-backend-canonical-all.log`. Recibo e capturas
em `.dumps/tasks/task104-106-final-evidence.md`; backend `task104-support-final.md`,
`task104-backend-final.md` e `task104-own-complete-goal-read.json`.
Não houve instalação/gesto/grant no aparelho físico.

## Histórico físico — APK12, goals, atividade e notificações

Estado registrado nas tasks101/103, anterior à ativação/correções104 acima.

`0.12.0-goals` (versionCode12), **instalado com autorização fresca do dono na task103**.
Atualização `install -r --user 0` Success: UID10318, inode CE899458 e firstInstallTime
originais preservados; app não aberto, sem captura/gesto/grant explícito.
Receipt: `.dumps/tasks/task103-install-receipt.json`. Backend/push continuam pendentes.
Ícone de goal14dp, alvo48dp acima de Enviar, abre um painel dentro do mesmo
compositor flutuante sem aumentar sua altura recolhida. Um goal nativo atual,
TODO independente, objetivo expansível e Pausar/Continuar humanos com observação
exata/ref/CAS; sem comandos de texto simulando controles ou shadow scheduler.
Trocar a observação cancela o gesto antigo; repetir o toque não repete a ação.
O catálogo tem indicadores distintos15dp de goal ativo/armado e agente respondendo,
entrada suave e pulso discreto, sem relógio em reduced-motion. Fonte fria/desconhecida
não vira falsa inatividade nem herda o estado de outra conversa.

Android recebe conclusão nativa verificada e FCM data-only estrito; opt-in explícito,
permissão, catálogo/ownership, receipt≤24h, geração persistida, dedup durável e toque
validado. Alertas são genéricos e usam `VISIBILITY_SECRET`; o override do canal é
controlado pelo Android/usuário. Firebase não inicializa nem pede token no startup.
**FCM real não configurado/testado**: login e projeto próprios do Companion amanhã;
nada do Casa de Tequila foi reutilizado. Guia: [NOTIFICATIONS.md](NOTIFICATIONS.md).

Build central com Firebase Messaging24.1.0: **82 protocolo +422 JVM app aprovados**,
1 teste live opt-in ignorado; lint sem issues. Offline: startup9/icon4/maid7 aprovados.
**190/190 Android em duas execuções completas** no emulador privado API34 e quatro
capturas de fixtures inspecionadas; compositor expandido também capturado da janela
Android para confirmar rascunho visível. **99/99 backend**, incluindo28 testes de
composição SDK real/boot declarativo, cancelamento, falha inicial e HMR fail-closed.
APK `.dumps/tasks/dsh-companion-0.12.0-goals.apk`,42.329.922bytes, SHA256
`ab948dc43a78abbf92b8008fa75620334e4b3989c606bec1631ae883a27e84da`,
mesmo package/certificado/API34 do11. Evidência: `.dumps/tasks/task101-parent-evidence.md`.
Os novos módulos backend foram exercitados com SDK público real isolado, mas o
profile ativo não foi alterado: falta janela segura para ativação. O gap de boot
declarativo foi corrigido com staging/commit público auditado. Não parar agentes
supondo ociosidade nem ler projeções privadas
de outras conversas para tentar comprová-la. Push permanece ausente da configuração.

Atritos da única conversa autorizada, UUID sufixo `e6d547cb`: instruções específicas
do workspace Companion acrescentadas mantendo2637bytes originais. Distinguem ferramenta
existente de canal `send:false`, ACK de pausa, limites de cwd e evidência parcial/cursor.
Help compartilhado session/TUI permanece apenas em proposta offline por risco HMR.

## Histórico físico — APK11, atualizado para12 na task103

**APK11 instalado com autorização do dono:0.11.0-polish (versionCode11), user0/UID10318.**
Compositor reaproveita a antiga fila inferior como viewport editável, sem aumentar o
orçamento de altura e mantendo enviar/parar48dp, texto literal e edição nativa.
Gesto lateral inicia até45% da largura, respeitando IME/seleção/mídia/código/tabelas.
Follow-bottom acompanha resize do teclado no próprio remeasure, nos dois sentidos;
leitura manual não é arrastada. Refresh preserva títulos nativos só com id+createdAt
coerentes; catálogo mantém membership/ordem/timestamps do servidor e fallback não vira título.
Subtítulo literal `i use arch btw`. Maid alterna22 animações/267 frames originais em
ciclos completos aleatórios sem repetir o anterior, sem falso estado sucesso/erro.
Os32 assets legados e o ícone permanecem byte-idênticos; playlist adicional em diretório
irmão, decode lazy serial fora da UI e LRU≤24frames/2MiB, sem preload267.
Build estrito:67 protocolo+393 JVM app aprovados/1liveoptin ignorado, lint sem issues;
icon4/startup9/maid7 offline aprovados e **170/170 Android** no emulador privado API34.
Quatro capturas sintéticas inspecionadas: documento/tabela, catálogo, longpress e seis linhas.
Proteção do slot retirado de Parar impede o segundo toque de atingir o editor ou outra resposta;
não adiciona altura nem mantém uma ação fantasma. Teste cobre conclusão imediata.
Artefato `.dumps/tasks/dsh-companion-0.11.0-polish.apk` (40.087.797 bytes), SHA256
`170033650c9ff7aed664094c1391b4149b1255bcc8739acaba1762dc4edd7622`;
certificado V2 preservado. Não inferir FPS ou aceitação visual física.
Atualização física100 autorizada por `pode instalar`: `install -r` Success, UID/diretório CE
e firstInstallTime originais preservados. Não houve abrir app, gesto, captura ou limpar dados.
Evidências: `.dumps/tasks/task95-apk11-evidence.md` (validação pré-instalação) e
`.dumps/tasks/task100-install-receipt.json` (versão11 instalada/metadados).

**Backend97/98: instância isolada de testes Companion**, ciclo de vida autorizado
autonomamente pelo dono; não pedir repetidamente a mesma janela RAM-safe. Integração97
de7 linhas preservou Settings/modelo openai-codex/gpt-6-sol/low, frontend/TUI e índice never.
98 comprovou autenticação legítima e modelCatalog reais no3081, rota salva anunciada e
plugin inventory nativo com sessão/criação/workspace/owner/controller ativos. A prova de
execução real do agente foi concluída em99 abaixo, não inferida desse inventário ou401.
A unit legada `dsh-web` foi removida
recuperavelmente; permanecem os serviços backend3081 e frontend3082, sem reiniciar TUI.
Evidências: `.dumps/tasks/task97-backend-activation-evidence.md` e `task98-capabilities-r3.json`.

**Goal99 ativo e validado na instância real.** O preset Companion agora monta os componentes
nativos `agent-instructions`, `command-goal`, `tool-goal` e o mock exclusivo. O bundle web
desativava esses três componentes no host, e o preset customizado não os incluía.
Motor goal/round-driver continuam nativos; nenhum scheduler ou banco paralelo de goals.
O AGENTS real do workspace recebeu a seção global de goal e as restrições nativas, com
carregamento integral comprovado em evento `agent-instructions` da sessão de teste.

Prova real: get/criação/pausa do mesmo goal, retomada pelo comando humano nativo e
**duas rodadas autônomas admitidas**. A primeira atingiu o orçamento de varredura da própria
sessão e foi cancelada explicitamente; após ajuste só de parâmetros, a segunda leu a própria
sessão e a fixture32bytes, verificou o objetivo e concluiu o mesmo goal nativo. Total:
3 turnos lógicos/11 requisições SDK, modelo salvo inalterado e nenhum grant novo.
Goal pausado exige controle humano `/goal resume`; o modelo não pode contornar essa regra.

Plugin `plugins/companion-notifications`: **um evento mock persistido** na conclusão real,
inalterado após reconexão autenticada. Ledger privado0600, payload mínimo sem objetivo/corpo,
dedup por goal/revisão e falha da notificação não reverte goal. **Nesse mock99 ativo não
há push no celular, Firebase ou HA**; o adapter novo de APK12 acima ainda não foi ativado.
13/13 testes SDK/isolados de pré-ativação também aprovados, separados da prova de modelo real.
Evidências: `.dumps/tasks/task99-source-report.md`, `task99-goal-autonomous-r2.json`
e `task99-executor-invariants.json`.
**Diagnóstico96 encerrado:** conversa autorizada apontava para SVG relativo criado por
write, sem imagem tipada/receipt. Placeholder87 esperado; nenhum relaxamento de URI/path
ou leitura do SVG. Novo teste admitido requer raster tipado/read_image e alias exato.

**Histórico APK10 (atualizado para11 na task100):0.10.0-amoled (versionCode10), user0/UID10318 e dados preservados.**
Canvas AMOLED `#000000`, superfícies neutras, compositor arredondado com texto acima
dos controles e envio circular. O chat não tem cabeçalho/título/botão voltar visível;
mantém gesto lateral e Back do Android, contexto e saída acessíveis. Parar resposta
fica no compositor sem substituir a possibilidade de enfileirar outro texto literal.
O catálogo abre com toque curto; pressão longa oferece Apagar, sempre com confirmação
e alternativa de acessibilidade, sem os três pontos permanentes. Reter um cartão com
deleção incerta não abre a conversa ao soltar nem permite repetir a ação destrutiva.

Splash nativo Android14 preto com a mesma maid aceita; a restauração inicial usa o
loading original, sem atraso artificial e sem reaparecer ao navegar/atualizar o chat.
Tabelas formam um grupo contínuo: duas colunas se ajustam quando legíveis, fontes
maiores/tabelas largas compartilham pan; só as extremidades têm cantos arredondados.
O orçamento soma pixels arredondados por componente para não comprimir a última coluna.
Tipografia/cadências/assets/seleção/limites lazy e autoridade das imagens são preservados.
Na rodada APK10, faltava diagnóstico exato da imagem do print1. A task96 acima rastreou
somente a conversa autorizada e comprovou SVG sem receipt; não contornar o subset por URI.

Naquela rodada, backend89/91 foi preparado, **110/110 testes passaram**, sem ativação;
a integração posterior97 está registrada acima.
Naquela rodada, ativação e atualização física eram decisões separadas, com consentimento fresco e
condição segura de todas as conversas em RAM. A autorização atual de backend98/99 está acima;
a atualização física continua separada. Atualização física92 já autorizada e
concluída: APK9→10, mesmo UID/dataDir/inode/firstInstallTime; sem ativar o backend.
Registro: `.dumps/tasks/task92-apk10-install-evidence.md`.
Validação final:67 protocolo,359 JVM de app aprovados +1 live opt-in ignorado,
152 Android no emulador privado,4 fixtures do ícone e9 do splash; Werror/lint estritos.
Artefato local `.dumps/tasks/dsh-companion-0.10.0-amoled.apk`, SHA256
`6fe81acbffb68c301c6b007bac561e2100a1fed710fe6178b5fa829ce52cf5b0`;
mesmo certificado V2 dos APK8/9. Três PNGs sintéticos inspecionados, sem prometer FPS
ou aceitação visual física. Evidência: `.dumps/tasks/task90-apk10-evidence.md`.

**Histórico APK9:0.9.0-night (versionCode9), substituído pelo APK10 sob92r1.**
Paleta grafite noturna, sem botões visíveis de copiar (só seleção/longpress nativa),
e ícone estático da MESMA maid do loading. Layout/tipografia/spacing/motion/gestos
aceitos permanecem. Os32 assets/timings do loading não mudaram; receita offline
em [icon/README.md](icon/README.md), sem geração/repaint da arte original.

Task87 adiciona imagens Markdown SOMENTE por associação exata a imagem tipada já
confirmada e anterior: `attachment:<opaqueId>` ou ORIGINAL `read_image.file_path`.
Não abre arquivos/URLs por texto. Live/tabelas e destinos externos seguem inertes;
A task96 posterior confirmou que o exemplo real SVG/write não é admitido nesse subset.

Build/lint estritos passaram:67 protocolo,341 JVM de app (342 casos/1 live opt-in
ignorado),130 Android no emulador API34 privado,4 fixtures offline do ícone.
Assinatura V2 igual ao APK8. Nenhum perfil/backend/modelo/tool82/83 foi ativado ou
reiniciado. Task88 instalou por upgrade user0 após autorização FRESCA e confirmação
de ausência de pendências: ADB Success, versão9/UID10318/inode de dados/primeira
instalação preservados; MainActivity Status:ok. Não apagar dados nem ler cofre/chats.
Aceitação visual/FPS físico não inferidos; nova atualização exige nova condição segura.
Evidências locais: `.dumps/tasks/task85-87-apk9-evidence.md` (build/testes) e
`.dumps/tasks/task88-apk9-install-evidence.md` (upgrade autorizado).

**APK8 instalado anteriormente:0.8.0-lazy (versionCode8), UID10318 preservado.**
Task84 usou upgrade user0 autorizado após condição segura: ADB Success e
MainActivity Status:ok. Sem apagar dados/reiniciar backend/ativar tools82/83;
O dono depois confirmou imagens, streaming e slide funcionando; pediu os ajustes
da task85. Isso não é medição de FPS físico. Evidência local:
`.dumps/tasks/task84-apk8-install-evidence.md`.
Task81 mantém fatos/approvals no dispatcher proprietário, decodifica socket em fila
ordenada e prepara projeção/Markdown fora da UI, inclusive histórico e finalização.
Uma única LazyColumn monta células limitadas em vez de respostas/tools inteiros.
O gesto começa até88dp da lateral; imagens tipadas confirmadas aparecem na cronologia
fora da atividade recolhida e o toque abre o preview existente. Não é medição de FPS.
Nova instalação exige autorização fresca e nenhuma intenção pendente em RAM.
Build/lint estritos,67 testes de protocolo,309 JVM de app e118 Android passaram;
um teste live opt-in foi ignorado. Mesma assinatura V2; telas inspecionadas usam só
fixtures sintéticas. Evidência local: `.dumps/tasks/task81-apk8-evidence.md`.

**APK7 instalado anteriormente:0.7.0-editorial (versionCode7), UID original preservado.**
Build/JVM/protocolo/lint estrito e **92 testes Android** passaram no emulador API34
dedicado. Somente humanos têm balão; assistente fica no fundo e atividade/tools
começam recolhidos. Markdown em streaming usa um worker sequencial fora da UI;
isso é uma melhoria sustentada por código/testes, não medição de FPS no telefone.
Imagens finais são fixtures sintéticas, não conteúdo dos dois prints privados
que o dono autorizou como referência. O dono confirmou ausência de pendências e
aprovou upgrade/restart; ADB respondeu Success e MainActivity Status:ok. O backend
Companion voltou ativo com o modelo salvo preservado. Depois o dono confirmou
visual e funcionamento; isso não mede FPS físico. Nova atualização exige condição segura.

**APK6 instalado anteriormente:0.6.0-agentic (versionCode6).** Build/JVM/protocolo/lint estrito passaram;
**85 testes Android** passaram no emulador API34 dedicado. Assinatura V2 igual à
dos APKs anteriores. Após retornar, o proprietário autorizou upgrade preservando
dados e restart somente do backend Companion, confirmando nenhuma intenção pendente.
A instalação física respondeu `Success`; aceitação visual e funcional é com o dono.
Nenhum uninstall, clear-data, captura privada nova ou troca real de modelo foi usado.

Inclui tools compactas, leitura contextual profunda de sessões, movimento compartilhado,
catálogo retido sem refresh ao voltar, Configurações com Sair/modelos e Apagar conversa
com confirmação/arquivo recuperável no servidor. O teste de modelo real usou somente
conversa sintética isolada; os85 testes Android não usam conversas, câmera ou grants reais.
As imagens reproduzíveis de tools/configurações/borda inferior são sintéticas e locais;
não são prova de fluidez/jank no telefone.

O login do APK5 já foi confirmado pelo proprietário. Credenciais continuam no cofre
Keystore da mesma aplicação; nenhuma URL/token/cookie é registrada em evidência.
Frontend Web/proxy3082 permanecem como fallback, sem mudanças de VPN/DNS/publicação/TTL.
Antes de atualizar/reiniciar de novo, confirmar que nenhuma intenção em RAM será perdida.

## Plataforma e build

- minSdk34, targetSdk34 e compileSdk34; JDK21, bytecode JVM17.
- Gradle8.13 com [checksum oficial obrigatório](https://downloads.gradle.org/distributions/gradle-8.13-bin.zip.sha256)
  `20f1b1176237254a6fc204d8434196fa11a4cfb387567519c61556e8710aed78`.
- AGP8.9.2; Kotlin/Compose compiler2.1.21; Compose BOM2024.12.01.
- SDK/build caches locais em `.dumps/android-toolchain`, sem alterar o SDK,
  cache ou signing keys de outros projetos. `local.properties` não é versionado.
- Compilação estrita APK8:67 testes de protocolo e309 testes JVM de app passaram;
  `LiveOwnerReadOnlyTest` é o único ignorado (310 casos de app).118 testes Android
  passaram no emulador API34 dedicado5039/5580, sem leitura/grants/modelos reais.
- `:app:lintDebug` e `:app:assembleDebug` passaram; pacote e assinatura verificados.
  Somente `OldTargetApi` e `GradleDependency` (sugestões de versões mais recentes)
  têm exceção documentada por causa do alvo deliberado API34. Backup e transferência
  de dados estão bloqueados explicitamente; demais achados de lint são fatais.
- Backend real: catálogo exige cookie e Origin, rejeita chats externos; mux preservou
  36 registros/cursor35 em reabertura e reconexão, sem envio ou retomada de Agent.
- O próprio transporte Kotlin repetiu essa prova, aplicando os reducers de histórico
  e streaming. `LiveOwnerReadOnlyTest` é opt-in e normalmente pula antes de qualquer
  leitura de credencial ou conexão; não confundir skip padrão com teste real executado.

## Usar o protótipo

O APK debug fica em `app/build/outputs/apk/debug/app-debug.apk`. Exige Android14
ou superior, acesso ao PC pelo Tailscale e o backend companion existente ligado.
Não contém WebView, runtime React ou motor de LLM no telefone.

Use o **link privado inicial completo** do companion; a URL limpa após o login
não autentica este app. O campo o oculta e o limpa ao conectar. Não compartilhe
esse link nem o envie em relatório, screenshot ou log.

Na versão0.2, somente os cookies owner são salvos com AES256-GCM e chave não
exportável Android Keystore, em arquivo privado sem backup. O link/token inicial
nunca é persistido; o cookie só é gravado após validar o303 e seu destino.
Ao abrir, o app verifica o login salvo somente pelo catálogo read-only. Falha de
rede não apaga a credencial. Cookie expirado ou401 real exige novo login.
`Sair`/`Esquecer login` remove a credencial local; não revoga o acesso no servidor.
O DSH usa prazo finito, padrão30dias, e segredo de assinatura persistente: reiniciar
o PC não invalida por si só um cookie válido. Nenhum prazo do backend foi alterado.

Rascunhos e controle de entrega continuam só em RAM; o ledger não é persistente.
Nunca recriar
manualmente um envio sem confirmação: primeiro reconectar e verificar o histórico.
O app não restaura nem reenvia rascunhos automaticamente.

O frontend publicado continua disponível para rollback. A instalação via ADB foi
explicitamente autorizada e direcionada com `--user 0`; nenhuma instalação ou
abertura foi feita no Work. Não repetir ações no telefone sem autorização.

Com o toolchain local configurado, a validação usada no APK9, da raiz do repo:

```fish
set -lx JAVA_HOME /usr/lib/jvm/java-21-openjdk
set -lx GRADLE_USER_HOME "$PWD/.dumps/android-toolchain/gradle-cache"
set -lx ANDROID_USER_HOME "$PWD/.dumps/android-toolchain/android-home"
env -u ANDROID_PREFS_ROOT -u DSH_LIVE_READONLY .dumps/android-toolchain/gradle-8.13/bin/gradle -Duser.home="$PWD/.dumps/android-toolchain/java-home" '-Dorg.gradle.jvmargs=-Xmx3g -XX:+UseSerialGC -XX:-ClassUnloading -Xshare:off -Dfile.encoding=UTF-8' -p android/companion :protocol:test :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon --no-parallel --max-workers=2
```

Os flags de JVM acima são locais à invocação, contornando dois crashes nativos
observados no OpenJDK21.0.12.1; não mudam a VM Android nem a configuração global.
Após mover recursos de mesmo nome entre qualifiers, um rerun integral
`--rerun-tasks` regenerou merge e símbolos R locais antes da validação final.
Não desabilitar lint/Werror para contornar fonte ou cache inconsistente.

O build deve usar um `GRADLE_USER_HOME` próprio e um diretório Java/Android home
isolado: o plugin Android pode tentar escrever preferências de métricas. Não
combinar `ANDROID_USER_HOME` com o legado `ANDROID_PREFS_ROOT`: um daemon novo
recusa caminhos contraditórios, mesmo se um daemon previamente aberto passou.
Não reutilizar ou mudar arquivos privados/signing keys de outro app. Um APK entregue
precisa ser compilado e inspecionado; não instalar no celular pessoal sem confirmação.

## Contratos e segurança

`protocol` contém DTOs, codecs JSON estritos e reducers de histórico, streaming e
aprovação. O catálogo `companion/listChats`/`detail` está em
`plugins/companion-api`: headers provam preset antes de abrir ou reter um chat.
Um título, PID ou hint de projeção não concede acesso. O catálogo é uma fronteira
**do produto**, não um firewall multitenant: a API nativa continua API do operador.

- Autoridade HTTPS fixa: `https://dsh.tail37b3d7.ts.net:8443`.
- Link inicial privado só em memória, GET de login,303 validado para o mesmo root.
- Cookie opaco cifrado no armazenamento privado sem backup; chave por UID/perfil
  Android Keystore. Expiração, domínio, path e HttpOnly são preservados. Não usar
  refresh token/bearer alternativo nem persistir startup token.
- TLS padrão e Origin explícito em POST e WSS; o proxy atual exige esse Origin.
- O cookie nativo rc.2 não inclui `Secure`: o cookie jar aplica independentemente
  HTTPS/host/porta exatos e nunca envia credenciais para outra autoridade.
- Sem bearer substituto, logs de URL/token/cookie/corpo ou trust-all.
- Envio reconhecido é admissão, não execução concluída. Resultado desconhecido
  nunca é reenviado automaticamente.
- Recuperação automática de conexões e redirects do OkHttp está desativada:
  o transporte padrão poderia repetir POSTs. ACK de geração antiga não libera
  reenvio; o ledger confirma evidência literal por `source.rpcId` no histórico.
- Aprovação usa o waterfall nativo e decisão `allowed-once`/`rejected`, vinculada
  à geração/clientId/eventId/agentId; não persistir ou repetir decisões.

Configurações permite consultar o catálogo nativo e confirmar o **padrão do perfil**;
conversas que já usaram modelo mantêm sua seleção. Não há picker de profile, editor
genérico de settings, terminal ou aprovação automática. Falta de capacidade/catálogo
desabilita seleção; mutação incerta não recebe replay. Terminais existentes sem bridge
continuam observáveis, mas não sendáveis; não reiniciá-los nem tomar seus locks.

Apagar conversa exige identidade/criação confirmadas e lease nativo sem writer ativo.
Move o diretório da sessão para lixeira externa ao corpus, não apaga anexos externos.
Só recibo exato confirma remoção local/draft/cache; falha incerta impede repetir a ação.

## Workspace e renderização nativa

- Catálogo e conversa em canvas AMOLED preto com tiers grafite neutros, camadas fullscreen, não bottom sheet.
  Tokens centralizados em `PremiumPalette`; sem cores dinâmicas de wallpaper.
  Nova/existente compartilham entrada600ms/fechamento480ms e origem no card/+.
  Drag acompanha dedo; release resolve só a distância restante e cancel assenta por mola.
  Backing retido, callbacks únicos e sem refresh automático ao voltar. Cache RAM de12
  conversas guarda apenas posição/folds/following; placeholders não clampeiam a posição.
  Não guarda transcrições nem recarrega páginas antigas automaticamente: restaura a mesma
  janela efetivamente recarregada. Motion reduzido/escala0 evita a animação.
  Padding final20dp integra afterContentPadding no follow-bottom, inclusive card alto.
- Apenas mensagens humanas têm balão à direita (máximo88%); prosa do assistente,
  avisos e contexto ficam diretamente no canvas, sem cabeçalhos DSH repetidos.
  O tema fornece `onSurface` também fora de Surface, mantendo contraste no fundo.
  Tools/raciocínio contíguos de um turno ficam numa linha Atividade recolhida por
  padrão; prosa entre atividades continua visível e na ordem original. IDs nativos,
  folds e tails são preservados; nenhuma duração ou conclusão é inventada.
  Expandir atividade monta apenas os headers de48dp próximos do viewport; detalhes
  abertos também viram células independentes. Imagens tipadas com recibo confirmado
  saem do fold no ponto cronológico associado, sem duplicá-las no detalhe. Nome de
  ferramenta, XML/JSON literal ou URL não autorizam promoção. Inspecionar suspende
  tail-following; seleção nativa e preview também o suspendem.
- Markdown nativo com CommonMark/GFM: títulos, listas, citações, ênfase, links
  validados, código selecionável, tabelas e strikethrough. Streaming
  mantém blocos indexados e substituição pelo histórico sem duplicação.
  Workers sequenciais conflam apenas snapshots de apresentação, nunca frames de
  protocolo/controle. Parse estático/live/final e plano de células rodam no Default;
  não há flush síncrono de finalização nem Text provisório de64KiB. A preparação é
  explícita e o cache AST/células vive só na janela selecionada, não no cache12.
  Tiles têm até2048 unidades UTF16 e48 separadores de linha de origem; código/tabelas
  mantêm fontes e spans, com limites explícitos. Seleção nativa cobre conteúdo lazy
  montado, **não intervalos desmontados**. Por pedido do dono, task85 remove os
  botões de copiar mensagem/código/fonte; a cópia fica só no menu nativo após
  longpress/seleção. Não há promessa de copiar fonte global ou trechos desmontados.
  Código/literal têm pan independente por fragmento para evitar que um fragmento
  curto zere o limite do longo; linhas de tabela compartilham pan e colunas coerentes,
  responsivas para até duas colunas legíveis, sem diminuir a fonte para caber.
  Crescimento live usa scroll direto, não reinicia tween por token; a geometria final
  também acompanha o fundo sem sobrepor leitura manual/seleção. A admissão discreta
  assenta em220ms, sem escala/stagger, não anima histórico ou cada delta.
  Gesto horizontal usa faixa lateral88dp; a faixa de cabeçalho96dp fica só em
  Configurações, nunca sobre o texto do chat sem cabeçalho. Slop/axis-lock e velocidade
  recente; código/tabelas/mídia/compositor, longpress/seleção e IME têm precedência.
- Ferramentas têm identidade/call/result, estados parciais/erro, JSON limitado,
  código, buscas/linhas, antes/depois e imagens tipadas. Família desconhecida usa
  fallback literal inerte; renderizar não instala ferramentas nem concede grants.
- Math/Mermaid ficam como fonte explícita, não HTML executável. Autolinks GFM
  nus e task checkboxes permanecem literais; GIF exibe só o primeiro quadro.
  Recursos avançados de compaction/feedback/offload são avisos limitados/inertes.

O [perfil de workspace](../../plugins/companion-workspace/README.md) foi corrigido
para criar novas conversas no projeto dedicado e permitir leitura do host com
escrita só nesse projeto. Task80 ativou apenas o delta de controller, após condição
segura confirmada pelo dono; demais configurações ficaram byte a byte preservadas.
Não reescrever headers antigos nem reiniciar enquanto houver intenção em RAM.
O CWD do processo backend pode continuar no repositório do app; ele não deve
determinar o CWD do Agent novo. Conversas legadas com CWD antigo mantêm leitura,
mas precisam de uma nova conversa no contexto dedicado para escrever/executar Bash.

## Imagens autorizadas e limites

`read_image` só renderiza uma referência presente no chat admitido. O app usa
`session/attachment` read-only com prova de admissão, seleção e geração atuais,
rechecadas antes/depois do I/O. Não abre caminhos do PC ou URLs arbitrárias,
não sobe arquivos e não faz fetch externo a partir de Markdown.
Projeção pendente aguarda a revisão durável atual antes de admitir uma referência;
resultado de worker antigo não autoriza imagem retirada ou de outra geração.

No Markdown final, o destino pode associar-se apenas a recibo original válido de
chamada/resultado anterior (`callSeq < resultSeq < corte durável do assistente`).
O nome/args reais e uma única imagem tipada de sucesso são capturados ANTES do
fallback de previews; nome de arquivo, JSON/texto e posição visual da call não
provam nada. Args duplicadas/parciais, erro, offload/truncation e ambiguidade
permanecem inertes. Caminhos são exatos, sem cwd/normalização/basename guessing.
O cache Markdown só guarda alt/destino, não autorização. Dependências completas
são rechecadas na revisão atual, inclusive se a mesma ref ainda existe em outro
recibo. Até4 imagens por assistente original; índice4096recibos estourado desliga
associações, sem esconder conflitos. Listas/citações compartilham a decoração
existente; tabelas/live e URLs/URIs genéricos não passam a buscar imagens. O caso
real do dono depende de conferir seu trecho `![...](...)`, não foi presumido.

- Parser geral continua2MiB/frame,512KiB/string. Apenas o envelope tipado de
  attachment admite8MiB, base64 canônico e no máximo4MiB decodificados.
- MIME PNG/JPEG/WebP/GIF, digest de IDs conhecidos, metadados e dimensões reais
  são verificados. Oversize/indisponível gera aviso honesto, sem retry automático.
- Thumbnails≤768px e preview≤2048px/16MiB por bitmap; decode concorrente1.
  RAM LRU24MiB/24 entradas **não é teto de RAM total do processo**.
  Cards mantêm slots220dp, mas desmontam imagens fora do viewport para não
  prender dezenas de bitmaps em uma única row. Evicção não recicla bitmap visível.
- Preview se ajusta ao viewport; pinça1×–4× e pan limitado só no preview.
  Troca de seleção/geração fecha o dialog e não reaproveita pixels de Ready antigo.

A Activity `.preview.FixtureActivity` existe somente no APK debug, sem launcher
ou deep link. Ignora extras e usa dados/pixels gerados apenas em RAM, com banner
“Prévia local · sem ações no PC”; não acessa ViewModel, cofre, transporte, câmera,
armazenamento, provider ou permissão real. O retorno ao app é clique explícito.
