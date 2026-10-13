# DSH — locais após a limpeza

Levantamento desta máquina em 2026-10-13, após o proprietário aplicar o corte e a retirada dos runtimes antigos. `~` significa `/home/alex`; `repo` significa `/home/alex/git/my/dsh-customs`.

## Resumo

**Uma instalação executável ativa:** `~/.local/share/dsh-cli`. Os perfis resolvem **404 links** nesse runtime; resta um pacote local regular `dsh-llm-llamacpp`, preservado. Web e as TUIs reabertas usam o canônico. As cinco fingerprints estáticas do SDK/Pi preservadas foram verificadas sem importar providers.

Não foi apagado tudo que tem “DSH” no nome: configurações, sessões, fontes, provas de builds vencedores e o compilador ainda necessário não são lixo. Caches auxiliares e backups estão discriminados abaixo — não foram escondidos sob uma alegação de limpeza total.

## Onde ficou

Tamanhos arredondados de `du`, sem seguir os links dos perfis para somar o runtime outra vez. Dados privados foram inventariados por categoria/existência, não pelo conteúdo.

| Local | Finalidade | Tamanho observado | Estado/dono lógico |
|---|---|---:|---|
| `~/.local/share/dsh-cli/` | CLI, Cordis, SDK, Pi, peers e launcher runtime | 550 MiB | **Runtime canônico**; gerido por dsh-customs |
| `~/.local/share/dsh-cli/artifacts/` | Dois conjuntos de artefatos Pi usados pela instalação/manifestos | 1,7 MiB, já dentro do runtime | Preservar; não são outra instalação |
| `repo/frontend/dsh-tui/` | Fonte do fork TUI | — | Fonte canônica, checkout separado |
| `repo/plugins/dsh-antigravity/` | Fonte do fork Antigravity | — | Fonte canônica, checkout separado |
| `repo/sources/pi-ai/` | Fonte Pi recuperada e verificada | 30 MiB | **Snapshot sem Git HEAD**, não clone atualizado |
| `repo/plugins/` | Fontes e bundles customizados, incluindo self-heal/browser | 50 MiB | Fonte/artefatos; não limpar por nome |
| `repo/tools/` | Receitas, promotores, validadores e manutenção | — | Fonte canônica da operação |
| `repo/node_modules/` | Dependências das ferramentas da oficina | 15 MiB | Auxiliar reproduzível, mantido |
| `~/.dsh/profiles/` | Perfis, configuração e links de módulos | links shared: cerca de 1,6 MiB antes da retirada dos diretórios antigos | **Configuração `.dsh`**; política de ownership: dotfiles. 403 links shared + 1 adapter TUI vão ao runtime canônico |
| `~/.dsh/{sessions,storages,attachments,logs,cache,...}` | Dados operacionais, histórico e arquivos privados | não medido por categoria nesta auditoria | **Preservados**, não movidos nem reescritos |
| `~/.config/fish/functions/dsh.fish` | Comando `dsh` | pequeno | Aponta `$XDG_DATA_HOME/dsh-cli`, fallback `~/.local/share/dsh-cli`; arquivo regular |
| `~/.config/systemd/user/dsh-web.service` | Serviço web | pequeno | Executa o `bin.js` canônico; ativo |
| `~/.cache/dsh-browser/playwright-1.64.0/` | Browsers utilizados pelo plugin atual | 681 MiB | **Requerido**, caminho explicitamente configurado |
| `~/.cache/dsh-browser/runtime/` | Temporários/host files do browser | 14 MiB | Auxiliar operacional; conteúdo privado não inspecionado |
| `~/.cache/dsh-browser/task05-stable/` | Browsers dos testes | 681 MiB | **Ainda referenciado** em `plugins/browser/browser.test.mjs`; mantido |
| `~/.cache/dsh-browser/task05-spike/` | Experimento browser anterior | 674 MiB | Candidato a limpeza adicional; ausência de uso/referências não certificada |
| `~/.local/share/dsh-customs-backups/` | Backups anteriores e área de preservação | 5,0 GiB | Mantidos; não houve novo backup de lixo nesta limpeza |
| `/tmp/alex-dsh-trash-*/` | Itens descartados nesta sessão | ver lista abaixo | Descarte temporário; pode sumir no reboot |

