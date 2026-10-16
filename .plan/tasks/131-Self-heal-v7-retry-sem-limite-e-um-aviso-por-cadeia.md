# Self-heal v7 / controller v6: agente nunca para, um aviso por cadeia

## Pedido do dono (2026-10-16)
"A ideia é retry para agentes nunca pararem, inclusive alguns têm cota (como Google
Antigravity) que remarcam assim que volta o limite da cota. O self-heal é exatamente a
mesma ideia: não reenviamos o mesmo request às cegas (pode falhar igual); encapsulamos o
erro e avisamos o modelo via texto simples, sem tooling, que algo falhou no turno, e
tentamos de novo (às vezes é erro temporário de servidor e logo volta)."
Aprovados: retry sem limite, um aviso por cadeia (texto curto), doctor e testes portáveis.
Isto **revoga** duas decisões da tarefa 112: "não há tentativa 11" e "acrescentar aviso
a cada falha" (§3).

## Evidência (sessão real de hoje, rota Vertex, internet caiu)
Turno 3 passo 11: cinco `llm/retry` TRANSPORT (7,03 s → 112,5 s), recuperou na 6ª
tentativa. Cada ciclo inseriu um `user/message` "harness warning: … retry N of 10" de
~880 bytes; os cinco ficam no histórico. Revisões independentes (Sonnet e Opus) confirmaram:
fluxo correto para classes transitórias, acúmulo por desenho (testes travam 11 avisos),
bundles v5/v6 sem drift.

## Especificação
1. **Sem limite para classes transitórias** (TRANSPORT, TIMEOUT, SERVER, RATE_LIMIT,
   EMPTY_RESPONSE, PI_AI_ERROR, ANTIGRAVITY_QUOTA_RESET, chamada malformada AGY): as 10
   primeiras esperas mantêm a escala atual (7,03125 s·2^(n-1)); depois disso a espera fica
   no teto (60 min) indefinidamente. Classes terminais (AUTH, QUOTA de billing, credencial,
   4xx) continuam sem retry. Opt-out explícito existente (`maxRetries: 0`) continua valendo;
   um limite finito explícito do dono continua respeitado.
2. **Reset de cota/Retry-After acima de 60 min**: esperar até o horário indicado, limitado
   por um teto de espera de cota (padrão 24 h; o perfil já declara
   `quotaResetRetry.maxWaitMs: 86400000`) em vez de suspender. Hint inválido não é terminal:
   cai na escala normal.
3. **Um aviso por cadeia**: `user/message` de aviso só na 1ª falha da cadeia e de novo só se
   o código de erro mudar. Ciclos seguintes ficam só com o espelho `llm/retry` (UI). Texto
   curto, sem contador ("retry N of M"), mantendo o prefixo `harness warning:` e a marcação
   "observação interna, não é pedido humano" + fatos allowlisted (code, summary, remediation).
4. **Recusas não silenciosas**: toda recusa/estado "unsafe" registra um motivo fixo (log),
   sem dados privados.
5. **Persistência**: nova versão de política nos audits; leitores aceitam audits antigos
   (v2). Rollback para v6 após audits novos não é downgrade seguro (mesmo precedente do V2).
6. **Bundles imutáveis novos**: `agent-self-heal/lib/index-v7-unified.mjs` e
   `llm-resilience/lib/index-v6-unified.mjs`, cada um com `.build.json` (esbuild 0.28.2,
   target node24, hashes das fontes, rollback = v6/v5). v5/v6 ficam intocados.
7. **Fiação**: builder, `plugins/activation.json`, `tools/resilience/profile.mjs`,
   `tools/clean-install/{install,inventory,profile}.mjs`, READMEs; perfis via `activate`.
8. **Doctor** em `tools/` (sem bundle): ponte de persistência presente no SDK instalado e
   owner/controller corretos nos perfis. **Testes portáveis**: sem `/home/alex` nos testes
   do self-heal/resilience/codex-transient-close e em `install-persistence.mjs`.

## Desejável (se o SDK permitir sem patch novo)
Mensagem humana durante uma espera longa acorda o retry na hora (hoje fica no inbox até o
fim da espera; só cancelar aborta).

## Aceite
Todas as suítes verdes (self-heal, llm-resilience, codex-transient-close, resilience,
clean-install, lts:contracts, portable, research); testes novos para: retry além de 10,
espera de cota > 60 min até o teto, aviso único por cadeia e novo aviso ao mudar o código,
logs de recusa; cenário offline da sessão real reproduzindo 1 aviso em vez de 5.

## Checklist (implementação 2026-10-16)
- [x] 1. Sem limite para classes transitórias: `maxRetries` omitido = sentinela
      `UNBOUNDED_RETRIES` (`Number.MAX_SAFE_INTEGER`); 10 primeiras esperas na escala
      atual, depois 60 min indefinidamente; terminais continuam terminais; `maxRetries: 0`,
      opt-out registrado e limites finitos explícitos respeitados; cadeias antigas (owner6,
      cap 10) continuam finitas.
