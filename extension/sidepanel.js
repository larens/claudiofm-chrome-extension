const port = chrome.runtime.connect({ name: "sidepanel" });
let portDisconnected = false;
try {
  port.onDisconnect.addListener(() => {
    portDisconnected = true;
  });
} catch {}

function safePost(msg) {
  if (portDisconnected) return;
  try {
    port.postMessage(msg);
  } catch {
    portDisconnected = true;
  }
}

const elChat = document.getElementById("chat");
const elInput = document.getElementById("input");
const elSend = document.getElementById("send");
const elBtnMic = document.getElementById("btnMic");
const elComposerHint = document.getElementById("composerHint");
const elAvatarBtn = document.getElementById("avatarBtn");
const elAvatarFile = document.getElementById("avatarFile");
const elAvatarImg = document.getElementById("avatarImg");
const elAvatarFallback = document.getElementById("avatarFallback");
const elDjDisplay = document.getElementById("djDisplay");
const elDjNameText = document.getElementById("djNameText");
const elProviderName = document.getElementById("providerName");
const elBtnQueue = document.getElementById("btnQueue");
const elQueue = document.getElementById("queue");
const elQueueList = document.getElementById("queueList");
const elQueueCount = document.getElementById("queueCount");
const elBtnSoul = document.getElementById("btnSoul");
const elSoulPanel = document.getElementById("soulPanel");
const elSoulClose = document.getElementById("btnSoulClose");
const elSoulStatus = document.getElementById("soulStatus");
const elSoulContent = document.getElementById("soulContent");

const elBtnHistory = document.getElementById("btnHistory");
const elHistoryPanel = document.getElementById("historyPanel");
const elHistoryClose = document.getElementById("btnHistoryClose");
const elHistoryBack = document.getElementById("btnHistoryBack");
const elHistoryImport = document.getElementById("btnHistoryImport");
const elHistoryImportFile = document.getElementById("historyImportFile");
const elHistoryTitle = document.getElementById("historyTitle");
const elHistoryStatus = document.getElementById("historyStatus");
const elHistoryList = document.getElementById("historyList");
const elHistoryDetail = document.getElementById("historyDetail");
const elHistoryDetailName = document.getElementById("historyDetailName");
const elHistoryDetailArtist = document.getElementById("historyDetailArtist");
const elHistoryDetailRaw = document.getElementById("historyDetailRaw");

const elBtnSettings = document.getElementById("btnSettings");
const elSettingsPanel = document.getElementById("settingsPanel");
const elSettingsClose = document.getElementById("btnSettingsClose");
const elSettingsStatus = document.getElementById("settingsStatus");
const elSettingsHint = document.getElementById("settingsHint");
const elSettingsDjNameInput = document.getElementById("settingsDjNameInput");
const elSettingsDjNameSave = document.getElementById("settingsDjNameSave");
const elTtsVoiceCount = document.getElementById("ttsVoiceCount");
const elTtsVoiceSelect = document.getElementById("ttsVoiceSelect");

const elTrackTitle = document.getElementById("trackTitle");
const elTrackTime = document.getElementById("trackTime");
const elProgress = document.getElementById("progress");
const elBtnPlay = document.getElementById("btnPlay");
const elBtnNext = document.getElementById("btnNext");
const elBtnPrev = document.getElementById("btnPrev");
const elAudio = document.getElementById("audio");
const elInterruptHint = document.getElementById("interruptHint");

const audioA = elAudio;
const audioB = new Audio();
audioA.preload = "auto";
audioB.preload = "auto";

let queue = [];
let queueIndex = -1;
let interrupted = false;
let userPaused = false;
let segueSpokenInQueue = 0;
let seeking = false;
let hintTimer = null;
let recognizing = false;
let recognition = null;
let djName = "Claudio";
let activeAudio = audioA;
let preloadAudio = audioB;
let preloadIndex = -1;
let preloadStatus = "idle";
let preloadRequestToken = 0;
let playRequestToken = 0;

let ttsVoiceId = "";
let cachedVoices = [];

let speechActive = false;
let speechPaused = false;
let segmentTarget = 0;
let segmentTracks = [];
let interludeInFlight = false;

let historySections = [];
let historySelectedIndex = -1;
let historyView = "list";
let historyPath = "";

if (elDjDisplay) elDjDisplay.hidden = false;

function getAudioDebugInfo(audio) {
  return {
    src: audio.currentSrc || audio.src || "",
    duration: audio.duration,
    currentTime: audio.currentTime,
    readyState: audio.readyState,
    networkState: audio.networkState,
  };
}

function resetAudioElement(audio) {
  try {
    audio.pause();
  } catch {}
  audio.removeAttribute("src");
  audio.load();
  audio.currentTime = 0;
}

function mergeResolvedTrack(track, resolved) {
  const streamUrl = (resolved?.streamUrl || "").replace(/`/g, "").trim();
  return {
    ...track,
    ...(resolved?.track || {}),
    streamUrl,
    provider: resolved?.provider || track.provider || "resolved",
    cover: resolved?.cover || track.cover || "",
    durationMs: resolved?.durationMs || track.durationMs || 0,
  };
}

function isPreloadedTrack(index) {
  return preloadIndex === index && preloadStatus === "ready" && Boolean(preloadAudio.src);
}

function clearPreload(reason = "reset") {
  preloadRequestToken += 1;
  preloadIndex = -1;
  preloadStatus = "idle";
  resetAudioElement(preloadAudio);
  console.log("[preload] cleared", { reason });
}

async function prefetchTrackAt(index) {
  if (index < 0 || index >= queue.length) return;
  if (index === queueIndex) return;
  if (preloadIndex === index && (preloadStatus === "resolving" || preloadStatus === "loading" || preloadStatus === "ready")) {
    return;
  }

  const track = queue[index];
  if (!track) return;
  if (isSpeechItem(track)) return;

  const token = ++preloadRequestToken;
  preloadIndex = index;
  preloadStatus = "resolving";
  console.log("[preload] start", { index, track });

  try {
    const resolved = await resolveTrack(track);
    if (token !== preloadRequestToken) return;

    const streamUrl = (resolved?.streamUrl || "").replace(/`/g, "").trim();
    if (!streamUrl) throw new Error("prefetch resolve missing streamUrl");

    const mergedTrack = mergeResolvedTrack(track, resolved);
    queue[index] = mergedTrack;
    preloadStatus = "loading";
    resetAudioElement(preloadAudio);
    preloadAudio.src = streamUrl;
    preloadAudio.load();
    console.log("[preload] loading", { index, track: mergedTrack, streamUrl });
  } catch (error) {
    if (token !== preloadRequestToken) return;
    console.warn("[preload] failed", { index, track, error: String(error) });
    preloadIndex = -1;
    preloadStatus = "error";
    resetAudioElement(preloadAudio);
  }
}

