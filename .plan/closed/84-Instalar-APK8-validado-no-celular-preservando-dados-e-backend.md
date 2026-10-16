# Atualização física autorizada — somente APK8

## Autorização fresca
Depois de confirmar que APK8 era o mais recente, dono pediu instalar, ligou ADB e respondeu 'está ligado pode sim, atualizar' à condição explícita de ausência de stream/envio/aprovação/intenção pendente. Autoriza agora upgrade físico APK8 preservando dados; NÃO reinício/ativação do backend nem novas tools82/83.

## Procedimento
1. Verificar checksum do artefato já validado `.dumps/tasks/dsh-companion-0.8.0-lazy.apk`: SHA256 a06cae5d1faef90f2ed9e0d15e4980f8b162eb16254bcd6c29427198f2c0a699. V2 signer 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d, package dev.alex.dsh.companion versionCode8/0.8.0-lazy min/target34. Fonte/testes fechados81:67protocolo+309JVM/1skip+118Android, sem FPS físico medido.
2. Listar ADB5037 e apontar EXCLUSIVAMENTE celular conhecido ZY22F2395W. Conferir package/user0/versão e UID original10318 antes da operação. Se conexão ausente, unauthorized, identidade/versão/assinatura inesperada ou upgrade inseguro, parar e perguntar; sem reset de ADB/auth, downgrade ou inferência de outro device.
3. `adb -P5037 -s ZY22F2395W install --user 0 -r <APK8>`; sem uninstall/clear-data, novos grants, force-stop prévio, captura/logcat/profiler, acesso a cookies/cofre ou Work profile. Conferir Success; erro não autoriza workaround destrutivo.
4. Conferir versionCode8/0.8.0-lazy e UID10318 após upgrade. Abrir somente MainActivity user0 como conclusão da instalação, sem enviar prompt/navegar chats/alterar modelos/grants. Registrar apenas metadata+Status:ok; não chamar aceitação visual/FPS físico.
5. Documentar evidência local e fechar tarefa com resultado concreto. APK8 upgrade pode terminar processo do app; consentimento condicionado a nenhuma intenção em RAM foi solicitado e dono autorizou.

## Limites
Não reiniciar/mudar backend3081/proxy3082/perfil/modelo/SDK/TUI/OAuth/HA/rede; não ativar tools82/83. Nenhuma captura de conteúdo privado/ADB logs, nenhum prompt/modelo/grant/delete real, commit/push/publicação. Preservar assinatura, UID, dados e cofre; se algo não bater, parar sem uninstall.