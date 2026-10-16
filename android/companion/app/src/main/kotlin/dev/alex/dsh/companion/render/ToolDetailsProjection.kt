package dev.alex.dsh.companion.render

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Reads only persisted public metadata or complete dispatched arguments; never invokes presenters. */
internal object ToolDetailsProjection {
    fun derive(tool: ToolPresentation, meta: JsonElement?): ToolPresentation {
        val args = RichJson.parse(tool.argsRaw) as? JsonObject
        val metadata = meta as? JsonObject
        val name = tool.name
        val text = tool.content.filterIsInstance<RenderBlock.Text>().joinToString("\n") { it.text }
        val completed = tool.resultSeq != null
        val detail: ToolDetail? = when {
            name == "read" && metadata != null && completed -> read(metadata)
            name in setOf("write", "edit", "apply_patch", "apply_patch_undo") -> diff(metadata, args, name, completed)
            name in setOf("glob", "grep", "list") && metadata != null && completed -> search(metadata)
            name in setOf("bash", "pwsh") && args != null -> terminal(args, text, completed)
            name in setOf("web_search", "web_fetch") && metadata != null && completed -> web(metadata)
            name in setOf("session", "job_list", "job_output", "job_kill", "gen_image", "gen_image_list", "gen_image_tail", "todo_write", "get_goal", "create_goal", "update_goal", "workflow", "browser", "ask_user_question", "plan_stage", "plan_read", "plan_list", "plan_close", "plan_move", "plan_reopen", "subagent", "subagent_fork", "list_agents", "send_message", "interrupt_agent") && completed -> {
                val json = RichJson.parse(text)
                if (json != null) ToolDetail.Json(name ?: "Resultado", RichJson.preview(json)) else null
            }
            else -> if (completed) RichJson.parse(text)?.let { ToolDetail.Json(name ?: "Resultado", RichJson.preview(it)) } else null
        }
        val exit = (detail as? ToolDetail.Terminal)?.exitCode
        val signal = (detail as? ToolDetail.Terminal)?.signal
        val stopped = signal != null || Regex("(?m)^\\[stopped: [^\\r\\n]*]$").containsMatchIn(text)
        val phase = when {
            completed && stopped -> ToolPhase.STOPPED
            completed && exit != null && exit != 0L -> ToolPhase.ERROR
            else -> tool.phase
        }
        val truncated = tool.truncated || RichJson.boolean(metadata?.get("truncated")) == true ||
            tool.content.filterIsInstance<RenderBlock.Text>().any { it.text.length > RichRenderLimits.MAX_TEXT } ||
            tool.content.filterIsInstance<RenderBlock.Unsupported>().any { it.kind in setOf("image", "content") && it.diagnostic.contains("limite") } ||
            (tool.argsRaw?.length ?: 0) > RichRenderLimits.MAX_TEXT ||
            (detail is ToolDetail.Terminal && (text.contains("[output truncated; full output:") || text.contains("[some output was dropped from memory; full output:"))) || when (detail) {
            is ToolDetail.Read -> detail.truncated
            is ToolDetail.Search -> detail.truncated
            is ToolDetail.Web -> detail.truncated
            is ToolDetail.Diff -> detail.truncated
            else -> false
        }
        return tool.copy(detail = detail, metadataPreview = meta?.let(RichJson::preview), exitCode = exit, signal = signal, phase = phase, truncated = truncated)
    }

    private fun read(meta: JsonObject): ToolDetail.Read? {
        val path = RichJson.string(meta["path"]) ?: return null
        val offset = RichJson.integer(meta["offset"])?.takeIf { it > 0 } ?: return null
        val total = RichJson.integer(meta["totalLines"])?.takeIf { it >= 0 } ?: return null
        val raw = meta["lines"] as? JsonArray ?: return null
        if ("lang" in meta && RichJson.string(meta["lang"]) == null) return null
        var previous = offset - 1
        var clippedText = false
        val lines = raw.take(RichRenderLimits.MAX_ROWS).map { element ->
            val line = element as? JsonObject ?: return null
            val number = RichJson.integer(line["number"])?.takeIf { it > previous && it <= total } ?: return null
            previous = number
            val text = RichJson.string(line["text"]) ?: return null
            if (text.length > 4096) clippedText = true
            NumberedLine(number, text.take(4096))
        }
        return ToolDetail.Read(path.take(4096), offset, lines, total, RichJson.string(meta["lang"]), clippedText || raw.size > lines.size || (lines.lastOrNull()?.number ?: (offset - 1)) < total)
    }

