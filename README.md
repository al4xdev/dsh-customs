# dsh-customs — oficina reproduzível do DSH

Este repositório é a base para reconstruir a oficina de Alex em outra máquina:
fontes dos plugins, receitas dos forks, builds, artefatos e ligação aos perfis.
Não é um backup da máquina nem um segundo lugar para guardar configurações pessoais.

## Divisão de responsabilidades

| Lugar | Responsabilidade |
| --- | --- |
| **dsh-customs** | Plugins, versões/pins, patches, ferramentas de preparação/build e wiring gerado |
| **dotfiles** | Configurações pessoais de `.dsh`, providers, preferências e launchers da shell/serviços |
| **Instalação DSH** | CLI e grafo de dependências produzido pela receita |
| **Dados privados** | Sessões, attachments, credenciais e OAuth; não entram no manifesto nem no bootstrap |

Os forks são repositórios separados. Não os absorvemos automaticamente no Git
principal. O manifesto registra como reconstruí-los; mudanças ainda não commitadas
neste checkout não aparecem magicamente num clone remoto.

## Mapa do repositório

- `plugins/`: plugins locais. `plugins/activation.json` é a lista única de ativação.
- `tools/workshop/manifest.json`: versões exatas, fontes/pins e estratégias da oficina.
- `tools/workshop/bootstrap.mjs`: doctor sem efeitos, plano, preparação e bootstrap explícito.
- `tools/task10-frontend/`: receita TUI upstream + patch das extensões locais commitadas.
- `tools/pi-ai-fork/`: build/validação da correção pi-ai; ferramentas antigas de promoção
  têm escopo desta máquina, não são instaladores universais.
- `tools/activate.mjs`: gera somente os blocos gerenciados `alex-*` nos perfis.
- `frontend/dsh-tui/` e `plugins/dsh-antigravity/`: checkouts locais separados, gitignored.
- `.plan/`: histórico de tarefas. `.dumps/`: evidência/fixtures locais, gitignored.

## Nova máquina: sequência segura

Requisitos da receita atual: Node **24+**, Git, npm e toolchain do frontend.
Configurações devem ser restauradas pelo **dotfiles**, conforme o README dele.
Não copie sessões/credenciais por meio desta receita.

```fish
git clone https://github.com/al4xdev/dsh-customs.git ~/git/my/dsh-customs
cd ~/git/my/dsh-customs
npm ci --ignore-scripts
npm run workshop:doctor
```

O doctor valida a receita e os hashes; não inicia o DSH, não conecta providers,
não lê configs privadas e não instala nada. `ready: true` significa **receita
consistente**, não build completo ou aceitação interativa comprovados.

Escolha um destino **novo**, cujo diretório pai já exista. Não use a instalação
ativa ou `.dsh`. A receita protege esses caminhos e recusa overwrite:

```fish
set WORKSHOP "$HOME/.local/share/dsh-workshop-rc2"
node tools/workshop/bootstrap.mjs --plan --destination "$WORKSHOP" --json
# Somente depois de revisar o plano; usa rede e compila fontes:
node tools/workshop/bootstrap.mjs --bootstrap --destination "$WORKSHOP" --allow-network --allow-build --json
```

`--prepare` cria apenas plano/manifesto/seed em um destino ausente, sem executar
comandos. Ele **não instala** e **não pode depois ser reutilizado por --bootstrap**:
os dois modos exigem destinos novos distintos. Não apague staging parcial para
esconder falhas; preserve seu receipt e escolha/revise uma nova tentativa.

O resultado separa `runtime/`, `sources/`, `artifacts/` e `receipt.json`. Artefatos
usados numa instalação precisam permanecer em **armazenamento durável**, não em
`.dumps`. Aqui `.dumps` é usado somente para ensaios, nunca para ativação nova.

**Perfis não são ativados automaticamente.** O bootstrap prepara a CLI com o
pi-ai corrigido e o pacote Antigravity, além do artefato TUI. Instalar o bundle
TUI nos perfis restaurados, gerar wiring e ajustar launchers do dotfiles são
etapas explícitas posteriores. Ver [o guia da oficina](tools/workshop/README.md).

