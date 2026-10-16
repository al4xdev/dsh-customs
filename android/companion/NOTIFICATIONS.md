# Notificações de goals — Companion

## Limite da entrega APK12

O código Android, o registro autenticado e o sender opcional estão implementados.
**Firebase Companion ainda não foi configurado; não houve login, envio FCM real ou
instalação do APK12 no telefone.** A configuração ativa do backend97/99 permanece
inalterada. A ativação do novo host de goals/TODO também aguarda uma janela segura:
não foi encontrado um endpoint nativo mínimo que prove ociosidade sem devolver
projeções privadas de outras conversas. Não parar o serviço por suposição.

A implementação reaproveita a separação de responsabilidades de `ha_app`:
evento real no servidor → mensagem data-only → serviço Android → notificação
nativa. Não reaproveita projeto Firebase, package, IDs, destinatários, credenciais,
HA, automações ou WorkManager horário do Casa de Tequila.

## Android

- `notifications/GoalNotifications.kt`: canal dedicado, opt-in explícito,
  `POST_NOTIFICATIONS`, autoridade nativa e publicação com deduplicação persistida.
- `GoalPushPolicy.kt`: conclusão nativa versionada mínima, validade temporal,
  eventId determinístico e ledger limitado; falha de persistência bloqueia entrega.
- `PushRegistration.kt` / `PushRegistrationStore.kt`: receipt de até24h ligado a
  device, perfil, configuração, tokenDigest, sessões autorizadas e geração
  monotônica persistida. O token FCM bruto não é persistido.
- `CompanionMessagingService.kt`: rejeita notification payload antes de o SDK
  tentar autoexibição. FCM aceita somente o envelope14 campos vinculado ao receipt;
  conclusão local confirmada usa os7 campos nativos e o mesmo ledger.
- `CompanionPushConfiguration.kt`: sem inicialização automática ou obtenção de
  token durante lançamento/login. Somente opt-in configurado, permissão e vínculo
  nativo permitem o registro solicitado pelo usuário.
- `MainActivity.kt`: permissão apenas por ação nas configurações; PendingIntent
  explícito/imutável e nonce persistido de uso único. Extras/URIs não conferem
  login ou ownership. O VM verifica geração atual e catálogo antes de navegar.

Título e texto são genéricos, sem objetivo, mensagens ou caminhos. A notificação
construída usa `VISIBILITY_SECRET`. A visibilidade do **canal** é reservada pelo
Android ao sistema/usuário e pode retornar `NO_OVERRIDE`; não alegar que o app
consegue impor esse override. Um toque obsoleto, forjado ou sem autorização RAM
atual abre somente o app/catálogo, não uma conversa por confiança nos extras.

Desativar revoga a autoridade local imediatamente; unregister autenticado é uma
única tentativa limitada a3s. Falha/offline não reativa avisos localmente; o lease
remoto tem validade máxima24h. Sucesso FCM no servidor significa aceitação HTTP,
não confirmação de exibição pelo aparelho. Crash entre commit e notify pode perder
um aviso, mas não deve duplicá-lo após reinício.

## Backend preparado, não ativado

- `android/companion/backend-native-goals`: único goal atual + TODO nativo
  independente, controles HUMAN via APIs públicas DSH com ref/CAS e Peer real.
- `plugins/companion-native-host`: assembly host com lease público do preset
  Companion. Não colocar os serviços diretamente no preset: o SDK exige realms,
  e o Gateway direto não resolve serviços isolados dessa forma.
- `plugins/companion-push`: registro/unregister/status autenticados, destinatários
  validados, outbox privado limitado e sender opcional HTTPv1. Default desabilitado
  não cria arquivos, listeners de goal, timers ou chamadas externas.

A conclusão vem de commit nativo `goal/changed`, não de palavras do modelo.
O eventId é SHA256 do JSON de `['companion', sessionId, goalId, revision]`.
O plugin99/mock ativo não foi modificado ou substituído.

## Amanhã, com o dono

1. Confirmar janela segura para o backend; revisar o candidato offline que monta
   TODO nativo no preset e o novo host no ROOT, preservando Settings/modelo/índice.
   Confirmar a prova de startup declarativo/lifecycle antes de aplicar. Manter push
   ausente enquanto não configurado. Não tocar TUI ou restaurar outros históricos.
2. Fazer login juntos e escolher/criar **projeto e app Firebase próprios do
   Companion**, package `dev.alex.dsh.companion`. Sem Analytics/Crashlytics,
   Firestore ou Functions. Nada de reutilizar a produção Casa de Tequila.
3. Preencher o arquivo local ignorado `companion-push.local.properties` apenas com
   `androidPackage`, `projectId`, `applicationId`, `apiKey`, `senderId` públicos.
   A configuração atual é de build: reconstruir o APK após obter esses dados.
4. Configurar o sender do backend com os mesmos IDs públicos e credencial própria
   aprovada do Companion em arquivo0600 fora do repositório. Escopo mínimo
   `roles/firebasecloudmessaging.admin`; nunca enviar chave/token no chat/log.
   Rever explicitamente a configuração push antes de habilitá-la.
5. Instalar somente após nova autorização. No aparelho, optar por avisos e conceder
   a permissão; registrar via transporte nativo autenticado e conferir receipt.
6. Concluir um goal fresco e verificar entrega real, dedup/reconexão, revogação e
   toque no aparelho, incluindo segundo plano/reinício. Somente essa prova permite
   declarar FCM ponta a ponta funcionando.

Testes locais, SDK real isolado e capturas de fixtures não substituem esse último
passo. Nenhuma etapa sensível acima foi executada durante a ausência do dono.
