# session_create: destino dsh-tui (plano129)

## O que foi corrigido

A tool pública continua scoped ao Companion, mas seu owner não chama mais `agents.create` no processo Companion. Ele prepara o pedido, pede aprovação nativa `allowed-once` e envia uma autorização assinada a um bridge compatível no **host dsh-tui já aberto**. O host resolve/monta seu preset `standard`, usa seu modelo e suas políticas reais e mantém o novo handle root-owned. Não copia o preset do chamador, não muda a aba ativa e não fabrica origem apenas alterando o header.

A implementação interna antiga (`controller.mjs`/`provisioner.mjs`) permanece para testes legados explicitamente identificados; não é fallback do owner público.

## Uso

Argumentos da tool **session_create**, não da tool `session`:

```json
{"operation":"capabilities"}
```

O retorno inclui `destination_profile:dsh-tui`, `preset:standard`, `hosts`, `available`, `new_project:false` e limites. Quando houver mais de um host, escolha um `host_id` exato retornado. Não escolher arbitrariamente o primeiro PID. Sem host compatível, retorna `destination_host_unavailable` antes de aprovar/criar: abrir/recarregar uma TUI com bridge atualizado é necessário. A existência de um canal antigo que só suporta send não prova suporte a create.

```json
{"operation":"create","request":{"version":1,"owner_intent":"Criar uma sessão separada no dsh-tui para o pedido do usuário","target":{"kind":"current"},"delivery":{"mode":"empty"},"idempotency_key":"pedido-123"}}
```

Com vários hosts, adicione `request.host_id` com o ID real. `request.profile` e `request.preset`, quando fornecidos, só aceitam `dsh-tui` e `standard`. `preset:companion` é rejeitado, não reinterpretado.

`delivery:empty` é o padrão: cria/persiste a sessão sem prompt/draft/modelo executado. `delivery:{mode:submit,text:...}` exige texto literal não vazio até16KiB UTF-8 e também admite a tarefa para execução. A aprovação exibe o texto completo escapado reversivelmente. ACK de admissão e `status:completed` do provisionamento não significam conclusão da tarefa.

O modelo padrão é o do host destino. `request.model` é uma asserção opcional exata desse modelo/provider/effort, não uma seleção arbitrária nem cópia do Companion. Nenhum default global é salvo.

## Políticas e fronteiras

A aprovação no Companion permanece obrigatoriamente `allowed-once`, mesmo quando o destino tem `approval:never`. A confirmação mostra perfil, host, modelo, cwd, preset e políticas reais do destino. Se o dsh-tui usa `danger-full-access/never`, isso é declarado como execução futura ampla sem aprovações de ferramentas; não é escondido nem silenciosamente substituído por outra política.

- `current`: cwd comprovado do chamador, dentro do workspace dedicado ou child autorizado.
- `existing_project`: projeto nativo exato já existente dentro da fronteira autorizada, com fatos revalidados nos dois hosts.
- `new_project`: **indisponível** nesta versão. A API nativa de registro é create-or-reuse e não comprova propriedade exclusiva de novo projeto; a tool não adota resultados de uma corrida nem inventa `created:true`. Retorna `new_project_unavailable`, sem criação/aprovação. Não criar diretórios/projetos por outro caminho para contornar a recusa.

O host destino mantém a sessão independente do chamador Companion. Cancelamento/desconexão do chamador após envio não mata a sessão de destino. Fechar o host dono drena/fecha somente seus handles. Não há promessa de preservar modelo no cold resume de uma sessão vazia: binding é live-pinned e essa limitação permanece explícita.

## Protocolo e integridade

- `list` anuncia `capabilities.createProfile` sem efeitos de criação.
- `prepare-create` é somente leitura e registra preparação limitada/temporária, com hash de proposta, perfil, preset, modelo, política, configuração, módulos e fatos de caminhos.
- `create-session` exige grant próprio, separado do grant de send, com MAC sobre identidade do processo/bridge, preparação/hash, nonce e TTL. A preparação inclui IDs e literal; não existem campos `confirmed`/grant aceitos do modelo.
- Host revalida antes dos efeitos, publicação e admissão. Fences bloqueiam requests/tools não aprovados durante startup.
- Journal durável e reserva anterior ao efeito; nonces e IDs não são reusados como autorização. Preparação pode expirar enquanto se aguarda aprovação: erro explícito, sem replay de aprovação antiga.
- Perda de resposta após dispatch é UNKNOWN, nunca confirmação de que nada aconteceu. `status` lê o recibo do chamador; não reexecuta. Sem retry automático, rollback destrutivo, delete/archive ou remoção de lock incerto.

Ledgers: owner Companion em `~/.dsh/session-create/profile-dsh-tui`; destino em `<bridge-root>/profile-create-ledger`. Não migrar recibos legados nem reutilizar aprovação salva. `operation_id` é restrito ao caller. IPC de criação tem timeout30s; timeout não cancela um efeito já admitido. Send/read conservam seus protocolos e limites anteriores.

## Skills no Companion (plano128)

O bundle web desativa `skill-filesystem` e `tool-skill` globais. Ambos foram adicionados **dentro do preset Companion**, no perfil instalado e no gerador, sem mudar modelo/permissões. O provider usa `customSkillDirs` para `/home/alex/git/my/dsh-companion-workspace/.agents/skills`, inclusive quando a sessão está em um projeto filho com `.git` próprio. O próprio `tool-skill` entrega a ferramenta e a mensagem `skill-catalog`.

O arquivo de instruções original é `~/.dsh/AGENTS-Companion.md`. `~/.dsh/Companion/AGENTS.md` é seu link necessário ao loader, não uma cópia duplicada.

## Validação e ativação

```sh
env SESSION_RESUME_REAL=0 node --test plugins/session/*.test.mjs plugins/session-create/*.test.mjs tools/session-companion/profile.test.mjs tools/session-companion/companion-skills.native.test.mjs
```

As fixtures usam armazenamento/identidades isolados e adapter fake, sem chamadas a modelos externos. Cobrem owner approval, contratos fechados, ambiguidades, perfis incorretos, adulteração/replay/drift, UNKNOWN, SDK AgentLoop/preset/policies/writer e criação via Unix IPC real. A fixture de destino é um perfil dsh-tui sintético com preset standard real montado, não boot completo do inventário de plugins instalado pelo usuário.

O teste de skills verifica tool schemas, quatro chamadas pela API pública e `skill-catalog` no primeiro request fake, em raiz e child repo. Isso é mais forte que apenas descobrir arquivos com um provider isolado, mas não é uma afirmação de inspeção de cada sessão já aberta.

Não foi forçado restart. O perfil Companion tem reload live de configuração; processos TUI com bridge antigo precisam de nova carga. A checagem somente leitura em `.dumps/companion-guides/live-capabilities.json` registrou zero hosts compatíveis naquele instante. Não foi criada/enviada nenhuma sessão de produção para testar ativação.