## Receita atual e limites

| Componente | Receita |
| --- | --- |
| DSH | `@deepseek-ai/dsh@0.2.0-rc.2` |
| TUI | Base `c2eee952…`, patch completo equivalente ao fork local `c4f04010…`, pnpm `11.21.0` |
| pi-ai | Baseline portátil `c043dedb…`, baseada em `0.87.1`, com correção de reasoning implícito; não segue HEAD |
| Antigravity | Fork `7dcd2427…`, versão `0.1.0-rc.5`, exportação de `lib` já commitado |

O host desta máquina já usa a promoção separada da tarefa 26: fonte `f5a24c96…`
e artefato pi-ai `206545bfd51e`. Isso não atualiza os pins da oficina automaticamente.

A tarefa 32 acrescenta `retryPolicies` por provider ao OAuth do fork TUI local;
no perfil desta máquina, Codex usa modo normal, nove retries e backoff de 5s
até 20min (última espera real 18–20min com jitter; 41min15s nominais acumulados,
além das requisições). O motor oficial continua dono de orçamento e cancelamento.
A etapa32 não muda os outros providers; a extensão Antigravity36 descrita abaixo
configura sua política separadamente. Essa extensão local não está nos pins
TUI/patch históricos acima; o checkout tem mudanças não publicadas. Não alegue
reprodução da configuração atual só com o doctor/baseline portátil. Candidato e
receipts de validação/promoção são separados, sem reempacotar artefatos antigos.

A tarefa 33 acrescenta usage ao fork Antigravity local: `/antigravity-usage`
mostra percentuais reportados por modelo, reset e janela desconhecida;
`/antigravity-usage --refresh` ignora o cache de 60s. É metadata sob demanda,
sem inferência, polling ou alteração de retry/billing; o serviço host
`antiGravityUsage` aplica deadline de 10s, limites de resposta e invalidação de
credenciais. A promoção local usa bundle host/declarations compilados em candidato
isolado e backup durável; recomenda processo TUI novo para carregar módulos de
forma reproduzível, sem reinício automático.
Isso não atualiza o pin Antigravity/tarball histórico acima nem comprova painel
web ou uso sem créditos. Preferências de overages do cliente oficial não são
herdadas automaticamente pelo fork.

As tarefas36/42 acrescentam resiliência compartilhada Claude/Gemini ao fork
Antigravity local: SSE limitado, falhas tipadas sanitizadas, associação de
assinaturas por bloco lógico e bridge request-local para o motor oficial.
A política Antigravity deste perfil é normal9, 5s–20min com jitter0.1; Search,
catálogo, contas e créditos não são rotacionados. `enabledCreditTypes: []` é
validado no cliente, sem promessa universal de billing pelo servidor.

V4 passou 310 testes de pacote e 26 casos native-loop, compilação host isolada,
14 declarações e consumer público; root contracts 76/76 + grammar config e wiring
YAML público do perfil também passaram. O teste real Claude aceitou cinco respostas
de código e um follow-up com replay na mesma sessão; quatro respostas atingiram
o teto16k, portanto não provam código completo ou executado. Gemini foi comparado
offline. A sequência parou no primeiro429 real: `RATE_LIMIT`, hint373203889ms
(~4,32dias), maior que o cap20min, logo zero retries oficiais — fail-fast correto.
Saldo final ausente permanece desconhecido, não0%; janela e recuperação positiva
após reset não foram comprovadas. Counters18/26/2 respeitaram32/40/4 e45min ativos.
A causa do400 anterior continua desconhecida, apesar do bug lógico demonstrado.