A política é dotfiles possuir a configuração `.dsh`, e dsh-customs possuir fontes, builds, artefatos e receitas. **Não foi comprovado que os arquivos fish/systemd atuais já estejam rastreados no Git do dotfiles**: os arquivos locais foram verificados, não foi fingida uma migração Git.

Não há instalação DSH em `~/.local/state`, launcher `dsh*` em `~/.local/bin`, outro repositório `dsh*` em `~/git/my`, ou outro root npx com dependência direta DSH nos manifestos públicos encontrados. Dos 22 roots npx existentes, 19 tinham manifestos diretos e três estavam vazios; os demais pertencem a ferramentas diferentes e não foram apagados. Isso não é uma varredura irrestrita de todo arquivo do home.

## O que saiu agora

Cada retirada usou `trash`, com cópia verificada para `/tmp` e remoção da origem. Os caminhos antigos abaixo **não existem mais**.

| Origem retirada | Descarte temporário | Bytes regulares copiados |
|---|---|---:|
| `~/.npm/_npx/1e7f6d9597241db0` | `/tmp/alex-dsh-trash-1e7f6d9597241db0-znAnfK/item` | 446.890.778 |
| `repo/.dumps/pi-ai-fork/runtime-cc0c4b95b7145f89` | `/tmp/alex-dsh-trash-runtime-cc0c4b95b7145f89-cSEFI0/item` | 61.685.888 |
| `repo/.dumps/pi-ai-fork/runtime-030fcab313c8f8df` | `/tmp/alex-dsh-trash-runtime-030fcab313c8f8df-Wjq0Yp/item` | 61.308.940 |
| `~/.local/share/dsh-tui-cli` | `/tmp/alex-dsh-trash-dsh-tui-cli-acxnhV/item` | 0; diretório vazio |
| `repo/.dumps/pi-ai-fork/manager-check.mjs` | `/tmp/alex-dsh-trash-manager-check.mjs-DW8Qts/item` | 1.045; probe sintético aposentado |

Total regular desta retirada: **569.886.651 bytes (~543,5 MiB)**. Ocupação anterior arredondada no disco: npx509 MiB + scratch95 MiB + scratch95 MiB, aproximadamente **699 MiB**. Bytes de arquivos e blocos alocados não são a mesma medida. O descarte ainda ocupa `/tmp` (tmpfs); não é backup persistente.

Os dois helpers históricos `session-clone/{clone,discover}.mjs` passaram a importar do canônico. **Não foram executados**: nenhuma sessão foi clonada, lida ou alterada por eles durante a limpeza.

### Limpeza anterior já realizada

- 404 links foram redirecionados e 205 links já irresolvíveis foram retirados no corte aplicado pelo proprietário; recibo `/tmp/dsh-finish-7RjVD8/receipt.jsonl`.
- 597 diretórios de fixtures descartáveis foram enviados para os grupos `/tmp/alex-dsh-trash-obsolete-test-fixtures-20261013-9GeRg9/` e `/tmp/alex-dsh-trash-obsolete-test-fixtures-20261013-more-LiwJkg/`.
- `workshop-build-20261012` e `workshop-build2-20261012` saíram do workspace para quarentena persistente na etapa anterior: cerca de 3,9 GB retirados do workspace, **não bytes liberados do disco naquela etapa**.

## O que ainda está em `.dumps` e por quê

A oficina ainda contém artefatos de desenvolvimento. Não é outra instalação live, mas também não é um diretório inteiramente descartável:

