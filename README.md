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

**Antigravity ainda não tem compilação standalone portátil.** Seu build espera
arquivos do workspace upstream ausentes neste clone; empacotar o código já
compilado não é o mesmo que reconstruí-lo da fonte. O empacotamento aplica um
patch hashado para tornar opcional um peer legado usado só por tipos/client.
Isso permite a instalação host/TUI, mas não comprova integração do client web.

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
