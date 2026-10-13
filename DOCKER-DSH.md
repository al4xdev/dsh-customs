# Instalação DSH limpa em Docker

O primeiro build limpo foi concluído e passou nos básicos offline. O pin Antigravity está sendo atualizado após uma alteração concorrente do fork durante a comparação. Não usa `~/.dsh`, caches, `node_modules` ou runtimes da máquina como entrada. O Dockerfile clona a raiz pública central por commit exato e os forks por pins; o build context local só permite o Dockerfile.

## Compilação

- TUI: fork `al4xdev/dsh-TUI`, commit `ebea5d738481bbc7c35006410ad9ce1a998dc883`, submodule fixo e build de fonte com pnpm11.21.0.
- Pi: snapshot recuperado agora versionado em `sources/pi-ai`, sem Git HEAD inventado; deps de lock, compilação completa telemetry/AI com patch observer38, catálogo público versionado e correção Codex.
- Antigravity: fork `al4xdev/dsh-antigravity`, commit `77c0c0fe39c0ddfa9647400db6d4726720aa7852`; host JS compilado por esbuild0.28.2. **Tipos/client/typert auxiliares continuam prebuilt commitados**: não é anunciado como build de todos os exports.
- Self-heal: bundle recompilado das fontes atuais, incluindo persistência; bridge SDK50 aplicado a apenas dois catálogos oficiais com hashes de base conferidos.
- DSH0.2.0-rc.2 instalado em `/home/alex/.local/share/dsh-cli`; shared Cordis/scope/Pi devem ter uma única identidade física. Perfil público novo em `/home/alex/.dsh/profiles/dsh-tui`; nenhuma sessão/configuração privada é copiada.

Base Node24 Debian/glibc com digest fixo. Os compiladores/managers são explícitos. A resolução inicial das dependências do runtime ainda gera um novo lock; igualdade de todas as transitivas com o host precisa ser medida, não presumida.

## Reproduzir pelo terminal fish

Após os commits serem publicados e a validação abaixo concluída:

```fish
cd /home/alex/git/my/dsh-customs
docker build --build-arg ROOT_COMMIT=(git rev-parse HEAD) -f docker/clean/Dockerfile -t alex-dsh-clean:20261013 .
docker run -d --init --name alex-dsh-clean-c6aa8602 alex-dsh-clean:20261013
docker exec -it --user alex alex-dsh-clean-c6aa8602 fish
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

**Estado da execução real:** pendente. A documentação será atualizada com imagem/commit, componentes efetivamente construídos, smoke checks e diferenças concretas após o primeiro build limpo. Não confundir testes de fixtures com Docker validado.
