package com.shuu19151.teleprompter

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.documentfile.provider.DocumentFile
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.Executors

@TauriPlugin(
  permissions = [
    Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone")
  ]
)
class AndroidDocumentsPlugin(private val activity: Activity) : Plugin(activity) {

  companion object {
    private const val PREFS_NAME = "teleprompter_prefs"
    private const val KEY_TREE_URI = "texts_tree_uri"
    private const val INTERNAL_URI = "internal://texts"
    private const val INTERNAL_NAME = "App Library"
    private const val MAX_TEXT_BYTES = 200 * 1024
    private const val MAX_READ_BYTES = 2L * 1024 * 1024

    private val SMALL_WORDS = setOf(
      "a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "vs"
    )
    private val RESERVED_STEMS = setOf(
      "CON", "PRN", "AUX", "NUL",
      "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
      "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    )

    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val lock = Any()
    @Volatile
    private var activePlugin: AndroidDocumentsPlugin? = null
    private var pendingImport: JSObject? = null
    private var listenerReady = false

    fun enqueuePendingImport(payload: JSObject) {
      val target: AndroidDocumentsPlugin?
      synchronized(lock) {
        if (listenerReady && activePlugin != null) {
          target = activePlugin
        } else {
          pendingImport = payload
          target = null
        }
      }
      if (target != null) {
        target.activity.runOnUiThread {
          target.trigger("pendingImport", payload)
        }
      }
    }
  }

  init {
    synchronized(lock) {
      activePlugin = this
    }
  }

  private fun prefs() = activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  private fun internalTextsDir(): File = File(activity.filesDir, "Teleprompter/texts")

  private fun savedTreeUriString(): String? = prefs().getString(KEY_TREE_URI, null)?.takeIf { it.isNotBlank() }

  private sealed class StorageRoot {
    data class Internal(val dir: File) : StorageRoot()
    data class Saf(val tree: DocumentFile, val uri: Uri) : StorageRoot()
  }

  private fun resolveStorageRoot(): StorageRoot {
    val rawUri = savedTreeUriString() ?: return StorageRoot.Internal(internalTextsDir())
    val uri = Uri.parse(rawUri)
    val hasPerm = activity.contentResolver.persistedUriPermissions.any {
      it.uri == uri && it.isReadPermission && it.isWritePermission
    }
    if (!hasPerm) {
      throw IllegalStateException("Library folder permission was revoked. Use Folder to choose it again.")
    }
    val tree = DocumentFile.fromTreeUri(activity, uri)
      ?: throw IllegalStateException("Library folder is unavailable. Use Folder to choose another.")
    if (!tree.exists() || !tree.isDirectory) {
      throw IllegalStateException("Library folder could not be found. Use Folder to choose another.")
    }
    return StorageRoot.Saf(tree, uri)
  }

  @Command
  fun ensureMicrophonePermission(invoke: Invoke) {
    val granted = ContextCompat.checkSelfPermission(
      activity,
      Manifest.permission.RECORD_AUDIO
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) {
      val ret = JSObject()
      ret.put("granted", true)
      invoke.resolve(ret)
    } else {
      requestPermissionForAlias("microphone", invoke, "microphonePermissionCallback")
    }
  }

  @PermissionCallback
  fun microphonePermissionCallback(invoke: Invoke) {
    val granted = ContextCompat.checkSelfPermission(
      activity,
      Manifest.permission.RECORD_AUDIO
    ) == PackageManager.PERMISSION_GRANTED
    if (granted) {
      val ret = JSObject()
      ret.put("granted", true)
      invoke.resolve(ret)
    } else {
      invoke.reject("Microphone permission denied")
    }
  }

  @Command
  fun shareTake(invoke: Invoke) {
    val name = invoke.getArgs().getString("name")
    if (name.isNullOrBlank()) {
      invoke.reject("Missing take name")
      return
    }
    val takesDir = File(activity.filesDir, "Teleprompter")
    val file = File(takesDir, name)
    if (!file.exists()) {
      invoke.reject("Take file not found: $name")
      return
    }
    val uri: Uri = FileProvider.getUriForFile(
      activity,
      "${activity.packageName}.fileprovider",
      file
    )
    val shareIntent = Intent(Intent.ACTION_SEND).apply {
      type = "audio/mp4"
      putExtra(Intent.EXTRA_STREAM, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(Intent.createChooser(shareIntent, "Export audio"))
    invoke.resolve()
  }

  @Command
  fun getSavedDirectory(invoke: Invoke) {
    ioExecutor.execute {
      try {
        val ret = JSObject()
        when (val root = resolveStorageRoot()) {
          is StorageRoot.Internal -> {
            root.dir.mkdirs()
            ret.put("uri", INTERNAL_URI)
            ret.put("name", INTERNAL_NAME)
            ret.put("internal", true)
          }
          is StorageRoot.Saf -> {
            ret.put("uri", root.uri.toString())
            ret.put("name", root.tree.name ?: "Folder")
            ret.put("internal", false)
          }
        }
        invoke.resolve(ret)
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not access library folder.")
      }
    }
  }

  @Command
  fun pickDirectory(invoke: Invoke) {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
      addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or
          Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
          Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
      )
    }
    startActivityForResult(invoke, intent, "pickDirectoryCallback")
  }

  @ActivityCallback
  fun pickDirectoryCallback(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode == Activity.RESULT_OK) {
      val uri = result.data?.data
      if (uri != null) {
        val takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        try {
          activity.contentResolver.takePersistableUriPermission(uri, takeFlags)
        } catch (_: SecurityException) {
          // Ignore if persistable permission is not supported
        }
        prefs().edit().putString(KEY_TREE_URI, uri.toString()).apply()
        val tree = DocumentFile.fromTreeUri(activity, uri)
        val ret = JSObject()
        ret.put("uri", uri.toString())
        ret.put("name", tree?.name ?: "Folder")
        ret.put("internal", false)
        invoke.resolve(ret)
        return
      }
    }
    invoke.reject("Directory selection cancelled")
  }

