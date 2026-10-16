# Upgrade físico APK9 autorizado

## Autorização fresca
Dono: 'aurotixado pode atulizar'. Pergunta safe_upgrade respondeu 'Confirmo, sem pendências' para rascunhos/envios/streams/aprovações em nenhuma conversa. Consentimento exclusivo ao APK9, não restart/ativação backend. Usar goal atual para orientar execução após aprovação.

## Artefato e destino
.d umps não é caminho: artefato correto `.dumps/tasks/dsh-companion-0.9.0-night.apk`, package dev.alex.dsh.companion, versionCode9/versionName0.9.0-night, API34, SHA256bf7b226de4c0a54e6396e19f6fb91956254af7f1b09fbd92f86b96567508aa15. CertV2SHA2561fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d igualAPK8. Build/lint/67protocolo/341JVM/130Android/4offline já passaram; `.dumps/tasks/task85-87-apk9-evidence.md`. Telefone específico ZY22F2395W(MotoXT2201_2), ADB5037, user0/UID10318 esperado. Não selecionar outros devices nem emuladores.

## Execução mínima
1. Revalidar hash/certificado local, serial get-state e metadados de pacote/versão/UID antes; não ler conteúdo privado.
2. Se APK8/UID esperado presentes e device autorizado, instalar somente arquivo acima via adb -P5037 -s ZY22F2395W install --user 0 -r. Sem -d, uninstall, clear-data, revoke ou backup de dados privados. Falha não autoriza reset/reinstalação destrutiva.
3. Confirmar package version9/UID10318/user0 preservado e abrir `.MainActivity` com am start -W --user 0; apenas status técnico, não navegar/mandar prompt/aprovar em conversa.
4. Registrar evidência local mínima e avisar dono para validar visual/longpress/ícone/imagens, sem afirmar FPS/aceitação física. Goal completo apenas após verificação do upgrade e launch, ou aguardar dono se dispositivo indisponível.

## Limites
Nenhum backend restart/HMR, perfil/modelo/Settings/índice/tool82/83 ativado/editado; nenhum Agent/sessão/projeto/grant/prompt/delete real. Sem captura/logcat/profiler, chats/cofre/cookies/OAuth, HA/rede/TUI/SDK/globais/commit/push/publicação. Fica somente upgrade APK autorizado e metadados técnicos mínimos.