function schedulePreloadForNextTrack() {
  for (let i = queueIndex + 1; i >= 0 && i < queue.length; i += 1) {
    const t = queue[i];
    if (!t) continue;
    if (isSpeechItem(t)) continue;
    void prefetchTrackAt(i);
    return;
  }
  clearPreload("no-next-track");
}

async function activatePreloadedTrack(index) {
  if (!isPreloadedTrack(index)) return false;

  const nextTrack = queue[index];
  const previousAudio = activeAudio;
  const nextAudio = preloadAudio;

  console.log("[preload] swap", { index, track: nextTrack, audio: getAudioDebugInfo(nextAudio) });
  try {
    previousAudio.pause();
  } catch {}

  activeAudio = nextAudio;
  preloadAudio = previousAudio;
  preloadIndex = -1;
  preloadStatus = "idle";

  try {
    await activeAudio.play();
  } catch (error) {
    console.error("[preload] swap play failed", error, { index, track: nextTrack });
    activeAudio = previousAudio;
    preloadAudio = nextAudio;
    return false;
  }

  resetAudioElement(preloadAudio);
  updateTimeUI(activeAudio.currentTime, activeAudio.duration);
  updateProgressUI(activeAudio.currentTime, activeAudio.duration);
  setPlayingUI(true);
  safePost({ type: "playbackState", playing: true });
  schedulePreloadForNextTrack();
  return true;
}

async function ensureMicPermission() {
  if (!navigator.mediaDevices?.getUserMedia) return true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  } catch (e) {
    const name = e?.name ? String(e.name) : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      setHint("麦克风权限被拒绝，请在系统与浏览器中允许 Chrome 使用麦克风后重试");
    } else {
      setHint("无法获取麦克风，请检查系统/浏览器麦克风权限");
    }
    return false;
  }
}