  @Command
  fun consumePendingImport(invoke: Invoke) {
    val payload: JSObject?
    synchronized(lock) {
      listenerReady = true
      payload = pendingImport
      pendingImport = null
    }
    val ret = JSObject()
    if (payload != null) {
      ret.put("pending", payload)
    }
    invoke.resolve(ret)
  }

  @Command
  fun listTexts(invoke: Invoke) {
    ioExecutor.execute {
      try {
        val items = scanTexts(resolveStorageRoot())
        val arr = JSArray()
        for (item in items) {
          arr.put(item.toJsObject())
        }
        val ret = JSObject()
        ret.put("items", arr)
        invoke.resolve(ret)
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not list texts.")
      }
    }
  }

  @Command
  fun readText(invoke: Invoke) {
    val id = invoke.getArgs().getString("id") ?: ""
    ioExecutor.execute {
      try {
        validateId(id)
        val found = scanTexts(resolveStorageRoot()).firstOrNull { it.id == id }
          ?: throw IllegalStateException("that text was not found")
        invoke.resolve(found.toJsObject())
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not read text.")
      }
    }
  }

  @Command
  fun writeText(invoke: Invoke) {
    val textObj = invoke.getArgs().getJSObject("text")
    if (textObj == null) {
      invoke.reject("Missing text payload.")
      return
    }
    ioExecutor.execute {
      try {
        val saved = writeTextRecord(resolveStorageRoot(), textObj)
        invoke.resolve(saved.toJsObject())
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not save text.")
      }
    }
  }

  @Command
  fun deleteText(invoke: Invoke) {
    val id = invoke.getArgs().getString("id") ?: ""
    ioExecutor.execute {
      try {
        validateId(id)
        deleteTextRecord(resolveStorageRoot(), id)
        invoke.resolve()
      } catch (error: Exception) {
        invoke.reject(error.message ?: "Could not delete text.")
      }
    }
  }

