const HOST_NAME = "com.claudefm.host";
const MEMORY_TEMPLATE_PATH = "";

const ports = new Set();
const pendingLocationResolvers = new Map();

let providerTabId = null;
let externalInterruptActive = false;
let welcomeInFlight = false;
let autoRecommendDone = false;
let currentLang = "zh";

function bgT(zh, en) {
  return currentLang === "en" ? en : zh;
}
let creatingOffscreen = null;
let playerStateCache = {
  queue: [],
  queueIndex: -1,
  currentTrack: null,
  playing: false,
  currentTime: 0,
  duration: 0,
  interrupted: false,
  userPaused: false,
  speechActive: false,
  speechPaused: false,
  preloadIndex: -1,
  preloadStatus: "idle",
  lastUpdatedAt: 0,
};

async function getPreferences() {
  const { preferences } = await chrome.storage.local.get("preferences");
  return {
    interruptAware: preferences?.interruptAware ?? true,
    ...preferences,
  };
}

function formatLocalDateKey(date = new Date()) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

function broadcast(msg) {
  ports.forEach((p) => {
    try {
      p.postMessage(msg);
    } catch {}
  });
}

async function hasOffscreenDocument(pathname = "offscreen.html") {
  const offscreenUrl = chrome.runtime.getURL(pathname);
  if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }
  const matchedClients = await self.clients.matchAll();
  return matchedClients.some((client) => client.url === offscreenUrl);
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Keep the hidden playback runtime alive outside the side panel lifecycle.",
    });
  }
  try {
    await creatingOffscreen;
  } finally {
    creatingOffscreen = null;
  }
}

async function sendOffscreenCommand(command, payload = {}) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    command,
    ...payload,
  });
  if (response?.ok && response.state) {
    playerStateCache = response.state;
  }
  return response;
}

function sendNative(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        void chrome.storage.local.set({
          nativeHostAvailable: false,
          nativeHostLastError: err.message,
        });
        resolve({ ok: false, error: err.message });
        return;
      }
      if (response?.ok) {
        void chrome.storage.local.set({
          nativeHostAvailable: true,
          nativeHostLastError: "",
        });
      }
      resolve(response);
    });
  });
}

async function sendNativeWithTimeout(payload, timeoutMs = 1200) {
  const timeoutResp = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: false, error: "timeout" }), timeoutMs);
  });
  try {
    const resp = await Promise.race([sendNative(payload), timeoutResp]);
    return resp;
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    return { ok: false, error: message };
  }
}

async function appendDailyConversation(kind, userText, result) {
  return await sendNative({
    type: "appendDailyConversation",
    kind,
    userText: userText ?? "",
    result: result ?? null,
  });
}

function normalizeTrackQuery(track) {
  const name = String(track?.name || track?.query || "").trim();
  const artist = String(track?.artist || "").trim();
  return { name, artist };
}

