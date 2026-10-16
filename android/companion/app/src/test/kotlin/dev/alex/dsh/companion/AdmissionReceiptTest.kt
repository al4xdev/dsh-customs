package dev.alex.dsh.companion

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertThrows
import org.junit.Test

class AdmissionReceiptTest {
    @Test fun onlyExactNativeBooleanTrueAcknowledgesAdmission() {
        AdmissionReceipt.requireAccepted(buildJsonObject { put("accepted", true) })
        for (invalid in listOf(
            buildJsonObject { put("accepted", "true") },
            buildJsonObject { put("accepted", false) },
            buildJsonObject { put("accepted", JsonNull) },
            buildJsonObject { put("accepted", 1) },
            buildJsonObject { put("accepted", true); put("extra", true) },
            buildJsonObject {}, JsonPrimitive(true),
        )) assertThrows(IllegalStateException::class.java) { AdmissionReceipt.requireAccepted(invalid) }
    }
}