function formatTime(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "00:00";
  const t = Math.floor(s);
  const m = Math.floor(t / 60);
  const ss = t % 60;
  return `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function updateTimeUI(currentSec, durationSec) {
  const current = formatTime(currentSec);
  const duration = formatTime(durationSec);
  elTrackTime.textContent = `${current} / ${duration}`;
}

function updateProgressUI(currentSec, durationSec) {
  if (!elProgress) return;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    elProgress.value = "0";
    return;
  }
  const ratio = Math.min(1, Math.max(0, currentSec / durationSec));
  elProgress.value = String(Math.round(ratio * 1000));
}

function setButtonIcon(button, name) {
  if (!button) return;
  const icons = button.querySelectorAll("[data-icon]");
  icons.forEach((icon) => {
    const active = icon.dataset.icon === name;
    if (active) {
      icon.removeAttribute("hidden");
    } else {
      icon.setAttribute("hidden", "");
    }
    icon.style.display = active ? "block" : "none";
  });
}

function setPlayingUI(playing) {
  setButtonIcon(elBtnPlay, playing ? "pause" : "play");
  elBtnPlay.setAttribute("aria-label", playing ? "暂停" : "播放");
}

function buildTitle(track) {
  const name = track?.name ? String(track.name) : "";
  const artist = track?.artist ? String(track.artist) : "";
  if (!name && !artist) return "未播放";
  if (!name) return artist;
  if (!artist) return name;
  return `${name} - ${artist}`;
}

function randomInt(minInclusive, maxInclusive) {
  const min = Number(minInclusive);
  const max = Number(maxInclusive);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return minInclusive;
  return Math.floor(min + Math.random() * (max - min + 1));
}

function resetLyricSegment() {
  segmentTracks = [];
  segmentTarget = randomInt(3, 5);
  interludeInFlight = false;
}

function isSpeechItem(track) {
  return track && typeof track === "object" && track.kind === "speech";
}

function buildInterludeItem(text, tracks) {
  const t = Array.isArray(tracks) ? tracks : [];
  const count = t.length ? `（${t.length} 首）` : "";
  return {
    kind: "speech",
    name: `插播：歌词情绪解读${count}`,
    artist: "",
    text: String(text || "").trim(),
  };
}

function buildSegueItem(text) {
  return {
    kind: "speech",
    name: "DJ 推荐语",
    artist: "",
    text: String(text || "").trim(),
  };
}

async function getPreferences() {
  const { preferences } = await chrome.storage.local.get("preferences");
  return preferences ?? {};
}

async function patchPreferences(patch) {
  const prefs = await getPreferences();
  const next = { ...prefs, ...patch };
  await chrome.storage.local.set({ preferences: next });
  return next;
}

function setAvatarUI(avatarDataUrl) {
  const src = avatarDataUrl ? String(avatarDataUrl) : "";
  if (src) {
    elAvatarImg.src = src;
    elAvatarImg.style.display = "block";
    elAvatarFallback.style.display = "none";
  } else {
    elAvatarImg.removeAttribute("src");
    elAvatarImg.style.display = "none";
    elAvatarFallback.style.display = "grid";
  }
}

function setDjNameUI(name) {
  const raw = name && String(name).trim() ? String(name).trim() : "Claudio";
  djName = Array.from(raw).slice(0, 8).join("") || "Claudio";
  elDjNameText.textContent = djName;
}

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  elChat.appendChild(div);
  elChat.scrollTop = elChat.scrollHeight;
}

function buildPlayListMessage(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return "";
  const lines = tracks.map((t, i) => {
    const name = t?.name ? String(t.name).trim() : "";
    const artist = t?.artist ? String(t.artist).trim() : "";
    const title = [name, artist].filter(Boolean).join(" - ").trim();
    return `${i + 1}. ${title || "未知歌曲"}`;
  });
  return `歌单推荐：\n${lines.join("\n")}`;
}

function renderQueue() {
  if (elQueueCount) elQueueCount.textContent = `（${queue.length}）`;
  elQueueList.innerHTML = "";
  queue.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "queueItem";
    row.addEventListener("click", () => {
      console.log("[renderQueue] row clicked, index:", i);
      void playAt(i);
    });

    const prefix = document.createElement("div");
    prefix.className = "queuePrefix";

    const index = document.createElement("div");
    index.className = "queueIndex";
    index.textContent = String(i + 1);

    const coverBox = document.createElement("div");
    coverBox.className = "queueCoverBox fallback";

    const cover = document.createElement("img");
    cover.className = "queueCover";
    cover.alt = "";
    cover.decoding = "async";
    cover.loading = "lazy";
    const coverUrl = t?.cover ? String(t.cover).trim() : "";
    if (coverUrl) {
      cover.src = coverUrl;
      coverBox.classList.remove("fallback");
    } else {
      cover.hidden = true;
    }
    cover.addEventListener("load", () => {
      cover.hidden = false;
      coverBox.classList.remove("fallback");
    });
    cover.addEventListener("error", () => {
      cover.hidden = true;
      cover.removeAttribute("src");
      coverBox.classList.add("fallback");
    });
    coverBox.appendChild(cover);

    prefix.appendChild(index);
    prefix.appendChild(coverBox);

    const meta = document.createElement("div");
    meta.className = "queueText";

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = t.name || "未知歌曲";
    const artist = document.createElement("div");
    artist.className = "artist";
    artist.textContent = t.artist || "";
    meta.appendChild(name);
    meta.appendChild(artist);

    row.appendChild(prefix);
    row.appendChild(meta);
    if (i === queueIndex) {
      row.style.opacity = "1";
      row.style.fontWeight = "700";
    } else {
      row.style.opacity = "0.85";
    }
    elQueueList.appendChild(row);
  });
}

function setHint(text) {
  if (!elComposerHint) return;
  if (hintTimer) {
    clearTimeout(hintTimer);
    hintTimer = null;
  }
  if (!text) {
    elComposerHint.hidden = true;
    elComposerHint.textContent = "";
    return;
  }
  elComposerHint.textContent = text;
  elComposerHint.hidden = false;
  hintTimer = setTimeout(() => {
    elComposerHint.hidden = true;
    elComposerHint.textContent = "";
    hintTimer = null;
  }, 2600);
}

function setSoulStatus(text) {
  if (!elSoulStatus) return;
  elSoulStatus.textContent = text ? String(text) : "";
}

function setSettingsStatus(text) {
  if (!elSettingsStatus) return;
  const t = text ? String(text) : "";
  const cleaned = t.trim();
  elSettingsStatus.textContent = cleaned;
  if (cleaned) {
    elSettingsStatus.hidden = false;
    elSettingsStatus.removeAttribute("hidden");
  } else {
    elSettingsStatus.hidden = true;
    elSettingsStatus.setAttribute("hidden", "");
  }
}

function refreshSettingsDjNameUI() {
  if (!elSettingsDjNameInput) return;
  elSettingsDjNameInput.value = djName;
}

function openSoulPanel() {
  if (!elSoulPanel) return;
  elSoulPanel.hidden = false;
  setSoulStatus("正在读取…");
}

function closeSoulPanel() {
  if (!elSoulPanel) return;
  elSoulPanel.hidden = true;
}

function openSettingsPanel() {
  if (!elSettingsPanel) return;
  elSettingsPanel.hidden = false;
  refreshSettingsDjNameUI();
  void refreshTtsSettingsUI();
}

function closeSettingsPanel() {
  if (!elSettingsPanel) return;
  elSettingsPanel.hidden = true;
}

function describeVoice(v) {
  const name = v?.name ? String(v.name).trim() : "";
  const lang = v?.lang ? String(v.lang).trim() : "";
  const local = v?.localService ? "本地" : "云端";
  const parts = [];
  if (name) parts.push(name);
  if (lang) parts.push(lang);
  parts.push(local);
  return parts.join(" · ") || "未知音色";
}

function refreshVoiceCache() {
  if (!("speechSynthesis" in window)) {
    cachedVoices = [];
    return;
  }
  const voices = window.speechSynthesis.getVoices();
  cachedVoices = Array.isArray(voices) ? voices.slice() : [];
  cachedVoices.sort((a, b) => {
    const la = String(a?.lang || "");
    const lb = String(b?.lang || "");
    if (la !== lb) return la.localeCompare(lb);
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
}

function pickVoiceById(voiceId) {
  const id = String(voiceId || "").trim();
  if (!id) return null;
  const byUri = cachedVoices.find((v) => String(v?.voiceURI || "") === id);
  if (byUri) return byUri;
  const byName = cachedVoices.find((v) => String(v?.name || "") === id);
  if (byName) return byName;
  return null;
}

async function refreshTtsSettingsUI() {
  if (!elTtsVoiceSelect || !elSettingsHint) return;
  if (!("speechSynthesis" in window)) {
    setSettingsStatus("当前浏览器不支持语音合成");
    if (elTtsVoiceCount) elTtsVoiceCount.textContent = "";
    elTtsVoiceSelect.innerHTML = "";
    elSettingsHint.textContent = "";
    return;
  }

  refreshVoiceCache();
  const zhVoices = cachedVoices.filter((v) => String(v?.lang || "").toLowerCase().startsWith("zh"));
  const list = zhVoices.length ? zhVoices : cachedVoices;

  elTtsVoiceSelect.innerHTML = "";
  const optDefault = document.createElement("option");
  optDefault.value = "";
  optDefault.textContent = "默认（浏览器/系统）";
  elTtsVoiceSelect.appendChild(optDefault);

  list.forEach((v) => {
    const opt = document.createElement("option");
    opt.value = String(v?.voiceURI || v?.name || "");
    opt.textContent = describeVoice(v);
    elTtsVoiceSelect.appendChild(opt);
  });

  const selected = String(ttsVoiceId || "").trim();
  elTtsVoiceSelect.value = selected;
  if (selected && elTtsVoiceSelect.value !== selected) {
    elTtsVoiceSelect.value = "";
  }

  setSettingsStatus("");
  if (elTtsVoiceCount) {
    elTtsVoiceCount.textContent = list.length ? `（可用音色：${list.length} 个）` : "（未发现可用音色）";
  }
  elSettingsHint.textContent = zhVoices.length
    ? "已优先展示中文音色"
    : list.length
      ? "未发现中文音色，已展示全部音色"
      : "";
}

async function refreshSoulFromFile() {
  setSoulStatus("正在读取 ~/Documents/Claudiofm/music.md …");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "readMemoryFile" });
    if (!resp?.ok) {
      setSoulStatus(`读取失败：${resp?.error || "unknown"}`);
      if (elSoulContent) elSoulContent.textContent = "(空)";
      return;
    }
    const content = resp?.content ? String(resp.content) : "";
    if (elSoulContent) elSoulContent.textContent = content && content.trim() ? content.trim() : "(空)";
    setSoulStatus(`已加载：${resp.path || "~/Documents/Claudiofm/music.md"}`);
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setSoulStatus(`读取失败：${message}`);
    if (elSoulContent) elSoulContent.textContent = "(空)";
  }
}

function normalizeHistoryKey(name, artist) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/[\s\-_–—·•、，,。.!！?？'"“”‘’()（）【】[\]{}<>《》:：;；/\\|]+/g, "");
  const a = String(artist || "")
    .toLowerCase()
    .replace(/[\s\-_–—·•、，,。.!！?？'"“”‘’()（）【】[\]{}<>《》:：;；/\\|]+/g, "");
  return `${n}|${a}`;
}

function parseTracksLoose(text, maxTracks = 5000) {
  const tracks = [];
  const raw = String(text || "");
  if (!raw.trim()) return tracks;
  const lines = raw.split(/\r?\n/g);
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    const patterns = [
      /^\s*-\s*(.+?)\s*[-–—]\s*(.+?)\s*$/u,
      /^\s*\d+[.、】【、)]\s*(.+?)\s*[-–—]\s*(.+?)\s*$/u,
      /^\s*["“](.+?)["”]\s*[-–—]\s*["“](.+?)["”]\s*$/u,
      /^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/u,
      /^\s*([^,\t|]+?)\s*[,|\t]\s*([^,\t|]+?)\s*$/u,
    ];
    let hit = null;
    for (const re of patterns) {
      const m = line.match(re);
      if (!m) continue;
      const name = String(m[1] || "").trim();
      const artist = String(m[2] || "").trim();
      if (!name || !artist) continue;
      if (["歌曲", "歌手", "name", "artist", "title"].includes(name)) continue;
      hit = { name, artist, raw: line };
      break;
    }
    if (!hit) {
      const parts = line
        .split(/[,\t|]+/g)
        .map((p) => String(p || "").trim())
        .filter(Boolean);
      if (parts.length >= 2 && !["歌曲", "歌手", "name", "artist", "title"].includes(parts[0])) {
        hit = { name: parts[0], artist: parts[1], raw: line };
      }
    }
    if (hit) tracks.push(hit);
    if (tracks.length >= maxTracks) break;
  }
  return tracks;
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  const s = String(line || "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '"') {
      if (inQuotes && s[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((c) => String(c || "").trim());
}

function parseCsvTracks(text, maxTracks = 5000) {
  const rows = String(text || "")
    .split(/\r?\n/g)
    .map((l) => String(l || "").trim())
    .filter(Boolean);
  if (!rows.length) return [];

  const first = splitCsvLine(rows[0]);
  const firstLower = first.map((c) => c.toLowerCase());
  const nameKeys = ["name", "title", "song", "歌曲", "歌名"];
  const artistKeys = ["artist", "singer", "歌手", "艺人"];
  const idxName = firstLower.findIndex((c) => nameKeys.some((k) => c.includes(k)));
  const idxArtist = firstLower.findIndex((c) => artistKeys.some((k) => c.includes(k)));
  const hasHeader = idxName !== -1 && idxArtist !== -1;

  const start = hasHeader ? 1 : 0;
  const tracks = [];
  for (let i = start; i < rows.length; i += 1) {
    const cells = splitCsvLine(rows[i]);
    const name = String(cells[hasHeader ? idxName : 0] || "").trim();
    const artist = String(cells[hasHeader ? idxArtist : 1] || "").trim();
    if (!name || !artist) continue;
    tracks.push({ name, artist, raw: rows[i] });
    if (tracks.length >= maxTracks) break;
  }
  return tracks;
}

function parseSectionTimestampMs(stamp) {
  const raw = String(stamp || "").trim();
  if (!raw) return null;
  const iso = raw.replace(" ", "T");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function parseListMdSections(text, maxSections = 1000) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/g);

  const patterns = [
    /^\s*-\s*(.+?)\s*[-–—]\s*(.+?)\s*$/u,
    /^\s*\d+[.、】【、)]\s*(.+?)\s*[-–—]\s*(.+?)\s*$/u,
    /^\s*["“](.+?)["”]\s*[-–—]\s*["“](.+?)["”]\s*$/u,
    /^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/u,
    /^\s*([^,\t|]+?)\s*[,|\t]\s*([^,\t|]+?)\s*$/u,
  ];

  const parseTrackLine = (line) => {
    const s = String(line || "").trim();
    if (!s || s.startsWith("#")) return null;
    for (const re of patterns) {
      const m = s.match(re);
      if (!m) continue;
      const name = String(m[1] || "").trim();
      const artist = String(m[2] || "").trim();
      if (!name || !artist) continue;
      if (["歌曲", "歌手", "name", "artist", "title"].includes(name)) continue;
      return { name, artist, raw: s };
    }
    const parts = s
      .split(/[,\t|]+/g)
      .map((p) => String(p || "").trim())
      .filter(Boolean);
    if (parts.length >= 2 && !["歌曲", "歌手", "name", "artist", "title"].includes(parts[0])) {
      return { name: parts[0], artist: parts[1], raw: s };
    }
    return null;
  };

  const sections = [];
  let current = null;
  let ungrouped = [];

  for (const rawLine of lines) {
    const line = String(rawLine || "").trimEnd();
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      if (current) sections.push(current);
      const stamp = trimmed.replace(/^##\s+/, "").trim();
      current = {
        stamp,
        timestampMs: parseSectionTimestampMs(stamp),
        kind: "",
        tracks: [],
      };
      if (sections.length >= maxSections) break;
      continue;
    }
    if (current && (trimmed.startsWith("> kind:") || trimmed.startsWith("<!-- kind:"))) {
      const m = trimmed.match(/kind:\s*([a-zA-Z0-9_-]+)/);
      if (m && m[1]) current.kind = String(m[1]).trim().toLowerCase();
      continue;
    }
    const t = parseTrackLine(trimmed);
    if (!t) continue;
    if (current) current.tracks.push(t);
    else ungrouped.push(t);
  }
  if (current) sections.push(current);

  if (ungrouped.length) {
    sections.push({ stamp: "未分组", timestampMs: null, tracks: ungrouped });
  }

  return sections;
}

function setHistoryStatus(text) {
  if (!elHistoryStatus) return;
  elHistoryStatus.textContent = text ? String(text) : "";
}

function setHistoryView(nextView) {
  historyView = "list";
  if (elHistoryBack) elHistoryBack.hidden = true;
  if (elHistoryImport) {
    elHistoryImport.hidden = false;
    elHistoryImport.removeAttribute("hidden");
  }
  if (elHistoryList) elHistoryList.hidden = false;
  if (elHistoryDetail) elHistoryDetail.hidden = true;
  if (elHistoryTitle) elHistoryTitle.textContent = "历史";
}

function renderHistoryList() {
  if (!elHistoryList) return;
  elHistoryList.innerHTML = "";
  if (!Array.isArray(historySections) || historySections.length === 0) {
    const empty = document.createElement("div");
    empty.style.padding = "10px 2px";
    empty.style.fontSize = "12px";
    empty.style.color = "var(--muted)";
    empty.textContent = "最近 7 天暂无历史记录";
    elHistoryList.appendChild(empty);
    return;
  }

  let globalIndex = 0;
  historySections.forEach((section) => {
    const stamp = section?.stamp ? String(section.stamp) : "";
    const divider = document.createElement("div");
    divider.className = "historyDivider";
    const row = document.createElement("div");
    row.className = "historyDividerRow";
    const icon = document.createElement("span");
    icon.className = "historyDividerIcon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v3"/><path d="M16 2v3"/><path d="M3.5 9h17"/><path d="M5 6h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/></svg>`;
    const text = document.createElement("span");
    text.className = "historyDividerText";
    text.textContent = stamp || "未命名";
    row.appendChild(icon);
    row.appendChild(text);
    divider.appendChild(row);
    elHistoryList.appendChild(divider);

    const tracks = Array.isArray(section?.tracks) ? section.tracks : [];
    tracks.forEach((t) => {
      globalIndex += 1;
      const row = document.createElement("div");
      row.className = "queueItem";

      const prefix = document.createElement("div");
      prefix.className = "queuePrefix";

      const index = document.createElement("div");
      index.className = "queueIndex";
      index.textContent = String(globalIndex);
      prefix.appendChild(index);

      const meta = document.createElement("div");
      meta.className = "queueText";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = t?.name ? String(t.name) : "未知歌曲";
      const artist = document.createElement("div");
      artist.className = "artist";
      artist.textContent = t?.artist ? String(t.artist) : "";
      meta.appendChild(name);
      meta.appendChild(artist);

      row.appendChild(prefix);
      row.appendChild(meta);
      elHistoryList.appendChild(row);
    });
  });
}

