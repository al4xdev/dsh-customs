# Instalação física APK10 — upgrade autorizado

## Consentimento fresco
Dono pediu explicitamente atualizar/instalar e respondeu **Confirmo, sem pendências** à pergunta sobre rascunhos não enviados, envios incertos, respostas em andamento e aprovações no Companion. Autorização nesta tarefa é SOMENTE upgrade APK10 e lançamento do app, preservando dados; nenhum backend restart/ativação.

## Artefato e alvo
APK `.dumps/tasks/dsh-companion-0.10.0-amoled.apk`; SHA256 esperado `6fe81acbffb68c301c6b007bac561e2100a1fed710fe6178b5fa829ce52cf5b0`. Pacote dev.alex.dsh.companion, versionCode10/versionName0.10.0-amoled, API34. Assinatura V2 certificateSHA256 `1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d`, igual APK8/9. Build Werror/lint,67 protocolo/359JVM+1ignored/152Android/4icon+9startup e3PNGs sintéticos validados sob90r2 fechado; não repetir testes em telefone.
Alvo explícito ADB5037 serial ZY22F2395W, MotoXT2201-2, user0. Nunca adbdevices, alvo implícito/outroaparelho/defaultscript.

## Execução e evidência
1. Reconfirmar hash/assinatura do artefato e modelo/API/metadados package instalados, somente readonly; verificar versão9/certidentidade/UID10318/dataDir/ceDataInode/firstInstallTime onde disponíveis. Se divergência de alvo/assinatura/versão inesperada, interromper e perguntar, sem downgrade/delete.
2. Upgrade `adb -P5037 -s ZY22F2395W install --user0 -r APK`, sem uninstall/clear/grant/takeover. Observar Success/exit; não repetir instalação incerta sem prova de estado.
3. Readonly package depois, comprovar versão10 e identidade/dataDir/UID/inode/firstInstallTime preservados. Lançar MainActivity explicitamente com am start -W, sem navegar/extrair screenshot/UI XML/chats/cofre/logcat. Lançamento pode restaurar login e fazer requisições readonly usuais; nenhum prompt/model/delete.
4. Registrar evidência privada .dumps/tasks/task92-apk10-install-evidence.md, atualizar README apenas estado instalado real, fechar plano com revisão exata. Se falha, preservar estado/dados e reportar fato concreto, sem silenciar ou alegar instalado.

## Limites
Sem mudança/restart/ativação backend89/91/índice/profile/modelo/Settings/SDK/TUI/OAuth/HA/global, nenhum grant/projeto/conversa/prompt/model real/delete/cópia de histórico/cofre. Sem novas capturas/navegação física/medição FPS/aceitação visual inferida. Sem commit/push/publicação. Não reaproveitar consentimento para outras atualizações ou tarefas.