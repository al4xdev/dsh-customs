# Instalação DSH limpa em Docker

Build limpo concluído e básicos offline aprovados. Imagem `alex-dsh-clean:20261013-current`, construída do commit central `98f3882356767c6d010824633ba459d316e9b814`. Não usa `~/.dsh`, caches, `node_modules` ou runtimes da máquina como entrada. O Dockerfile clona a raiz pública central por commit exato e os forks por pins; o build context local só permite o Dockerfile.

## Mudanças na receita depois do commit validado (2026-10-16)

O build acima é do `98f3882`; **o Docker não foi refeito depois destas mudanças**,
que a instalação no host (`tools/clean-install/host.mjs`, mesma receita) exercitou:

- `096bd6f` fazia `install.mjs` quebrar já no import numa máquina limpa (`profile.mjs`
  → `tools/resilience/profile.mjs` carrega `yaml` no load). Agora `profile.mjs` é
  importado só no passo de seed, quando o runtime já tem `yaml`.
- `@deepseek-ai/cordis` 4.0.5 saiu depois do build: o `dsh` (`~4.0.4`) aninhava uma
  segunda cópia e o `sharedGraph` recusava. O runtime agora fixa `cordis` 4.0.4 por
  override, a versão exata que o Antigravity exige e a mesma do lab.
- Pin do TUI: `ebea5d7` → `4d0b808` (branch `custom` do lab: + favoritas globais e
  ownership de questions), compilado e com `verify:oauth` aprovado no host.

## Compilação

- TUI: fork `al4xdev/dsh-TUI`, commit `ebea5d738481bbc7c35006410ad9ce1a998dc883`, submodule fixo e build de fonte com pnpm11.21.0.
- Pi: snapshot recuperado agora versionado em `sources/pi-ai`, sem Git HEAD inventado; deps de lock, compilação completa telemetry/AI com patch observer38, catálogo público versionado e correção Codex.
- Antigravity: fork `al4xdev/dsh-antigravity`, commit `77c0c0fe39c0ddfa9647400db6d4726720aa7852`; host JS compilado por esbuild0.28.2. **Tipos/client/typert auxiliares continuam prebuilt commitados**: não é anunciado como build de todos os exports.
- Self-heal: bundle recompilado das fontes atuais, incluindo persistência; bridge SDK50 aplicado a apenas dois catálogos oficiais com hashes de base conferidos.
- DSH0.2.0-rc.2 instalado em `/home/alex/.local/share/dsh-cli`; shared Cordis/scope/Pi devem ter uma única identidade física. Perfil público novo em `/home/alex/.dsh/profiles/dsh-tui`; nenhuma sessão/configuração privada é copiada.

Base Node24 Debian/glibc com digest fixo. Os compiladores/managers são explícitos. A resolução inicial das dependências do runtime ainda gera um novo lock; igualdade de todas as transitivas com o host precisa ser medida, não presumida.

## Reproduzir pelo terminal fish

O container validado já está rodando, sem mounts do host. Para entrar:

```fish
docker exec -it --user alex alex-dsh-clean-current-c6aa8602 fish
```

Para reproduzir em outro container a partir do commit publicado e validado:

```fish
cd /home/alex/git/my/dsh-customs
docker build --build-arg ROOT_COMMIT=98f3882356767c6d010824633ba459d316e9b814 -f docker/clean/Dockerfile -t alex-dsh-clean:20261013-current .
docker run -d --init --name alex-dsh-clean-manual alex-dsh-clean:20261013-current
docker exec -it --user alex alex-dsh-clean-manual fish
```

`docker run` deve criar um container novo. Se esse nome já existir, use o container existente ou escolha outro nome; não remova containers aleatórios.

Já dentro do container:

```fish
cd /home/alex/git/my/dsh-customs
node /home/alex/.local/share/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js --profile dsh-tui
```

A inicialização interativa, login e qualquer prompt com inferência são **ações manuais suas**, fora dos testes automáticos. Não há systemd nem servidor de modelo local do host embutidos no container. Browser/headless libraries e serviços auxiliares precisam de validação específica antes de afirmar equivalência completa.

## Credenciais Codex

Nenhum OAuth foi localizado por busca ampla, lido, publicado, copiado para o build ou colocado numa imagem. O caminho oficial da TUI é `$DSH_HOME/dsh-auth/credentials.json` (ou `DSH_AUTH_CREDENTIALS`), com um `device-id` adjacente. Esse arquivo pode conter mais de um provider e o refresh pode escrevê-lo; **um bind mount read-only não garante login/refresh funcional**.

Prefira fazer o login manual dentro do container. Se você optar por reutilizar uma credencial existente, essa será uma etapa separada e explicitamente delimitada, nunca um `COPY ~/.dsh` ou montagem do home inteiro. Não forneça tokens no chat, build args, Git ou logs.

## Evidências e limites

Os recibos de fonte/build/artefatos/versões ficam em `/home/alex/.local/share/dsh-cli/artifacts/` e `clean-install-receipt.json`. Os testes de receitas usam fixtures temporárias sem contas. A captura/comparação pública lê somente manifests e código selecionado, não configs, OAuth ou histórico.

**Estado da execução real:** aprovado nos básicos offline.

- Imagem: `sha256:cdba98d0382e88de7d31a3d71f8d753d0b3eefaab7453611339ef9902ad9ec16`; container `alex-dsh-clean-current-c6aa8602`, rodando com zero mounts.
- 54 testes das receitas passaram. No container: SDK50 aceita o evento sintético `agent/self-heal`, rejeita evento obrigatório desconhecido; observer38 classifica quota/rate limit, sanitiza fatos e descarta listener; probe de compatibilidade self-heal passa. Isso é validação em memória, não replay de sessões reais.
- CLI TUI `--version` retorna 0.14.0 sem boot; `node-pty` executou `printf` com saída `pty-ok`, exit 0.
- Comparação com captura atual do host: 11 versões iguais, todas as fontes selecionadas iguais e todos os hashes selecionados iguais exceto o bundle Antigravity. Nele, somente 17 comentários trocam o prefixo de scratch `.dumps/.../source/src/` por `src/`; após essa transformação específica, todos os demais bytes coincidem. Código executável equivalente; igualdade bruta permanece **false**, sem normalização genérica.
- Cordis/scope/Pi dos pacotes instalados compartilham a identidade canônica. Dependências de desenvolvimento do fork TUI do host foram reportadas separadamente: não são prova da ativação de perfis nem de construtores em um daemon vivo.
- Evidências públicas locais, ignoradas pelo Git: `.dumps/docker-dsh-52/host-public-v3.json`, `container-current-public.json` e `code-comparison/antigravity-comment-proof.json`. Capturas anteriores foram preservadas: houve alterações concorrentes dos artefatos TUI e do fork AG durante a validação.
- Credenciais/OAuth/histórico lidos ou copiados: **nenhum**. Chamadas de modelos: **zero**. Inicialização interativa e autenticação permanecem testes manuais.

A fonte nova de quota-reset Antigravity está presente, mas **desligada por padrão**. O executor separado e a política privada do host para esperar até 24h não foram habilitados/copiados. Configuração pessoal, servidores locais, browser, systemd e funcionamento de providers autenticados não fazem parte da equivalência comprovada aqui.
