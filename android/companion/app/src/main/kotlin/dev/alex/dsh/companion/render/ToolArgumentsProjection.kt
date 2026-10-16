package dev.alex.dsh.companion.render

import kotlinx.serialization.json.JsonObject

/** Uses the existing bounded JSON reader only after preparation; raw evidence stays available. */
object ToolArgumentsProjection {
    data class Field(val name: String, val value: String)
    data class Arguments(val fields: List<Field>, val limited: Boolean)

    fun project(tool: ToolPresentation): Arguments? {
        if (tool.phase == ToolPhase.PREPARING) return null
        val raw = tool.argsRaw ?: return null
        val args = RichJson.parse(raw) as? JsonObject ?: return null
        val entries = args.entries.take(32)
        val fields = entries.map { (name, value) ->
            Field(name.take(160), (RichJson.string(value) ?: RichJson.preview(value)).take(4096))
        }
        return Arguments(fields, args.size > entries.size || entries.any { (name, value) ->
            name.length > 160 || (RichJson.string(value)?.length ?: RichJson.preview(value).length) > 4096
        })
    }
}
