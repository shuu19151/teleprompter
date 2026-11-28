package com.shuu19151.teleprompter

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.plugin.JSObject
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

class MainActivity : TauriActivity() {

  companion object {
    private const val MAX_IMPORT_BYTES = 200 * 1024
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    handleIncomingIntent(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleIncomingIntent(intent)
  }

  private fun handleIncomingIntent(intent: Intent?) {
    if (intent == null) return
    when (intent.action) {
      Intent.ACTION_VIEW -> {
        val uri = intent.data ?: return
        dispatchUriImport(uri, intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: "")
      }
      Intent.ACTION_SEND -> {
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: ""
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)
        val streamUri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        if (streamUri != null) {
          dispatchUriImport(streamUri, subject)
        } else if (!text.isNullOrBlank()) {
          val payload = JSObject().apply {
            put("title", subject)
            put("body", text)
            put("fileName", "")
            put("markdown", false)
          }
          AndroidDocumentsPlugin.enqueuePendingImport(payload)
        }
      }
    }
  }

  private fun dispatchUriImport(uri: Uri, fallbackTitle: String) {
    Thread {
      try {
        val fileName = queryDisplayName(uri)
        val body = readTextCapped(uri) ?: return@Thread
        val isMd = fileName.lowercase().endsWith(".md")
        val payload = JSObject().apply {
          put("title", fallbackTitle)
          put("body", body)
          put("fileName", fileName)
          put("markdown", isMd)
        }
        AndroidDocumentsPlugin.enqueuePendingImport(payload)
      } catch (_: Exception) {
        // Ignore unreadable incoming URIs
      }
    }.start()
  }

  private fun queryDisplayName(uri: Uri): String {
    contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (idx >= 0) {
          val name = cursor.getString(idx)
          if (!name.isNullOrBlank()) return name
        }
      }
    }
    return uri.lastPathSegment?.substringAfterLast('/') ?: ""
  }

  private fun readTextCapped(uri: Uri): String? {
    contentResolver.openInputStream(uri)?.use { input ->
      val out = ByteArrayOutputStream()
      val buf = ByteArray(8192)
      var total = 0
      while (true) {
        val read = input.read(buf)
        if (read <= 0) break
        total += read
        if (total > MAX_IMPORT_BYTES) return null
        out.write(buf, 0, read)
      }
      return out.toString(StandardCharsets.UTF_8.name())
    }
    return null
  }
}
