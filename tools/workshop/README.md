# Oficina portátil: fontes → artefatos → runtime → perfis

A oficina descreve como montar um DSH novo sem depender do npx ou dos diretórios
ativos de outra máquina. Ela **não** sincroniza `.dsh`, não importa credenciais,
não assume que os profiles do dotfiles já foram instalados e não reinicia serviços.

## Fonte de verdade

- `manifest.json`: pacote/versão DSH, repositórios HTTPS e commits completos,
  package managers, patch TUI com SHA256 e estratégias revisadas.
- `../task10-frontend/recipe.json` + `frontend.patch`: base upstream `c2eee952…`
  mais o delta completo até `c4f040104e9d45955ed346ce0b1a2d8cb2fab779`.
  Esse patch substitui o snapshot antigo de 13 arquivos por 32 arquivos,
  incluindo as extensões de gramática e os contratos de planos já commitados.
- pi-ai: `c043dedb60695f45fd9577ced676074f08d7f9b0` é o baseline portátil da correção
  de reasoning implícito, não o pin atualmente implantado no host. A tarefa 26
  promoveu `f5a24c96d72732ba63aeca9a02295c320db04c2d` / artefato `206545bfd51e`;
  essa promoção não muda automaticamente a receita portátil nem seus pins.
- Antigravity: `7dcd24272a0897cb0698b24cc9edc0a587c3bea7`; `lib` está commitado.
  A estratégia atual é **committed-prebuilt**, não um source rebuild standalone.
  Um patch versionado/hashado torna opcional o peer legado `dsh-client-runtime`,
  usado somente em tipos/testes/client injection, não importado pelo JavaScript
  compilado. O executor recusa um bundle que passe a referenciá-lo em JS. Isso
  permite instalar o provider host/TUI sem puxar o runtime npm incompatível
  `0.0.1-rc.1`; **não comprova compatibilidade do client web**.

Os checkouts locais continuam sendo oficinas Git separadas. Não fazemos
`reset`, commit, push ou captura automática de todos os untracked. Atualizar o
pin/patch da receita é uma decisão explícita, não consequência de mudar HEAD.

`reproduction.status: ready` indica que há uma estratégia registrada, não
atestação de compilação completa, acesso remoto ou autenticação de providers.
Leia `reproduction.reason` e as limitações do doctor.

## Modos e efeitos

| Comando | Efeito |
| --- | --- |
| Sem argumentos / `--doctor` | Metadata/hashes/prerequisites, somente leitura |
| `--plan --destination ABS` | Plano de comandos e paths, sem criar destino nem executar comandos |
| `--prepare --destination ABS` | Cria destino ausente com snapshot, plano, seed e receipt `prepared`; nenhum install/build |
| `--bootstrap --destination ABS --allow-network --allow-build` | Instala/compila/empacota **somente** dentro do staging novo |
| `--help` | Uso, sem inspeção ou escrita |

`--json` mantém saída machine-readable. O doctor não importa módulos de providers,
não monta plugins, não chama DSH boot/dump-config e não lê configs de perfil.
`git`/`npm` são conferidos no PATH por metadata; o doctor não chama seus scripts.

Flags desconhecidas, modos combinados, consentimentos ausentes e receitas
bloqueadas/mismatched falham antes de reservar um destino. `--prepare` e
`--bootstrap` **não são fases retomáveis do mesmo diretório**: ambos exigem um
alvo ausente. Uma preparação é para revisão; a execução usa outro alvo novo.

## Paths e proteção

O repo resolve pelo próprio módulo. HOME, XDG_DATA_HOME e DSH_HOME determinam os
roots protegidos, sem `/home/alex` fixo. O destino exige caminho absoluto, pai
existente/canônico e reserva exclusiva (0700). Overwrite, diretórios ocupados,
links inclusive quebrados, parents não canônicos, traversal e overlap com fontes,
`.dsh`, runtime atual ou ancestrais HOME são recusados. Também se protegem configs/
caches (`.config`, `.cache`, `.npm`, incluindo npx), os roots equivalentes explícitos
no ambiente e qualquer outro worktree Git encontrado nos ancestrais por metadata.
A exceção `.dumps` desta oficina não autoriza targets dentro de outro Git aninhado.

