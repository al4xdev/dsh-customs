package dev.alex.dsh.companion.preview

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Shader
import androidx.compose.ui.graphics.toArgb
import androidx.core.graphics.createBitmap
import dev.alex.dsh.companion.protocol.CompanionChat
import dev.alex.dsh.companion.render.FileChange
import dev.alex.dsh.companion.render.FileMatches
import dev.alex.dsh.companion.render.ImageReference
import dev.alex.dsh.companion.render.NumberedLine
import dev.alex.dsh.companion.render.RenderBlock
import dev.alex.dsh.companion.render.RichMessage
import dev.alex.dsh.companion.render.ToolDetail
import dev.alex.dsh.companion.render.ToolError
import dev.alex.dsh.companion.render.ToolPhase
import dev.alex.dsh.companion.render.ToolPresentation
import dev.alex.dsh.companion.ui.MessageRole
import dev.alex.dsh.companion.ui.premium.PremiumPalette
import java.io.ByteArrayOutputStream

/** Only authored synthetic literals and generated pixels; never reads a file, camera or owner state. */
internal class FixtureData {
    val bitmap: Bitmap = chart()
    val image: ImageReference = ImageReference(
        attachmentId = "fixture-generated-chart",
        mediaType = "image/png",
        bytes = ByteArrayOutputStream().use { output ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
            output.size().toLong()
        },
        width = 640,
        height = 360,
        name = "Gráfico sintético · gerado somente na RAM",
    )
    val chats: List<CompanionChat> = listOf(
        "Renderização rica no Android", "Contrato de mensagens e ferramentas", "Markdown com tabelas e código",
        "Imagens e limites nativos", "Streaming: argumentos parciais", "Estados UNKNOWN e reconexão",
        "Scroll e retenção de ferramentas", "Swipe: cancelar ou fechar", "Teclado e composer",
        "Cards de diff e leitura", "Resultados de shell e erros", "Confirmação uma vez (local)",
        "Perguntas e revisão somente leitura", "Fallback para conteúdo desconhecido",
        "Fontes legíveis: math e Mermaid", "Checklist de release sintético",
    ).mapIndexed { index, title -> CompanionChat("fixture-chat-${index.toString().padStart(2, '0')}", title, 0, 0) }