function openHistoryDetail(index) {
  return;
}

function openHistoryPanel() {
  if (!elHistoryPanel) return;
  elHistoryPanel.hidden = false;
  setHistoryView("list");
  setHistoryStatus("正在读取…");
}

function closeHistoryPanel() {
  if (!elHistoryPanel) return;
  elHistoryPanel.hidden = true;
}

async function refreshHistoryFromFile() {
  setHistoryStatus("正在读取 ~/Documents/Claudiofm/list.md …");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "readListFile" });
    if (!resp?.ok) {
      setHistoryStatus(`读取失败：${resp?.error || "unknown"}`);
      historySections = [];
      historyPath = "";
      renderHistoryList();
      return;
    }
    historyPath = resp?.path ? String(resp.path) : "";
    const content = resp?.content ? String(resp.content) : "";
    const allSections = parseListMdSections(content, 2000);
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    historySections = allSections.filter((s) => {
      if (s?.timestampMs == null || s.timestampMs < cutoff) return false;
      const kind = String(s?.kind || "").trim().toLowerCase();
      if (!kind) return true;
      return kind !== "import";
    });
    renderHistoryList();
    setHistoryView("list");
    setHistoryStatus(`已加载：${historyPath || "~/Documents/Claudiofm/list.md"}（最近 7 天）`);
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHistoryStatus(`读取失败：${message}`);
    historySections = [];
    historyPath = "";
    renderHistoryList();
  }
}

