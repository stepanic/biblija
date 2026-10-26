package hr.stepanic.biblija.data

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Realtime obavijesti s `/api/live` (Durable Object `SyncRoom` u src/worker.ts), kao `connectLive()` na webu.
 * Veza ne nosi podatke: na `{"type":"changed"}` pozove [onChanged], a model napravi običan sync.
 * Drži se samo dok je aplikacija u prvom planu; prekid se ponavlja uz backoff do 30 s.
 */
class LiveConnection(private val onChanged: () -> Unit) {
    private val http = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS) // protokolni ping: odgovara runtime, objekt se ne budi
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var socket: WebSocket? = null
    private var url: String? = null
    private var retry = 0
    private val reconnect = Runnable { open() }

    /** Spoji na sobu (ili ostani spojen ako je ista). Poziva se s glavne niti. */
    fun connect(serverUrl: String, room: String, clientId: String) {
        val base = serverUrl.trim().trimEnd('/')
        val wsBase = when {
            base.startsWith("https://") -> "wss://" + base.removePrefix("https://")
            base.startsWith("http://") -> "ws://" + base.removePrefix("http://")
            else -> return
        }
        val next = "$wsBase/api/live?room=$room&client=$clientId"
        if (next == url && socket != null) return
        disconnect()
        url = next
        retry = 0
        open()
    }

    fun disconnect() {
        main.removeCallbacks(reconnect)
        url = null
        socket?.close(1000, null)
        socket = null
    }

    private fun open() {
        val target = url ?: return
        val request = runCatching { Request.Builder().url(target).build() }.getOrNull() ?: return
        socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                main.post {
                    if (socket !== webSocket) return@post
                    // nakon prekida je možda propuštena obavijest
                    val reconnected = retry > 0
                    retry = 0
                    if (reconnected) onChanged()
                }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.contains("\"changed\"")) main.post { if (socket === webSocket) onChanged() }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, null)
                main.post { dropped(webSocket) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                main.post { dropped(webSocket) }
            }
        })
    }

    private fun dropped(webSocket: WebSocket) {
        if (socket !== webSocket || url == null) return
        socket = null
        val delayMs = minOf(30_000L, 1_000L shl minOf(retry++, 5))
        main.postDelayed(reconnect, delayMs)
    }
}
