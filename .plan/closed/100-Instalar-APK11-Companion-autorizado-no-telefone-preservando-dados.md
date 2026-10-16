# Atualização física APK11 autorizada

Pedido fresco do dono: `pode instalar`, após entrega do APK11 validado. Autoriza instalar a atualização, não apagar dados ou navegar/capturar a UI.

1. Conferir conexão ADB5037 do alvo conhecido ZY22F2395W/Moto XT2201-2/API34 e versão/package/user0/UID atuais do Companion por metadados mínimos. Não iniciar servidor/emulador alternativo nem mexer em outros aparelhos.
2. Revalidar `.dumps/tasks/dsh-companion-0.11.0-polish.apk`,40.087.797bytes,SHA256170033650c9ff7aed664094c1391b4149b1255bcc8739acaba1762dc4edd7622,package dev.alex.dsh.companion/versionCode11/versionName0.11.0-polish/cert1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d.
3. Executar somente `adb -s ZY22F2395W install -r` do APK exato: atualização preservando dados; sem uninstall/clear/-d/-g/-t ou permissões extras. Se houver incompatibilidade/erro, diagnosticar antes de qualquer nova tentativa, nunca resetar o app.
4. Verificar versão11 instalada e UID/user0/firstInstallTime mantidos por metadados; registrar recibo redigido `.dumps/tasks/task100-*` se id alocado100 (ou id efetivo equivalente). Não alegar auditoria byte-a-byte de dados privados. Fechar após Success+verificação.

Sem abrir app, screenshot, UIgestos, leitura de dados privados/credenciais, mudanças de Settings, backend/frontend/TUI/SDK, commit/push. APK10 continua artefato rollback local; downgrade nunca automático.