  private data class Sidecar(
    val version: Int,
    val id: String,
    val code: String,
    val title: String,
    val createdAt: Any?,
    val updatedAt: Any?
  )

  private data class ListedText(
    val id: String,
    val code: String,
    val title: String,
    val body: String,
    val createdAt: Any,
    val updatedAt: Any?,
    val name: String,
    val path: String,
    val extension: String,
    val sidecar: Boolean
  ) {
    fun toJsObject(): JSObject {
      val obj = JSObject()
      obj.put("id", id)
      obj.put("code", code)
      obj.put("title", title)
      obj.put("body", body)
      obj.put("createdAt", createdAt)
      if (updatedAt != null) obj.put("updatedAt", updatedAt)
      obj.put("name", name)
      obj.put("path", path)
      obj.put("extension", extension)
      obj.put("sidecar", sidecar)
      return obj
    }
  }

  private fun scanTexts(root: StorageRoot): List<ListedText> {
    val raw = when (root) {
      is StorageRoot.Internal -> scanInternal(root.dir)
      is StorageRoot.Saf -> scanSaf(root.tree)
    }
    val deduped = mutableListOf<ListedText>()
    val index = HashMap<String, Int>()
    for (item in raw) {
      val existingSlot = index[item.id]
      if (existingSlot != null) {
        if (item.sidecar && !deduped[existingSlot].sidecar) {
          deduped[existingSlot] = item
        }
        continue
      }
      index[item.id] = deduped.size
      deduped.add(item)
    }
    return deduped
  }

  private fun scanInternal(dir: File): List<ListedText> {
    if (!dir.exists()) return emptyList()
    val files = dir.listFiles() ?: return emptyList()
    val byName = files.associateBy { it.name }
    val out = mutableListOf<ListedText>()
    for (file in files) {
      if (!file.isFile) continue
      val name = file.name
      if (name.startsWith('.')) continue
      val ext = textExtension(name) ?: continue
      if (file.length() > MAX_READ_BYTES) {
        throw IllegalStateException("Text is too large to read: $name")
      }
      val body = file.readText(StandardCharsets.UTF_8)
      val sideFile = byName[sidecarName(name)]
      val side = sideFile?.takeIf { it.isFile }?.let { parseSidecar(it.readText(StandardCharsets.UTF_8)) }
      out.add(buildListedText(name, file.absolutePath, ext, body, file.lastModified(), side))
    }
    out.sortWith(compareBy<ListedText>({ createdMillis(it.createdAt) }, { it.name }))
    return out
  }

  private fun scanSaf(tree: DocumentFile): List<ListedText> {
    val entries = tree.listFiles()
    val byName = HashMap<String, DocumentFile>()
    for (entry in entries) {
      val n = entry.name ?: continue
      byName[n] = entry
    }
    val out = mutableListOf<ListedText>()
    for (entry in entries) {
      if (!entry.isFile) continue
      val name = entry.name ?: continue
      if (name.startsWith('.')) continue
      val ext = textExtension(name) ?: continue
      if (entry.length() > MAX_READ_BYTES) {
        throw IllegalStateException("Text is too large to read: $name")
      }
      val body = readUriText(entry.uri)
      val sideDoc = byName[sidecarName(name)]
      val side = sideDoc?.takeIf { it.isFile }?.let {
        try {
          parseSidecar(readUriText(it.uri))
        } catch (_: Exception) {
          null
        }
      }
      out.add(buildListedText(name, entry.uri.toString(), ext, body, entry.lastModified(), side))
    }
    out.sortWith(compareBy<ListedText>({ createdMillis(it.createdAt) }, { it.name }))
    return out
  }

