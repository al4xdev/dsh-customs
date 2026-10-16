# Companion: sandbox nativa workspace-write e Bash aprovado no app

## Pedido e esclarecimento do proprietário
O proprietário autorizou ferramentas para criar relatórios/arquivos numa pasta própria e Bash com aprovação do comando no app. Depois esclareceu: não criar um projeto paralelo de hardening nem limitar semanticamente o agente a relatórios; dar write dentro da sandbox e continuar tudo em paralelo. Esta revisão substitui exigências excessivas de read-isolation e sandbox personalizada da r1.

## Implementação simples e nativa
- Usar `/home/alex/git/my/dsh-companion-workspace` como CWD de **novas** sessões habilitadas; `relatorios/` opcional para organizar arquivos.
- Compor tools normais read/list/write/edit com sandbox nativa `workspace-write`. Leituras normais e temporários internos `/tmp` permitidos pela sandbox padrão são aceitos; não construir filesystem virtual/read-only privado, checks customizados de hardlinks ou permitir só determinados formatos de relatório.
- Preservar confinamento de escrita nativo fora do workspace e diretórios temporários normais. Não oferecer grant automático `danger-full-access`; se a aprovação do Bash implicar promoção de modo, separar a aprovação literal da execução mantendo workspace-write.
- Cada comando Bash deve ser exibido literal com CWD e aprovado explicitamente no app allowed-once/rejected antes de executar. Reutilizar permission/approval/SDK existentes; pequeno wrapper/hook apenas se nativo não possibilitar pedir sempre sem escalar sandbox. Sem regexallowlist/sandbox própria/prompt novo.
- Renderer/ícones não concedem capabilities; permissão vem da composição declarada e do runtime, exclusivamente neste escopo aprovado. Outros perfis/modelos/publicação/Tailscale/HA seguem intactos.

## Integração necessária
Ler fontes públicas SDKreadonly para encontrar caminho mínimo que preserva modo nativeworkspace-write+aprovação literal. Fixar CWD/escopo por Host para novas sessões; não basta confiar num payload Android que clientes alternativos possam alterar. Manter guards do preset/catálogo/header/admission. Não reescrever CWD nem ampliar ferramentas de chats antigos inadvertidamente; sem takeover/restart/hotinject do agente que o usuário está usando.

## Testes proporcionais
- Fixtures/fakeproviders: arquivo dentro workspace permitido, escrita fora recusada pela proteção nativa, Bash sem aprovação/rejeitado não executa, permitido executa uma vez no CWD esperado e sem promover sandbox; stale generation/doubletap/disconnect não repetem.
- Mostrar command+CWD literal completo no app dentro dos bounds existentes; recusar comando que não possa ser apresentado com integridade, não inventar amplo inspector/novo produto.
- Testar gerador/guards/backend e app, lint/protoc/JVM/Compose/emuladorSDK34 e integrar com APK4task70. Sem modelos/grants reais para testes, capturas sófixture; celular em uso não recebe update/forceStop/instrumentação até condição segura.

## Aceite e entrega
Agente versátil sem personaextra, workspace próprio e write sandboxnative. Bash aprovado no app e sem grant perigoso automático. InterfaceTask70 refinada segue em paralelo. Relatórios apresentados por refsattachments públicas admitidas quando suportado; sem arbitraryhostpath/URLfetch. Evidências e limites honestos, assinatura/UID/cofre preservados, nenhumcommit/push, nenhum deployHA ou mudança de serviços sem requisito explícito/safe idle.