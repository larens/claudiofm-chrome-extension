const PLAYER_STATE_CACHE_KEY = "playerStateCacheV1";

const audioA = new Audio();
const audioB = new Audio();
audioA.preload = "auto";
audioB.preload = "auto";

let queue = [];
let queueIndex = -1;
let interrupted = false;
let userPaused = false;
let segueSpokenInQueue = 0;
let speechActive = false;
let speechPaused = false;
let segmentTarget = 0;
let segmentTracks = [];
let interludeInFlight = false;
let activeAudio = audioA;
let preloadAudio = audioB;
let preloadIndex = -1;
let preloadStatus = "idle";
let preloadRequestToken = 0;
let playRequestToken = 0;
let lastProgressBroadcastAt = 0;

function cloneTrack(track) {
  if (!track || typeof track !== "object") return track;
  return {
    kind: track.kind || "",
    name: track.name || "",
    artist: track.artist || "",
    text: track.text || "",
    streamUrl: track.streamUrl || "",
    provider: track.provider || "",
    cover: track.cover || "",
    durationMs: track.durationMs || 0,
  };
}

function snapshotState() {
  const currentTrack = queueIndex >= 0 && queueIndex < queue.length ? cloneTrack(queue[queueIndex]) : null;
  return {
    queue: queue.map(cloneTrack),
    queueIndex,
    currentTrack,
    playing: speechActive ? !speechPaused : !activeAudio.paused && Boolean(activeAudio.src),
    currentTime: speechActive ? 0 : Number(activeAudio.currentTime || 0),
    duration: speechActive ? 0 : Number(activeAudio.duration || 0),
    interrupted,
    userPaused,
    speechActive,
    speechPaused,
    preloadIndex,
    preloadStatus,
    lastUpdatedAt: Date.now(),
  };
}

async function emitState(reason = "state") {
  const state = snapshotState();
  try {
    await chrome.runtime.sendMessage({ type: "player.stateBroadcast", state, reason, cacheKey: PLAYER_STATE_CACHE_KEY });
  } catch {}
  return state;
}

async function emitError(error, context = "") {
  const message = error?.message ? String(error.message) : String(error || "");
  try {
    await chrome.runtime.sendMessage({ type: "player.errorBroadcast", error: message, context });
  } catch {}
}

function resetAudioElement(audio) {
  try {
    audio.pause();
  } catch {}
  try {
    audio.removeAttribute("src");
    audio.load();
    audio.currentTime = 0;
  } catch {}
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

async function clearPreload(reason = "reset") {
  preloadRequestToken += 1;
  preloadIndex = -1;
  preloadStatus = "idle";
  resetAudioElement(preloadAudio);
  await emitState(`preload:${reason}`);
}

function base64ToBlob(b64, mime) {
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return new Blob([arr], { type: mime || "audio/mpeg" });
}

async function requestTtsAudio(text) {
  try {
    console.log("[offscreen] requestTtsAudio sending, text=" + text.slice(0, 40));
    const resp = await chrome.runtime.sendMessage({ type: "tts", text });
    console.log("[offscreen] requestTtsAudio response:", JSON.stringify({ ok: resp?.ok, provider: resp?.provider, error: resp?.error, hasAudio: !!(resp?.audio?.base64) }));
    if (resp && resp.ok && resp.audio && resp.audio.base64) {
      return resp.audio;
    }
  } catch (e) {
    console.log("[offscreen] requestTtsAudio error:", e?.message || e);
  }
  return null;
}

async function playTtsAudio(text, token) {
  const audio = await requestTtsAudio(text);
  if (!audio) return false;
  if (token !== playRequestToken) return true;

  const blob = base64ToBlob(audio.base64, audio.mime);
  if (!blob.size) return false;
  const url = URL.createObjectURL(blob);
  const el = new Audio();
  el.preload = "auto";
  el.src = url;

  let played = false;
  await emitState("speech:start");
  await new Promise((resolve) => {
    el.oncanplaythrough = () => {
      el.play().then(() => { played = true; }).catch(() => {}).finally(() => resolve());
    };
    el.onerror = () => resolve();
    setTimeout(() => resolve(), 5000);
  });
  if (!played) {
    try { URL.revokeObjectURL(url); } catch {}
    return false;
  }
  await new Promise((resolve) => {
    el.onended = () => resolve();
    el.onerror = () => resolve();
  });
  try { URL.revokeObjectURL(url); } catch {}
  return true;
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

async function getPlayerPreferences() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "player.getPreferences" });
    return resp?.ok ? resp.prefs || {} : {};
  } catch {
    return {};
  }
}

