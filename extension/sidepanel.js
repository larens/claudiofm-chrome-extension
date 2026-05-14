const { __t, __lang } = window;

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

const elApp = document.querySelector(".app");
const elChat = document.getElementById("chat");
const elInput = document.getElementById("input");
const elSend = document.getElementById("send");
const elBtnClear = document.getElementById("btnClear");
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
const elHistoryDetailCoverBox = document.getElementById("historyDetailCoverBox");
const elHistoryDetailCover = document.getElementById("historyDetailCover");
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
const elSettingsKeepSession = document.getElementById("settingsKeepSession");
const elSettingsAutoRecommend = document.getElementById("settingsAutoRecommend");

const elAiToolModeAuto = document.getElementById("aiToolModeAuto");
const elAiToolModeManual = document.getElementById("aiToolModeManual");
const elAiToolSelect = document.getElementById("aiToolSelect");
const elAiToolStatus = document.getElementById("aiToolStatus");
const elAiToolRefresh = document.getElementById("aiToolRefresh");
const elAiToolHint = document.getElementById("aiToolHint");
const elAiProviderLocal = document.getElementById("aiProviderLocal");
const elAiProviderCloud = document.getElementById("aiProviderCloud");
const elLocalAiToolSection = document.getElementById("localAiToolSection");
const elCloudAiSection = document.getElementById("cloudAiSection");
const elCloudAiStatus = document.getElementById("cloudAiStatus");
const elCloudAiHint = document.getElementById("cloudAiHint");

const elTrackTitle = document.getElementById("trackTitle");
const elTrackTime = document.getElementById("trackTime");
const elProgress = document.getElementById("progress");
const elBtnPlay = document.getElementById("btnPlay");
const elBtnNext = document.getElementById("btnNext");
const elBtnPrev = document.getElementById("btnPrev");
const elInterruptHint = document.getElementById("interruptHint");

let queue = [];
let queueIndex = -1;
let interrupted = false;
let userPaused = false;
let segueSpokenInQueue = 0;
let seeking = false;
let hintTimer = null;
let recognizing = false;
let recognition = null;
let djName = "Claudefm";
let preloadIndex = -1;
let preloadStatus = "idle";
let playerPlaying = false;
let playerCurrentTime = 0;
let playerDuration = 0;
let lastProgressAt = 0;
let progressTick = null;
let currentTrack = null;

let localAiToolMode = "auto";
let localAiToolId = "";
let aiProvider = "local";

let speechActive = false;
let speechPaused = false;

const SESSION_KEY = "sidepanelSessionV1";
let keepSessionOnClose = true;
let autoRecommendPlay = true;
let sessionMessages = [];
let sessionSaveTimer = null;

const TRACK_VOTES_KEY = "trackVotesV1";
let trackVotes = {};

let historySections = [];
let historySelectedIndex = -1;
let historyView = "list";
let historyPath = "";
let historyCoverByKey = {};
let historyCoverRenderToken = 0;

let lastChatText = "";
let recommendCardEl = null;
let pendingAssistantEl = null;
let pendingAssistantToken = 0;
let pendingAssistantTimerA = null;
let pendingAssistantTimerB = null;
let pendingAssistantTimerC = null;

if (elDjDisplay) elDjDisplay.hidden = false;

function resetCoverImage(cover, coverBox) {
  if (cover) {
    cover.hidden = true;
    cover.removeAttribute("src");
  }
  if (coverBox) coverBox.classList.add("fallback");
}

function showCoverImage(cover, coverBox, coverUrl) {
  const nextUrl = coverUrl ? String(coverUrl).trim() : "";
  if (!cover || !coverBox || !nextUrl) {
    resetCoverImage(cover, coverBox);
    return false;
  }
  cover.hidden = false;
  coverBox.classList.remove("fallback");
  cover.src = nextUrl;
  if (cover.complete && cover.naturalWidth > 0) {
    cover.hidden = false;
    coverBox.classList.remove("fallback");
  }
  return true;
}

function bindCoverImageState(cover, coverBox) {
  if (!cover || !coverBox) return;
  cover.addEventListener("load", () => {
    cover.hidden = false;
    coverBox.classList.remove("fallback");
  });
  cover.addEventListener("error", () => {
    resetCoverImage(cover, coverBox);
  });
}

bindCoverImageState(elHistoryDetailCover, elHistoryDetailCoverBox);

async function sendPlayerCommand(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (response?.state) applyPlayerState(response.state);
    return response;
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    setHint(__t("播放器通信失败：{0}", {0: message}));
    return { ok: false, error: message };
  }
}

function applyPlayerState(state) {
  if (!state || typeof state !== "object") return;
  queue = Array.isArray(state.queue) ? state.queue.slice(0, 800) : [];
  queueIndex = Number.isFinite(state.queueIndex) ? state.queueIndex : -1;
  currentTrack = state.currentTrack && typeof state.currentTrack === "object" ? { ...state.currentTrack } : null;
  playerPlaying = Boolean(state.playing);
  playerCurrentTime = Number.isFinite(state.currentTime) ? Number(state.currentTime) : 0;
  playerDuration = Number.isFinite(state.duration) ? Number(state.duration) : 0;
  interrupted = Boolean(state.interrupted);
  userPaused = Boolean(state.userPaused);
  speechActive = Boolean(state.speechActive);
  speechPaused = Boolean(state.speechPaused);
  preloadIndex = Number.isFinite(state.preloadIndex) ? state.preloadIndex : -1;
  preloadStatus = state.preloadStatus ? String(state.preloadStatus) : "idle";

  const titleTrack = currentTrack || (queueIndex >= 0 && queueIndex < queue.length ? queue[queueIndex] : null);
  elTrackTitle.textContent = titleTrack ? buildTitle(titleTrack) : __t("未播放");
  updateTimeUI(playerCurrentTime, playerDuration);
  if (!seeking) updateProgressUI(playerCurrentTime, playerDuration);
  if (playerPlaying && playerDuration > 0) {
    startProgressTick();
  } else {
    stopProgressTick();
  }
  setPlayingUI(playerPlaying);
  if (elInterruptHint) elInterruptHint.hidden = !interrupted;
  renderQueue();
}