O doctor vincula nomes/versões/package managers aos três builders revisados e
confere todos os pins da receita TUI, incluindo o submodule. Alterar só metadata
para parecer uma versão nova falha antes de instalações; upgrade requer receita/
implementação/testes correspondentes.

Staging em `.dumps` é permitido para testes. **Não ative um resultado de `.dumps`.**
Para instalar numa máquina nova, use armazenamento persistente, por exemplo um
novo diretório sob `$HOME/.local/share`. Não use o root protegido `dsh-cli` ativo:
a promoção/consolidação desse root é uma operação separada com backup/rollback.

São guards de tooling, não sandbox de código Git/dependências nem garantia contra
alterações adversariais simultâneas nos diretórios pais. Não execute em checkouts
não revisados, nem modifique o staging enquanto os comandos estiverem rodando.

## O que o bootstrap executa

1. Reserva target novo e grava manifesto/plano/receipt antes de instalações.
   Antes dos subprocessos, cria HOME/DSH_HOME/XDG e caches/temporários privados
   sob o target, configura npm/pnpm para usá-los e usa configs npm/Git vazias.
   Redirects herdados de package managers/Git são filtrados; não reutiliza seus
   hooks/configs pessoais nem caches da máquina. PATH preserva executáveis do
   sistema e proxies/CA explícitos continuam disponíveis; isto não é sandbox.
2. Instala runtime seed `@deepseek-ai/dsh@0.2.0-rc.2`, npm `12.2.0`, pnpm `11.21.0`
   e catálogo donor oficial `@earendil-works/pi-ai@0.87.1`, com install scripts
   desabilitados. A CLI inicial usa o npm da máquina; versões efetivas são registradas.
3. TUI: clone/base detached/submodule pin, `git apply --check` + apply, install
   frozen/ignore-scripts, compile revisado, smoke import de UI e `npm pack`.
   Não executa a enorme suíte upstream e não escreve `lib` do checkout em uso.
4. Pi: clone detached do baseline portátil, `npm ci --include=dev --ignore-scripts`,
   compile telemetry/AI e pack usando o catálogo **do seed novo**. O terceiro
   argumento posicional de `../pi-ai-fork/prepare.mjs` escolhe a raiz de artefatos.
5. Antigravity: clone detached do pin, patch peer opcional check/apply, `lib` tracked
   inalterado e sem import JS do peer legado, depois `npm pack --ignore-scripts`.
   Não chama `npm run bundle`, cujo workspace upstream não está presente.
6. Verifica nome/versão dos tarballs e hashes. Instala o override pi **escopado ao
   adapter** `@deepseek-ai/dsh-llm-pi-ai@0.2.0-rc.2`, mantendo peers do host, e o
   pacote Antigravity no runtime novo. Não usa legacy-peer-deps para esconder
   divergências do host.
7. Confere manifests/runtime e identidades compartilhadas de Cordis/scope por
   paths, sem importar providers ou autenticar. Sela o hash do package-lock.

Os `build.commands` do manifesto são descrição legível. O executor aceita apenas
as três estratégias implementadas/revisadas; não executa shell arbitrária enviada
pelo manifesto. Placeholders `<...>` são apenas documentação, não interpolação.
A estratégia Pi encapsula seus comandos de staging no helper.

O catálogo donor upstream não reproduz automaticamente modelos locais acrescentados
nesta máquina, como aliases/metadata personalizados. Esse delta é configuração ou
uma futura receita de catálogo explícita; não copiamos silenciosamente arquivos do
runtime ativo. Mesmo fixando fontes/deps diretas, o primeiro npm resolve transitivas:
receipts/locks atestam a instalação produzida, não equivalência bit-a-bit futura.

O helper Pi inclui o `LICENSE` MIT completo do upstream no novo tarball e registra
seu SHA256 na proveniência. Recusa qualquer diretório de saída source/catalog já
existente, completo ou parcial, antes de staging/compilação. Repetir a preparação
exige outra raiz de artefatos explícita. Tarballs/receipts históricos e o binário
`206545bfd51e` instalado permanecem imutáveis; esta correção de empacotamento só
vale para novas preparações e não atualiza evidências antigas.

## Estrutura e receipts