async function resolveTrack(track) {
  const cachedStreamUrl = (track?.streamUrl || "").replace(/`/g, "").trim();
  if (cachedStreamUrl) {
    return {
      provider: track?.provider || "cached",
      track: { name: track?.name || "", artist: track?.artist || "" },
      streamUrl: cachedStreamUrl,
      cover: track?.cover || "",
      durationMs: track?.durationMs || 0,
    };
  }
  const res = await chrome.runtime.sendMessage({ type: "resolveTrack", track });
  if (!res || !res.streamUrl) throw new Error("resolve failed");
  return res;
}

async function prefetchTrackAt(index) {
  if (index < 0 || index >= queue.length) return;
  if (index === queueIndex) return;
  if (preloadIndex === index && (preloadStatus === "resolving" || preloadStatus === "loading" || preloadStatus === "ready")) {
    return;
  }
  const track = queue[index];
  if (!track || isSpeechItem(track)) return;

  const token = ++preloadRequestToken;
  preloadIndex = index;
  preloadStatus = "resolving";
  await emitState("preload:start");

  try {
    const resolved = await resolveTrack(track);
    if (token !== preloadRequestToken) return;
    const streamUrl = (resolved?.streamUrl || "").replace(/`/g, "").trim();
    if (!streamUrl) throw new Error("prefetch resolve missing streamUrl");
    queue[index] = mergeResolvedTrack(track, resolved);
    preloadStatus = "loading";
    resetAudioElement(preloadAudio);
    preloadAudio.src = streamUrl;
    preloadAudio.load();
    await emitState("preload:loading");
  } catch (error) {
    if (token !== preloadRequestToken) return;
    preloadIndex = -1;
    preloadStatus = "error";
    resetAudioElement(preloadAudio);
    await emitError(error, "prefetchTrackAt");
    await emitState("preload:error");
  }
}

function schedulePreloadForNextTrack() {
  for (let i = queueIndex + 1; i >= 0 && i < queue.length; i += 1) {
    const track = queue[i];
    if (!track || isSpeechItem(track)) continue;
    void prefetchTrackAt(i);
    return;
  }
  void clearPreload("no-next-track");
}

async function activatePreloadedTrack(index) {
  if (!isPreloadedTrack(index)) return false;
  const previousAudio = activeAudio;
  const nextAudio = preloadAudio;

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
    activeAudio = previousAudio;
    preloadAudio = nextAudio;
    await emitError(error, "activatePreloadedTrack");
    return false;
  }

  resetAudioElement(preloadAudio);
  schedulePreloadForNextTrack();
  await emitState("track:activated-preload");
  return true;
}

async function requestLyricInterlude(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const cleaned = list
    .map((t) => ({ name: String(t?.name || "").trim(), artist: String(t?.artist || "").trim() }))
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
  } catch (error) {
    const message = error?.message ? String(error.message) : String(error);
    return { ok: false, error: message };
  }
}