async function requestPlayerState() {
  const response = await sendPlayerCommand("player.getState");
  if (response?.state) applyPlayerState(response.state);
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
      setHint(__t("麦克风权限被拒绝，请在系统与浏览器中允许 Chrome 使用麦克风后重试"));
    } else {
      setHint(__t("无法获取麦克风，请检查系统/浏览器麦克风权限"));
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

function startProgressTick() {
  stopProgressTick();
  if (!playerPlaying || playerDuration <= 0) return;
  lastProgressAt = Date.now();
  progressTick = setInterval(() => {
    const now = Date.now();
    playerCurrentTime += (now - lastProgressAt) / 1000;
    lastProgressAt = now;
    if (playerCurrentTime >= playerDuration) {
      playerCurrentTime = playerDuration;
      stopProgressTick();
    }
    updateTimeUI(playerCurrentTime, playerDuration);
    if (!seeking) updateProgressUI(playerCurrentTime, playerDuration);
  }, 200);
}

function stopProgressTick() {
  if (progressTick != null) {
    clearInterval(progressTick);
    progressTick = null;
  }
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
  elBtnPlay.setAttribute("aria-label", playing ? __t("暂停") : __t("播放"));
}

function buildTitle(track) {
  const name = track?.name ? String(track.name) : "";
  const artist = track?.artist ? String(track.artist) : "";
  if (!name && !artist) return __t("未播放");
  if (!name) return artist;
  if (!artist) return name;
  return `${name} - ${artist}`;
}

function isSpeechItem(track) {
  return track && typeof track === "object" && track.kind === "speech";
}

function buildInterludeItem(text, tracks) {
  const t = Array.isArray(tracks) ? tracks : [];
  const count = t.length ? `（${t.length} ${__lang === "en" ? "songs" : "首"}）` : "";
  return {
    kind: "speech",
    name: `${__t("插播：歌词情绪解读")}${count}`,
    artist: "",
    text: String(text || "").trim(),
  };
}

function buildSegueItem(text, ttsAudioUrl) {
  const item = {
    kind: "speech",
    name: __t("DJ 推荐语"),
    artist: "",
    text: String(text || "").trim(),
  };
  if (ttsAudioUrl) item.ttsAudioUrl = ttsAudioUrl;
  return item;
}

async function requestTtsAudioUrl(text) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "tts", text: String(text || "").trim() });
    if (resp?.ok && resp.audioUrl) return resp.audioUrl;
  } catch {}
  return "";
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
  const raw = name && String(name).trim() ? String(name).trim() : "Claudefm";
  djName = Array.from(raw).slice(0, 8).join("") || "Claudefm";
  elDjNameText.textContent = djName;
}

function appendMessageDom(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  elChat.appendChild(div);
  elChat.scrollTop = elChat.scrollHeight;
  return div;
}

function appendChatNode(node) {
  elChat.appendChild(node);
  elChat.scrollTop = elChat.scrollHeight;
}

function clearRecommendCard() {
  if (recommendCardEl && recommendCardEl.isConnected) recommendCardEl.remove();
  recommendCardEl = null;
}

function clearPendingAssistant() {
  if (pendingAssistantTimerA) clearTimeout(pendingAssistantTimerA);
  if (pendingAssistantTimerB) clearTimeout(pendingAssistantTimerB);
  if (pendingAssistantTimerC) clearTimeout(pendingAssistantTimerC);
  pendingAssistantTimerA = null;
  pendingAssistantTimerB = null;
  pendingAssistantTimerC = null;
  if (pendingAssistantEl && pendingAssistantEl.isConnected) pendingAssistantEl.remove();
  pendingAssistantEl = null;
}

function startPendingAssistant() {
  clearPendingAssistant();
  const token = ++pendingAssistantToken;
  pendingAssistantEl = appendMessageDom("assistant", __t("正在思考…"));
  pendingAssistantEl.classList.add("pending");
  pendingAssistantTimerA = setTimeout(() => {
    if (token !== pendingAssistantToken) return;
    if (!pendingAssistantEl || !pendingAssistantEl.isConnected) return;
    pendingAssistantEl.textContent = __t("还在生成回复…");
  }, 12000);
  pendingAssistantTimerB = setTimeout(() => {
    if (token !== pendingAssistantToken) return;
    if (!pendingAssistantEl || !pendingAssistantEl.isConnected) return;
    pendingAssistantEl.textContent = __t("回复有点慢，可能在排队/Host 忙，请稍等…");
  }, 25000);
  pendingAssistantTimerC = setTimeout(() => {
    if (token !== pendingAssistantToken) return;
    clearPendingAssistant();
    appendMessage("assistant", __t("请求超时，请稍后再试"));
  }, 140000);
}

function showRecommendConfirm(question) {
  clearRecommendCard();
  const wrap = document.createElement("div");
  wrap.className = "recommendCard";

  const title = document.createElement("div");
  title.className = "recommendTitle";
  title.textContent = question ? String(question) : __t("要不要我给你推荐一份歌单并直接开始播放？");

  const actions = document.createElement("div");
  actions.className = "recommendActions";

  const yes = document.createElement("button");
  yes.className = "recommendBtn primary";
  yes.type = "button";
  yes.textContent = __t("推荐歌单");
  yes.addEventListener("click", () => {
    const seed = lastChatText ? String(lastChatText) : "";
    if (!seed) return;
    clearRecommendCard();
    appendMessage("user", "推荐一份歌单");
    startPendingAssistant();
    try {
      void chrome.runtime.sendMessage({ type: "chat", text: seed, forceRecommend: true });
    } catch {}
  });

  const no = document.createElement("button");
  no.className = "recommendBtn";
  no.type = "button";
  no.textContent = __t("先不用");
  no.addEventListener("click", () => {
    clearRecommendCard();
    appendMessage("assistant", __t("好，那我先陪你聊。你想从哪开始？"));
  });

  actions.appendChild(yes);
  actions.appendChild(no);
  wrap.appendChild(title);
  wrap.appendChild(actions);
  recommendCardEl = wrap;
  appendChatNode(wrap);
}