| Local preservado | Tamanho observado | Motivo/limite |
|---|---:|---|
| `.dumps/workshop-build3-20261012/` | 2,8 GiB | Donor de compilador/dependências e baseline de workshop; não apagar o inteiro |
| `.dumps/pi-ai-fork/ws-review/` | 445 MiB | Snapshot original, dependências e proveniência; `.git` antigo não está saudável |
| `.dumps/pi-ai-fork/206545bfd51e-34a0a629dac6/` | 17 MiB | Artefato Pi vencedor/tarball/provenance |
| `.dumps/codex-failure-categories-20261013-candidate{1,2,3}/` | cerca de 16 MiB cada | Candidate3 vencedor; anteriores fazem parte da cadeia/evidência, não classificados para descarte nesta rodada |
| `.dumps/self-heal-persistence-20261013/` e bundles publicados self-heal | centenas de KiB | Melhorias de persistência atuais e prova de publicação |
| `.dumps/antigravity-resilience-20261013/` e demais provas AG | variável | Fontes/receipts da melhoria atual e cadeia anterior |
| `.dumps/tasks/` | 233 MiB | Evidência/artefatos de tarefas, classificação interna pendente |
| `.dumps/workshop-tui-replay-20261012/` | 68 MiB | Replays/evidência, não inspecionados internamente nesta rodada |
| `.dumps/overnight-audit-20261013/` | 67 MiB | Evidência, não classificada como descartável |
| `.dumps/antigravity-search-tools/` | 58 MiB | Scripts/fixtures/evidência, classificação adicional necessária |
| `.dumps/workshop-bootstrap-tests/` | 36 MiB | Fixtures restantes, não reclassificadas nesta rodada |
| `.dumps/task10-artifacts/` | 18 MiB | Artefatos de validação, preservados |
| Outros grupos de testes/provas `.dumps` | geralmente KiB a poucos MiB | Mantidos sem leitura de conteúdo privado |

**Limitação de reprodução:** `sources/pi-ai` preserva a fonte, mas não tem `.git` nem `node_modules/.bin/tsgo`. `tools/pi-ai-fork/prepare.mjs` ainda exige ambos para o build normal. Por isso o donor `workshop-build3` foi mantido; não foi afirmado que um clone limpo já reproduza todos os overlays do host. A baseline histórica também não é equivalente ao runtime atual.

Os caches browser stable/spike, os snapshots/artefatos da oficina e os 5 GiB de backups são os principais volumes remanescentes fora do runtime. Limpeza adicional exige separar compilador/evidência necessária e referências dos testes — não apagar tudo por ser grande.

## Validação curta pós-limpeza

```fish
cd /home/alex/git/my/dsh-customs
node tools/installation-consolidation/status.mjs
systemctl --user is-active dsh-web.service
```

Esperado: `state: "complete"`, `canonicalLinks: 404`, `localPackages: 1`, `codeProofs: 5`, `blockers: []`; serviço `active`. `status.mjs` não depende de npx/scratch aposentados, não importa providers nem encerra TUIs. `finish.mjs`/`cold.mjs` ficaram como procedimentos históricos e fixtures, **não repetir sua aplicação/preview nesta máquina limpa**.

A auditoria de referências cobriu perfis e superfícies públicas de lançamento, runtime canônico, ferramentas/plugins da oficina, dependências TUI e candidatos/artefatos/compilador selecionados. Nenhum consumidor ativo ou link externo para os três roots retirados foi encontrado. Uma varredura ampla de `.dumps` atingiu limite de entradas; a inspeção foi depois delimitada aos grupos relevantes e completada. Não houve leitura de env/credenciais/conteúdo de sessões, nem inferência ou teste de todos os providers. Não se afirma inspecionar módulos já fechados em memória.

**Fora do escopo:** frontend externo/mobile, Android/toolchains e protótipos companion; serviços `dsh-companion.service` e `dsh-mobile-companion.service` têm presença local, mas não foram migrados, apagados ou validados. Nenhum conteúdo deles foi utilizado para certificar esta instalação.