- [x] 2. Mínimo do provedor (`providerRetryAfterMs`, genérico para qualquer adapter) honrado
      até `maxProviderWaitMs` (padrão/máx. 24 h); acima → suspensão visível
      (`provider-wait-over-cap`); hint inválido/zero → ignorado, escala normal.
- [x] 3. Um aviso por cadeia (1ª falha; novo só com código diferente; teto de 8 por cadeia
      contra alternância); texto curto sem contador; `harness warning:` + "observação
      interna" + `code`/`summary`/`remediation`; terminal uma vez por suspensão.
- [x] 4. Recusas não silenciosas: motivo fixo no log (owner, aux e histórico inseguro com
      `unsafeReason`/`RecoveryHistoryError.reason`).
- [x] 5. Persistência: audit payload v2 / policy 3; v1/policy 2 continuam legíveis;
      accounting stateVersion 3; ownership v2 (`mirrorRetry`). Rollback para v6/v5 após
      audits novos não é downgrade seguro (documentado nos READMEs).
- [x] 6. Bundles novos `agent-self-heal/lib/index-v7-unified.mjs` e
      `llm-resilience/lib/index-v6-unified.mjs` + `.build.json` (esbuild 0.28.2, node24,
      rollback v6/v5); v1–v6 byte-idênticos. sha256 (rebuild após o follow-up): owner7
      `2c2118236ca25a5087cad71755c4ab76b5891b242591b821b727532be1a42777`, controller6
      `a2c2460b1372995698b667bc424ed2c83f3adf233cecb126d16279db1b2f06db`; rebuild reproduz
      byte a byte (`reused: true`). O primeiro build (não publicado) foi substituído.
- [x] 7. Fiação: builder (`tools/resilience/build-unified-recovery.mjs`), `activation.json`,
      `tools/resilience/profile.mjs` (aceita caminhos antigos; nota de cota reescrita),
      `tools/clean-install/{install,inventory,profile,smoke}.mjs`, READMEs.
- [ ] 7b. Perfis reais via `node tools/activate.mjs --write` — **pendente** (rollout do
      orquestrador após revisão; nada em `~/.dsh` foi tocado).
- [x] 8. Doctor `tools/resilience/doctor.mjs` (somente leitura; `npm run resilience:doctor`).
      Testes portáveis (sem `/home/alex` em self-heal/resilience/codex-transient-close,
      `install-persistence.mjs` e `plugins/common.mjs`).
- [x] Desejável: mensagem humana ao vivo acorda a espera local na hora (mínimo do provedor
      ainda vale; a mensagem entra no próximo passo/turno — o SDK não permite reivindicar o
      inbox no meio do passo sem patch).
- [x] Achado extra: o espelho `llm/retry` do owner6 violava a regra v4 do formato de sessão
      quando a cadeia continuava em outro passo/turno (log não reabria). Corrigido no owner7.

## Follow-up pré-rollout (2026-10-16, após revisão Opus "GO condicional")
Decisão do dono: manter retry sem limite para TODAS as classes transitórias/determinísticas
(EMPTY_RESPONSE, PI_AI_ERROR, chamada malformada, imagem/mtmd), sem tetos novos.
- [x] Esperas longas pelo relógio de parede: fatias de ≤60 s; termina quando o relógio
      monotônico OU o de parede (`notBeforeMs` durável) cobriu a espera; nunca antes do
      mínimo do provedor; cancel/HMR/wake mantidos. Testes com relógio de parede falso
      saltando (suspensão de 8 h numa espera de 5 h).
- [x] Espelho `llm/retry`: `failure` copiado só com campos de dados próprios e sem
      `providerRetryAfterMs` inválido (≤0/não finito).
- [x] Doctor: owner antes do controller, `alex-codex-transient-close` ausente e `llm-retry`
      duplicado agora falham; limites finitos explícitos viram aviso.
- [ ] Wake por mensagem do Companion: **não implementado**. A entrega pelo bridge
      (`plugins/session/bridge.mjs:92`) chega como `{role:'user', source:{kind:'user'}}`
      sem `rpcId` nem marcador, idêntica ao `/plan new` do managed-plans
      (`plugins/managed-plans/index.mjs:184`) e a outros envios de plugin; o caminho local
      (`controller.mjs:292`) roda no ALS do agente remetente. Ambíguo → precisa de um
      marcador fixo na entrega do bridge (dono de `plugins/session`).
- [x] Docs: sessões quebradas pelo owner6 (`llm/retry skips its policy attempt sequence`
      ao reabrir) e como detectá-las; procedimento manual de rollback (mão única).
- [x] Scanner somente leitura `tools/resilience/scan-retry-ordinals.mjs` (+ teste com
      fixtures reais do SDK, zstd por frame): lista ids/caminhos/regra/seq, e as sessões
      com audits owner7 (`ownerV2`, rollback inseguro). Sem reparo. Não foi executado
      contra `~/.dsh/sessions` (regra: não ler sessões reais).
