package dev.alex.dsh.companion.net

import java.io.IOException
import android.content.ContentResolver
import dev.alex.dsh.companion.files.BoundUploadedFiles
import dev.alex.dsh.companion.files.FileTransferFailure
import dev.alex.dsh.companion.files.SelectedUploadFile
import dev.alex.dsh.companion.files.knownLengthUploadBody
import dev.alex.dsh.companion.files.uploadBoundFiles
import dev.alex.dsh.companion.files.validateSelectedUploads
import dev.alex.dsh.companion.protocol.FileReceiptCodec
import dev.alex.dsh.companion.protocol.FileUploadLimits
import dev.alex.dsh.companion.protocol.FileUploadReceipt
import dev.alex.dsh.companion.protocol.UploadBinding
import dev.alex.dsh.companion.protocol.CompanionAdmission
import dev.alex.dsh.companion.protocol.DecodedImageAttachment
import dev.alex.dsh.companion.protocol.ImageAttachmentCodec
import dev.alex.dsh.companion.protocol.ImageAttachmentMetadata
import dev.alex.dsh.companion.protocol.NativeRequests
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

class TransportFailure(val kind: Kind) : IOException(kind.name) {
    enum class Kind { AUTH_REQUIRED, AUTH_REFUSED, INVALID_LOGIN, NETWORK, STORAGE, TOO_LARGE, HTTP_FAILURE }
}

/** Blocking unary methods must run on Dispatchers.IO; admission failures never retry. */
class OwnerTransport(private val cookies: OwnerCookieJar = OwnerCookieJar()) {
    private val client = OwnerHttpPolicy.client(cookies)
    private val fileCalls = FileUploadCalls()

    fun login(link: String) {
        val startup = try { OwnerOrigin.startup(link) }
        catch (_: IllegalArgumentException) { throw TransportFailure(TransportFailure.Kind.INVALID_LOGIN) }
        try {
            cookies.beginLogin()
            OwnerHttpPolicy.unaryCall(client, Request.Builder().url(startup).get().build()).execute().use { response ->
                if (response.code != 303) throw TransportFailure(TransportFailure.Kind.AUTH_REFUSED)
                val location = response.header("Location")
                    ?: throw TransportFailure(TransportFailure.Kind.INVALID_LOGIN)
                try { OwnerOrigin.loginDestination(location, startup) }
                catch (_: IllegalArgumentException) { throw TransportFailure(TransportFailure.Kind.INVALID_LOGIN) }
                if (!cookies.authenticated()) throw TransportFailure(TransportFailure.Kind.AUTH_REFUSED)
                cookies.commitLogin()
            }
        } catch (_: CookieStoreFailure) {
            cookies.forgetMemory()
            throw TransportFailure(TransportFailure.Kind.STORAGE)
        } catch (failure: TransportFailure) {
            cookies.forgetMemory()
            throw failure
        } catch (_: IOException) {
            cookies.forgetMemory()
            throw TransportFailure(TransportFailure.Kind.NETWORK)
        }
    }

    fun restoreLogin(): Boolean = cookies.restore()

    fun hasLogin(): Boolean = cookies.authenticated()

    fun forgetLogin() {
        cancelFileUploads()
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
        try { cookies.clear() } finally { cookies.forgetMemory() }
    }

    fun rpc(method: String, envelope: String): String {
        require(method in NativeRpcPolicy.methods) { "Operação não suportada." }
        return executeRpc(method, envelope, NativeRpcPolicy.responseLimit(method))
    }

    /** Read ownership is cancellable without cancelling unrelated, possibly admitted mutations. */
    suspend fun rpcCancellableRead(method: String, envelope: String): String {
        require(method in NativeRpcPolicy.foregroundReads) { "Leitura não suportada." }
        return cancellableRpc(method, envelope)
    }

    /** Cancel only this human-response Call on UI withdrawal; admission may still be ambiguous. */
    suspend fun rpcCancellableInteraction(method: String, envelope: String): String {
        require(method in NativeRpcPolicy.interactions) { "Resposta não suportada." }
        return cancellableRpc(method, envelope)
    }

