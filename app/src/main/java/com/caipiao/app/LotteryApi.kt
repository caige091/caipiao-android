package com.caipiao.app

import android.net.Uri
import android.webkit.WebResourceResponse
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 原生版开奖接口代理，逻辑对齐网页项目的 server.js：
 *  - 代理中国福利彩票官网接口（绕过浏览器跨域、补齐 Referer/UA）
 *  - 5 分钟内存缓存；上游故障时用过期缓存兜底
 *  - 仅允许 ssq / 3d 两个彩种
 *
 * shouldInterceptRequest 本身在非 UI 线程回调，可以直接做阻塞网络请求。
 */
object LotteryApi {

    private const val UPSTREAM =
        "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"
    private const val UA =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    private const val REFERER = "https://www.cwl.gov.cn/ygkj/wqkjgg/"
    private const val CACHE_TTL_MS = 5 * 60 * 1000L
    private const val TIMEOUT_MS = 10_000

    private val ALLOWED_GAMES = setOf("ssq", "3d")

    private data class Entry(val ts: Long, val body: String)

    private val cache = HashMap<String, Entry>()
    private val isoFmt =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    fun intercept(uri: Uri): WebResourceResponse {
        val game = uri.getQueryParameter("game") ?: "ssq"
        if (game !in ALLOWED_GAMES) {
            return json(400, JSONObject().put("error", "不支持的彩种，仅支持 ssq / 3d"))
        }

        synchronized(cache) {
            val hit = cache[game]
            if (hit != null && System.currentTimeMillis() - hit.ts < CACHE_TTL_MS) {
                return respond(hit.body, fromCache = true, stale = false)
            }
        }

        return try {
            val body = fetchDraws(game)
            synchronized(cache) { cache[game] = Entry(System.currentTimeMillis(), body) }
            respond(body, fromCache = false, stale = false)
        } catch (e: Exception) {
            val stale = synchronized(cache) { cache[game] }
            if (stale != null) {
                respond(stale.body, fromCache = true, stale = true)
            } else {
                json(502, JSONObject().put("error", "获取开奖数据失败：${e.message}"))
            }
        }
    }

    private fun fetchDraws(game: String): String {
        val url = UPSTREAM + "?name=" + URLEncoder.encode(game, "UTF-8") + "&issueCount=10"
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            instanceFollowRedirects = true
            setRequestProperty("User-Agent", UA)
            setRequestProperty("Referer", REFERER)
            setRequestProperty("Accept", "application/json, text/plain, */*")
        }
        try {
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                ?: throw IllegalStateException("上游接口返回 HTTP $code")
            if (code !in 200..299) throw IllegalStateException("上游接口返回 HTTP $code")

            val data = JSONObject(text)
            if (data.optInt("state", -1) != 0) {
                throw IllegalStateException(data.optString("message", "上游数据格式异常"))
            }
            val results = data.optJSONArray("result")
            if (results == null || results.length() == 0) {
                throw IllegalStateException("上游数据格式异常")
            }
            return text
        } finally {
            conn.disconnect()
        }
    }

    /** 在上游 JSON 上附加与 server.js 一致的 fetchedAt / fromCache / stale 字段后回传。 */
    private fun respond(upstreamBody: String, fromCache: Boolean, stale: Boolean): WebResourceResponse {
        val wrapped = JSONObject(upstreamBody)
            .put("fetchedAt", isoFmt.format(Date()))
            .put("fromCache", fromCache)
            .put("stale", stale)
        return json(200, wrapped)
    }

    private fun json(statusCode: Int, payload: JSONObject): WebResourceResponse {
        val reason = if (statusCode == 200) "OK" else "ERROR"
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)
        return WebResourceResponse(
            "application/json",
            "utf-8",
            statusCode,
            reason,
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(bytes)
        )
    }
}