  private fun buildListedText(
    name: String,
    path: String,
    extension: String,
    rawBody: String,
    modifiedMs: Long,
    parsedSidecar: Sidecar?
  ): ListedText {
    val side = parsedSidecar?.takeIf { it.id.trim().isNotEmpty() }
    val hasSidecar = side != null
    val stem = fileStem(name)
    val (nameCode, nameTitle) = titleAndCodeFromStem(stem)
    val legacyEssay = !hasSidecar && extension == "txt" && nameCode.startsWith('E')

    val id = side?.id?.takeIf { it.isNotBlank() }
      ?: if (legacyEssay) name else stableFileId(name)
    val code = side?.code?.takeIf { it.isNotBlank() } ?: nameCode
    var title = side?.title?.takeIf { it.isNotBlank() } ?: nameTitle
    var body = rawBody
    if (legacyEssay) {
      val normalized = body.replace("\r\n", "\n").trim()
      val splitIdx = normalized.indexOf("\n\n")
      if (splitIdx >= 0) {
        title = titleCase(normalized.substring(0, splitIdx))
        body = normalized.substring(splitIdx + 2)
      } else {
        title = titleCase(normalized)
        body = ""
      }
    }
    val createdAt: Any = side?.createdAt?.takeIf { !isNullValue(it) } ?: modifiedMs
    val updatedAt: Any? = side?.updatedAt?.takeIf { !isNullValue(it) }
    return ListedText(
      id = id,
      code = code,
      title = title,
      body = body,
      createdAt = createdAt,
      updatedAt = updatedAt,
      name = name,
      path = path,
      extension = extension,
      sidecar = hasSidecar
    )
  }

  private fun writeTextRecord(root: StorageRoot, draft: JSObject): ListedText {
    val id = draft.getString("id") ?: ""
    validateId(id)
    val code = normalizeCode(draft.getString("code") ?: "")
    val title = normalizeTitle(draft.getString("title") ?: "")
    val body = draft.getString("body") ?: ""
    val extension = normalizeExtension(draft.getString("extension") ?: "")
    val bodyBytes = body.toByteArray(StandardCharsets.UTF_8)
    if (bodyBytes.size > MAX_TEXT_BYTES) {
      throw IllegalArgumentException("that text is larger than 200 KB")
    }

    if (root is StorageRoot.Internal && !root.dir.exists()) {
      root.dir.mkdirs()
    }

    val allTexts = scanTexts(root)
    val existing = allTexts.filter { it.id == id }
    val ownNames = existing.flatMap { listOf(it.name, sidecarName(it.name)) }.toSet()
    val existingNames = existingFileNames(root)
    val fileName = uniqueName(code, title, extension, ownNames, existingNames)
    val sideName = sidecarName(fileName)

    val rawCreated = draft.opt("createdAt")
    val createdAt: Any = if (!isNullValue(rawCreated) && !(rawCreated is String && rawCreated.isBlank())) {
      rawCreated!!
    } else {
      existing.firstOrNull()?.createdAt?.takeIf { !isNullValue(it) } ?: System.currentTimeMillis()
    }
    val rawUpdated = draft.opt("updatedAt")
    val updatedAt: Any? = if (!isNullValue(rawUpdated)) rawUpdated else null

    val sideJson = JSONObject().apply {
      put("version", 1)
      put("id", id)
      put("code", code)
      put("title", title)
      put("createdAt", createdAt)
      if (updatedAt != null) put("updatedAt", updatedAt)
    }
    val sideBytes = sideJson.toString(2).toByteArray(StandardCharsets.UTF_8)

    when (root) {
      is StorageRoot.Internal -> {
        writeInternalFile(File(root.dir, fileName), bodyBytes)
        writeInternalFile(File(root.dir, sideName), sideBytes)
        for (old in existing) {
          if (old.name != fileName) File(root.dir, old.name).delete()
          val oldSide = sidecarName(old.name)
          if (oldSide != sideName) File(root.dir, oldSide).delete()
        }
      }
      is StorageRoot.Saf -> {
        writeSafFile(root.tree, fileName, if (extension == "md") "text/markdown" else "text/plain", bodyBytes)
        writeSafFile(root.tree, sideName, "application/json", sideBytes)
        for (old in existing) {
          if (old.name != fileName) root.tree.findFile(old.name)?.delete()
          val oldSide = sidecarName(old.name)
          if (oldSide != sideName) root.tree.findFile(oldSide)?.delete()
        }
      }
    }

    return scanTexts(root).firstOrNull { it.id == id }
      ?: throw IllegalStateException("that text was not found")
  }