    val transcript: List<RichMessage> = buildList {
        add(prose(0, MessageRole.USER, "Vamos conferir o chat nativo com conteúdo sintético. Nada aqui é uma conversa real."))
        add(prose(1, MessageRole.ASSISTANT, """
            # Uma conversa, várias formas de conteúdo

            Este cenário é **local**. Texto, ferramentas e imagens preservam suas identidades sem executar ações no PC.

            | Bloco | Apresentação | Efeito externo |
            | --- | --- | --- |
            | Texto | Markdown nativo | Nenhum |
            | Ferramenta | Resultado tipado | Nenhum |
            | Imagem | Bitmap da prévia | Nenhum |

            > Os gestos e a seleção usam os mesmos componentes do app.

            1. Abra uma ferramenta.
            2. Selecione ou copie a fonte.
            3. Arraste o workspace e cancele antes de fechar.

            ~~Texto antigo~~ → conteúdo legível, sem WebView.
        """.trimIndent()))
        add(tool(2, ToolPresentation("fixture-read", "read", ToolPhase.OK, "{\"file_path\":\"fixture.kt\",\"offset\":101,\"limit\":5}",
            content = listOf(RenderBlock.Text("Leitura sintética: linhas 101–105. O nome é um rótulo, não um arquivo acessado.")),
            detail = ToolDetail.Read("fixture.kt", 101, listOf(
                NumberedLine(101, "data class RenderItem(val id: String)"), NumberedLine(102, "val source = \"fixture only\""),
                NumberedLine(103, "val blocks = listOf(source)"), NumberedLine(104, "// No owner calls."), NumberedLine(105, "check(blocks.isNotEmpty())"),
            ), 105, "kotlin", false), callSeq = 2, resultSeq = 2)))
        add(prose(3, MessageRole.USER, "Now show a long code line. Horizontal scrolling must not dismiss the workspace."))
        add(prose(4, MessageRole.ASSISTANT, """
            ## Código e fonte literal

            ```kotlin
            val preview = RenderItem(id = "fixture-only", title = "Uma linha longa para testar o gesto horizontal, a seleção de texto e a prioridade do código sobre o swipe do workspace")
            val outcome = "local" // Never dispatches a tool.
            ```

            **English / Português:** selection stays native; o texto copiado continua literal.
        """.trimIndent()))
        add(tool(5, ToolPresentation("fixture-diff", "edit", ToolPhase.OK, "{\"file_path\":\"fixture.kt\",\"old_string\":\"plain\",\"new_string\":\"typed\"}",
            content = listOf(RenderBlock.Text("Diff simulado. Nenhum arquivo foi gravado.")),
            detail = ToolDetail.Diff(listOf(FileChange("fixture.kt", "val presentation = \"plain\"", "val presentation = \"typed\"\nval actions = \"local only\"")), false), callSeq = 5, resultSeq = 5)))
        add(tool(6, ToolPresentation("fixture-search", "grep", ToolPhase.OK, "{\"pattern\":\"fixture\",\"path\":\"preview-workspace\"}",
            content = listOf(RenderBlock.Text("Correspondências inventadas para esta prévia.")),
            detail = ToolDetail.Search(emptyList(), listOf(FileMatches("fixture.kt", listOf(NumberedLine(12, "val fixture = true"), NumberedLine(21, "// Local fixture")))), 8, true),
            truncated = true, callSeq = 6, resultSeq = 6)))
        add(prose(7, MessageRole.ASSISTANT, """
            ## Estados não são permissões

            - Preparando: argumentos ainda incompletos.
            - Resultado registrado: recibo visível, não um novo grant.
            - Estado desconhecido: nenhuma repetição automática.

            Toda ferramenta desta prévia é somente uma apresentação sintética.
        """.trimIndent()))
        add(tool(8, ToolPresentation("fixture-shell", "bash", ToolPhase.ERROR, "{\"command\":\"fixture command (not executed)\"}",
            content = listOf(RenderBlock.Text("Saída sintética\n[stderr]\nExemplo de falha local\n[exit code: 7]")),
            detail = ToolDetail.Terminal("fixture command (not executed)", "preview-workspace", "Saída sintética\n[exit code: 7]", 7, null, false),
            error = ToolError("SyntheticFailure", "FIXTURE_EXIT", "Este erro é inventado. Nenhum processo foi iniciado."), exitCode = 7, callSeq = 8, resultSeq = 8)))
        add(tool(9, ToolPresentation("fixture-job", "job_output", ToolPhase.UNKNOWN, "{\"job_id\":\"fixture-job-only\"}",
            content = listOf(RenderBlock.Text("{\"state\":\"unknown\",\"retrySafe\":false,\"fixture\":true}")),
            detail = ToolDetail.Json("job_output local", "{\n  \"state\": \"unknown\",\n  \"retrySafe\": false,\n  \"fixture\": true\n}"), resultSeq = 9)))
        add(RichMessage(10, MessageRole.ASSISTANT, "Raciocínio sintético e fonte desconhecida", listOf(
            RenderBlock.Reasoning("Conteúdo de raciocínio escrito para a prévia. O botão apenas expande esta fonte local."),
            RenderBlock.Text("Uma extensão desconhecida mantém diagnóstico legível, sem ganhar controles."),
            RenderBlock.Unsupported("future-block", "Bloco sintético não suportado; fonte inerte", "{\"type\":\"future-block\",\"fixture\":true}"),
        )))
        add(RichMessage(11, MessageRole.ASSISTANT, "Argumentos parciais", listOf(
            RenderBlock.Text("Fragmento local incompleto, nunca convertido em chamada executável."),
            RenderBlock.ToolCall("fixture-partial", "session", "{\"operation\":\"read\",\"limit\":", preparing = true),
        ), streaming = true, turn = 1, step = 0, attemptId = "fixture-attempt", nextIndex = 3))
        add(prose(12, MessageRole.USER, "E se o modelo terminar antes do conteúdo ser publicado?"))
        add(prose(13, MessageRole.ASSISTANT, "O renderer mantém uma identidade estável entre a resposta parcial e a durável. Esta linha é apenas uma explicação sintética."))
        add(prose(14, MessageRole.ASSISTANT, """
            ## Fallback honesto

            Matemática em fonte: ${'$'}x^2 + y^2${'$'}.

            ```mermaid
            graph TD
              Source --> NativeText
              NativeText --> LocalPreview
            ```

            A fonte aparece sem executar Mermaid ou prometer renderização matemática.
        """.trimIndent()))
        add(prose(15, MessageRole.USER, "Vou rolar, selecionar texto e testar o teclado. O rascunho fica somente na RAM."))
        add(prose(16, MessageRole.ASSISTANT, "O catálogo contém 16 conversas inventadas. Voltar e reabrir permite observar a retenção real dos componentes, sem criar outra sessão no backend."))
        add(prose(17, MessageRole.NOTICE, "Prévia local: o botão Enviar apenas acrescenta uma mensagem sintética nesta Activity. Não existe transporte ou entrega ao PC."))
        add(tool(18, ToolPresentation("fixture-image", "read_image", ToolPhase.OK, "{\"file_path\":\"generated-preview.png (label only)\"}",
            content = listOf(RenderBlock.Text("Imagem gerada na memória desta Activity. Envelope separado da referência; não é foto nem arquivo do proprietário."), RenderBlock.Image(image)),
            callSeq = 18, resultSeq = 18)))
        add(prose(19, MessageRole.ASSISTANT, "**Pronto para testar os gestos.** Use os controles locais acima para simular offline, UNKNOWN, carregamento e uma confirmação fictícia. Nada será enviado ao PC."))
    }