function cleanProviderValue(value) {
  return String(value ?? "")
    .replace(/^[\s`'"]+|[\s`'"]+$/g, "")
    .trim();
}

function normalizeForCompare(value) {
  return cleanProviderValue(value).toLowerCase().replace(/\s+/g, "");
}

function scoreResolvedTrack(query, candidate) {
  const queryName = normalizeForCompare(query?.name || "");
  const queryArtist = normalizeForCompare(query?.artist || "");
  const candidateName = normalizeForCompare(candidate?.name || "");
  const candidateArtist = normalizeForCompare(candidate?.artist || "");

  let score = 0;
  if (!candidateName) return score;
  if (queryName && candidateName === queryName) score += 10;
  else if (queryName && candidateName.includes(queryName)) score += 6;
  else if (queryName && queryName.includes(candidateName)) score += 4;

  if (queryArtist && candidateArtist === queryArtist) score += 8;
  else if (queryArtist && candidateArtist.includes(queryArtist)) score += 5;
  else if (queryArtist && queryArtist.includes(candidateArtist)) score += 3;

  return score;
}

function extractSongIds(searchHtml) {
  const ids = [];
  const seen = new Set();
  const matches = searchHtml.matchAll(/song\.php\?id=(\d+)/g);
  for (const match of matches) {
    const id = match?.[1] ? String(match[1]).trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 5) break;
  }
  return ids;
}

function parseSongPage(songHtml, fallbackTrack) {
  const urlMatch = songHtml.match(/url\s*:\s*[`'"]([^`'"]+)[`'"]/i);
  const nameMatch = songHtml.match(/(?:name|title)\s*:\s*[`'"]([^`'"]+)[`'"]/i);
  const artistMatch = songHtml.match(/artist\s*:\s*[`'"]([^`'"]+)[`'"]/i);
  const coverMatch = songHtml.match(/cover\s*:\s*[`'"]([^`'"]+)[`'"]/i);

  const streamUrl = cleanProviderValue(urlMatch?.[1] || "");
  const name = cleanProviderValue(nameMatch?.[1] || fallbackTrack?.name || "");
  const artist = cleanProviderValue(artistMatch?.[1] || fallbackTrack?.artist || "");
  const cover = cleanProviderValue(coverMatch?.[1] || "");

  if (!streamUrl) return null;

  return {
    provider: "paojiao",
    track: { name, artist },
    streamUrl,
    cover,
    durationMs: 0,
  };
}

async function resolveTrackViaFetch(track) {
  const { name, artist } = normalizeTrackQuery(track);
  if (!name) return null;

  try {
    const searchQuery = encodeURIComponent([name, artist].filter(Boolean).join(" "));
    const searchUrl = `https://music.pjmp3.com/search.php?keyword=${searchQuery}&n=1`;
    console.log("[background] resolveTrackViaFetch search", { name, artist, searchUrl });

    const searchResp = await fetch(searchUrl, {
      credentials: "include",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!searchResp.ok) {
      console.warn("[background] search failed", searchResp.status, { name, artist });
      return null;
    }

    const searchHtml = await searchResp.text();
    const songIds = extractSongIds(searchHtml);
    if (!songIds.length) {
      console.warn("[background] no song ID found", { name, artist });
      return null;
    }

    let bestResult = null;
    let bestScore = -1;

    for (const songId of songIds) {
      const songUrl = `https://music.pjmp3.com/song.php?id=${songId}`;
      console.log("[background] resolveTrackViaFetch song", { songId, songUrl, name, artist });

      const songResp = await fetch(songUrl, {
        credentials: "include",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      if (!songResp.ok) {
        console.warn("[background] song fetch failed", songResp.status, { songId, name, artist });
        continue;
      }

      const songHtml = await songResp.text();
      const parsed = parseSongPage(songHtml, { name, artist });
      if (!parsed?.streamUrl) continue;

      const score = scoreResolvedTrack({ name, artist }, parsed.track);
      console.log("[background] resolveTrackViaFetch matches", {
        songId,
        score,
        streamUrl: parsed.streamUrl,
        resolvedName: parsed.track.name,
        resolvedArtist: parsed.track.artist,
      });

      if (score > bestScore) {
        bestScore = score;
        bestResult = parsed;
      }

      if (score >= 18) break;
    }

    return bestResult;
  } catch (error) {
    console.error("[background] resolveTrackViaFetch error", error, { name, artist });
    return null;
  }
}

async function ensureProviderTab() {
  if (providerTabId != null) {
    try {
      const tab = await chrome.tabs.get(providerTabId);
      if (tab && !tab.discarded) return providerTabId;
    } catch {
      providerTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: "https://music.pjmp3.com/",
    active: false,
  });
  providerTabId = tab.id;

  await new Promise((r) => setTimeout(r, 2000));

  try {
    await chrome.scripting.executeScript({
      target: { tabId: providerTabId },
      files: ["providers/paojiao/adapter.js"],
    });
  } catch {}

  await new Promise((r) => setTimeout(r, 2000));

  return providerTabId;
}

async function resolveTrackViaProviderTab(track) {
  const tabId = await ensureProviderTab();
  const result = await new Promise((resolve) => {
    let attempts = 0;
    const trySend = () => {
      chrome.tabs.sendMessage(
        tabId,
        { type: "paojiao.resolveTrack", track },
        (resp) => {
          const err = chrome.runtime.lastError;
          if (err && err.message.includes("Receiving end does not exist")) {
            attempts++;
            if (attempts < 20) {
              setTimeout(trySend, 500);
              return;
            }
            resolve(null);
            return;
          }
          resolve(resp ?? null);
        }
      );
    };
    trySend();
  });
  return result;
}

function demoStreamUrl(track) {
  return "";
}

async function validateStreamUrl(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

async function resolveTrackWithFallback(track) {
  try {
    const query = normalizeTrackQuery(track);
    if (query?.name && query?.artist) {
      const cached = await sendNativeWithTimeout({ type: "getCachedTrack", track: query }, 900);
      if (cached?.ok && cached?.hit && cached?.resolved?.streamUrl) {
        const valid = await validateStreamUrl(cached.resolved.streamUrl);
        if (valid) return cached.resolved;
        console.log("[background] cached streamUrl expired, re-resolving:", query.name);
        void sendNativeWithTimeout({ type: "invalidateCache", track: query }, 600);
      }
    }
  } catch {}

  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 800));

    const directResult = await resolveTrackViaFetch(track);
    if (directResult?.streamUrl) {
      try {
        const query = normalizeTrackQuery(track);
        if (query?.name && query?.artist) {
          void sendNativeWithTimeout({ type: "cacheTrack", track: query, resolved: directResult }, 1200);
        }
      } catch {}
      return directResult;
    }

    const tabResult = await resolveTrackViaProviderTab(track);
    if (tabResult?.streamUrl) {
      try {
        const query = normalizeTrackQuery(track);
        if (query?.name && query?.artist) {
          void sendNativeWithTimeout({ type: "cacheTrack", track: query, resolved: tabResult }, 1200);
        }
      } catch {}
      return tabResult;
    }
  }

  console.warn("[background] resolveTrack failed after retries", { track });
  return null;
}

async function warmCacheTracks(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const cleaned = list
    .map((t) => normalizeTrackQuery(t))
    .filter((t) => t?.name && t?.artist)
    .slice(0, 10);
  if (!cleaned.length) return;

  for (const t of cleaned) {
    try {
      const cached = await sendNativeWithTimeout({ type: "getCachedTrack", track: t }, 600);
      if (cached?.ok && cached?.hit && cached?.resolved?.streamUrl) {
        const valid = await validateStreamUrl(cached.resolved.streamUrl);
        if (valid) continue;
        void sendNativeWithTimeout({ type: "invalidateCache", track: t }, 600);
      }
      const resolved = await Promise.race([
        resolveTrackViaFetch(t),
        new Promise((resolve) => setTimeout(() => resolve(null), 6500)),
      ]);
      if (resolved?.streamUrl) {
        void sendNativeWithTimeout({ type: "cacheTrack", track: t, resolved }, 1200);
      }
    } catch {}
  }
}

async function onChat(text, options = {}) {
  const { turnCount } = await chrome.storage.local.get("turnCount");
  const nextTurnCount = Number(turnCount ?? 0) + 1;
  await chrome.storage.local.set({ turnCount: nextTurnCount });

  const { profileSummary } = await chrome.storage.local.get("profileSummary");
  const { trackVotesV1 } = await chrome.storage.local.get("trackVotesV1");
  const prefs = await getPreferences();

  const votes = trackVotesV1 && typeof trackVotesV1 === "object" ? trackVotesV1 : {};
  const likedTracks = [];
  const dislikedTracks = [];
  Object.entries(votes).forEach(([key, v]) => {
    const vote = Number(v);
    if (vote !== 1 && vote !== -1) return;
    const k = String(key || "");
    const parts = k.split("|");
    if (parts.length < 2) return;
    const name = parts[0] ? String(parts[0]).trim() : "";
    const artist = parts[1] ? String(parts[1]).trim() : "";
    if (!name || !artist) return;
    if (vote === 1) likedTracks.push({ name, artist });
    else dislikedTracks.push({ name, artist });
  });

  const payload = {
    type: "chat",
    text,
    lang: currentLang,
    djName: prefs.djName ?? "Claudefm",
    provider: "paojiao",
    profileSummary: profileSummary ?? "",
    turnCountSinceLastProfileRefresh: nextTurnCount % 3,
    forceProfileRefresh: nextTurnCount % 3 === 0,
    forceRecommend: Boolean(options?.forceRecommend),
    chatOnly: Boolean(options?.chatOnly),
    likedTracks: likedTracks.slice(0, 20),
    dislikedTracks: dislikedTracks.slice(0, 20),
    preferences: {
      localAiToolMode: prefs.localAiToolMode || "auto",
      localAiToolId: prefs.localAiToolId || "",
      aiProvider: prefs.aiProvider || "local",
    },
  };

  const resp = await Promise.race([
    sendNative(payload),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "Host 响应超时，请稍后再试" }), 135000)),
  ]);
  if (!resp?.ok) {
    const extensionId = chrome.runtime.id;
    const toolLabel = resp?.toolContext?.toolLabel || "本地 AI 工具";
    const hint =
      resp?.error?.includes("forbidden") || resp?.error?.includes("Not allowed")
        ? `Native Host 未授权（extensionId=${extensionId}）。请更新 host/install-<platform>.json（或 host/install-macos.json 兼容）里的 extensionId，并运行：node host/install.mjs（执行后需要完全退出并重启浏览器）`
        : `${toolLabel} 不可用或 Host 未安装（extensionId=${extensionId}）。可运行：node host/install.mjs`;
    broadcast({
      type: "chatResult",
      result: { say: resp?.error || bgT("Claude Code 不可用或 Host 未安装。", "Claude Code unavailable or Host not installed."), play: [] },
    });
    broadcast({ type: "chatResult", result: { say: hint, play: [] } });
    return;
  }

  if (resp.profileSummary) {
    await chrome.storage.local.set({ profileSummary: resp.profileSummary });
    try {
      void sendNative({
        type: "optimizeMemoryFile",
        djName: prefs.djName ?? "Claudefm",
        profileSummary: resp.profileSummary ?? profileSummary ?? "",
        templatePath: MEMORY_TEMPLATE_PATH,
      });
    } catch {}
  }

  try {
    if (resp.result && typeof resp.result === "object" && Array.isArray(resp.result.play)) {
      resp.result.play = applyTrackVotesFilter(resp.result.play, votes);
    }
  } catch {}

  broadcast({ type: "chatResult", result: resp.result, toolContext: resp.toolContext || null });
  try {
    await appendDailyConversation("chat", text, resp.result);
  } catch {}
  try {
    await prependListSection("chat", resp.result);
  } catch {}
  try {
    const play = resp?.result?.play;
    if (Array.isArray(play) && play.length) void warmCacheTracks(play);
  } catch {}

  if (nextTurnCount % 10 === 0) {
    try {
      await sendNative({
        type: "optimizeMemoryFile",
        djName: prefs.djName ?? "Claudefm",
        profileSummary: resp.profileSummary ?? profileSummary ?? "",
        templatePath: MEMORY_TEMPLATE_PATH,
      });
    } catch {}
  }
}

async function exportMemoryMd() {
  const { profileSummary } = await chrome.storage.local.get("profileSummary");
  const prefs = await getPreferences();
  return await sendNative({
    type: "optimizeMemoryFile",
    lang: currentLang,
    djName: prefs.djName ?? "Claudefm",
    profileSummary: profileSummary ?? "",
    templatePath: MEMORY_TEMPLATE_PATH,
  });
}

async function readMemoryFile() {
  return await sendNative({ type: "readMemoryFile" });
}

async function readListFile() {
  return await sendNative({ type: "readListFile" });
}

async function importListTracks(tracks) {
  return await sendNative({ type: "importListTracks", tracks: Array.isArray(tracks) ? tracks : [] });
}

async function prependListSection(kind, result) {
  const k = String(kind || "").trim() || "chat";
  const play = result && typeof result === "object" ? result.play : null;
  const tracks = Array.isArray(play)
    ? play
        .map((t) => ({
          name: String(t?.name || "").trim(),
          artist: String(t?.artist || "").trim(),
        }))
        .filter((t) => t.name && t.artist)
    : [];
  if (!tracks.length) return { ok: true, skipped: true };
  return await sendNative({ type: "prependListSection", kind: k, tracks });
}

function normalizeVoteKey(name, artist) {
  const strip = (v) =>
    String(v || "")
      .toLowerCase()
      .trim()
      .replace(/[\s\-_–—·•、，,。.!！?？'"“”‘’()（）【】[\]{}<>《》:：;；/\\|]+/g, "");
  return `${strip(name)}|${strip(artist)}`;
}

function applyTrackVotesFilter(tracks, votes) {
  const list = Array.isArray(tracks) ? tracks : [];
  const map = votes && typeof votes === "object" ? votes : {};
  const dislikedArtists = new Set();
  Object.entries(map).forEach(([k, v]) => {
    if (Number(v) !== -1) return;
    const parts = String(k || "").split("|");
    if (parts.length < 2) return;
    const artist = parts[1] ? String(parts[1]).trim() : "";
    if (artist) dislikedArtists.add(artist);
  });
  return list.filter((t) => {
    const name = t?.name ? String(t.name).trim() : "";
    const artist = t?.artist ? String(t.artist).trim() : "";
    if (!name || !artist) return false;
    const key = normalizeVoteKey(name, artist);
    if (Number(map[key]) === -1) return false;
    if (dislikedArtists.has(artist)) return false;
    return true;
  });
}

async function prependListSectionTracks(kind, tracks) {
  const k = String(kind || "").trim() || "chat";
  const cleaned = Array.isArray(tracks)
    ? tracks
        .map((t) => ({
          name: String(t?.name || "").trim(),
          artist: String(t?.artist || "").trim(),
        }))
        .filter((t) => t.name && t.artist)
    : [];
  if (!cleaned.length) return { ok: true, skipped: true };
  return await sendNative({ type: "prependListSection", kind: k, tracks: cleaned });
}

function requestLocationFromPort(port) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingLocationResolvers.delete(port);
      resolve({ ok: false, error: "timeout" });
    }, 12000);

    pendingLocationResolvers.set(port, (payload) => {
      clearTimeout(timer);
      pendingLocationResolvers.delete(port);
      resolve(payload);
    });

    try {
      port.postMessage({ type: "requestLocation" });
    } catch {
      clearTimeout(timer);
      pendingLocationResolvers.delete(port);
      resolve({ ok: false, error: "port postMessage failed" });
    }
  });
}

async function maybeWelcome(port) {
  if (welcomeInFlight) return;
  if (autoRecommendDone) return;

  welcomeInFlight = true;
  try {
    const ensure = await sendNative({
      type: "ensureMusicFile",
      lang: currentLang,
      templatePath: MEMORY_TEMPLATE_PATH,
    });
    if (!ensure?.ok) {
      const extensionId = chrome.runtime.id;
      broadcast({
        type: "chatResult",
        result: { say: ensure?.error || bgT("初始化 music.md 失败。", "Failed to initialize music.md."), play: [] },
      });
      broadcast({
        type: "chatResult",
        result: {
          say: `Native Host 不可用或未授权（extensionId=${extensionId}）。可更新 host/install-<platform>.json（或 host/install-macos.json 兼容）的 extensionId 后执行：node host/install.mjs（执行后需要完全退出并重启浏览器；若仍 forbidden 请检查 chrome://policy 是否限制 NativeMessaging）`,
          play: [],
        },
      });
      return;
    }
    if (ensure.created) {
      broadcast({
        type: "chatResult",
        result: {
          say: bgT(
            `已初始化 music.md（模板来自 ${MEMORY_TEMPLATE_PATH}）。你可以在本机 Claudefm 数据目录中找到它（macOS 默认 ~/Documents/Claudefm；Linux 默认 ~/.local/share/Claudefm；Windows 默认 %APPDATA%\\Claudefm）。`,
            `Initialized music.md (template from ${MEMORY_TEMPLATE_PATH}). You can find it in your local Claudefm data directory (macOS: ~/Documents/Claudefm; Linux: ~/.local/share/Claudefm; Windows: %APPDATA%\\Claudefm).`
          ),
          play: [],
        },
      });
    }

    const prefs = await getPreferences();
    const { profileSummary } = await chrome.storage.local.get("profileSummary");
    const { trackVotesV1 } = await chrome.storage.local.get("trackVotesV1");
    const votes = trackVotesV1 && typeof trackVotesV1 === "object" ? trackVotesV1 : {};

    const loc = await requestLocationFromPort(port);
    const lat = loc?.coords?.latitude;
    const lon = loc?.coords?.longitude;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    const payload = {
      type: "welcome",
      lang: currentLang,
      djName: prefs.djName ?? "Claudefm",
      provider: "paojiao",
      profileSummary: profileSummary ?? "",
      templatePath: MEMORY_TEMPLATE_PATH,
      latitude: hasCoords ? lat : null,
      longitude: hasCoords ? lon : null,
      likedTracks: [],
      dislikedTracks: [],
      preferences: {
        localAiToolMode: prefs.localAiToolMode || "auto",
        localAiToolId: prefs.localAiToolId || "",
        aiProvider: prefs.aiProvider || "local",
      },
    };

    const resp = await sendNative(payload);
    if (resp?.ok) {
      if (resp.profileSummary) {
        await chrome.storage.local.set({ profileSummary: resp.profileSummary });
        try {
          void sendNative({
            type: "optimizeMemoryFile",
            lang: currentLang,
            djName: prefs.djName ?? "Claudefm",
            profileSummary: resp.profileSummary ?? profileSummary ?? "",
            templatePath: MEMORY_TEMPLATE_PATH,
          });
        } catch {}
      }
      try {
        if (resp.result && typeof resp.result === "object" && Array.isArray(resp.result.play)) {
          resp.result.play = applyTrackVotesFilter(resp.result.play, votes);
        }
      } catch {}
      broadcast({ type: "chatResult", result: resp.result });
      try {
        await appendDailyConversation("welcome", "", resp.result);
      } catch {}
      try {
        await prependListSection("welcome", resp.result);
      } catch {}
      autoRecommendDone = true;
    } else {
      broadcast({
        type: "chatResult",
        result: { say: resp?.error || bgT("欢迎语生成失败。", "Welcome message generation failed."), play: [] },
      });
    }
  } finally {
    welcomeInFlight = false;
  }
}

async function updateExternalAudioState() {
  const prefs = await getPreferences();
  if (!prefs.interruptAware) return;

  const audibleTabs = await chrome.tabs.query({ audible: true });
  const active = audibleTabs.some((t) => {
    if (t.id == null) return false;
    if (t.id === providerTabId) return false;
    if (t.url?.startsWith("chrome-extension://")) return false;
    return true;
  });

  if (active && !externalInterruptActive) {
    externalInterruptActive = true;
    try {
      await sendOffscreenCommand("player.interruptStart");
    } catch {}
  } else if (!active && externalInterruptActive) {
    externalInterruptActive = false;
    try {
      await sendOffscreenCommand("player.interruptEnd");
    } catch {}
  }
}

chrome.runtime.onConnect.addListener(async (port) => {
  ports.add(port);
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    pendingLocationResolvers.delete(port);
  });
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      if (msg.lang) currentLang = String(msg.lang);
      void ensureOffscreenDocument();
      try {
        port.postMessage({ type: "player.state", state: playerStateCache, reason: "connect" });
      } catch {}
      void maybeWelcome(port);
      return;
    }
    if (msg.type === "locationResult") {
      const resolve = pendingLocationResolvers.get(port);
      if (resolve) resolve(msg);
    }
  });
});

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (!msg || typeof msg !== "object") {
        sendResponse({ ok: false, error: "invalid message" });
        return;
      }
      if (msg.target === "offscreen") {
        return;
      }
      if (msg.type === "player.stateBroadcast") {
        playerStateCache = msg.state && typeof msg.state === "object" ? msg.state : playerStateCache;
        try {
          await chrome.storage.local.set({ [msg.cacheKey || "playerStateCacheV1"]: playerStateCache });
        } catch {}
        broadcast({ type: "player.state", state: playerStateCache, reason: msg.reason || "" });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "player.errorBroadcast") {
        broadcast({ type: "player.error", error: msg.error || "", context: msg.context || "" });
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "player.getPreferences") {
        const prefs = await getPreferences();
        sendResponse({
          ok: true,
          prefs: {
            ttsVoiceId: String(prefs.ttsVoiceId || "").trim(),
          },
        });
        return;
      }
      if (msg.type === "player.getState") {
        try {
          const res = await sendOffscreenCommand("player.getState");
          if (res?.ok && res.state) {
            playerStateCache = res.state;
          }
        } catch {}
        sendResponse({ ok: true, state: playerStateCache });
        return;
      }
      if (
        msg.type === "player.playAt" ||
        msg.type === "player.play" ||
        msg.type === "player.pause" ||
        msg.type === "player.next" ||
        msg.type === "player.prev" ||
        msg.type === "player.seek" ||
        msg.type === "player.replaceQueueAndPlay" ||
        msg.type === "player.insertTrackAtAndPlay" ||
        msg.type === "player.reset" ||
        msg.type === "player.setPreferences"
      ) {
        const res = await sendOffscreenCommand(msg.type, msg);
        sendResponse(res || { ok: false, error: "offscreen unavailable" });
        return;
      }
      if (msg.type === "chat") {
        sendResponse({ ok: true });
        void onChat(msg.text, { forceRecommend: Boolean(msg.forceRecommend), chatOnly: Boolean(msg.chatOnly) }).catch((error) => {
          const message = error?.message ? String(error.message) : String(error);
          broadcast({
            type: "chatResult",
            result: { say: bgT(`发生错误：${message}`, `Error: ${message}`), play: [] },
          });
        });
        return;
      }
      if (msg.type === "nextBatch") {
        sendResponse({ ok: true });
        try {
          const prefs = await getPreferences();
          const { profileSummary } = await chrome.storage.local.get("profileSummary");
          const { trackVotesV1 } = await chrome.storage.local.get("trackVotesV1");
          const votes = trackVotesV1 && typeof trackVotesV1 === "object" ? trackVotesV1 : {};
          const likedTracks = [];
          const dislikedTracks = [];
          Object.entries(votes).forEach(([key, v]) => {
            const vote = Number(v);
            if (vote !== 1 && vote !== -1) return;
            const k = String(key || "");
            const parts = k.split("|");
            if (parts.length < 2) return;
            const name = parts[0] ? String(parts[0]).trim() : "";
            const artist = parts[1] ? String(parts[1]).trim() : "";
            if (!name || !artist) return;
            if (vote === 1) likedTracks.push({ name, artist });
            else dislikedTracks.push({ name, artist });
          });

          const payload = {
            type: "nextBatch",
            lang: currentLang,
            recentTracks: msg.recentTracks || [],
            djName: prefs.djName ?? "Claudefm",
            provider: "paojiao",
            profileSummary: profileSummary ?? "",
            likedTracks: likedTracks.slice(0, 20),
            dislikedTracks: dislikedTracks.slice(0, 20),
            preferences: {
              localAiToolMode: prefs.localAiToolMode || "auto",
              localAiToolId: prefs.localAiToolId || "",
              aiProvider: prefs.aiProvider || "local",
            },
          };

          const resp = await sendNative(payload);
          if (!resp?.ok) return;

          if (resp.profileSummary) {
            await chrome.storage.local.set({ profileSummary: resp.profileSummary });
          }
          try {
            if (resp.result && typeof resp.result === "object" && Array.isArray(resp.result.play)) {
              resp.result.play = applyTrackVotesFilter(resp.result.play, votes);
            }
          } catch {}

          void prependListSection("nextBatch", resp.result).catch(() => {});
          try {
            if (Array.isArray(resp.result?.play)) void warmCacheTracks(resp.result.play);
          } catch {}

          let ttsAudioUrl = "";
          const segueText = resp.result?.segue ? String(resp.result.segue).trim() : "";
          if (segueText) {
            try {
              const ttsResp = await sendNativeWithTimeout({ type: "tts", text: segueText }, 30000);
              if (ttsResp?.ok && ttsResp.audioUrl) ttsAudioUrl = ttsResp.audioUrl;
            } catch {}
          }

          void sendOffscreenCommand("player.nextBatchResult", {
            result: resp.result,
            ttsAudioUrl,
          });
        } catch (e) {
          console.warn("[background] nextBatch error", e);
        }
        return;
      }
      if (msg.type === "resolveTrack") {
        const res = await resolveTrackWithFallback(msg.track);
        sendResponse(res);
        return;
      }
      if (msg.type === "getCachedTrack") {
        const query = normalizeTrackQuery(msg.track);
        if (!query?.name || !query?.artist) {
          sendResponse({ ok: false, error: "invalid track" });
          return;
        }
        const res = await sendNativeWithTimeout({ type: "getCachedTrack", track: query }, 900);
        sendResponse(res);
        return;
      }
      if (msg.type === "getCachedCoverUrls") {
        const tracks = Array.isArray(msg.tracks) ? msg.tracks.map(normalizeTrackQuery).filter((t) => t?.name && t?.artist) : [];
        const res = await sendNativeWithTimeout({ type: "getCachedCoverUrls", tracks }, 3000);
        sendResponse(res || { ok: false, error: "no response" });
        return;
      }
      if (msg.type === "cleanupExpiredCache") {
        const res = await sendNativeWithTimeout({ type: "cleanupExpiredCache" }, 3000);
        sendResponse(res || { ok: false, error: "no response" });
        return;
      }
      if (msg.type === "exportMemoryMd") {
        const res = await exportMemoryMd();
        sendResponse(res);
        return;
      }
      if (msg.type === "readMemoryFile") {
        const res = await readMemoryFile();
        sendResponse(res);
        return;
      }
      if (msg.type === "readListFile") {
        const res = await readListFile();
        sendResponse(res);
        return;
      }
      if (msg.type === "importListTracks") {
        const res = await importListTracks(msg.tracks);
        sendResponse(res);
        return;
      }
      if (msg.type === "prependListSection") {
        const res = await prependListSectionTracks(msg.kind, msg.tracks);
        sendResponse(res);
        return;
      }
      if (msg.type === "lyricInterlude") {
        const prefs = await getPreferences();
        const { profileSummary } = await chrome.storage.local.get("profileSummary");
        const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
        const res = await sendNative({
          type: "lyricInterlude",
          lang: currentLang,
          djName: prefs.djName ?? "Claudefm",
          profileSummary: profileSummary ?? "",
          tracks,
        });
        sendResponse(res);
        return;
      }
      if (msg.type === "tts") {
        const text = msg.text ? String(msg.text) : "";
        const voiceId = msg.voiceId ? String(msg.voiceId) : "";
        const res = await sendNative({ type: "tts", text, voiceId });
        sendResponse(res);
        return;
      }
      if (msg.type === "detectLocalAiTools") {
        const res = await sendNative({ type: "detectLocalAiTools", forceRefresh: Boolean(msg.forceRefresh) });
        sendResponse(res || { ok: false, error: bgT("Host 无响应", "Host not responding") });
        return;
      }
      if (msg.type === "getResolvedLocalAiTool") {
        const prefs = await getPreferences();
        const res = await sendNative({
          type: "getResolvedLocalAiTool",
          lang: currentLang,
          preferences: {
            localAiToolMode: prefs.localAiToolMode || "auto",
            localAiToolId: prefs.localAiToolId || "",
            aiProvider: prefs.aiProvider || "local",
          },
        });
        sendResponse(res || { ok: false, error: bgT("Host 无响应", "Host not responding") });
        return;
      }
      if (msg.type === "checkCloudAiStatus") {
        const res = await sendNative({ type: "checkCloudAiStatus" });
        sendResponse(res || { ok: false, error: bgT("Host 无响应", "Host not responding") });
        return;
      }
      sendResponse({ ok: false, error: bgT("未知消息类型", "Unknown message type") });
    } catch (error) {
      const message = error?.message ? String(error.message) : String(error);
      broadcast({
        type: "chatResult",
        result: { say: bgT(`发生错误：${message}`, `Error: ${message}`), play: [] },
      });
      sendResponse({ ok: false, error: message });
    }
  })();
  return true;
});

chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo) => {
  if ("audible" in changeInfo) await updateExternalAudioState();
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === providerTabId) providerTabId = null;
  await updateExternalAudioState();
});

chrome.tabs.onActivated.addListener(async () => {
  await updateExternalAudioState();
});