async function importHistoryFile(file) {
  const f = file;
  if (!f) return;
  setHistoryStatus(`正在导入：${f.name} …`);
  await new Promise((r) => setTimeout(r, 0));

  let text = "";
  try {
    text = await f.text();
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHistoryStatus(`导入失败：${message}`);
    return;
  }

  const lower = String(f.name || "").toLowerCase();
  const lineCount = text ? text.split(/\r?\n/g).length : 0;
  if (lineCount >= 1200) {
    setHistoryStatus(`正在解析：${f.name}（${lineCount} 行）…`);
    await new Promise((r) => setTimeout(r, 0));
  }
  const parsed = lower.endsWith(".csv") ? parseCsvTracks(text, 50000) : parseTracksLoose(text, 50000);
  const seen = new Set();
  const tracks = [];
  for (const t of parsed) {
    const name = String(t?.name || "").trim();
    const artist = String(t?.artist || "").trim();
    if (!name || !artist) continue;
    const key = normalizeHistoryKey(name, artist);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tracks.push({ name, artist });
  }

  if (!tracks.length) {
    setHistoryStatus("导入失败：文件中未识别到可用的歌曲清单");
    return;
  }

  try {
    setHistoryStatus(`正在写入 list.md：共 ${tracks.length} 首…`);
    await new Promise((r) => setTimeout(r, 0));
    const resp = await chrome.runtime.sendMessage({ type: "prependListSection", kind: "import", tracks });
    if (!resp?.ok) {
      setHistoryStatus(`导入失败：${resp?.error || "unknown"}`);
      return;
    }
    if (resp?.skipped) {
      setHistoryStatus("导入完成：未新增（可能全部与历史重复）");
    } else {
      setHistoryStatus(`导入完成：已写入一个新分段（## ${resp?.stamp || "当前时间"}）`);
    }
    await refreshHistoryFromFile();
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHistoryStatus(`导入失败：${message}`);
  }
}

function updateSendState() {
  const text = (elInput?.value ?? "").trim();
  if (recognizing) {
    elSend.disabled = false;
    elSend.classList.add("enabled");
    setButtonIcon(elSend, "stop");
    elSend.setAttribute("aria-label", "结束语音");
    return;
  }
  const enabled = text.length > 0;
  elSend.disabled = !enabled;
  elSend.classList.toggle("enabled", enabled);
  setButtonIcon(elSend, "send");
  elSend.setAttribute("aria-label", "发送");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function dataUrlToImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = String(dataUrl);
  });
}

function canvasToDataUrl(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(canvas.toDataURL("image/png"));
          return;
        }
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(blob);
      },
      "image/webp",
      0.9
    );
  });
}

async function cropAvatar(file) {
  const dataUrl = await fileToDataUrl(file);
  const img = await dataUrlToImage(dataUrl);
  const size = Math.min(img.width, img.height);
  const sx = Math.floor((img.width - size) / 2);
  const sy = Math.floor((img.height - size) / 2);
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.beginPath();
  ctx.arc(48, 48, 48, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, sx, sy, size, size, 0, 0, 96, 96);
  ctx.restore();
  return await canvasToDataUrl(canvas);
}