  private fun deleteTextRecord(root: StorageRoot, id: String) {
    val matches = scanTexts(root).filter { it.id == id }
    if (matches.isEmpty()) return
    when (root) {
      is StorageRoot.Internal -> {
        for (item in matches) {
          File(root.dir, item.name).delete()
          File(root.dir, sidecarName(item.name)).delete()
        }
      }
      is StorageRoot.Saf -> {
        for (item in matches) {
          root.tree.findFile(item.name)?.delete()
          root.tree.findFile(sidecarName(item.name))?.delete()
        }
      }
    }
  }

  private fun existingFileNames(root: StorageRoot): Set<String> {
    return when (root) {
      is StorageRoot.Internal -> root.dir.listFiles()?.map { it.name }?.toSet() ?: emptySet()
      is StorageRoot.Saf -> root.tree.listFiles().mapNotNull { it.name }.toSet()
    }
  }

  private fun writeInternalFile(target: File, bytes: ByteArray) {
    val tmp = File(target.parentFile, ".${target.name}.tmp")
    tmp.writeBytes(bytes)
    if (!tmp.renameTo(target)) {
      tmp.copyTo(target, overwrite = true)
      tmp.delete()
    }
  }

  private fun writeSafFile(tree: DocumentFile, name: String, mimeType: String, bytes: ByteArray) {
    val existing = tree.findFile(name)
    val doc = existing ?: tree.createFile(mimeType, name)
      ?: throw IllegalStateException("Could not create file: $name")
    activity.contentResolver.openOutputStream(doc.uri, "wt")?.use { out ->
      out.write(bytes)
      out.flush()
    } ?: throw IllegalStateException("Could not write file: $name")
  }

  private fun readUriText(uri: Uri): String {
    return activity.contentResolver.openInputStream(uri)?.use { input ->
      input.readBytes().toString(StandardCharsets.UTF_8)
    } ?: throw IllegalStateException("Could not read file")
  }

  private fun parseSidecar(raw: String): Sidecar? {
    return try {
      val obj = JSONObject(raw)
      Sidecar(
        version = obj.optInt("version", 1),
        id = obj.optString("id", ""),
        code = obj.optString("code", ""),
        title = obj.optString("title", ""),
        createdAt = obj.opt("createdAt"),
        updatedAt = obj.opt("updatedAt")
      )
    } catch (_: Exception) {
      null
    }
  }

  private fun isNullValue(value: Any?): Boolean = value == null || value == JSONObject.NULL

  private fun validateId(id: String) {
    if (id.isEmpty() || id.length > 200 || id.trim().isEmpty()) {
      throw IllegalArgumentException("that text name is not allowed")
    }
    if (id.contains('/') || id.contains('\\') || id.contains('\u0000') || id == "." || id == ".." || id.startsWith('.')) {
      throw IllegalArgumentException("that text name is not allowed")
    }
    if (id.any { it.isISOControl() }) {
      throw IllegalArgumentException("that text name is not allowed")
    }
  }

  private fun normalizeCode(raw: String): String {
    val code = raw.trim()
    if (!isDisplayCode(code)) {
      throw IllegalArgumentException("that text name is not allowed")
    }
    return code
  }

  private fun isDisplayCode(value: String): Boolean {
    if (value.length < 2 || value.length > 16) return false
    val first = value[0]
    if (!((first in 'a'..'z') || (first in 'A'..'Z'))) return false
    return value.substring(1).all { it in '0'..'9' }
  }

  private fun normalizeTitle(title: String): String {
    val clean = title.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")
    if (clean.isEmpty()) return "Untitled"
    return if (clean.length <= 180) clean else clean.substring(0, 179) + "…"
  }

  private fun normalizeExtension(ext: String): String {
    val clean = ext.trim().trimStart('.').lowercase(Locale.ROOT)
    if (clean.isEmpty()) return "md"
    if (clean == "md" || clean == "txt") return clean
    throw IllegalArgumentException("that text name is not allowed")
  }