function showRecommendPush(tracks, defaultSegue) {
  clearRecommendCard();
  const list = Array.isArray(tracks) ? tracks : [];
  if (!list.length) return;

  const pushQueue = async (segueText) => {
    segueSpokenInQueue = 0;
    const next = [];
    const text = String(segueText || "").trim();
    let ttsAudioUrl = "";
    if (text) ttsAudioUrl = await requestTtsAudioUrl(text);
    if (text) next.push(buildSegueItem(text, ttsAudioUrl));
    next.push(
      ...list.map((t) => ({
        ...t,
        streamUrl: (t?.streamUrl || "").replace(/`/g, "").trim(),
        provider: t?.provider || "pending",
      }))
    );
    setHint(__t("已推送 {0} 首新歌单，正在播放", {0: list.length}));
    try {
      await sendPlayerCommand("player.replaceQueueAndPlay", { queue: next, startIndex: 0 });
    } catch {}
  };

  if (autoRecommendPlay) {
    setHint(__t("已推荐 {0} 首歌曲，正在开始播放", {0: list.length}));
    void pushQueue(defaultSegue);
    return;
  }

  const wrap = document.createElement("div");
  wrap.className = "recommendCard";

  const title = document.createElement("div");
  title.className = "recommendTitle";
  title.textContent = __t("新歌单推荐");

  const segueBody = document.createElement("div");
  segueBody.className = "recommendTextarea";
  segueBody.textContent = defaultSegue ? String(defaultSegue) : "";

  const actions = document.createElement("div");
  actions.className = "recommendActions";

  const push = document.createElement("button");
  push.className = "recommendBtn primary";
  push.type = "button";
  push.textContent = __t("推送并播放");
  push.addEventListener("click", async () => {
    const segueText = String(segueBody.textContent || "").trim();
    clearRecommendCard();
    await pushQueue(segueText);
  });

  const cancel = document.createElement("button");
  cancel.className = "recommendBtn";
  cancel.type = "button";
  cancel.textContent = __t("取消");
  cancel.addEventListener("click", () => clearRecommendCard());

  actions.appendChild(push);
  actions.appendChild(cancel);
  wrap.appendChild(title);
  wrap.appendChild(segueBody);
  wrap.appendChild(actions);
  recommendCardEl = wrap;
  appendChatNode(wrap);
}

function scheduleSessionSave() {
  if (!keepSessionOnClose) return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    void saveSessionNow();
  }, 500);
}

async function saveSessionNow() {
  if (!keepSessionOnClose) return;
  const payload = {
    messages: sessionMessages.slice(-220),
  };
  try {
    await chrome.storage.local.set({ [SESSION_KEY]: payload });
  } catch {}
}

async function clearSavedSession() {
  try {
    await chrome.storage.local.remove(SESSION_KEY);
  } catch {}
}

async function restoreSessionIfAny() {
  if (!keepSessionOnClose) return;
  let stored = null;
  try {
    const resp = await chrome.storage.local.get(SESSION_KEY);
    stored = resp ? resp[SESSION_KEY] : null;
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== "object") return;

  const msgs = Array.isArray(stored.messages) ? stored.messages : [];

  sessionMessages = [];
  if (elChat) elChat.innerHTML = "";
  msgs.slice(-220).forEach((m) => {
    const role = m?.role ? String(m.role) : "";
    const text = m?.text ? String(m.text) : "";
    if (!role || !text) return;
    sessionMessages.push({ role, text });
    appendMessageDom(role, text);
  });
}

async function loadTrackVotes() {
  try {
    const resp = await chrome.storage.local.get(TRACK_VOTES_KEY);
    const raw = resp ? resp[TRACK_VOTES_KEY] : null;
    if (raw && typeof raw === "object") {
      trackVotes = raw;
      return;
    }
  } catch {}
  trackVotes = {};
}

async function saveTrackVotes() {
  try {
    await chrome.storage.local.set({ [TRACK_VOTES_KEY]: trackVotes });
  } catch {}
}

function getVoteKeyForTrack(track) {
  const name = track?.name ? String(track.name).trim() : "";
  const artist = track?.artist ? String(track.artist).trim() : "";
  if (!name || !artist) return "";
  return normalizeHistoryKey(name, artist);
}

function renderVoteIcon(kind, active) {
  const common = `class="btnIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"`;
  const outline = `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  const solid = `fill="currentColor" stroke="none"`;
  if (kind === "up") {
    return active
      ? `<svg ${common} ${solid}><path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3zM7 10l4.6-6.7A2 2 0 0 1 13.2 2H14a2 2 0 0 1 2 2v5h3.2a2 2 0 0 1 2 2.5l-1.4 6A3 3 0 0 1 16.9 20H9a2 2 0 0 1-2-2V10h0z"/></svg>`
      : `<svg ${common} ${outline}><path d="M7 10v11H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3zM7 10l4.6-6.7A2 2 0 0 1 13.2 2H14a2 2 0 0 1 2 2v5h3.2a2 2 0 0 1 2 2.5l-1.4 6A3 3 0 0 1 16.9 20H9a2 2 0 0 1-2-2V10h0z"/></svg>`;
  }
  return active
    ? `<svg ${common} ${solid}><path d="M17 14V3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3zM17 14l-4.6 6.7A2 2 0 0 1 10.8 22H10a2 2 0 0 1-2-2v-5H4.8a2 2 0 0 1-2-2.5l1.4-6A3 3 0 0 1 7.1 4H15a2 2 0 0 1 2 2v8h0z"/></svg>`
    : `<svg ${common} ${outline}><path d="M17 14V3h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3zM17 14l-4.6 6.7A2 2 0 0 1 10.8 22H10a2 2 0 0 1-2-2v-5H4.8a2 2 0 0 1-2-2.5l1.4-6A3 3 0 0 1 7.1 4H15a2 2 0 0 1 2 2v8h0z"/></svg>`;
}

function appendMessage(role, text) {
  const r = String(role || "").trim();
  const t = String(text || "");
  if (!r) return;
  appendMessageDom(r, t);
  if (t.trim()) {
    sessionMessages.push({ role: r, text: t });
    if (sessionMessages.length > 240) sessionMessages = sessionMessages.slice(-240);
    scheduleSessionSave();
  }
}

function buildPlayListMessage(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return "";
  const lines = tracks.map((t, i) => {
    const name = t?.name ? String(t.name).trim() : "";
    const artist = t?.artist ? String(t.artist).trim() : "";
    const title = [name, artist].filter(Boolean).join(" - ").trim();
    return `${i + 1}. ${title || __t("未知歌曲")}`;
  });
  return `${__t("歌单推荐：")}\n${lines.join("\n")}`;
}

function renderQueue() {
  if (elQueueCount) elQueueCount.textContent = `(${queue.length})`;
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
    name.textContent = t.name || __t("未知歌曲");
    const artist = document.createElement("div");
    artist.className = "artist";
    artist.textContent = t.artist || "";
    meta.appendChild(name);
    meta.appendChild(artist);

    const actions = document.createElement("div");
    actions.className = "queueActions";
    const key = !isSpeechItem(t) ? getVoteKeyForTrack(t) : "";
    const vote = key ? Number(trackVotes[key] ?? 0) : 0;
    if (key) {
      const likeBtn = document.createElement("button");
      likeBtn.className = `queueVoteBtn${vote === 1 ? " active" : ""}`;
      likeBtn.type = "button";
      likeBtn.setAttribute("aria-label", __t("点赞"));
      likeBtn.dataset.kind = "up";
      likeBtn.innerHTML = renderVoteIcon("up", vote === 1);
      likeBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = vote === 1 ? 0 : 1;
        if (next === 0) delete trackVotes[key];
        else trackVotes[key] = 1;
        await saveTrackVotes();
        renderQueue();
      });

      const dislikeBtn = document.createElement("button");
      dislikeBtn.className = `queueVoteBtn${vote === -1 ? " active" : ""}`;
      dislikeBtn.type = "button";
      dislikeBtn.setAttribute("aria-label", __t("踩"));
      dislikeBtn.dataset.kind = "down";
      dislikeBtn.innerHTML = renderVoteIcon("down", vote === -1);
      dislikeBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const next = vote === -1 ? 0 : -1;
        if (next === 0) delete trackVotes[key];
        else trackVotes[key] = -1;
        await saveTrackVotes();
        renderQueue();
      });

      actions.appendChild(likeBtn);
      actions.appendChild(dislikeBtn);
    }

    row.appendChild(prefix);
    row.appendChild(meta);
    row.appendChild(actions);
    if (i === queueIndex) {
      row.style.opacity = "1";
      row.style.fontWeight = "700";
    } else {
      row.style.opacity = "0.85";
    }
    elQueueList.appendChild(row);
  });
  scheduleSessionSave();
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

async function startNewSession() {
  try {
    if (typeof window.removeStartPlayCard === "function") window.removeStartPlayCard();
  } catch {}

  await sendPlayerCommand("player.reset");
  setHint("");

  if (elChat) elChat.innerHTML = "";
  sessionMessages = [];
  await clearSavedSession();
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

function refreshOverlayTransientUiState() {
  if (!elApp) return;
  const overlayActive =
    (elSoulPanel && !elSoulPanel.hidden) ||
    (elHistoryPanel && !elHistoryPanel.hidden) ||
    (elSettingsPanel && !elSettingsPanel.hidden);
  elApp.classList.toggle("overlay-active", Boolean(overlayActive));
}

function openSoulPanel() {
  if (!elSoulPanel) return;
  elSoulPanel.hidden = false;
  refreshOverlayTransientUiState();
  setSoulStatus(__t("正在读取…"));
}

function closeSoulPanel() {
  if (!elSoulPanel) return;
  elSoulPanel.hidden = true;
  refreshOverlayTransientUiState();
}

function openSettingsPanel() {
  if (!elSettingsPanel) return;
  elSettingsPanel.hidden = false;
  refreshOverlayTransientUiState();
  refreshSettingsDjNameUI();
  applyProviderVisibility();
}

function closeSettingsPanel() {
  if (!elSettingsPanel) return;
  elSettingsPanel.hidden = true;
  refreshOverlayTransientUiState();
}

async function refreshAiToolSettingsUI(forceRefresh = false) {
  if (!elAiToolSelect || !elAiToolStatus) return;
  elAiToolStatus.textContent = __t("正在检测本地 AI 工具…");
  elAiToolHint.textContent = "";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "detectLocalAiTools", forceRefresh });
    if (!resp || resp.ok === false) {
      elAiToolStatus.textContent = resp?.error?.includes("unknown message type")
        ? __t("Host 版本过低，不支持工具检测")
        : __t("检测失败：{0}", {0: resp?.error || __t("Host 无响应")});
      elAiToolSelect.innerHTML = "";
      return;
    }
    const tools = Array.isArray(resp.tools) ? resp.tools : [];
    elAiToolSelect.innerHTML = "";
    for (const tool of tools) {
      const opt = document.createElement("option");
      opt.value = tool.id;
      const statusSuffix = tool.callable ? (__lang === "en" ? "Callable" : "可直接调用") : tool.installed ? (__lang === "en" ? "Detection only" : "仅检测展示") : (__lang === "en" ? "Not installed" : "未安装");
      opt.textContent = `${tool.label} · ${statusSuffix}`;
      elAiToolSelect.appendChild(opt);
    }
    const recommendedId = resp.recommendedToolId || "";
    const resolvedId = resp.resolvedToolId || recommendedId;
    const selectedId = localAiToolMode === "manual" && localAiToolId ? localAiToolId : resolvedId;
    elAiToolSelect.value = selectedId;
    if (elAiToolSelect.value !== selectedId) elAiToolSelect.value = "";
    elAiToolSelect.disabled = localAiToolMode === "auto";
    const resolvedTool = tools.find((t) => t.id === (selectedId || resolvedId));
    elAiToolStatus.textContent = resolvedTool
      ? __t("当前使用：{0}（{1}）", {0: resolvedTool.label, 1: resolvedTool.statusText || (__lang === "en" ? "Detected" : "已检测")})
      : tools.length
        ? __t("未发现可用工具")
        : __t("未检测到本地 AI 工具");
    if (localAiToolMode === "manual" && localAiToolId) {
      const selectedTool = tools.find((t) => t.id === localAiToolId);
      if (selectedTool && !selectedTool.callable) {
        elAiToolHint.textContent = __t("注意：{0} 暂不支持直接调用。聊天功能将无法使用。", {0: selectedTool.label});
      } else {
        elAiToolHint.textContent = "";
      }
    } else if (!recommendedId && tools.length) {
      elAiToolHint.textContent = __t("未发现可直接调用的本地 AI 工具。请安装 Claude Code 或其他支持的工具。");
    } else {
      elAiToolHint.textContent = "";
    }
  } catch (e) {
    elAiToolStatus.textContent = __t("检测请求失败：{0}", {0: e?.message || e});
  }
}