async function playAt(index) {
  const token = ++playRequestToken;
  const track = queue[index];
  if (!track) return snapshotState();

  queueIndex = index;
  userPaused = false;

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
  await emitState("track:selected");

  if (isSpeechItem(track)) {
    await clearPreload("speech");
    resetAudioElement(activeAudio);
    const text = track?.text ? String(track.text).trim() : "";
    if (!text) {
      await emitState("speech:empty");
      return snapshotState();
    }
    speechActive = true;
    speechPaused = false;
    schedulePreloadForNextTrack();

    // 使用 MiMo TTS 生成的音频文件播放推荐语
    await playTtsAudio(text, token);
    if (token !== playRequestToken) return snapshotState();

    speechActive = false;
    speechPaused = false;
    await emitState("speech:end");
    await playNext();
    return snapshotState();
  }

  if (await activatePreloadedTrack(index)) {
    return snapshotState();
  }

  let resolved;
  try {
    resolved = await resolveTrack(track);
  } catch (error) {
    if (token === playRequestToken) {
      await emitError(error, "playAt.resolveTrack");
      await emitState("track:resolve-error");
    }
    return snapshotState();
  }
  if (token !== playRequestToken) return snapshotState();

  const streamUrl = (resolved?.streamUrl || "").replace(/`/g, "").trim();
  if (!streamUrl) {
    await emitError(new Error("missing streamUrl"), "playAt.streamUrl");
    return snapshotState();
  }

  queue[index] = mergeResolvedTrack(track, resolved);
  await clearPreload("manual-play");
  if (token !== playRequestToken) return snapshotState();

  activeAudio.src = streamUrl;
  activeAudio.currentTime = 0;
  activeAudio.load();

  const canPlay = await new Promise((resolve) => {
    const onOk = () => { cleanup(); resolve(true); };
    const onErr = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      activeAudio.removeEventListener("canplaythrough", onOk);
      activeAudio.removeEventListener("error", onErr);
    };
    activeAudio.addEventListener("canplaythrough", onOk, { once: true });
    activeAudio.addEventListener("error", onErr, { once: true });
    setTimeout(() => { cleanup(); resolve(false); }, 8000);
  });

  if (!canPlay || token !== playRequestToken) {
    if (token === playRequestToken) {
      await emitError(new Error("audio source load failed"), "playAt.audio.load");
      await emitState("track:play-error");
    }
    return snapshotState();
  }

  try {
    await activeAudio.play();
  } catch (error) {
    await emitError(error, "playAt.audio.play");
    await emitState("track:play-error");
    return snapshotState();
  }
  if (token !== playRequestToken) return snapshotState();
  schedulePreloadForNextTrack();
  await emitState("track:play");
  return snapshotState();
}

async function playNext() {
  if (!queue.length) return snapshotState();
  const next = Math.min(queueIndex + 1, queue.length - 1);
  if (next === queueIndex) return snapshotState();
  return await playAt(next);
}

async function playPrev() {
  if (!queue.length) return snapshotState();
  const prev = Math.max(queueIndex - 1, 0);
  if (prev === queueIndex) return snapshotState();
  return await playAt(prev);
}

async function commandPlay() {
  if (speechActive && "speechSynthesis" in window) {
    speechPaused = false;
    try {
      window.speechSynthesis.resume();
    } catch {}
    await emitState("speech:resume");
    return snapshotState();
  }
  if (!activeAudio.src) {
    if (queue.length) return await playAt(Math.max(queueIndex, 0));
    return snapshotState();
  }
  userPaused = false;
  try {
    await activeAudio.play();
  } catch (error) {
    await emitError(error, "commandPlay");
  }
  await emitState("player:play");
  return snapshotState();
}

async function commandPause(reason = "pause") {
  if (speechActive && "speechSynthesis" in window) {
    speechPaused = true;
    try {
      window.speechSynthesis.pause();
    } catch {}
    await emitState(`speech:${reason}`);
    return snapshotState();
  }
  userPaused = reason !== "interrupt";
  try {
    await activeAudio.pause();
  } catch {}
  await emitState(`player:${reason}`);
  return snapshotState();
}

async function interruptStart() {
  if (speechActive && !speechPaused) {
    interrupted = true;
    speechPaused = true;
    try {
      window.speechSynthesis.pause();
    } catch {}
    await emitState("interrupt:start");
    return snapshotState();
  }
  if (!activeAudio.paused) {
    interrupted = true;
    userPaused = false;
    try {
      await activeAudio.pause();
    } catch {}
    await emitState("interrupt:start");
  }
  return snapshotState();
}

async function interruptEnd() {
  if (!interrupted || userPaused) {
    interrupted = false;
    await emitState("interrupt:end-noop");
    return snapshotState();
  }
  interrupted = false;
  if (speechActive && speechPaused) {
    speechPaused = false;
    try {
      window.speechSynthesis.resume();
    } catch {}
    await emitState("interrupt:end");
    return snapshotState();
  }
  try {
    await activeAudio.play();
  } catch (error) {
    await emitError(error, "interruptEnd");
  }
  await emitState("interrupt:end");
  return snapshotState();
}

async function replaceQueueAndPlay(nextQueue, startIndex = 0) {
  const list = Array.isArray(nextQueue) ? nextQueue.map(cloneTrack) : [];
  queue = list;
  queueIndex = -1;
  userPaused = false;
  segueSpokenInQueue = 0;
  resetLyricSegment();
  await clearPreload("replace-queue");
  await emitState("queue:replace");
  if (!queue.length) return snapshotState();
  return await playAt(Math.max(0, Math.min(startIndex, queue.length - 1)));
}

async function insertTrackAtAndPlay(track, index) {
  const item = cloneTrack(track);
  if (!item?.name || !item?.artist) return snapshotState();
  const insertAt = Math.max(0, Math.min(Number(index) || 0, queue.length));
  queue.splice(insertAt, 0, item);
  await emitState("queue:insert");
  return await playAt(insertAt);
}

async function seekTo(seconds) {
  if (speechActive) return snapshotState();
  const nextTime = Number(seconds);
  if (!Number.isFinite(nextTime) || nextTime < 0) return snapshotState();
  try {
    activeAudio.currentTime = nextTime;
  } catch {}
  await emitState("player:seek");
  return snapshotState();
}

async function resetPlayer() {
  try {
    activeAudio.pause();
  } catch {}
  try {
    activeAudio.currentTime = 0;
  } catch {}
  resetAudioElement(activeAudio);
  resetAudioElement(preloadAudio);
  if ("speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {}
  }
  queue = [];
  queueIndex = -1;
  interrupted = false;
  userPaused = false;
  speechActive = false;
  speechPaused = false;
  preloadIndex = -1;
  preloadStatus = "idle";
  segueSpokenInQueue = 0;
  resetLyricSegment();
  await emitState("player:reset");
  return snapshotState();
}

function bindAudioEvents(audio) {
  audio.addEventListener("play", () => {
    if (audio !== activeAudio) return;
    void emitState("audio:play");
  });
  audio.addEventListener("pause", () => {
    if (audio !== activeAudio) return;
    void emitState("audio:pause");
  });
  audio.addEventListener("loadedmetadata", () => {
    if (audio !== activeAudio) return;
    void emitState("audio:loadedmetadata");
  });
  audio.addEventListener("canplay", () => {
    if (audio === preloadAudio && preloadStatus === "loading") {
      preloadStatus = "ready";
      void emitState("preload:ready");
    }
  });
  audio.addEventListener("durationchange", () => {
    if (audio !== activeAudio) return;
    void emitState("audio:durationchange");
  });
  audio.addEventListener("timeupdate", () => {
    if (audio !== activeAudio) return;
    const now = Date.now();
    if (now - lastProgressBroadcastAt < 500) return;
    lastProgressBroadcastAt = now;
    void emitState("audio:progress");
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
      if (name && artist) segmentTracks.push({ name, artist });
      if (!interludeInFlight && segmentTracks.length >= segmentTarget) {
        interludeInFlight = true;
        const snapshot = segmentTracks.slice(0, 5);
        const resp = await requestLyricInterlude(snapshot);
        if (stableToken !== playRequestToken) return;
        const text = resp?.ok && resp?.result?.text ? String(resp.result.text).trim() : "";
        if (text && !resp?.skipped) {
          queue.splice(finishedIndex + 1, 0, {
            kind: "speech",
            name: `插播：歌词情绪解读（${snapshot.length} 首）`,
            artist: "",
            text,
          });
          await emitState("queue:insert-interlude");
        }
        resetLyricSegment();
      }
    }
    await playNext();
  });
  audio.addEventListener("error", () => {
    void emitError(audio.error || new Error("audio error"), "audio");
    void emitState("audio:error");
  });
}

bindAudioEvents(audioA);
bindAudioEvents(audioB);
resetLyricSegment();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object" || msg.target !== "offscreen") return undefined;
  (async () => {
    try {
      if (msg.command === "player.getState") {
        sendResponse({ ok: true, state: snapshotState() });
        return;
      }
      if (msg.command === "player.playAt") {
        sendResponse({ ok: true, state: await playAt(Number(msg.index)) });
        return;
      }
      if (msg.command === "player.play") {
        sendResponse({ ok: true, state: await commandPlay() });
        return;
      }
      if (msg.command === "player.pause") {
        sendResponse({ ok: true, state: await commandPause("pause") });
        return;
      }
      if (msg.command === "player.next") {
        sendResponse({ ok: true, state: await playNext() });
        return;
      }
      if (msg.command === "player.prev") {
        sendResponse({ ok: true, state: await playPrev() });
        return;
      }
      if (msg.command === "player.seek") {
        sendResponse({ ok: true, state: await seekTo(msg.time) });
        return;
      }
      if (msg.command === "player.replaceQueueAndPlay") {
        sendResponse({ ok: true, state: await replaceQueueAndPlay(msg.queue, Number(msg.startIndex) || 0) });
        return;
      }
      if (msg.command === "player.insertTrackAtAndPlay") {
        sendResponse({ ok: true, state: await insertTrackAtAndPlay(msg.track, Number(msg.index) || 0) });
        return;
      }
      if (msg.command === "player.reset") {
        sendResponse({ ok: true, state: await resetPlayer() });
        return;
      }
      if (msg.command === "player.interruptStart") {
        sendResponse({ ok: true, state: await interruptStart() });
        return;
      }
      if (msg.command === "player.interruptEnd") {
        sendResponse({ ok: true, state: await interruptEnd() });
        return;
      }
      if (msg.command === "player.setPreferences") {
        sendResponse({ ok: true, state: await emitState("player:set-preferences") });
        return;
      }
      sendResponse({ ok: false, error: `unknown command: ${msg.command || ""}` });
    } catch (error) {
      await emitError(error, msg.command || "offscreen.command");
      sendResponse({ ok: false, error: error?.message ? String(error.message) : String(error) });
    }
  })();
  return true;
});

(async () => {
  await getPlayerPreferences();
  await emitState("offscreen:init");
})();