  private fun textExtension(name: String): String? {
    val dot = name.lastIndexOf('.')
    if (dot <= 0) return null
    val ext = name.substring(dot + 1).lowercase(Locale.ROOT)
    return if (ext == "md" || ext == "txt") ext else null
  }

  private fun fileStem(name: String): String {
    val dot = name.lastIndexOf('.')
    if (dot <= 0) return name
    val ext = name.substring(dot + 1).lowercase(Locale.ROOT)
    return if (ext == "md" || ext == "txt" || ext == "json") name.substring(0, dot) else name
  }

  private fun sidecarName(textName: String): String = "${fileStem(textName)}.json"

  private fun slug(title: String): String {
    val out = StringBuilder()
    var hyphen = false
    for (ch in title) {
      if (out.length >= 80) break
      if ((ch in 'a'..'z') || (ch in 'A'..'Z') || (ch in '0'..'9')) {
        out.append(ch.lowercaseChar())
        hyphen = false
      } else if (ch.isLetterOrDigit()) {
        val lower = ch.lowercase(Locale.ROOT)
        for (c in lower) {
          if (out.length >= 80) break
          out.append(c)
        }
        hyphen = false
      } else if (out.isNotEmpty() && !hyphen) {
        out.append('-')
        hyphen = true
      }
    }
    while (out.endsWith('-')) out.deleteCharAt(out.length - 1)
    return if (out.isEmpty()) "untitled" else out.toString()
  }

  private fun uniqueName(
    code: String,
    title: String,
    extension: String,
    ownNames: Set<String>,
    existingNames: Set<String>
  ): String {
    val s = slug(title)
    for (index in 1 until 1000) {
      val stem = if (index == 1) "$code-$s" else "$code-$s-$index"
      val head = stem.substringBefore('.').uppercase(Locale.ROOT)
      if (RESERVED_STEMS.contains(head)) continue
      val name = "$stem.$extension"
      if (name.length > 180) throw IllegalArgumentException("that text name is not allowed")
      val taken = listOf("md", "txt", "json").any { ext ->
        val candidate = "$stem.$ext"
        !ownNames.contains(candidate) && existingNames.contains(candidate)
      }
      if (!taken) return name
    }
    throw IllegalArgumentException("that text name is not allowed")
  }

  private fun stableFileId(name: String): String {
    var hash = -0x340d631b7bdddcdbL // 0xcbf29ce484222325UL
    for (byte in name.toByteArray(StandardCharsets.UTF_8)) {
      hash = hash xor (byte.toLong() and 0xffL)
      hash *= 0x100000001b3L
    }
    return String.format(Locale.ROOT, "file-%016x", hash)
  }

  private fun titleAndCodeFromStem(stem: String): Pair<String, String> {
    val idx = stem.indexOf('-')
    val head = if (idx >= 0) stem.substring(0, idx) else stem
    val tail = if (idx >= 0) stem.substring(idx + 1) else ""
    val (code, rest) = if (isDisplayCode(head)) head to tail else "" to stem
    val spaced = rest.replace('-', ' ').replace('_', ' ').trim()
    val titled = titleCase(spaced).ifEmpty { "Untitled" }
    val clamped = if (titled.length <= 180) titled else titled.substring(0, 179) + "…"
    return code to clamped
  }

  private fun titleCase(raw: String): String {
    val words = raw.lowercase(Locale.ROOT).split(Regex("\\s+")).filter { it.isNotEmpty() }
    return words.mapIndexed { index, word ->
      if (index > 0 && SMALL_WORDS.contains(word)) word
      else word.replaceFirstChar { it.titlecase(Locale.ROOT) }
    }.joinToString(" ")
  }

  private fun createdMillis(value: Any?): Long {
    return when (value) {
      is Number -> value.toLong()
      is String -> try {
        java.time.Instant.parse(value).toEpochMilli()
      } catch (_: Exception) {
        0L
      }
      else -> 0L
    }
  }
}
