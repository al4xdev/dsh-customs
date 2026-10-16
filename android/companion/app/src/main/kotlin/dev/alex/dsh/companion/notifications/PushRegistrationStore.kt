package dev.alex.dsh.companion.notifications

import android.content.Context
import android.annotation.SuppressLint
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

internal data class StoredPushRegistration(val receipt: PushRegistrationReceipt, val epoch: String)

/** App-private, backup-excluded metadata only; never the FCM token or native authentication cookie. */
@SuppressLint("UseKtx") // KTX edit discards commit's Boolean; these writes require a durable acknowledgment.
internal object PushRegistrationStore {
    private const val PREFS = "companion_push_registration_v1"
    private const val DEVICE = "device"
    private const val RECEIPT = "receipt"

    fun deviceId(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.getString(DEVICE, null)?.let { return it }
        val id = UUID.randomUUID().toString()
        return id.takeIf { prefs.edit().putString(DEVICE, id).commit() }
    }

    fun clear(context: Context): Boolean =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(RECEIPT).commit()

    fun write(context: Context, receipt: PushRegistrationReceipt, epoch: String): Boolean {
        val json = JSONObject().put("version", receipt.version).put("registrationId", receipt.registrationId)
            .put("bindingId", receipt.bindingId).put("profile", receipt.profile).put("ownerScopeId", receipt.ownerScopeId)
            .put("deviceId", receipt.deviceId).put("tokenDigest", receipt.tokenDigest).put("configDigest", receipt.configDigest)
            .put("authGeneration", receipt.authGeneration).put("sessionIds", JSONArray(receipt.sessionIds.sorted()))
            .put("issuedAt", receipt.issuedAt).put("expiresAt", receipt.expiresAt).put("epoch", epoch)
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(RECEIPT, json.toString()).commit()
    }

    fun read(context: Context, configDigest: String, now: Long): StoredPushRegistration? = runCatching {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val encoded = prefs.getString(RECEIPT, null) ?: return null
        require(encoded.length <= 32_768)
        val json = JSONObject(encoded)
        val sessions = json.getJSONArray("sessionIds")
        require(sessions.length() in 1..PushRegistrationPolicy.MAX_SESSIONS)
        val ids = (0 until sessions.length()).map { sessions.getString(it) }.toSet()
        require(ids.size == sessions.length())
        val receipt = PushRegistrationReceipt(json.getInt("version"), json.getString("registrationId"),
            json.getString("bindingId"), json.getString("profile"), json.getString("ownerScopeId"),
            json.getString("deviceId"), json.getString("tokenDigest"), json.getString("configDigest"),
            json.getLong("authGeneration"), ids, json.getLong("issuedAt"), json.getLong("expiresAt"))
        require(PushRegistrationPolicy.validReceipt(receipt, now))
        require(receipt.configDigest == configDigest && receipt.deviceId == prefs.getString(DEVICE, null))
        val epoch = json.getString("epoch")
        require(UUID.fromString(epoch).toString() == epoch)
        StoredPushRegistration(receipt, epoch)
    }.getOrNull()
}