function applyProviderVisibility() {
  if (aiProvider === "cloud") {
    if (elLocalAiToolSection) elLocalAiToolSection.hidden = true;
    if (elCloudAiSection) elCloudAiSection.hidden = false;
    refreshCloudAiStatus();
  } else {
    if (elLocalAiToolSection) elLocalAiToolSection.hidden = false;
    if (elCloudAiSection) elCloudAiSection.hidden = true;
    refreshAiToolSettingsUI();
  }
}

async function refreshCloudAiStatus() {
  if (!elCloudAiStatus) return;
  elCloudAiStatus.textContent = __t("检测中…");
  try {
    const resp = await chrome.runtime.sendMessage({ type: "checkCloudAiStatus" });
    if (resp?.ok) {
      elCloudAiStatus.textContent = `${resp.model} · ${resp.endpoint}`;
      if (elCloudAiHint) elCloudAiHint.textContent = __t("API Key 已配置，云端 AI 可用。");
    } else {
      elCloudAiStatus.textContent = __t("不可用");
      if (elCloudAiHint) elCloudAiHint.textContent = resp?.error || __t("云端 AI 不可用：未配置 API Key（请在 tts-config.json 中设置 api_key）");
    }
  } catch (e) {
    elCloudAiStatus.textContent = __t("检测失败");
    if (elCloudAiHint) elCloudAiHint.textContent = e?.message || __t("Host 无响应");
  }
}

