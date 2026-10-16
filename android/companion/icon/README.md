# Ícone Companion — mesma maid do loading

O launcher usa **um quadro estático da mesma arte já empacotada no loading**. O loading continua animado; nenhum quadro, tempo ou código dele foi alterado. Não foi usada geração de imagem, rede, repaint, blur ou biblioteca instalada para esta conversão.

## Origem e integridade

- Quadro original: `app/src/main/assets/companion/maid/thinking/00.png`,301×288px, com alpha.
- SHA256 original: `c4132f28c128c06d86874f61e7ba7ae8b6d305708127879cbc36c6ed3e7e4319`.
- Arte fornecida pelo proprietário para uso pessoal neste app; não é logo oficial. Não se presume licença comercial ou autorização de republicação do pack original.
- Os32 arquivos originais de `assets/companion/maid` permanecem byte-idênticos. Digest ordenado de caminhos+SHA256: `79adf5586518472860e0f67eedd0f739da6c888eb5a2eb6c912d3678619391c6`.
- Foreground derivado: `app/src/main/res/drawable-nodpi/ic_companion_maid_foreground_pixels.png`,432×432px RGBA.
- SHA256 do foreground: `57f67d45a9b4a7ca165c06ba809ab91a470ccda3d21682d897416ac1b54471c4`.

## Receita offline

Python3 padrão +ImageMagick já disponível. A partir da raiz do repositório:

```fish
uv run --no-project --offline python android/companion/icon/generate_maid_icon.py
uv run --no-project --offline python android/companion/icon/generate_maid_icon.py --check
uv run --no-project --offline python android/companion/icon/test_maid_icon.py
```

O script recusa outro hash-fonte. Remove somente padding totalmente transparente, redimensiona a região de alpha com filtro `point`/nearest-neighbor e a centra numa tela transparente de432px (108dp a4px/dp). O recorte de alpha fica202×197px. Todos os pixels visíveis continuam com RGBA existente no original; o script rejeita cor/alpha novo.

O maior raio de centro de pixel visível é130.201767px, inferior à margem131px e ao raio132px da área segura circular de66dp. A reserva também mantém os cantos dos pixels dentro dessa área. Círculo e squircle não cortam rosto, cabelo, laço ou cauda. Isso é uma verificação do recurso, não uma alegação de teste físico em todo launcher/OEM.

A codificação remove metadados voláteis e usa PNG32/compressão9. `--check` exige igualdade byte-a-byte com a receita no ImageMagick disponível; versões futuras de encoder podem requerer revalidar bytes, sem alterar o contrato de pixels/alpha.

## Recursos Android

- `mipmap-anydpi/ic_companion_maid.xml`: adaptive icon canônico, normal e `roundIcon` apontam para ele. O app exige API34; qualifier-v26 e fallback legado são desnecessários.
- `drawable/ic_companion_maid_foreground.xml`: bitmap sem filtro/antialias/dither; a transparência é preservada.
- `values/launcher_icon_colors.xml`: fundo grafite exclusivo do ícone, `#0E0E12`; não muda tema/paleta do app.
- Não há monochrome reinterpretado: a maid conserva as cores e os detalhes do quadro original.
- A duplicata-v26 e o antigo `drawable/ic_companion.xml` sem referências foram removidos. Há somente um wrapper de foreground, sem recurso morto ou símbolo de chat legado.
- Nenhuma mudança de label, pacote, permissões, activities, assinatura, UID, cofre ou versão. Parent integra no APK9 junto às mudanças aprovadas de paleta/copy.

## Verificação

`test_maid_icon.py` verifica fonte/pack inalterado, manifesto, recursos, reprodutibilidade e bounds círculo/squircle. `MaidLauncherIconTest` é fixture Android para PackageManager/adaptive drawable, fundo, filtro, alpha-safe bounds e hash do quadro original no APK; execução Gradle/emulador fica centralizada no parent.

O PNG derivado foi inspecionado como imagem real. Nenhum celular foi instalado, aberto, capturado ou operado nesta tarefa. A validação física do launcher exige autorização/condição segura nova do dono; não é necessária para gerar estes recursos.