async function resolveTrack(track) {
  const cachedStreamUrl = (track?.streamUrl || "").replace(/`/g, "").trim();
  if (cachedStreamUrl) {
    return {
      provider: track?.provider || "cached",
      track: {
        name: track?.name || "",
        artist: track?.artist || "",
      },
      streamUrl: cachedStreamUrl,
      cover: track?.cover || "",
      durationMs: track?.durationMs || 0,
    };
  }

  if (typeof window.resolveTrackFromPaojiao === "function") {
    const res = await window.resolveTrackFromPaojiao(track);
    if (res?.streamUrl) return res;
  }
  const res = await chrome.runtime.sendMessage({ type: "resolveTrack", track });
  if (!res || !res.streamUrl) {
    throw new Error("resolve failed");
  }
  return res;
}

async function playAt(i) {
  const token = ++playRequestToken;
  const track = queue[i];
  if (!track) return;
  queueIndex = i;
  userPaused = false;
  seeking = false;
  setPlayingUI(false);
  elTrackTitle.textContent = buildTitle(track);
  updateTimeUI(0, 0);
  updateProgressUI(0, 0);
  renderQueue();

  try {
    activeAudio.pause();
  } catch {}

  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  speechActive = false;
  speechPaused = false;

  if (isSpeechItem(track)) {
    clearPreload("speech");
    resetAudioElement(activeAudio);
    updateTimeUI(0, 0);
    updateProgressUI(0, 0);
    renderQueue();
    const text = track?.text ? String(track.text).trim() : "";
    if (!text) {
      setHint("插播内容为空");
      safePost({ type: "playbackState", playing: false });
      return;
    }
    speechActive = true;
    speechPaused = false;
    setPlayingUI(true);
    safePost({ type: "playbackState", playing: true });
    schedulePreloadForNextTrack();
    refreshVoiceCache();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "zh-CN";
    const v = pickVoiceById(ttsVoiceId);
    if (v) u.voice = v;
    await new Promise((resolve) => {
      u.onend = () => resolve();
      u.onerror = () => resolve();
      try {
        window.speechSynthesis.cancel();
      } catch {}
      window.speechSynthesis.speak(u);
    });
    if (token !== playRequestToken) return;
    speechActive = false;
    speechPaused = false;
    setPlayingUI(false);
    safePost({ type: "playbackState", playing: false });
    await playNext();
    return;
  }

  if (await activatePreloadedTrack(i)) {
    return;
  }

  let resolved;
  try {
    resolved = await resolveTrack(track);
  } catch (e) {
    console.error("[playAt] resolveTrack failed", e, { track, index: i });
    if (token === playRequestToken) {
      setHint("歌曲解析失败，可能是音源不可用或网络问题");
    }
    return;
  }

  if (token !== playRequestToken) return;

  const streamUrl = (resolved?.streamUrl || "").replace(/`/g, "").trim();
  if (!streamUrl) {
    console.error("[playAt] no streamUrl! resolved:", resolved);
    if (token === playRequestToken) {
      setHint("歌曲解析失败：未找到播放链接");
    }
    return;
  }

  const mergedTrack = mergeResolvedTrack(track, resolved);
  queue[i] = mergedTrack;
  elTrackTitle.textContent = buildTitle(mergedTrack);
  renderQueue();

  clearPreload("manual-play");
  if (token !== playRequestToken) return;

  activeAudio.src = streamUrl;
  activeAudio.currentTime = 0;
  activeAudio.load();
  try {
    await activeAudio.play();
  } catch (e) {
    console.error("[playAt] audio.play failed", e, { streamUrl, track: mergedTrack });
    setPlayingUI(false);
    if (token === playRequestToken) {
      setHint("播放失败：浏览器拦截或音源不可播放");
    }
    return;
  }
  if (token !== playRequestToken) return;
  setPlayingUI(true);
  safePost({ type: "playbackState", playing: true });
  schedulePreloadForNextTrack();
}

async function playNext() {
  if (!queue.length) return;
  const next = Math.min(queueIndex + 1, queue.length - 1);
  if (next === queueIndex) return;
  await playAt(next);
}

async function playPrev() {
  if (!queue.length) return;
  const prev = Math.max(queueIndex - 1, 0);
  if (prev === queueIndex) return;
  await playAt(prev);
}

async function requestLyricInterlude(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const cleaned = list
    .map((t) => ({
      name: String(t?.name || "").trim(),
      artist: String(t?.artist || "").trim(),
    }))
    .filter((t) => t.name && t.artist)
    .slice(0, 5);
  if (cleaned.length < 3) return { ok: true, skipped: true, error: "insufficient tracks" };

  const timeoutMs = 12000;
  const timeoutResp = new Promise((resolve) => {
    setTimeout(() => resolve({ ok: true, skipped: true, error: "timeout" }), timeoutMs);
  });
  try {
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: "lyricInterlude", tracks: cleaned }),
      timeoutResp,
    ]);
    return resp ?? { ok: true, skipped: true, error: "empty response" };
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    return { ok: false, error: message };
  }
}