async function refreshSoulFromFile() {
  setSoulStatus(__t("正在读取 music.md …"));
  try {
    const resp = await chrome.runtime.sendMessage({ type: "readMemoryFile" });
    if (!resp?.ok) {
      setSoulStatus(__t("读取失败：{0}", {0: resp?.error || "unknown"}));
      if (elSoulContent) elSoulContent.textContent = __t("(空)");
      return;
    }
    const content = resp?.content ? String(resp.content) : "";
    if (elSoulContent) elSoulContent.textContent = content && content.trim() ? content.trim() : __t("(空)");
    setSoulStatus(__t("已加载：{0}", {0: resp.path || "music.md"}));
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setSoulStatus(__t("读取失败：{0}", {0: message}));
    if (elSoulContent) elSoulContent.textContent = __t("(空)");
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
  const v = nextView === "detail" ? "detail" : "list";
  historyView = v;
  if (elHistoryBack) elHistoryBack.hidden = v !== "detail";
  if (elHistoryImport) {
    const hideImport = v === "detail";
    elHistoryImport.hidden = hideImport;
    if (!hideImport) elHistoryImport.removeAttribute("hidden");
  }
  if (elHistoryList) elHistoryList.hidden = v !== "list";
  if (elHistoryDetail) elHistoryDetail.hidden = v !== "detail";
  if (elHistoryTitle) elHistoryTitle.textContent = v === "detail" ? __t("详情") : __t("历史");
}

async function hydrateHistoryCoverFromCache(track, cover, coverBox, renderToken) {
  const key = getVoteKeyForTrack(track);
  if (!key) return;
  if (renderToken !== historyCoverRenderToken) return;

  const existing = historyCoverByKey[key];
  if (typeof existing === "string" && existing) {
    showCoverImage(cover, coverBox, existing);
    return;
  }
  if (existing === null) return;
}

function renderHistoryList() {
  if (!elHistoryList) return;
  elHistoryList.innerHTML = "";
  if (!Array.isArray(historySections) || historySections.length === 0) {
    const empty = document.createElement("div");
    empty.style.padding = "10px 2px";
    empty.style.fontSize = "12px";
    empty.style.color = "var(--muted)";
    empty.textContent = __t("最近 7 天暂无历史记录");
    elHistoryList.appendChild(empty);
    return;
  }

  const renderToken = ++historyCoverRenderToken;
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
    text.textContent = stamp || (__lang === "en" ? "Untitled" : "未命名");
    row.appendChild(icon);
    row.appendChild(text);
    divider.appendChild(row);
    elHistoryList.appendChild(divider);

    const tracks = Array.isArray(section?.tracks) ? section.tracks : [];
    tracks.forEach((t) => {
      globalIndex += 1;
      const row = document.createElement("div");
      row.className = "queueItem";
      row.style.cursor = "pointer";
      const voteKey = getVoteKeyForTrack(t);
      if (voteKey) row.setAttribute("data-cover-key", voteKey);

      const prefix = document.createElement("div");
      prefix.className = "queuePrefix";

      const index = document.createElement("div");
      index.className = "queueIndex";
      index.textContent = String(globalIndex);
      prefix.appendChild(index);

      const coverBox = document.createElement("div");
      coverBox.className = "queueCoverBox fallback";

      const cover = document.createElement("img");
      cover.className = "queueCover";
      cover.alt = "";
      cover.decoding = "async";
      cover.loading = "lazy";
      bindCoverImageState(cover, coverBox);
      const coverUrl = t?.cover ? String(t.cover).trim() : "";
      if (!showCoverImage(cover, coverBox, coverUrl)) resetCoverImage(cover, coverBox);
      coverBox.appendChild(cover);

      prefix.appendChild(coverBox);

      const meta = document.createElement("div");
      meta.className = "queueText";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = t?.name ? String(t.name) : __t("未知歌曲");
      const artist = document.createElement("div");
      artist.className = "artist";
      artist.textContent = t?.artist ? String(t.artist) : "";
      meta.appendChild(name);
      meta.appendChild(artist);

      const actions = document.createElement("div");
      actions.className = "queueActions";
      const key = getVoteKeyForTrack(t);
      const vote = key ? Number(trackVotes[key] ?? 0) : 0;
      if (key) {
        const likeBtn = document.createElement("button");
        likeBtn.className = `queueVoteBtn${vote === 1 ? " active" : ""}`;
        likeBtn.type = "button";
        likeBtn.setAttribute("aria-label", __t("点赞"));
        likeBtn.dataset.kind = "up";
        likeBtn.innerHTML = renderVoteIcon("up", vote === 1);
        likeBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const next = vote === 1 ? 0 : 1;
          if (next === 0) delete trackVotes[key];
          else trackVotes[key] = 1;
          await saveTrackVotes();
          renderHistoryList();
          renderQueue();
        });

        const dislikeBtn = document.createElement("button");
        dislikeBtn.className = `queueVoteBtn${vote === -1 ? " active" : ""}`;
        dislikeBtn.type = "button";
        dislikeBtn.setAttribute("aria-label", __t("踩"));
        dislikeBtn.dataset.kind = "down";
        dislikeBtn.innerHTML = renderVoteIcon("down", vote === -1);
        dislikeBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const next = vote === -1 ? 0 : -1;
          if (next === 0) delete trackVotes[key];
          else trackVotes[key] = -1;
          await saveTrackVotes();
          renderHistoryList();
          renderQueue();
        });

        actions.appendChild(likeBtn);
        actions.appendChild(dislikeBtn);
      }

      row.appendChild(prefix);
      row.appendChild(meta);
      row.appendChild(actions);
      elHistoryList.appendChild(row);
      if (key) void hydrateHistoryCoverFromCache(t, cover, coverBox, renderToken);

      row.addEventListener("click", async () => {
        const trackName = t?.name ? String(t.name).trim() : "";
        const trackArtist = t?.artist ? String(t.artist).trim() : "";
        if (!trackName || !trackArtist) return;
        const item = { name: trackName, artist: trackArtist, provider: "cached" };
        const insertAt = queueIndex >= 0 ? Math.min(queueIndex + 1, queue.length) : queue.length;
        try {
          await sendPlayerCommand("player.insertTrackAtAndPlay", { track: item, index: insertAt });
        } catch {}
      });
    });
  });
}

async function openHistoryDetail(track, stamp) {
  const name = track?.name ? String(track.name).trim() : "";
  const artist = track?.artist ? String(track.artist).trim() : "";
  const raw = track?.raw ? String(track.raw) : "";
  const key = getVoteKeyForTrack(track);
  if (!name || !artist) return;

  historySelectedIndex = -1;
  setHistoryView("detail");
  if (elHistoryTitle) elHistoryTitle.textContent = stamp ? String(stamp) : "详情";
  if (elHistoryDetailName) elHistoryDetailName.textContent = name;
  if (elHistoryDetailArtist) elHistoryDetailArtist.textContent = artist;
  if (elHistoryDetailRaw) elHistoryDetailRaw.textContent = raw;

  resetCoverImage(elHistoryDetailCover, elHistoryDetailCoverBox);

  const knownCover =
    (key && typeof historyCoverByKey[key] === "string" && historyCoverByKey[key]) ||
    (track?.cover ? String(track.cover).trim() : "");
  if (knownCover) {
    if (key) historyCoverByKey[key] = knownCover;
    showCoverImage(elHistoryDetailCover, elHistoryDetailCoverBox, knownCover);
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({ type: "getCachedTrack", track: { name, artist } });
    const cover = resp?.ok && resp?.hit && resp?.resolved?.cover ? String(resp.resolved.cover) : "";
    if (!cover) {
      if (key) historyCoverByKey[key] = null;
      return;
    }
    if (key) historyCoverByKey[key] = cover;
    showCoverImage(elHistoryDetailCover, elHistoryDetailCoverBox, cover);
  } catch {}
}