    private fun prose(seq: Long, role: MessageRole, text: String) = RichMessage(seq, role, text, listOf(RenderBlock.Text(text)))
    private fun tool(seq: Long, value: ToolPresentation) = RichMessage(seq, MessageRole.TOOL, value.content.filterIsInstance<RenderBlock.Text>().joinToString("\n") { it.text }, value.content, value, "tool:${value.callId}")

    private fun chart(): Bitmap {
        val result = createBitmap(640, 360, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(result)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.shader = LinearGradient(0f, 0f, 640f, 360f, PremiumPalette.PlumHigh.toArgb(), PremiumPalette.Plum.toArgb(), Shader.TileMode.CLAMP)
        canvas.drawRect(0f, 0f, 640f, 360f, paint)
        paint.shader = null
        paint.color = PremiumPalette.PlumMuted.toArgb()
        paint.textSize = 16f
        canvas.drawText("RICH RENDER / LOCAL FIXTURE", 36f, 44f, paint)
        paint.color = PremiumPalette.PlumText.toArgb()
        paint.textSize = 28f
        paint.isFakeBoldText = true
        canvas.drawText("Conteúdo tipado", 36f, 88f, paint)
        paint.isFakeBoldText = false
        paint.strokeWidth = 1f
        paint.color = PremiumPalette.PlumOutline.toArgb()
        for (y in listOf(140f, 190f, 240f, 290f)) canvas.drawLine(36f, y, 604f, y, paint)
        val line = Path().apply {
            moveTo(44f, 267f); lineTo(126f, 242f); lineTo(208f, 250f); lineTo(290f, 205f)
            lineTo(372f, 186f); lineTo(454f, 147f); lineTo(536f, 163f); lineTo(596f, 120f)
        }
        paint.color = PremiumPalette.PlumAccent.toArgb()
        paint.strokeWidth = 5f
        paint.style = Paint.Style.STROKE
        canvas.drawPath(line, paint)
        paint.style = Paint.Style.FILL
        paint.color = PremiumPalette.BlueAccent.toArgb()
        canvas.drawCircle(596f, 120f, 7f, paint)
        paint.color = PremiumPalette.PlumMuted.toArgb()
        paint.textSize = 16f
        canvas.drawText("640 × 360 · pixels gerados na RAM · nenhuma imagem real", 36f, 331f, paint)
        return result
    }
}
