package dev.alex.dsh.companion.render

import dev.alex.dsh.companion.protocol.SessionEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Only SDK-owned model context is optional; notices, unknown producers and media stay visible. */
internal object ModelContextVisibility {
    fun isHidden(event: SessionEvent, showModelContext: Boolean): Boolean {
        if (showModelContext) return false
        val data = event.data as? JsonObject ?: return false
        return when (event.type) {
            "system/message" -> {
                val message = data["message"] as? JsonObject ?: return false
                val source = source(message, "system", "system-prompt") ?: return false
                source.keys == setOf("kind") && plainText(message["content"], allowEmpty = true)
            }
            "developer/message" -> {
                val message = data["message"] as? JsonObject ?: return false
                val source = source(message, "developer", "tool-registry") ?: return false
                val content = message["content"] as? JsonArray ?: return false
                source.keys == setOf("kind") && content.isNotEmpty() && content.all { raw ->
                    val block = raw as? JsonObject ?: return@all false
                    block.keys == setOf("type", "toolName") && RichJson.string(block["type"]) in setOf("tool-addition", "tool-removal") &&
                        !RichJson.string(block["toolName"]).isNullOrEmpty()
                }
            }
            "user/message" -> userContext(data)
            else -> false
        }
    }

    private fun source(message: JsonObject, role: String, kind: String): JsonObject? {
        if (RichJson.string(message["role"]) != role) return null
        return (message["source"] as? JsonObject)?.takeIf { RichJson.string(it["kind"]) == kind }
    }

    private fun userContext(message: JsonObject): Boolean {
        if (RichJson.string(message["role"]) != "user") return false
        val source = message["source"] as? JsonObject ?: return false
        val kind = RichJson.string(source["kind"])
        return when (kind) {
            "agent-instructions" -> agentInstructions(source) && plainText(message["content"], allowMultiple = true)
            "skill-invocation" -> source.keys == setOf("kind", "name", "form") &&
                RichJson.string(source["form"]) == "instructions" && !RichJson.string(source["name"]).isNullOrEmpty() && plainText(message["content"])
            "skill-catalog" -> skillCatalog(source) && plainText(message["content"])
            // Only runtime-context emits an unformed/cleared kind-only message.
            "runtime-context" -> (source.keys == setOf("kind") || snapshot(source)) && plainText(message["content"])
            "time-context", "tmux-context" -> snapshot(source, kind) && plainText(message["content"])
            // Producer kinds and forms are open vocabularies. A notice/relay,
            // security warning or future producer is never inferred to be debug.
            else -> false
        }
    }

    private fun snapshot(source: JsonObject, expectedName: String? = null): Boolean {
        if (source.keys != setOf("kind", "form", "sections") || RichJson.string(source["form"]) != "snapshot") return false
        val sections = source["sections"] as? JsonArray ?: return false
        if (sections.isEmpty() || expectedName != null && sections.size != 1) return false
        return sections.all { raw ->
            val section = raw as? JsonObject ?: return@all false
            val name = RichJson.string(section["name"])
            section.keys == setOf("name", "text") && !name.isNullOrEmpty() && (expectedName == null || name == expectedName) &&
                RichJson.string(section["text"]) != null
        }
    }

    private fun skillCatalog(source: JsonObject): Boolean {
        if (source.keys - "update" != setOf("kind", "form", "entries") || RichJson.string(source["form"]) != "catalog") return false
        if ("update" in source && RichJson.boolean(source["update"]) != true) return false
        val entries = source["entries"] as? JsonArray ?: return false
        return entries.all { raw ->
            val entry = raw as? JsonObject ?: return@all false
            entry.keys == setOf("name", "description") && !RichJson.string(entry["name"]).isNullOrEmpty() && RichJson.string(entry["description"]) != null
        }
    }

    private fun agentInstructions(source: JsonObject): Boolean {
        if (source.keys - setOf("baseline", "baselineIdentity") != setOf("kind", "form", "changes") ||
            RichJson.string(source["form"]) != "instructions") return false
        if ("baseline" in source && RichJson.boolean(source["baseline"]) != true) return false
        if ("baselineIdentity" in source && RichJson.string(source["baselineIdentity"]) == null) return false
        val changes = source["changes"] as? JsonArray ?: return false
        return changes.all { raw ->
            val change = raw as? JsonObject ?: return@all false
            change.keys - "digest" == setOf("action", "scope", "path") &&
                RichJson.string(change["action"]) in setOf("set", "replace", "remove") &&
                RichJson.string(change["scope"]) != null && RichJson.string(change["path"]) != null &&
                ("digest" !in change || RichJson.string(change["digest"]) != null)
        }
    }

    private fun plainText(raw: JsonElement?, allowEmpty: Boolean = false, allowMultiple: Boolean = false): Boolean {
        val content = raw as? JsonArray ?: return false
        if (content.isEmpty()) return allowEmpty
        if (!allowMultiple && content.size != 1) return false
        // Workspace baseline and deltas may be combined into several text blocks
        // by the SDK. Media, unknown blocks and their extra fields stay visible.
        return content.all { rawBlock ->
            val block = rawBlock as? JsonObject ?: return@all false
            block.keys == setOf("type", "text") && RichJson.string(block["type"]) == "text" && RichJson.string(block["text"]) != null
        }
    }
}