    private fun diff(meta: JsonObject?, args: JsonObject?, name: String?, completed: Boolean): ToolDetail.Diff? {
        val raw = meta?.get("diffs") as? JsonArray
        if (raw != null) {
            val files = raw.take(32).map { element ->
                val file = element as? JsonObject ?: return null
                val path = RichJson.string(file["path"]) ?: return null
                val after = RichJson.string(file["newText"]) ?: return null
                if (file["oldText"] != kotlinx.serialization.json.JsonNull && RichJson.string(file["oldText"]) == null) return null
                FileChange(path.take(4096), RichJson.string(file["oldText"])?.take(RichRenderLimits.MAX_TEXT), after.take(RichRenderLimits.MAX_TEXT))
            }
            return ToolDetail.Diff(files, proposed = false, truncated = raw.size > files.size || raw.any { item ->
                val file = item as? JsonObject
                listOf("oldText", "newText").any { key -> (RichJson.string(file?.get(key))?.length ?: 0) > RichRenderLimits.MAX_TEXT }
            })
        }
        if (completed || args == null) return null
        val path = RichJson.string(args["file_path"]) ?: return null
        val change = when (name) {
            "write" -> FileChange(path, null, RichJson.string(args["content"]) ?: return null)
            "edit" -> FileChange(path, RichJson.string(args["old_string"]) ?: return null, RichJson.string(args["new_string"]) ?: return null)
            else -> return null
        }
        return ToolDetail.Diff(listOf(change.copy(path = change.path.take(4096), oldText = change.oldText?.take(RichRenderLimits.MAX_TEXT), newText = change.newText.take(RichRenderLimits.MAX_TEXT))), proposed = true)
    }

    private fun search(meta: JsonObject): ToolDetail.Search? {
        val truncated = RichJson.boolean(meta["truncated"]) ?: return null
        val total = RichJson.integer(meta["total"])
        return when (RichJson.string(meta["shape"])) {
            "paths" -> {
                val raw = meta["paths"] as? JsonArray ?: return null
                val paths = raw.take(RichRenderLimits.MAX_ROWS).map { RichJson.string(it)?.take(4096) ?: return null }
                ToolDetail.Search(paths, emptyList(), total, truncated || raw.size > paths.size)
            }
            "matches" -> {
                val raw = meta["files"] as? JsonArray ?: return null
                val files = raw.take(32).map { item ->
                    val file = item as? JsonObject ?: return null
                    val path = RichJson.string(file["path"]) ?: return null
                    val matches = file["matches"] as? JsonArray ?: return null
                    val lines = matches.take(64).map { match ->
                        val line = match as? JsonObject ?: return null
                        NumberedLine(RichJson.integer(line["lineNumber"]) ?: return null, RichJson.string(line["line"])?.take(4096) ?: return null)
                    }
                    FileMatches(path.take(4096), lines)
                }
                ToolDetail.Search(emptyList(), files, total, truncated || raw.size > files.size || raw.any { ((it as? JsonObject)?.get("matches") as? JsonArray)?.size?.let { size -> size > 64 } == true })
            }
            else -> {
                val raw = meta["entries"] as? JsonArray ?: return null
                val paths = raw.take(RichRenderLimits.MAX_ROWS).map { item -> RichJson.string((item as? JsonObject)?.get("path"))?.take(4096) ?: return null }
                ToolDetail.Search(paths, emptyList(), total, truncated || raw.size > paths.size)
            }
        }
    }

    private fun terminal(args: JsonObject, text: String, completed: Boolean): ToolDetail.Terminal? {
        val command = RichJson.string(args["command"]) ?: return null
        val background = RichJson.boolean(args["run_in_background"]) == true || text.contains("[still running after ")
        // Missing markers, spill footers and background handoffs cannot prove exit zero.
        val intact = !background && !text.contains("full output:") && !text.contains("output was dropped")
        val exit = if (completed && intact) Regex("(?:^|\\n)\\[exit code: (-?\\d+)]\\s*$").find(text)?.groupValues?.get(1)?.toLongOrNull() else null
        val signal = if (completed && intact) Regex("(?:^|\\n)\\[killed by signal: ([A-Za-z0-9_-]+)]\\s*$").find(text)?.groupValues?.get(1) else null
        return ToolDetail.Terminal(command.take(RichRenderLimits.MAX_TEXT), RichJson.string(args["workdir"])?.take(4096), text.takeIf { completed }?.take(RichRenderLimits.MAX_TEXT), exit, signal, !completed || background)
    }

    private fun web(meta: JsonObject): ToolDetail.Web? {
        val truncated = RichJson.boolean(meta["truncated"]) ?: return null
        val raw = meta["sources"] as? JsonArray
        val sources = raw?.take(32)?.map { element ->
            val source = element as? JsonObject ?: return null
            WebSource(RichJson.string(source["url"])?.take(4096) ?: return null, RichJson.string(source["title"])?.take(4096), RichJson.string(source["snippet"])?.take(4096), RichJson.string(source["publishedAt"])?.take(160))
        } ?: emptyList()
        val url = RichJson.string(meta["url"])?.take(4096)
        if (raw == null && url == null) return null
        return ToolDetail.Web(sources, RichJson.string(meta["answer"])?.take(RichRenderLimits.MAX_TEXT), url, RichJson.integer(meta["statusCode"]), truncated || (raw != null && raw.size > sources.size))
    }
}