function speak(text) {
  if (!text) return;
  if (!("speechSynthesis" in window)) return;
  refreshVoiceCache();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "zh-CN";
  const v = pickVoiceById(ttsVoiceId);
  if (v) u.voice = v;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function shouldSpeakSegue() {
  if (segueSpokenInQueue >= 3) return false;
  if (queueIndex <= 0) return true;
  if (segueSpokenInQueue === 0) return true;
  return Math.random() < 0.35;
}

async function handleAssistantResult(result) {
  if (typeof result === "string") {
    const text = result.trim();
    if (text) appendMessage("assistant", text);
    else appendMessage("assistant", "未收到有效回复");
    return;
  }

  if (!result || typeof result !== "object") {
    appendMessage("assistant", "未收到有效回复");
    return;
  }

  const hasTracks = Array.isArray(result.play) && result.play.length > 0;
  const parts = [];
  const say = result.say != null ? String(result.say).trim() : "";
  const reason = result.reason != null ? String(result.reason).trim() : "";
  if (say) parts.push(say);
  if (reason) parts.push(reason);
  if (parts.length) appendMessage("assistant", parts.join("\n\n"));
  else if (!hasTracks) appendMessage("assistant", "未收到有效回复");
  const shouldPrefixSegue = hasTracks && queueIndex === -1 && queue.length === 0 && result.segue;
  if (!shouldPrefixSegue && result.segue && shouldSpeakSegue()) {
    segueSpokenInQueue += 1;
    speak(result.segue);
  }

  if (hasTracks) {
    const playListMessage = buildPlayListMessage(result.play);
    if (playListMessage) appendMessage("assistant", playListMessage);
    setHint(`已推荐 ${result.play.length} 首歌曲，可点歌单查看/播放`);
    if (queue.length === 0 || queueIndex >= queue.length - 1) {
      segueSpokenInQueue = 0;
      resetLyricSegment();
    }
    const nextItems = [];
    if (shouldPrefixSegue) {
      const item = buildSegueItem(result.segue);
      if (item.text) {
        nextItems.push(item);
        segueSpokenInQueue += 1;
      }
    }
    nextItems.push(
      ...result.play.map((t) => ({
        ...t,
        streamUrl: (t?.streamUrl || "").replace(/`/g, "").trim(),
        provider: t?.provider || "pending",
      }))
    );
    queue = queue.concat(nextItems);
    renderQueue();
    if (queueIndex === -1) {
      await playAt(0);
    } else {
      schedulePreloadForNextTrack();
    }
  }
}

port.onMessage.addListener(async (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "requestLocation") {
    if (!("geolocation" in navigator) || typeof navigator.geolocation?.getCurrentPosition !== "function") {
      safePost({ type: "locationResult", ok: false, error: "geolocation unsupported" });
      return;
    }
    try {
      const result = await new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              ok: true,
              coords: {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
              },
            }),
          (err) => {
            const message = err?.message ? String(err.message) : "geolocation failed";
            resolve({ ok: false, error: message });
          },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 }
        );
      });
      if (!result.ok) setHint("定位失败，已使用时间与历史记忆推荐");
      safePost({ type: "locationResult", ...result });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      setHint("定位失败，已使用时间与历史记忆推荐");
      safePost({ type: "locationResult", ok: false, error: message });
    }
    return;
  }
  if (msg.type === "chatResult") {
    await handleAssistantResult(msg.result);
    if (elSoulPanel && !elSoulPanel.hidden) {
      try {
        await refreshSoulFromFile();
      } catch {}
    }
    return;
  }
  if (msg.type === "interruptStart") {
    if (!activeAudio.paused) {
      interrupted = true;
      elInterruptHint.hidden = false;
      await activeAudio.pause();
      setPlayingUI(false);
      safePost({ type: "playbackState", playing: false });
    }
    return;
  }
  if (msg.type === "interruptEnd") {
    elInterruptHint.hidden = true;
    if (interrupted && !userPaused) {
      interrupted = false;
      try {
        await activeAudio.play();
        setPlayingUI(true);
        safePost({ type: "playbackState", playing: true });
      } catch {}
    }
    return;
  }
});

elSend.addEventListener("click", async () => {
  if (recognizing) {
    try {
      recognition?.stop?.();
    } catch {}
    return;
  }
  const text = elInput.value.trim();
  if (!text) return;
  elInput.value = "";
  updateSendState();
  appendMessage("user", text);
  try {
    await chrome.runtime.sendMessage({ type: "chat", text });
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    appendMessage("assistant", `发送失败：${message}`);
  }
});

elInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    elSend.click();
  }
});

elInput.addEventListener("input", () => {
  updateSendState();
});

elAvatarBtn.addEventListener("click", () => {
  elAvatarFile.value = "";
  elAvatarFile.click();
});

elAvatarFile.addEventListener("change", async () => {
  const file = elAvatarFile.files && elAvatarFile.files[0];
  if (!file) return;
  try {
    const avatarDataUrl = await cropAvatar(file);
    await patchPreferences({ avatarDataUrl });
    setAvatarUI(avatarDataUrl);
    setHint("头像已更新");
  } catch {
    setHint("头像处理失败");
  }
});



elBtnQueue.addEventListener("click", () => {
  elQueue.hidden = !elQueue.hidden;
});

elBtnPlay.addEventListener("click", async () => {
  if (speechActive && "speechSynthesis" in window) {
    if (speechPaused) {
      speechPaused = false;
      try {
        window.speechSynthesis.resume();
      } catch {}
      setPlayingUI(true);
      safePost({ type: "playbackState", playing: true });
    } else {
      speechPaused = true;
      try {
        window.speechSynthesis.pause();
      } catch {}
      setPlayingUI(false);
      safePost({ type: "playbackState", playing: false });
    }
    return;
  }
  if (!activeAudio.src) {
    if (queue.length) await playAt(Math.max(queueIndex, 0));
    return;
  }
  if (activeAudio.paused) {
    userPaused = false;
    try {
      await activeAudio.play();
      setPlayingUI(true);
      safePost({ type: "playbackState", playing: true });
    } catch {}
  } else {
    userPaused = true;
    await activeAudio.pause();
    setPlayingUI(false);
    safePost({ type: "playbackState", playing: false });
  }
});

elBtnNext.addEventListener("click", playNext);
elBtnPrev.addEventListener("click", playPrev);

function bindAudioEvents(audio, label) {
  audio.addEventListener("play", () => {
    if (audio !== activeAudio) return;
    setPlayingUI(true);
    safePost({ type: "playbackState", playing: true });
  });

  audio.addEventListener("pause", () => {
    if (audio !== activeAudio) return;
    setPlayingUI(false);
    safePost({ type: "playbackState", playing: false });
  });

  audio.addEventListener("loadedmetadata", () => {
    console.log(`[audio:${label}] loadedmetadata`, getAudioDebugInfo(audio));
    if (audio !== activeAudio) return;
    updateTimeUI(audio.currentTime, audio.duration);
    if (!seeking) updateProgressUI(audio.currentTime, audio.duration);
  });

  audio.addEventListener("loadstart", () => {
    console.log(`[audio:${label}] loadstart`, getAudioDebugInfo(audio));
  });

  audio.addEventListener("canplay", () => {
    console.log(`[audio:${label}] canplay`, getAudioDebugInfo(audio));
    if (audio === preloadAudio && preloadStatus === "loading") {
      preloadStatus = "ready";
      console.log("[preload] ready", { index: preloadIndex, audio: getAudioDebugInfo(audio) });
    }
  });

  audio.addEventListener("canplaythrough", () => {
    console.log(`[audio:${label}] canplaythrough`, getAudioDebugInfo(audio));
  });

  audio.addEventListener("durationchange", () => {
    if (audio !== activeAudio) return;
    updateTimeUI(audio.currentTime, audio.duration);
    if (!seeking) updateProgressUI(audio.currentTime, audio.duration);
  });

  audio.addEventListener("timeupdate", () => {
    if (audio !== activeAudio) return;
    updateTimeUI(audio.currentTime, audio.duration);
    if (!seeking) updateProgressUI(audio.currentTime, audio.duration);
  });

  audio.addEventListener("ended", async () => {
    if (audio !== activeAudio) return;
    const stableToken = playRequestToken;
    const finishedIndex = queueIndex;
    const finished = queue[finishedIndex];
    if (segmentTarget <= 0) resetLyricSegment();
    if (finished && !isSpeechItem(finished)) {
      const name = String(finished?.name || "").trim();
      const artist = String(finished?.artist || "").trim();
      if (name && artist) {
        segmentTracks.push({ name, artist });
      }
      if (!interludeInFlight && segmentTracks.length >= segmentTarget) {
        interludeInFlight = true;
        setHint("正在生成歌词情绪解读…");
        const snapshot = segmentTracks.slice(0, 5);
        const resp = await requestLyricInterlude(snapshot);
        if (stableToken !== playRequestToken) return;
        const text = resp?.ok && resp?.result?.text ? String(resp.result.text).trim() : "";
        if (text && !resp?.skipped) {
          const item = buildInterludeItem(text, snapshot);
          queue.splice(finishedIndex + 1, 0, item);
          renderQueue();
          appendMessage("assistant", text);
          setHint("已插入一段歌词情绪解读");
        }
        resetLyricSegment();
      }
    }
    await playNext();
  });

  audio.addEventListener("stalled", () => {
    console.warn(`[audio:${label}] stalled`, getAudioDebugInfo(audio));
  });

  audio.addEventListener("suspend", () => {
    console.warn(`[audio:${label}] suspend`, getAudioDebugInfo(audio));
  });

  audio.addEventListener("abort", () => {
    console.warn(`[audio:${label}] abort`, getAudioDebugInfo(audio));
  });

  audio.addEventListener("error", () => {
    if (audio === preloadAudio) {
      console.warn("[preload] audio error", {
        index: preloadIndex,
        code: audio.error?.code ?? null,
        message: audio.error?.message ?? "",
        audio: getAudioDebugInfo(audio),
      });
      preloadIndex = -1;
      preloadStatus = "error";
      return;
    }

    const mediaError = audio.error;
    console.error("[audio] playback error", {
      code: mediaError?.code ?? null,
      message: mediaError?.message ?? "",
      ...getAudioDebugInfo(audio),
      queueIndex,
      track: queue[queueIndex] || null,
    });
    setPlayingUI(false);
  });
}

bindAudioEvents(audioA, "A");
bindAudioEvents(audioB, "B");

elProgress.addEventListener("input", () => {
  const duration = activeAudio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  seeking = true;
  const ratio = Number(elProgress.value) / 1000;
  const nextTime = ratio * duration;
  updateTimeUI(nextTime, duration);
});

elProgress.addEventListener("change", () => {
  const duration = activeAudio.duration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const ratio = Number(elProgress.value) / 1000;
  activeAudio.currentTime = ratio * duration;
  seeking = false;
});

elBtnMic.addEventListener("click", async () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setHint("当前浏览器不支持语音输入");
    return;
  }

  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.addEventListener("result", (event) => {
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const r = event.results[i];
        if (r.isFinal) {
          finalText += (r[0]?.transcript ?? "").trim() + " ";
        }
      }
      finalText = finalText.trim();
      if (!finalText) return;
      const prev = (elInput.value ?? "").replace(/\s+$/g, "");
      elInput.value = `${prev}${prev ? " " : ""}${finalText}`;
      updateSendState();
      elInput.focus();
    });

    recognition.addEventListener("error", (event) => {
      const err = event?.error ? String(event.error) : "unknown";
      if (err === "not-allowed" || err === "service-not-allowed") {
        setHint("语音权限被拒绝");
      } else if (err === "no-speech") {
        setHint("未检测到语音");
      } else {
        setHint(`语音识别失败：${err}`);
      }
      updateSendState();
    });

    recognition.addEventListener("end", () => {
      recognizing = false;
      elBtnMic.classList.remove("recording");
      elBtnMic.setAttribute("aria-pressed", "false");
      updateSendState();
    });
  }

  if (recognizing) {
    recognition.stop();
    return;
  }

  try {
    const ok = await ensureMicPermission();
    if (!ok) return;
    recognizing = true;
    elBtnMic.classList.add("recording");
    elBtnMic.setAttribute("aria-pressed", "true");
    setHint("正在聆听…");
    updateSendState();
    recognition.start();
  } catch {
    recognizing = false;
    elBtnMic.classList.remove("recording");
    elBtnMic.setAttribute("aria-pressed", "false");
    updateSendState();
    setHint("语音输入启动失败");
  }
});

if (elBtnSoul && elSoulPanel) {
  elBtnSoul.addEventListener("click", async () => {
    const nextOpen = elSoulPanel.hidden;
    if (nextOpen) {
      closeHistoryPanel();
      closeSettingsPanel();
      openSoulPanel();
      await refreshSoulFromFile();
    } else {
      closeSoulPanel();
    }
  });
}

if (elSoulClose) {
  elSoulClose.addEventListener("click", () => closeSoulPanel());
}

if (elSoulPanel) {
  elSoulPanel.addEventListener("click", (e) => {
    if (e.target === elSoulPanel) closeSoulPanel();
  });
}

if (elBtnHistory && elHistoryPanel) {
  elBtnHistory.addEventListener("click", async () => {
    const nextOpen = elHistoryPanel.hidden;
    if (nextOpen) {
      closeSoulPanel();
      closeSettingsPanel();
      openHistoryPanel();
      await refreshHistoryFromFile();
    } else {
      closeHistoryPanel();
    }
  });
}

if (elHistoryClose) {
  elHistoryClose.addEventListener("click", () => closeHistoryPanel());
}

if (elHistoryPanel) {
  elHistoryPanel.addEventListener("click", (e) => {
    if (e.target === elHistoryPanel) closeHistoryPanel();
  });
}

if (elHistoryBack) {
  elHistoryBack.addEventListener("click", () => setHistoryView("list"));
}

if (elHistoryImport && elHistoryImportFile) {
  elHistoryImport.addEventListener("click", () => {
    elHistoryImportFile.value = "";
    elHistoryImportFile.click();
  });
  elHistoryImportFile.addEventListener("change", async () => {
    const file = elHistoryImportFile.files?.[0] || null;
    elHistoryImportFile.value = "";
    if (!file) return;
    await importHistoryFile(file);
  });
}

if (elBtnSettings && elSettingsPanel) {
  elBtnSettings.addEventListener("click", async () => {
    const nextOpen = elSettingsPanel.hidden;
    if (nextOpen) {
      closeSoulPanel();
      closeHistoryPanel();
      openSettingsPanel();
    } else {
      closeSettingsPanel();
    }
  });
}

if (elSettingsClose) {
  elSettingsClose.addEventListener("click", () => closeSettingsPanel());
}

if (elSettingsPanel) {
  elSettingsPanel.addEventListener("click", (e) => {
    if (e.target === elSettingsPanel) closeSettingsPanel();
  });
}

if (elTtsVoiceSelect) {
  elTtsVoiceSelect.addEventListener("change", async () => {
    const next = String(elTtsVoiceSelect.value || "").trim();
    ttsVoiceId = next;
    try {
      await patchPreferences({ ttsVoiceId: next });
      setHint("已保存口播音色");
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      setHint(`保存失败：${message}`);
    }
    await refreshTtsSettingsUI();
  });
}

async function saveDjNameFromSettings() {
  if (!elSettingsDjNameInput) return;
  const raw = String(elSettingsDjNameInput.value || "").trim();
  const next = Array.from(raw).slice(0, 8).join("");
  if (!next) {
    setHint("DJ 名称不能为空");
    refreshSettingsDjNameUI();
    return;
  }
  try {
    await patchPreferences({ djName: next });
    setDjNameUI(next);
    setHint("已保存 DJ 名称");
    refreshSettingsDjNameUI();
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHint(`保存失败：${message}`);
  }
}

if (elSettingsDjNameSave) {
  elSettingsDjNameSave.addEventListener("click", async () => {
    await saveDjNameFromSettings();
  });
}

if (elSettingsDjNameInput) {
  elSettingsDjNameInput.addEventListener("input", () => {
    const raw = elSettingsDjNameInput.value || "";
    const next = Array.from(raw).slice(0, 8).join("");
    if (next !== raw) elSettingsDjNameInput.value = next;
  });
  elSettingsDjNameInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await saveDjNameFromSettings();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      refreshSettingsDjNameUI();
    }
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (elHistoryPanel && !elHistoryPanel.hidden) {
    e.preventDefault();
    closeHistoryPanel();
  } else if (elSoulPanel && !elSoulPanel.hidden) {
    e.preventDefault();
    closeSoulPanel();
  } else if (elSettingsPanel && !elSettingsPanel.hidden) {
    e.preventDefault();
    closeSettingsPanel();
  }
});

updateSendState();
safePost({ type: "ready" });

(async () => {
  const prefs = await getPreferences();
  setDjNameUI(prefs.djName || "Claudio");
  setAvatarUI(prefs.avatarDataUrl || "");
  ttsVoiceId = String(prefs.ttsVoiceId || "").trim();
  if ("speechSynthesis" in window) {
    refreshVoiceCache();
    try {
      window.speechSynthesis.onvoiceschanged = () => {
        refreshVoiceCache();
        if (elSettingsPanel && !elSettingsPanel.hidden) void refreshTtsSettingsUI();
      };
    } catch {}
  }
})();