    private suspend fun cancellableRpc(method: String, envelope: String): String {
        return withContext(Dispatchers.IO) {
            currentCoroutineContext().ensureActive()
            try {
                val limit = NativeRpcPolicy.responseLimit(method)
                rpcCall(method, envelope).awaitOwnerBody { response -> readRpcResponse(response, limit) }
            } catch (_: CookieStoreFailure) {
                throw TransportFailure(TransportFailure.Kind.STORAGE)
            } catch (failure: TransportFailure) {
                throw failure
            } catch (_: IOException) {
                currentCoroutineContext().ensureActive()
                throw TransportFailure(TransportFailure.Kind.NETWORK)
            }
        }
    }

    /** Explicit Send only: one captured list, one actual byte budget, no partial prompt or replay. */
    suspend fun uploadSelectedFiles(
        resolver: ContentResolver,
        files: List<SelectedUploadFile>,
        binding: UploadBinding,
        isCurrent: () -> Boolean,
    ): BoundUploadedFiles {
        val snapshot = files.toList()
        validateSelectedUploads(snapshot, binding.draft)
        return uploadBoundFiles(snapshot, binding, { it.declaredBytes }, isCurrent) { file, remaining ->
            uploadBinary(resolver, file, binding, maximumBytes = remaining, isCurrent = isCurrent)
        }
    }

    /** Only the explicit Send orchestrator calls this; selecting a document performs no upload. */
    suspend fun uploadBinary(
        resolver: ContentResolver,
        file: SelectedUploadFile,
        binding: UploadBinding,
        maximumBytes: Long = FileUploadLimits.MAX_BYTES,
        isCurrent: () -> Boolean,
    ): FileUploadReceipt = withContext(Dispatchers.IO) {
        currentCoroutineContext().ensureActive()
        if (!cookies.authenticated()) throw TransportFailure(TransportFailure.Kind.AUTH_REQUIRED)
        if (!file.draft.matches(binding.draft) || !isCurrent()) throw FileTransferFailure(FileTransferFailure.Kind.STALE)
        val url = OwnerOrigin.root.newBuilder().encodedPath("/api/session/uploadFileBinary")
            .addQueryParameter("sessionId", binding.admission.sessionId).addQueryParameter("name", file.name).build()
        check(OwnerOrigin.accepts(url))
        // A blocking spool of an unsized document cannot observe cancellation itself; fence it per chunk.
        val job = currentCoroutineContext()[Job]
        try {
            val body = knownLengthUploadBody(file.declaredBytes, maximumBytes,
                isCurrent = { job?.isActive != false && cookies.authenticated() && isCurrent() }, opener = { file.openForSend(resolver, binding) })
            val request = Request.Builder().url(url).header("Origin", OwnerOrigin.ORIGIN).post(body).build()
            fileCalls.await(OwnerHttpPolicy.uploadCall(client, request, body.contentLength()), body) { response ->
                val raw = readRpcResponse(response, FileUploadLimits.MAX_RECEIPT_BYTES.toLong())
                if (response.code != 200 || !body.fullyWritten || !isCurrent()) throw FileTransferFailure(FileTransferFailure.Kind.STALE)
                FileReceiptCodec.decode(raw, binding, body.bytesWritten)
            }
        } catch (_: CookieStoreFailure) { throw TransportFailure(TransportFailure.Kind.STORAGE) }
        catch (failure: TransportFailure) { throw failure }
        catch (failure: FileTransferFailure) { throw failure }
        catch (_: IOException) {
            currentCoroutineContext().ensureActive()
            // The server may have staged bytes/receipt. Never replay this one-shot operation.
            throw FileTransferFailure(FileTransferFailure.Kind.UNKNOWN_UPLOAD)
        }
    }

    /** Parent wires STOP/source withdrawal/removal here; unrelated HTTP Calls are untouched. */
    fun cancelFileUploads() { fileCalls.cancelAll() }

    /** Explicit opt-out/logout cleanup is best effort; never inherit the general 45s deadline. */
    fun unregisterPush(envelope: String): String = executeRpc("goalPush/unregister", envelope, 64L * 1024, 2500)