A promoção V4 substituiu somente `lib/index.js` compilado, com backup durável,
comparação de hashes e rollback que recusa edições posteriores; quatro declarações,
21 outros outputs e seis outputs TUI foram preservados. Nada atualiza os pins da
oficina nem constitui nova publicação. Ver [documentação do fork](plugins/dsh-antigravity/README.md#official-retry-policy-and-validated-local-rollout)
e o [resultado local](.dumps/antigravity-resilience-20261013/promotion-live-result-v4.md).
Hot-mount de selfheal foi observado num perfil existente, mas não limpa caches SDK;
idade do processo não prova ausência de todos os hooks. Recomenda-se TUI/worker novo
para provar carregamento; não houve restart automático. A tarefa43 corrigiu e
publicou selfheal V2: max3 por episódio consecutivo, renovado por progresso saudável
causal ou retomada humana autenticada, não por mensagens artificiais/reload.
Source96 e native50+4 em source/bundle passaram; três gates da entrada física
configurada observaram audit policyVersion2 em processo próprio novo, sem afirmar
upgrade de TTYs já abertos. O bundle novo contém toda a lógica; após possível
ativação V2, restaurar bytes V1 não é downgrade seguro de checkpoint. Ver o
[resultado local](.dumps/agent-self-heal-20261013-v2/promotion-result-v2.md).

**A baseline portátil continua separada do build host local validado.** O build
monorepo padrão Antigravity espera arquivos upstream ausentes neste clone; a receita
histórica empacota `lib` commitado e aplica patch hashado para tornar opcional um
peer legado usado só por tipos/client. O build host isolado recente usa ferramentas
em cache e dependências desta instalação, não comprova bootstrap universal,
integração client web, todas as versões LTS ou estabilidade de longo prazo.

O catálogo usado pelo novo build pi-ai vem do DSH seed isolado, não do catálogo
alterado desta máquina. Providers/modelos pessoais devem ser configurados
explicitamente. O primeiro install npm ainda resolve dependências transitivas;
o lock e hashes resultantes são registrados, sem promessa bit-a-bit entre datas.

## Ativação dos plugins

Após instalar os bundles corretos e restaurar os perfis pelo dotfiles:

```fish
node tools/activate.mjs --check --profile dsh-tui
# Revise o drift antes da escrita:
node tools/activate.mjs --write --profile dsh-tui
```

A geração resolve caminhos pelo checkout atual e preserva os bytes dos blocos
não gerenciados, incluindo comentários/configs por máquina. Não clona forks,
compila, instala bundles nem cria automaticamente perfis ausentes. A dependência
`yaml` é local e fixada no lock deste repositório; não depende de um antigo npx.

Opções: `--profile NAME` (repetível), `--root DIR`, `--json`, `--check`, `--write`.
Sem `--profile`, o sync também pode atualizar o overlay do repositório.
Manifestos inválidos, módulos ausentes e múltiplos blocos gerenciados separados
são reportados; não se tenta adivinhar a configuração.

## Estado da consolidação desta máquina

A instalação local já executa as TUIs. O web ainda usa npx, e muitos links dos
perfis dependem daquele cache. Existe também referência ativa a um adapter antigo
em `.dumps`. **Nada disso pode ser limpo só pelo nome da pasta.**

A tarefa 7 permanece aberta: provar reprodução primeiro, depois migrar dependentes
com backup persistente/rollback e aprovação dos alvos; só então retirar duplicação.
Não há `npm cache clean`, remoção automática, promoção live ou restart no bootstrap.

## Browser nativo

`plugins/browser` implementa uma única tool hierárquica `browser`, com Playwright
estável1.64.0 público e worker SDK2 privado. Sessões/Pages pertencem ao Agent;
screenshots, mobile, vídeo e trace usam artefatos próprios, sem código livre da LLM
ou dependências no produto. Consulte [contrato e preparação](plugins/browser/README.md).
A ativação continua controlada pelo manifest e pelos gates de smoke dos perfis;
existência do módulo ou um doctor pronto não comprova rollout.

## Validação

```fish
npm run test:workshop
npm run test:lts:contracts
npm run test:project-mcp
npm run test:managed-plans
npm run browser:doctor
npm run test:browser
npm run test:browser:live
```

Os testes da oficina usam fixtures isoladas e comandos controlados; não substituem
um build real ou teste manual dos perfis. A documentação em `tools/task10-profile/`
registra provisionamento/promoção históricos e suas restrições, não uma promessa de
instalação universal nem permissão de alterar o runtime ativo.
