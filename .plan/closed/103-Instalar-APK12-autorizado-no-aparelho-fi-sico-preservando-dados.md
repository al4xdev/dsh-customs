# Instalação física do APK12

Autorização fresca do dono: **pode instalar**, referente ao APK12 entregue. Escopo apenas atualização do Companion; não autoriza backend/Firebase/login, abrir app, gestos, screenshots ou concessão de permissão.

1. Confirmar artefato `.dumps/tasks/dsh-companion-0.12.0-goals.apk`, SHA256 ab948dc43a78abbf92b8008fa75620334e4b3989c606bec1631ae883a27e84da, package dev.alex.dsh.companion/versionCode12/API34 e assinatura SHA256 1fa5e52df976fefd0b80e256304a47e18e2cdcdcaeff19676e98d8b947fe4a2d.
2. Descobrir aparelhos ADB5037 e confirmar serial conhecido ZY22F2395W/model XT2201-2/SDK34; se diferente/ambíguo/offline, parar antes de instalar. Ler somente metadata do package para registrar versão, UID/CE inode e firstInstallTime.
3. Atualizar uma única vez com adb5037 serial explícito `install -r`, sem -g, uninstall ou clear. Em falha, investigar antes de qualquer repetição.
4. Confirmar versão12/nome0.12.0-goals e preservação de UID, inode CE e firstInstallTime; registrar receipt sanitizado em .dumps/tasks/task103-install-receipt.json. Não auditar dados privados byte a byte nem alegar isso.
5. Fechar plano/goal após confirmação e informar limites de backend/push que permanecem pendentes. Sem commit/push/HA/cloud.