    /** The caller fences generation and proves the ref came from admitted content. */
    fun attachment(admission: CompanionAdmission, rpcId: String, expected: ImageAttachmentMetadata): DecodedImageAttachment {
        if (expected.bytes > ImageAttachmentCodec.MAX_DECODED_BYTES) throw TransportFailure(TransportFailure.Kind.TOO_LARGE)
        val envelope = NativeRequests.attachment(rpcId, admission, expected.attachmentId)
        return ImageAttachmentCodec.decode(executeRpc("session/attachment", envelope, ImageAttachmentCodec.MAX_ENVELOPE_BYTES.toLong()), rpcId, expected)
    }

    private fun executeRpc(method: String, envelope: String, responseLimit: Long, maximumCallMillis: Long? = null): String {
        return try {
            rpcCall(method, envelope).also { call ->
                maximumCallMillis?.let { call.timeout().timeout(it, java.util.concurrent.TimeUnit.MILLISECONDS) }
            }.execute().use { response -> readRpcResponse(response, responseLimit) }
        } catch (_: CookieStoreFailure) {
            throw TransportFailure(TransportFailure.Kind.STORAGE)
        } catch (failure: TransportFailure) {
            throw failure
        } catch (_: IOException) {
            // A POST may already have been admitted. Do not hide this by replaying it.
            throw TransportFailure(TransportFailure.Kind.NETWORK)
        }
    }

    private fun rpcCall(method: String, envelope: String): okhttp3.Call {
        require(envelope.toByteArray(Charsets.UTF_8).size <= MAX_REQUEST_BYTES) { "Mensagem muito grande." }
        if (!cookies.authenticated()) throw TransportFailure(TransportFailure.Kind.AUTH_REQUIRED)
        val url = OwnerOrigin.root.resolve("api/$method")
            ?: throw TransportFailure(TransportFailure.Kind.HTTP_FAILURE)
        val request = Request.Builder().url(url)
            // OkHttp does not add Origin itself. The current public proxy requires it
            // on POST and websocket upgrades; this is also the future direct authority.
            .header("Origin", OwnerOrigin.ORIGIN)
            .post(envelope.toRequestBody(JSON)).build()
        return OwnerHttpPolicy.unaryCall(client, request)
    }

    private fun readRpcResponse(response: Response, responseLimit: Long): String {
        when (response.code) {
            401 -> {
                // Vault failure must not leave a refused credential active in RAM.
                try { cookies.clear() } catch (_: CookieStoreFailure) { cookies.forgetMemory() }
                throw TransportFailure(TransportFailure.Kind.AUTH_REQUIRED)
            }
            403 -> throw TransportFailure(TransportFailure.Kind.AUTH_REFUSED)
        }
        if (!response.isSuccessful) throw TransportFailure(TransportFailure.Kind.HTTP_FAILURE)
        return boundedBody(response, responseLimit)
    }

    fun socket(listener: WebSocketListener): WebSocket {
        if (!cookies.authenticated()) throw TransportFailure(TransportFailure.Kind.AUTH_REQUIRED)
        val request = Request.Builder().url(OwnerOrigin.mux)
            .header("Origin", OwnerOrigin.ORIGIN).build()
        return client.newWebSocket(request, listener)
    }

    fun close() {
        cancelFileUploads()
        client.dispatcher.cancelAll()
        client.connectionPool.evictAll()
        cookies.forgetMemory()
    }

    private fun boundedBody(response: Response, maximumBytes: Long): String {
        val body = response.body ?: throw TransportFailure(TransportFailure.Kind.HTTP_FAILURE)
        if (body.contentLength() > maximumBytes) throw TransportFailure(TransportFailure.Kind.TOO_LARGE)
        val source = body.source()
        val buffer = Buffer()
        while (true) {
            val read = source.read(buffer, minOf(8192L, maximumBytes + 1L - buffer.size))
            if (buffer.size > maximumBytes) throw TransportFailure(TransportFailure.Kind.TOO_LARGE)
            if (read == -1L) break
        }
        return buffer.readUtf8()
    }

    private companion object {
        const val MAX_REQUEST_BYTES = 1024 * 1024
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