function openHistoryPanel() {
  if (!elHistoryPanel) return;
  elHistoryPanel.hidden = false;
  refreshOverlayTransientUiState();
  setHistoryView("list");
  setHistoryStatus(__t("正在读取…"));
}

function closeHistoryPanel() {
  if (!elHistoryPanel) return;
  elHistoryPanel.hidden = true;
  refreshOverlayTransientUiState();
}

async function refreshHistoryFromFile() {
  setHistoryStatus(__t("正在读取 list.md …"));
  try {
    const resp = await chrome.runtime.sendMessage({ type: "readListFile" });
    if (!resp?.ok) {
      setHistoryStatus(__t("读取失败：{0}", {0: resp?.error || "unknown"}));
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
    setHistoryStatus(__t("已加载：{0}", {0: historyPath || "list.md"}));
    void batchLoadHistoryCovers();
    void chrome.runtime.sendMessage({ type: "cleanupExpiredCache" }).catch(() => {});
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHistoryStatus(__t("读取失败：{0}", {0: message}));
    historySections = [];
    historyPath = "";
    renderHistoryList();
  }
}

async function batchLoadHistoryCovers() {
  const allTracks = [];
  for (const section of historySections) {
    const tracks = Array.isArray(section?.tracks) ? section.tracks : [];
    for (const t of tracks) {
      const name = t?.name ? String(t.name).trim() : "";
      const artist = t?.artist ? String(t.artist).trim() : "";
      if (name && artist) allTracks.push({ name, artist });
    }
  }
  if (!allTracks.length) return;

  try {
    const resp = await chrome.runtime.sendMessage({ type: "getCachedCoverUrls", tracks: allTracks });
    if (!resp?.ok || !resp?.covers) return;
    const covers = resp.covers;
    for (const [key, url] of Object.entries(covers)) {
      if (url) historyCoverByKey[key] = url;
    }
    const renderToken = historyCoverRenderToken;
    const items = elHistoryList?.querySelectorAll("[data-cover-key]") || [];
    items.forEach((el) => {
      const key = el.getAttribute("data-cover-key");
      const url = key ? historyCoverByKey[key] : null;
      if (typeof url === "string" && url) {
        const coverEl = el.querySelector(".queueCover");
        const coverBoxEl = el.querySelector(".queueCoverBox");
        if (coverEl && coverBoxEl) showCoverImage(coverEl, coverBoxEl, url);
      }
    });
  } catch {}
}

async function importHistoryFile(file) {
  const f = file;
  if (!f) return;
  setHistoryStatus(__t("正在导入：{0} …", {0: f.name}));
  await new Promise((r) => setTimeout(r, 0));

  let text = "";
  try {
    text = await f.text();
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHistoryStatus(__t("导入失败：{0}", {0: message}));
    return;
  }

  const lower = String(f.name || "").toLowerCase();
  const lineCount = text ? text.split(/\r?\n/g).length : 0;
  if (lineCount >= 1200) {
    setHistoryStatus(__t("正在解析：{0}（{1} 行）…", {0: f.name, 1: lineCount}));
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
    setHistoryStatus(__t("导入失败：文件中未识别到可用的歌曲清单"));
    return;
  }

  try {
    setHistoryStatus(__t("正在写入 list.md：共 {0} 首…", {0: tracks.length}));
    await new Promise((r) => setTimeout(r, 0));
    const resp = await chrome.runtime.sendMessage({ type: "prependListSection", kind: "import", tracks });
    if (!resp?.ok) {
      setHistoryStatus(__t("导入失败：{0}", {0: resp?.error || "unknown"}));
      return;
    }
    if (resp?.skipped) {
      setHistoryStatus(__t("导入完成：未新增（可能全部与历史重复）"));
    } else {
      setHistoryStatus(__t("导入完成：已写入一个新分段（## {0}）", {0: resp?.stamp || "current time"}));
    }
    await refreshHistoryFromFile();
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHistoryStatus(__t("导入失败：{0}", {0: message}));
  }
}

function updateSendState() {
  const text = (elInput?.value ?? "").trim();
  if (recognizing) {
    elSend.disabled = false;
    elSend.classList.add("enabled");
    setButtonIcon(elSend, "stop");
    elSend.setAttribute("aria-label", __t("结束语音"));
    return;
  }
  const enabled = text.length > 0;
  elSend.disabled = !enabled;
  elSend.classList.toggle("enabled", enabled);
  setButtonIcon(elSend, "send");
  elSend.setAttribute("aria-label", __t("发送"));
}

const COMPOSER_INPUT_MAX_HEIGHT = 120;
function autosizeComposerInput() {
  if (!elInput) return;
  const value = String(elInput.value ?? "");
  const cs = window.getComputedStyle(elInput);
  const lineHeight = Number.parseFloat(cs.lineHeight) || 20;
  const paddingTop = Number.parseFloat(cs.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(cs.paddingBottom) || 0;
  const minHeight = Math.ceil(lineHeight + paddingTop + paddingBottom);

  if (!value) {
    elInput.style.height = `${minHeight}px`;
    elInput.style.overflowY = "hidden";
    return;
  }

  elInput.style.height = "0px";
  const fullHeight = elInput.scrollHeight;
  const clampedHeight = Math.min(COMPOSER_INPUT_MAX_HEIGHT, Math.max(minHeight, fullHeight));
  elInput.style.height = `${clampedHeight}px`;
  elInput.style.overflowY = fullHeight > COMPOSER_INPUT_MAX_HEIGHT ? "auto" : "hidden";
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

async function playAt(index) {
  await sendPlayerCommand("player.playAt", { index });
}

async function playNext() {
  await sendPlayerCommand("player.next");
}

async function playPrev() {
  await sendPlayerCommand("player.prev");
}

async function handleAssistantResult(result) {
  if (typeof result === "string") {
    const text = result.trim();
    if (text) appendMessage("assistant", text);
    else appendMessage("assistant", __t("未收到有效回复"));
    return;
  }

  if (!result || typeof result !== "object") {
    appendMessage("assistant", __t("未收到有效回复"));
    return;
  }

  const parts = [];
  if (result.say) parts.push(result.say);
  if (result.reason) parts.push(result.reason);
  if (parts.length) appendMessage("assistant", parts.join("\n\n"));

  if (result.confirmRecommend) {
    const q = result.confirmQuestion ? String(result.confirmQuestion).trim() : "";
    showRecommendConfirm(q);
    return;
  }

  const hasTracks = Array.isArray(result.play) && result.play.length > 0;
  if (hasTracks) {
    const segueText = result.segue ? String(result.segue).trim() : "";
    if (segueText) appendMessage("assistant", segueText);
    const playListMessage = buildPlayListMessage(result.play);
    if (playListMessage) appendMessage("assistant", playListMessage);
    if (autoRecommendPlay) {
      setHint(__t("已推荐 {0} 首歌曲，正在开始播放", {0: result.play.length}));
      segueSpokenInQueue = 0;
      const nextItems = [];
      let ttsAudioUrl = "";
      if (segueText) ttsAudioUrl = await requestTtsAudioUrl(segueText);
      if (segueText) {
        nextItems.push(buildSegueItem(segueText, ttsAudioUrl));
        segueSpokenInQueue += 1;
      }
      nextItems.push(
        ...result.play.map((t) => ({
          ...t,
          streamUrl: (t?.streamUrl || "").replace(/`/g, "").trim(),
          provider: t?.provider || "pending",
        }))
      );
      await sendPlayerCommand("player.replaceQueueAndPlay", { queue: nextItems, startIndex: 0 });
    } else {
      showRecommendPush(result.play, result.segue);
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
      if (!result.ok) setHint(__t("定位失败，已使用时间与历史记忆推荐"));
      safePost({ type: "locationResult", ...result });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      setHint(__t("定位失败，已使用时间与历史记忆推荐"));
      safePost({ type: "locationResult", ok: false, error: message });
    }
    return;
  }
  if (msg.type === "chatResult") {
    clearPendingAssistant();
    await handleAssistantResult(msg.result);
    if (elSoulPanel && !elSoulPanel.hidden) {
      try {
        await refreshSoulFromFile();
      } catch {}
    }
    return;
  }
  if (msg.type === "player.state") {
    applyPlayerState(msg.state);
    return;
  }
  if (msg.type === "player.error") {
    const message = msg.error ? String(msg.error) : __t("未知错误");
    if (msg.context) setHint(`${msg.context}: ${message}`);
    else setHint(__t("播放异常：{0}", {0: message}));
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
  if (pendingAssistantEl && pendingAssistantEl.isConnected) {
    setHint(__t("上一条还在生成回复…"));
    return;
  }
  const text = elInput.value.trim();
  if (!text) return;
  elInput.value = "";
  autosizeComposerInput();
  updateSendState();
  appendMessage("user", text);
  lastChatText = text;
  clearRecommendCard();
  startPendingAssistant();
  try {
    void chrome.runtime.sendMessage({ type: "chat", text, chatOnly: true });
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    clearPendingAssistant();
    appendMessage("assistant", __t("发送失败：{0}", {0: message}));
  }
});

if (elBtnClear) {
  elBtnClear.addEventListener("click", async () => {
    await startNewSession();
    updateSendState();
    setHint(__t("已开启新会话"));
  });
}

elInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    elSend.click();
  }
});

elInput.addEventListener("input", () => {
  autosizeComposerInput();
  updateSendState();
});

window.addEventListener("focus", () => {
  autosizeComposerInput();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) autosizeComposerInput();
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
    setHint(__t("头像已更新"));
  } catch {
    setHint(__t("头像处理失败"));
  }
});



elBtnQueue.addEventListener("click", () => {
  elQueue.classList.toggle("open");
});

window.addEventListener("click", (e) => {
  if (!elQueue || !elQueue.classList.contains("open")) return;
  const t = e?.target;
  if (!t) return;
  if (elQueue.contains(t)) return;
  if (elBtnQueue && elBtnQueue.contains(t)) return;
  elQueue.classList.remove("open");
});

elBtnPlay.addEventListener("click", async () => {
  if (playerPlaying) await sendPlayerCommand("player.pause");
  else await sendPlayerCommand("player.play");
});

elBtnNext.addEventListener("click", playNext);
elBtnPrev.addEventListener("click", playPrev);

elProgress.addEventListener("input", () => {
  const duration = playerDuration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  seeking = true;
  const ratio = Number(elProgress.value) / 1000;
  const nextTime = ratio * duration;
  updateTimeUI(nextTime, duration);
});

elProgress.addEventListener("change", () => {
  const duration = playerDuration;
  if (!Number.isFinite(duration) || duration <= 0) return;
  const ratio = Number(elProgress.value) / 1000;
  void sendPlayerCommand("player.seek", { time: ratio * duration });
  seeking = false;
});

elBtnMic.addEventListener("click", async () => {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setHint(__t("当前浏览器不支持语音输入"));
    return;
  }

  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = __lang === "en" ? "en-US" : "zh-CN";
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
      autosizeComposerInput();
      updateSendState();
      elInput.focus();
    });

    recognition.addEventListener("error", (event) => {
      const err = event?.error ? String(event.error) : "unknown";
      if (err === "not-allowed" || err === "service-not-allowed") {
        setHint(__t("语音权限被拒绝"));
      } else if (err === "no-speech") {
        setHint(__t("未检测到语音"));
      } else {
        setHint(__t("语音识别失败：{0}", {0: err}));
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
    setHint(__t("正在聆听…"));
    updateSendState();
    recognition.start();
  } catch {
    recognizing = false;
    elBtnMic.classList.remove("recording");
    elBtnMic.setAttribute("aria-pressed", "false");
    updateSendState();
    setHint(__t("语音输入启动失败"));
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

if (elHistoryDetailCover && elHistoryDetailCoverBox) {
  elHistoryDetailCover.addEventListener("load", () => {
    elHistoryDetailCover.hidden = false;
    elHistoryDetailCoverBox.classList.remove("fallback");
  });
  elHistoryDetailCover.addEventListener("error", () => {
    elHistoryDetailCover.hidden = true;
    elHistoryDetailCover.removeAttribute("src");
    elHistoryDetailCoverBox.classList.add("fallback");
  });
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

if (elSettingsKeepSession) {
  elSettingsKeepSession.addEventListener("change", async () => {
    const enabled = Boolean(elSettingsKeepSession.checked);
    keepSessionOnClose = enabled;
    try {
      await patchPreferences({ keepSessionOnClose: enabled });
    } catch {}
    if (!enabled) {
      await clearSavedSession();
      setHint(__t("已关闭保留会话"));
    } else {
      scheduleSessionSave();
      setHint(__t("已开启保留会话"));
    }
  });
}

if (elSettingsAutoRecommend) {
  elSettingsAutoRecommend.addEventListener("change", async () => {
    const enabled = Boolean(elSettingsAutoRecommend.checked);
    autoRecommendPlay = enabled;
    try {
      await patchPreferences({ autoRecommendPlay: enabled });
    } catch {}
    setHint(enabled ? __t("已开启 DJ 推荐自动播放") : __t("已关闭 DJ 推荐自动播放，推荐时将显示确认按钮"));
  });
}

if (elAiToolModeAuto) {
  elAiToolModeAuto.addEventListener("change", async () => {
    if (!elAiToolModeAuto.checked) return;
    localAiToolMode = "auto";
    try { await patchPreferences({ localAiToolMode: "auto" }); } catch {}
    setHint(__t("已切换为自动检测模式"));
    await refreshAiToolSettingsUI();
  });
}

if (elAiToolModeManual) {
  elAiToolModeManual.addEventListener("change", async () => {
    if (!elAiToolModeManual.checked) return;
    localAiToolMode = "manual";
    const selectedId = elAiToolSelect ? String(elAiToolSelect.value || "").trim() : "";
    localAiToolId = selectedId;
    try { await patchPreferences({ localAiToolMode: "manual", localAiToolId: selectedId }); } catch {}
    setHint(__t("已切换为手动选择模式"));
    await refreshAiToolSettingsUI();
  });
}

if (elAiToolSelect) {
  elAiToolSelect.addEventListener("change", async () => {
    if (localAiToolMode !== "manual") return;
    const selectedId = String(elAiToolSelect.value || "").trim();
    localAiToolId = selectedId;
    try { await patchPreferences({ localAiToolId: selectedId }); } catch {}
    setHint(__t("已保存工具选择"));
    await refreshAiToolSettingsUI();
  });
}

if (elAiToolRefresh) {
  elAiToolRefresh.addEventListener("click", async () => {
    setHint(__t("正在刷新工具检测…"));
    await refreshAiToolSettingsUI(true);
    setHint(__t("工具检测已刷新"));
  });
}

if (elAiProviderLocal) {
  elAiProviderLocal.addEventListener("change", async () => {
    if (!elAiProviderLocal.checked) return;
    aiProvider = "local";
    try { await patchPreferences({ aiProvider: "local" }); } catch {}
    setHint(__t("已切换为本地 AI 引擎"));
    applyProviderVisibility();
  });
}
if (elAiProviderCloud) {
  elAiProviderCloud.addEventListener("change", async () => {
    if (!elAiProviderCloud.checked) return;
    aiProvider = "cloud";
    try { await patchPreferences({ aiProvider: "cloud" }); } catch {}
    setHint(__t("已切换为云端 AI 引擎"));
    applyProviderVisibility();
  });
}

async function saveDjNameFromSettings() {
  if (!elSettingsDjNameInput) return;
  const raw = String(elSettingsDjNameInput.value || "").trim();
  const next = Array.from(raw).slice(0, 8).join("");
  if (!next) {
    setHint(__t("DJ 名称不能为空"));
    refreshSettingsDjNameUI();
    return;
  }
  try {
    await patchPreferences({ djName: next });
    setDjNameUI(next);
    setHint(__t("已保存 DJ 名称"));
    refreshSettingsDjNameUI();
  } catch (e) {
    const message = e?.message ? String(e.message) : String(e);
    setHint(__t("保存失败：{0}", {0: message}));
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

autosizeComposerInput();
updateSendState();
safePost({ type: "ready", lang: __lang });

(async () => {
  const prefs = await getPreferences();
  await loadTrackVotes();
  setDjNameUI(prefs.djName || "Claudefm");
  setAvatarUI(prefs.avatarDataUrl || "");
  keepSessionOnClose = prefs.keepSessionOnClose !== false;
  if (elSettingsKeepSession) elSettingsKeepSession.checked = keepSessionOnClose;
  autoRecommendPlay = prefs.autoRecommendPlay !== false;
  if (elSettingsAutoRecommend) elSettingsAutoRecommend.checked = autoRecommendPlay;
  localAiToolMode = prefs.localAiToolMode || "auto";
  localAiToolId = prefs.localAiToolId || "";
  if (elAiToolModeAuto) elAiToolModeAuto.checked = localAiToolMode === "auto";
  if (elAiToolModeManual) elAiToolModeManual.checked = localAiToolMode === "manual";
  if (elAiToolSelect) elAiToolSelect.disabled = localAiToolMode === "auto";
  aiProvider = prefs.aiProvider || "local";
  if (elAiProviderLocal) elAiProviderLocal.checked = aiProvider === "local";
  if (elAiProviderCloud) elAiProviderCloud.checked = aiProvider === "cloud";
  applyProviderVisibility();
  if (keepSessionOnClose) {
    await restoreSessionIfAny();
  } else {
    await clearSavedSession();
  }
  await requestPlayerState();

  window.addEventListener("pagehide", () => {
    if (keepSessionOnClose) void saveSessionNow();
    else void clearSavedSession();
  });
  window.addEventListener("beforeunload", () => {
    if (keepSessionOnClose) void saveSessionNow();
    else void clearSavedSession();
  });
})();

// Wave animation
{
  const wrap = document.getElementById("waveWrap");
  if (wrap) {
    const BAR_COUNT = 58;
    const MAX_HEIGHT = 120;
    const MIN_HEIGHT = 3;
    const FLOW_SPEED = 170;
    const CENTER_WEIGHT = 0.7;
    const WAVE_RAND_RANGE = 0.85;
    const bars = [];
    const waveData = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      const el = document.createElement("div");
      el.className = "bar";
      wrap.appendChild(el);
      bars.push(el);
      waveData.push(MIN_HEIGHT);
    }
    function getVoiceHeight(pos) {
      const mid = BAR_COUNT / 2;
      const dist = Math.abs(pos - mid) / mid;
      const envelope = 1 - dist * CENTER_WEIGHT;
      let base = 0.2 + Math.random() * WAVE_RAND_RANGE;
      let h = MAX_HEIGHT * base * envelope;
      return Math.max(MIN_HEIGHT, h);
    }
    function flowWave() {
      for (let i = 0; i < BAR_COUNT - 1; i++) {
        waveData[i] = waveData[i + 1] * 0.88;
      }
      waveData[BAR_COUNT - 1] = getVoiceHeight(BAR_COUNT - 1);
      for (let i = 0; i < BAR_COUNT; i++) {
        if (Math.random() > 0.65) {
          waveData[i] = getVoiceHeight(i);
        }
        bars[i].style.height = waveData[i] + "px";
      }
    }
    setInterval(flowWave, FLOW_SPEED);
  }
}