```text
DEST/
  manifest.json        snapshot da receita
  plan.json            comandos e destino revisados
  receipt.json         estado/proveniência/hashes/resultados
  runtime/             package.json, lock e dependências instaladas
  sources/{tui,pi-ai,antigravity}/
  artifacts/{tui,pi-ai,antigravity}/
```

Status `prepared` não significa installed. `bootstrapped` significa que os
contratos de artefatos/instalação desta ferramenta passaram; `profileActivated`
permanece false. A falha deixa `status: failed`, o command ID/exit code e arquivos
parciais para inspeção. O executor não armazena stderr arbitrário de dependências
que possa conter informações sensíveis, não apaga nem tenta reparar o target.
Não reutilize o diretório falho como se estivesse completo.

Artifacts e receipts de uma instalação mantida devem ficar em storage durável.
Não mova um staging depois da instalação: `file:` paths absolutos e locks fazem
parte do grafo. Uma promoção precisa recalcular/reinstalar em destino final e
validar tudo de novo, não apenas fazer `mv`.

## Nova máquina e dotfiles

```fish
# No checkout da oficina, após restaurar configs pelo seu dotfiles:
npm ci --ignore-scripts
npm run workshop:doctor
set WORKSHOP "$HOME/.local/share/dsh-workshop-rc2"
node tools/workshop/bootstrap.mjs --plan --destination "$WORKSHOP" --json
node tools/workshop/bootstrap.mjs --bootstrap --destination "$WORKSHOP" --allow-network --allow-build --json
```

Depois revise o receipt e o tarball TUI em `artifacts/tui/receipt.json`. O runtime
está em `$WORKSHOP/runtime`; a CLI é `runtime/node_modules/.bin/dsh`. A receita
não troca PATH/aliases fish nem o serviço web. Seus launchers devem ser ajustados
no dotfiles para a instalação escolhida, sem npx móvel.

Antes de lançar, instalar o bundle TUI no perfil restaurado é uma etapa explícita:
revise o comando `plugin --profile dsh-tui add` da CLI fixada com o tarball correto,
lock/peer identity e configs externas. O bootstrap não chama esse comando porque
poderia mudar um perfil pessoal existente. Só depois gere o wiring com
`node tools/activate.mjs --check --profile dsh-tui` e o `--write` deliberado.
Referências não `alex-*` (login Antigravity, modelos/paths locais) continuam sob
controle do dotfiles e exigem revisão na nova máquina.

Credenciais OAuth/login não estão nos tarballs. Configure-as pelo mecanismo normal
em separado; nenhum teste de bootstrap comprova Google login ou inferência Codex.

## Atualizar a receita

- Fork TUI: escolher commits, gerar delta do base até fork aprovado e revisar
  arquivos; atualizar SHA em `task10-frontend/recipe.json` e no manifesto juntos.
  Não gerar `git diff HEAD` de checkout clean achando que isso inclui commits locais.
- Pi: promover nova correção validada com pin explícito; não selecionar branch/HEAD
  em revisão. Catálogo/proveniência deve ser escolhido e registrado.
- Antigravity: fonte pode ser empacotada do pin atual, mas source rebuild requer
  tarefa própria para resolver o workspace ausente. Não marcar isso como compilação.
- Recipe/hash mudado invalida receipts de preparação anteriores. Não atualize
  receipts antigos à mão para fazê-los passar.
- Para que um clone remoto leve esta base, alterações/testes/lock/recipes precisam
  ser commitados e enviados pelo proprietário. Nesta tarefa não há commit/push.

## Validação

```fish
npm run test:workshop
```

Fixtures persistidas exercitam manifest/pins/hash/paths, reserva concorrente,
defaults sem subprocessos/writes, preparação exclusiva, comandos simulados,
tarballs errados, falhas parciais e identidades peers divergentes. Não confundem
simulação com instalação real. Evidências dos ensaios reais ficam em `.dumps` e
são reportadas separadamente; não constituem backup de produção.

A limpeza da tarefa 7 só vem depois de validação da oficina, backup persistente,
migração dos links/adapter scratch/serviço web e aprovação da retirada do root npx.
Runtimes atuais e dados privados permanecem intocados nesta etapa.
