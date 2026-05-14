#!/usr/bin/env node
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AI_TOOLS, getToolById } = require("./ai-tools.cjs");
const { t: ht, weatherCodeToLabel, getTimeSegment: getLangTimeSegment } = require("./i18n-host.cjs");

function resolveTemplatePath(inputPath, lang) {
  const provided = inputPath ? String(inputPath) : "";
  if (provided && fs.existsSync(provided)) return provided;
  const base = path.resolve(__dirname, "..", "docs", "superpowers", "specs");
  if (lang === "en") {
    const enPath = path.join(base, "music_user_memory.en.md");
    if (fs.existsSync(enPath)) return enPath;
  }
  const fallback = path.join(base, "music_user_memory.md");
  if (fs.existsSync(fallback)) return fallback;
  return "";
}

function getPlatformConfigName(platform = os.platform()) {
  if (platform === "darwin") return "install-macos.json";
  if (platform === "win32") return "install-windows.json";
  return "install-linux.json";
}

function readInstallConfig() {
  const candidates = [
    path.resolve(__dirname, "runtime-config.json"),
    path.resolve(__dirname, getPlatformConfigName()),
    path.resolve(__dirname, "install-macos.json"),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

function getDefaultClaudefmFolder(platform = os.platform()) {
  const home = os.homedir();
  if (platform === "darwin") return path.join(home, "Documents", "Claudefm");
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claudefm");
  }
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdgDataHome, "Claudefm");
}

function getClaudefmFolder() {
  const envDir = process.env.CLAUDEFM_DATA_DIR ? String(process.env.CLAUDEFM_DATA_DIR).trim() : "";
  if (envDir && path.isAbsolute(envDir)) return envDir;
  const config = readInstallConfig();
  const configDir = config && config.dataDir ? String(config.dataDir).trim() : "";
  if (configDir && path.isAbsolute(configDir)) return configDir;
  return getDefaultClaudefmFolder();
}

function getMusicFilePath() {
  return path.join(getClaudefmFolder(), "music.md");
}

function getListFilePath() {
  return path.join(getClaudefmFolder(), "list.md");
}

function getLogFilePath() {
  const home = os.homedir();
  if (os.platform() === "darwin") {
    return path.join(home, "Library", "Logs", "ClaudefmHost.log");
  }
  if (os.platform() === "win32") {
    return path.join(process.env.TEMP || os.tmpdir(), "ClaudefmHost.log");
  }
  const stateHome = process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
  return path.join(stateHome, "Claudefm", "ClaudefmHost.log");
}

function buildExecEnv() {
  const home = os.homedir();
  const sep = path.delimiter;
  const extras = [
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin")
  ];
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppdata = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    extras.push(
      path.join(appdata, "npm"),
      path.join(localAppdata, "Microsoft", "WinGet", "Packages")
    );
  } else {
    extras.push(
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin"
    );
  }
  const current = String(process.env.PATH || "");
  const nextPath = Array.from(new Set([...extras, ...current.split(sep).filter(Boolean)])).join(sep);
  return { ...process.env, HOME: process.env.HOME || home, PATH: nextPath };
}

function findBinaryInDirs(dirs, binName, extensions = [""]) {
  for (const d of dirs) {
    try {
      if (!fs.statSync(d).isDirectory()) continue;
    } catch { continue; }
    for (const ext of extensions) {
      const p = path.join(d, binName + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch {}
    }
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          for (const ext of extensions) {
            const p = path.join(d, entry.name, binName + ext);
            try { if (fs.statSync(p).isFile()) return p; } catch {}
          }
        }
      }
    } catch {}
  }
  return "";
}

function findClaudeBinary() {
  const envBin = process.env.CLAUDE_BIN || process.env.CLAUDE_PATH;
  if (envBin && fs.existsSync(envBin)) return String(envBin);
  if (process.platform !== "win32") {
    for (const shell of ["zsh", "bash"]) {
      try {
        const shellPath = spawnSync("which", [shell], { encoding: "utf8" }).stdout.trim();
        if (!shellPath) continue;
        const found = spawnSync(shellPath, ["-lc", "command -v claude 2>/dev/null || true"], {
          encoding: "utf8",
          env: buildExecEnv(),
        }).stdout.trim();
        if (found && fs.existsSync(found)) return found;
      } catch {}
    }
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppdata = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const winDirs = [
      path.join(appdata, "npm"),
      path.join(home, ".npm-global", "bin"),
      path.join(localAppdata, "Microsoft", "WinGet", "Packages")
    ];
    const found = findBinaryInDirs(winDirs, "claude", [".exe", ".cmd", ".bat", ""]);
    if (found) return found;
  } else {
    const candidates = [
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      path.join(home, ".npm-global", "bin", "claude"),
      path.join(home, "workspace", ".npm-global", "bin", "claude"),
      path.join(home, ".local", "bin", "claude"),
      path.join(home, ".bun", "bin", "claude"),
      path.join(home, ".cargo", "bin", "claude")
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  }
  return "claude";
}

// ---------------------------------------------------------------------------
// Multi-tool detection & execution abstraction
// ---------------------------------------------------------------------------

function detectBinaryForTool(toolDef) {
  const envKeys = Array.isArray(toolDef.envKeys) ? toolDef.envKeys : [];
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && fs.existsSync(val)) return { found: true, path: String(val) };
  }
  const candidates = Array.isArray(toolDef.binaryCandidates) ? toolDef.binaryCandidates : [];
  for (const bin of candidates) {
    if (process.platform !== "win32") {
      for (const shell of ["zsh", "bash"]) {
        try {
          const shellPath = spawnSync("which", [shell], { encoding: "utf8" }).stdout.trim();
          if (!shellPath) continue;
          const found = spawnSync(shellPath, ["-lc", `command -v ${bin} 2>/dev/null || true`], {
            encoding: "utf8",
            env: buildExecEnv(),
          }).stdout.trim();
          if (found && fs.existsSync(found)) return { found: true, path: found };
        } catch {}
      }
    }
  }
  const home = os.homedir();
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppdata = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const winDirs = [
      path.join(appdata, "npm"),
      path.join(home, ".npm-global", "bin"),
      path.join(localAppdata, "Microsoft", "WinGet", "Packages")
    ];
    for (const bin of candidates) {
      const found = findBinaryInDirs(winDirs, bin, [".exe", ".cmd", ".bat", ""]);
      if (found) return { found: true, path: found };
    }
  } else {
    const pathDirs = [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      path.join(home, ".npm-global", "bin"),
      path.join(home, "workspace", ".npm-global", "bin"),
      path.join(home, ".local", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
    ];
    for (const bin of candidates) {
      for (const dir of pathDirs) {
        const p = path.join(dir, bin);
        try {
          if (fs.existsSync(p)) return { found: true, path: p };
        } catch {}
      }
    }
  }
  return { found: false, path: "" };
}

function detectAppForTool(toolDef) {
  const appCandidates = Array.isArray(toolDef.appCandidates) ? toolDef.appCandidates : [];
  const home = os.homedir();
  const platform = os.platform();
  for (const name of appCandidates) {
    const appName = name.endsWith(".app") ? name : name + ".app";
    if (platform === "darwin") {
      const dirs = ["/Applications", path.join(home, "Applications")];
      for (const dir of dirs) {
        const p = path.join(dir, appName);
        try {
          if (fs.existsSync(p)) return { found: true, path: p };
        } catch {}
      }
    } else if (platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const p = path.join(localAppData, "Programs", name);
      try {
        if (fs.existsSync(p)) return { found: true, path: p };
      } catch {}
    } else {
      const p = path.join("/usr", "share", "applications", name.toLowerCase() + ".desktop");
      try {
        if (fs.existsSync(p)) return { found: true, path: p };
      } catch {}
    }
  }
  // Also try binary detection for tools that have both app and binary candidates
  if (toolDef.binaryCandidates && toolDef.binaryCandidates.length) {
    const binResult = detectBinaryForTool(toolDef);
    if (binResult.found) return binResult;
  }
  return { found: false, path: "" };
}

let _detectionCache = null;
let _detectionCacheTs = 0;
const DETECTION_CACHE_TTL_MS = 30000;

function detectLocalAiTools(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _detectionCache && now - _detectionCacheTs < DETECTION_CACHE_TTL_MS) {
    return _detectionCache;
  }
  const tools = [];
  for (const def of AI_TOOLS) {
    let detected = { found: false, path: "" };
    if (def.detectionMode === "binary") {
      detected = detectBinaryForTool(def);
    } else if (def.detectionMode === "app_bundle") {
      detected = detectAppForTool(def);
    } else if (def.detectionMode === "path_probe") {
      detected = detectBinaryForTool(def);
    }
    const installed = detected.found;
    const callable = installed && def.executionMode === "cli";
    let statusText = "未安装";
    if (installed && callable) statusText = "已安装，可直接调用";
    else if (installed) statusText = "已安装，仅检测展示";
    tools.push({
      id: def.id,
      label: def.label,
      category: def.category,
      installed,
      callable,
      executionMode: def.executionMode,
      statusText,
      resolvedPath: detected.path || "",
      priority: def.priority,
      description: def.description || "",
      installHint: def.installHint || "",
    });
  }
  const callableTools = tools.filter((t) => t.callable).sort((a, b) => a.priority - b.priority);
  const recommendedToolId = callableTools.length ? callableTools[0].id : "";
  const result = { tools, recommendedToolId, resolvedToolId: recommendedToolId };
  _detectionCache = result;
  _detectionCacheTs = now;
  return result;
}

function resolveLocalAiTool(preferences, detectionResult) {
  const mode = preferences && preferences.localAiToolMode ? String(preferences.localAiToolMode) : "auto";
  if (mode === "manual") {
    const id = preferences && preferences.localAiToolId ? String(preferences.localAiToolId).trim() : "";
    if (id) {
      const tool = (detectionResult.tools || []).find((t) => t.id === id);
      if (tool) return { tool, mode: "manual", resolvedToolId: tool.id };
    }
    return { tool: null, mode: "manual", resolvedToolId: "" };
  }
  const recId = detectionResult.recommendedToolId || "";
  const tool = recId ? (detectionResult.tools || []).find((t) => t.id === recId) : null;
  return { tool, mode: "auto", resolvedToolId: recId };
}

function runWithLocalAiTool(tool, prompt, schema) {
  if (!tool) return { ok: false, error: "未指定工具" };
  if (!tool.callable) {
    if (tool.executionMode === "unsupported") {
      return { ok: false, error: `工具 ${tool.label} 暂不支持直接调用，仅支持安装检测` };
    }
    return { ok: false, error: `工具 ${tool.label} 当前不可用` };
  }
  if (tool.id === "claude_code") return runClaudeWithRetry(prompt, schema);
  // Future adapters for codex, gemini_cli, etc. go here
  return { ok: false, error: `工具 ${tool.label} 暂无适配器` };
}

function sanitizeMarkdownOutput(text, requiredHeading) {
  let raw = String(text || "").trim();
  if (!raw) return "";

  const fenced = raw.match(/```(?:markdown|md)?\s*\n([\s\S]*?)\n```/i);
  if (fenced && fenced[1]) raw = String(fenced[1]).trim();

  const idx = raw.indexOf(requiredHeading);
  if (idx >= 0) raw = raw.slice(idx).trim();

  const lines = raw
    .split("\n")
    .filter((l) => !String(l).trim().startsWith("```"))
    .map((l) => String(l).replace(/\s+$/g, ""));

  return lines.join("\n").trim();
}

function readNativeMessageStream(onMessage) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) return;
      const payload = buffer.slice(4, 4 + len);
      buffer = buffer.slice(4 + len);
      try {
        const obj = JSON.parse(payload.toString("utf8"));
        onMessage(obj);
      } catch {}
    }
  });
}

function sendNativeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonFromText(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // 1) Try raw parse
  try { return JSON.parse(trimmed); } catch {}
  // 2) Extract code-fenced JSON
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenced && fenced[1]) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  // 3) Brace-matching scan
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === "{") depth++;
      else if (trimmed[i] === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch {}
          break;
        }
      }
    }
  }
  return null;
}

function validateMimoResult(obj, lang) {
  const defaultSay = ht("host.default.say", lang);
  if (!obj || typeof obj !== "object") {
    return { say: defaultSay, play: [], memory: [] };
  }
  const say = typeof obj.say === "string" && obj.say.trim() ? obj.say.trim() : defaultSay;
  let play = [];
  if (Array.isArray(obj.play)) {
    play = obj.play
      .filter((t) => t && typeof t.name === "string" && t.name.trim() && typeof t.artist === "string" && t.artist.trim())
      .map((t) => ({ name: String(t.name).trim(), artist: String(t.artist).trim(), ...(t.album ? { album: String(t.album).trim() } : {}), ...(t.query ? { query: String(t.query).trim() } : {}), ...(t.provider ? { provider: String(t.provider).trim() } : {}) }));
  }
  let memory = [];
  if (Array.isArray(obj.memory)) {
    memory = obj.memory
      .filter((m) => m && typeof m.text === "string" && m.text.trim())
      .map((m) => ({ type: typeof m.type === "string" && m.type.trim() ? m.type.trim() : "taste", text: m.text.trim() }));
  }
  const result = { say, play, memory };
  if (typeof obj.reason === "string" && obj.reason.trim()) result.reason = obj.reason.trim();
  if (typeof obj.segue === "string" && obj.segue.trim()) result.segue = obj.segue.trim();
  if (typeof obj.confirmRecommend === "boolean") result.confirmRecommend = obj.confirmRecommend;
  if (typeof obj.confirmQuestion === "string" && obj.confirmQuestion.trim()) result.confirmQuestion = obj.confirmQuestion.trim();
  return result;
}

function buildSchema() {
  return {
    type: "object",
    properties: {
      say: { type: "string", minLength: 1 },
      reason: { type: "string" },
      confirmRecommend: { type: "boolean" },
      confirmQuestion: { type: "string" },
      play: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            artist: { type: "string" },
            album: { type: "string" },
            provider: { type: "string" },
            query: { type: "string" },
            streamUrl: { type: "string" }
          },
          required: ["name", "artist"]
        }
      },
      segue: { type: "string", description: "电台 DJ 推荐语 / DJ recommendation, 100-200字/words" },
      memory: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { type: "string" },
            text: { type: "string" }
          },
          required: ["type", "text"]
        }
      }
    },
    required: ["say", "play", "memory"]
  };
}

function applyMemory(profileSummary, memory) {
  const lines = (profileSummary || "").split("\n").filter(Boolean);
  const existing = new Set(lines);
  for (const m of memory || []) {
    const type = m && m.type ? String(m.type) : "taste";
    const text = m && m.text ? String(m.text) : "";
    const line = `- [${type}] ${text}`.trim();
    if (!text) continue;
    if (!existing.has(line)) {
      existing.add(line);
      lines.push(line);
    }
  }
  return lines.slice(-200).join("\n");
}

function buildPrompt(input) {
  const djRaw = input.djName ?? "Claudefm";
  let dj = String(djRaw).replace(/\r|\n/g, " ").trim().slice(0, 24);
  if (!dj) dj = "Claudefm";
  const provider = input.provider || "qq";
  const profile = input.profileSummary || "";
  const scene = input.scene || "";
  const force = Boolean(input.forceProfileRefresh);
  const forceRecommend = Boolean(input.forceRecommend);
  const likedTracks = Array.isArray(input.likedTracks) ? input.likedTracks : [];
  const dislikedTracks = Array.isArray(input.dislikedTracks) ? input.dislikedTracks : [];
  const lang = input.lang || "zh";
  const isEn = lang === "en";
  const listFile = readListFile();
  const listMd = listFile && listFile.ok ? String(listFile.content || "") : "";
  const memMd = readMusicMemoryFile();

  const fmtTracks = (items, limit = 20) =>
    items
      .slice(0, limit)
      .map((t) => {
        const name = t && t.name ? String(t.name).trim() : "";
        const artist = t && t.artist ? String(t.artist).trim() : "";
        if (!name || !artist) return "";
        return `- ${name} - ${artist}`;
      })
      .filter(Boolean)
      .join("\n");

  const instructions = [
    ht("host.djRole", lang, {0: dj}),
    ht("host.djTask", lang),
    ht("host.djProvider", lang, {0: provider}),
    ht("host.djJsonSchema", lang),
    ht("host.djSayRequired", lang),
    ht("host.djConfirmHint", lang),
    ht("host.djConfirmWay", lang),
    ht("host.djConfirmNoSay", lang),
    ht("host.djForceRecommend", lang),
    ht("host.djExplicitRecommend", lang),
    ht("host.djNoMusic", lang),
    ht("host.djDislikedConstraint", lang),
    ht("host.djLikedPreference", lang),
    ht("host.djOutputFormat", lang),
    ht("host.djMemoryHint", lang),
    force ? ht("host.djProfileRefresh", lang) : ""
  ].filter(Boolean);

  const empty = ht("host.empty", lang);

  return [
    instructions.join("\n"),
    "",
    isEn ? "[forceRecommend]" : "【forceRecommend】",
    forceRecommend ? "true" : "false",
    "",
    isEn ? "[likedTracks (liked)]" : "【likedTracks（赞）】",
    fmtTracks(likedTracks) || empty,
    "",
    isEn ? "[dislikedTracks (disliked)]" : "【dislikedTracks（踩）】",
    fmtTracks(dislikedTracks) || empty,
    "",
    isEn ? "[Playlist History (list.md summary)]" : "【历史播放歌单（list.md 摘要）】",
    listMd.trim() || empty,
    "",
    isEn ? "[Memory File (music.md summary)]" : "【历史记忆文件（music.md 摘要）】",
    memMd.trim() || empty,
    "",
    isEn ? "[Profile Summary]" : "【画像摘要】",
    profile || empty,
    "",
    isEn ? "[Scene Info]" : "【场景信息】",
    scene || empty,
    "",
    isEn ? "[User Message]" : "【用户消息】",
    input.text || ""
  ].join("\n");
}

function runClaude(prompt, schema) {
  return new Promise((resolve) => {
    const claudePath = findClaudeBinary();
    const args = [
      "--bare",
      "-p",
      prompt,
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema)
    ];
    const env = buildExecEnv();
    const child = spawn(claudePath, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let settled = false;
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve({ ok: false, error: "Claude CLI 响应超时（30s）" });
    }, 30000);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const message = e && e.message ? String(e.message) : String(e);
      resolve({
        ok: false,
        error: `Claude CLI not found or failed to start (${claudePath}): ${message}`
      });
    });
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: err || `claude exited ${code}` });
        return;
      }
      const payload = safeJsonParse(out);
      const structured = payload && payload.structured_output ? payload.structured_output : null;
      if (!structured) {
        resolve({ ok: false, error: "claude output missing structured_output" });
        return;
      }
      resolve({ ok: true, result: structured });
    });
  });
}

const CLAUDE_MAX_RETRIES = 3;
const CLAUDE_RETRY_DELAY_MS = 5000;

async function runClaudeWithRetry(prompt, schema) {
  let lastErr;
  for (let attempt = 0; attempt <= CLAUDE_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.error(`[claude] retry attempt ${attempt}/${CLAUDE_MAX_RETRIES}`);
      await new Promise((r) => setTimeout(r, CLAUDE_RETRY_DELAY_MS));
    }
    const resp = await runClaude(prompt, schema);
    if (resp.ok) return resp;
    lastErr = resp;
    console.error(`[claude] attempt ${attempt + 1} failed: ${resp.error}`);
  }
  return lastErr;
}

let cachedClaudeModelFlag = undefined;
function getClaudeModelFlag() {
  if (cachedClaudeModelFlag !== undefined) return cachedClaudeModelFlag;
  const claudePath = findClaudeBinary();
  try {
    const env = buildExecEnv();
    const res = spawnSync(claudePath, ["--help"], { encoding: "utf8", env });
    const text = `${String(res.stdout || "")}\n${String(res.stderr || "")}`;
    if (text.includes("--model")) {
      cachedClaudeModelFlag = "--model";
      return cachedClaudeModelFlag;
    }
    if (/\s-m[, \t].*model/i.test(text)) {
      cachedClaudeModelFlag = "-m";
      return cachedClaudeModelFlag;
    }
  } catch {}
  cachedClaudeModelFlag = "";
  return cachedClaudeModelFlag;
}

function extractModelStrings(obj, out) {
  if (obj == null) return;
  if (typeof obj === "string") {
    const s = String(obj).trim();
    if (!s) return;
    if (/tts/i.test(s)) {
      out.add(s);
      return;
    }
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s)) {
      out.add(s);
      return;
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v) => extractModelStrings(v, out));
    return;
  }
  if (typeof obj === "object") {
    Object.entries(obj).forEach(([k, v]) => {
      const key = String(k || "").trim().toLowerCase();
      if (
        [
          "model",
          "models",
          "default_model",
          "defaultmodel",
          "tts_model",
          "ttsmodel",
          "speech_model",
          "speechmodel",
        ].includes(key)
      ) {
        extractModelStrings(v, out);
      } else {
        extractModelStrings(v, out);
      }
    });
  }
}

function listConfiguredModels() {
  const home = os.homedir();
  const paths = [
    path.join(home, ".config", "claude", "config.json"),
    path.join(home, ".config", "claude", "settings.json"),
    path.join(home, ".claude", "config.json"),
    path.join(home, ".claude.json"),
  ];
  const found = new Set();
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      extractModelStrings(data, found);
    } catch {}
  }
  const envModel = process.env.CLAUDEFM_TTS_MODEL || process.env.CLAUDE_TTS_MODEL || process.env.TTS_MODEL;
  if (envModel) found.add(String(envModel).trim());
  return Array.from(found).map((m) => String(m).trim()).filter(Boolean).sort();
}

function pickTtsModels() {
  const envModel = process.env.CLAUDEFM_TTS_MODEL || process.env.CLAUDE_TTS_MODEL || process.env.TTS_MODEL;
  const configured = listConfiguredModels();
  const preferred = [];
  if (envModel) preferred.push(String(envModel).trim());
  const exact = "xiaomi/mimo-v2.5-tts";
  if (configured.includes(exact) && !preferred.includes(exact)) preferred.push(exact);
  configured.forEach((m) => {
    if (preferred.includes(m)) return;
    if (/tts/i.test(m)) preferred.push(m);
  });
  configured.forEach((m) => {
    if (preferred.includes(m)) return;
    preferred.push(m);
  });
  return preferred.filter(Boolean);
}

function buildTtsSchema() {
  return {
    type: "object",
    properties: { mime: { type: "string" }, base64: { type: "string" } },
    required: ["mime", "base64"],
  };
}

function buildTtsPrompt(text) {
  let s = String(text || "").trim();
  if (s.length > 520) s = s.slice(0, 520).trimEnd();
  return [
    "你是一个文本转语音（TTS）模型。",
    "请将【输入文本】合成为音频，并只输出 JSON，字段严格遵循 schema：",
    "- mime: 音频 MIME 类型，优先使用 audio/wav（24kHz, mono, 16-bit PCM），也可用 audio/mpeg",
    "- base64: 音频二进制数据的 base64（不要加 data: 前缀，不要换行）",
    "要求：",
    "- 语音为中文普通话，语气自然，适合电台 DJ 口播。",
    "- 禁止输出任何额外说明文字。",
    "",
    "【输入文本】",
    s,
  ].join("\n");
}

function sniffAudioMime(buf) {
  if (!buf || buf.length < 16) return "";
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (buf.slice(0, 3).toString("ascii") === "ID3") return "audio/mpeg";
  if (buf[0] === 0xff && buf[1] === 0xfb) return "audio/mpeg";
  if (buf.slice(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  return "";
}

function decodeAudioBase64(b64) {
  const s = String(b64 || "").replace(/\s+/g, "").trim();
  if (!s) return null;
  try {
    const buf = Buffer.from(s, "base64");
    if (!buf || !buf.length) return null;
    return buf;
  } catch {
    return null;
  }
}

function runClaudeWithOptionalModel(prompt, schema, model) {
  return new Promise((resolve) => {
    const claudePath = findClaudeBinary();
    const args = ["--bare"];
    const modelFlag = getClaudeModelFlag();
    const modelStr = model ? String(model).trim() : "";
    if (modelFlag && modelStr) args.push(modelFlag, modelStr);
    args.push("-p", prompt, "--output-format", "json", "--json-schema", JSON.stringify(schema));
    const env = buildExecEnv();
    const child = spawn(claudePath, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.on("error", (e) => {
      const message = e && e.message ? String(e.message) : String(e);
      resolve({ ok: false, error: `Claude CLI not found or failed to start (${claudePath}): ${message}` });
    });
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: err || `claude exited ${code}` });
        return;
      }
      const payload = safeJsonParse(out);
      const structured = payload && payload.structured_output ? payload.structured_output : null;
      if (!structured) {
        resolve({ ok: false, error: "claude output missing structured_output" });
        return;
      }
      resolve({ ok: true, result: structured });
    });
  });
}

function getCacheFolder() {
  return path.join(getClaudefmFolder(), "cache");
}

function ensureCacheFolders() {
  const base = getCacheFolder();
  const tracks = path.join(base, "tracks");
  const covers = path.join(base, "covers");
  const tts = path.join(base, "tts");
  fs.mkdirSync(tracks, { recursive: true });
  fs.mkdirSync(covers, { recursive: true });
  fs.mkdirSync(tts, { recursive: true });
  return { base, tracks, covers, tts };
}

function sha1Hex(text) {
  return crypto.createHash("sha1").update(String(text || ""), "utf8").digest("hex");
}

function safeJsonLoad(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function safeJsonWrite(p, obj) {
  const folder = path.dirname(p);
  fs.mkdirSync(folder, { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

// ---------------------------------------------------------------------------
// MiMo TTS
// ---------------------------------------------------------------------------

function getTtsConfigPath() {
  return path.join(getClaudefmFolder(), "tts-config.json");
}

function loadTtsConfig() {
  const p = getTtsConfigPath();
  const data = safeJsonLoad(p);
  if (!data || typeof data !== "object") return null;
  const apiKey = String(data.api_key || "").trim();
  if (!apiKey) return null;
  return {
    provider: String(data.provider || "mimo").trim(),
    apiKey,
    endpoint: String(data.endpoint || "https://api.xiaomimimo.com/v1/chat/completions").trim(),
    model: String(data.model || "mimo-v2.5-tts").trim(),
    voice: String(data.voice || "冰糖").trim(),
    style: String(data.style || "").trim(),
  };
}

async function mimoTtsSynthesize(text, config) {
  let s = String(text || "").trim();
  if (!s) return { ok: false, error: "empty text" };
  if (s.length > 2000) s = s.slice(0, 2000);

  const endpoint = config.endpoint || "https://api.xiaomimimo.com/v1/chat/completions";
  const style = config.style || "温柔亲切的电台DJ风格，语速适中，带有感染力";

  const messages = [
    { role: "user", content: style },
    { role: "assistant", content: s },
  ];

  const body = JSON.stringify({
    model: config.model || "mimo-v2.5-tts",
    messages,
    audio: {
      format: "wav",
      voice: config.voice || "冰糖",
    },
  });

  console.error(`[mimo] tts request: endpoint=${endpoint}, voice=${config.voice}, text=${s.slice(0, 40)}...`);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": config.apiKey,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, error: `mimo http ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const result = await resp.json();
    const audioData = result?.choices?.[0]?.message?.audio?.data;
    if (!audioData) {
      return { ok: false, error: "mimo returned no audio data" };
    }

    // MiMo returns wav, convert to mp3-compatible base64 for browser playback
    // Actually browser Audio can play wav directly, so just return it
    console.error(`[mimo] tts success: audio base64 length=${audioData.length}`);
    return { ok: true, audio: { mime: "audio/wav", base64: audioData } };
  } catch (e) {
    return { ok: false, error: `mimo request failed: ${e.message || e}` };
  }
}

async function runMiMoChat(prompt, schema, lang) {
  const config = loadTtsConfig();
  if (!config || !config.apiKey) {
    return { ok: false, error: ht("host.error.cloudUnavailable", lang) };
  }

  const model = "mimo-v2-flash";
  const endpoint = config.endpoint || "https://api.xiaomimimo.com/v1/chat/completions";

  const isEn = lang === "en";
  const systemPrompt = [
    ht("host.mimo.systemPrompt", lang),
    "JSON schema: {",
    '  "say": "' + (isEn ? "string (required, brief DJ response)" : "string (必须，简短的DJ口吻回应)") + '",',
    '  "reason": "' + (isEn ? "string (optional, recommendation reason)" : "string (可选，推荐理由)") + '",',
    '  "confirmRecommend": "boolean (' + (isEn ? "optional" : "可选") + ')",',
    '  "confirmQuestion": "' + (isEn ? "string (optional, confirmation question)" : "string (可选，确认提问)") + '",',
    '  "play": [{"name":"string","artist":"string","album":"string?","query":"string?","provider":"string?"}] (' + (isEn ? "3-5 songs" : "3-5首歌") + '),',
    '  "segue": "string (' + (isEn ? "optional, 100-200 word DJ recommendation" : "可选，100-200字DJ推荐语") + ')",',
    '  "memory": [{"type":"string","text":"string"}] (' + (isEn ? "1-3 preference memories" : "1-3条偏好记忆") + ')',
    "}",
    ht("host.mimo.requiredFields", lang),
  ].join("\n");

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  const body = JSON.stringify({ model, messages, temperature: 0.7 });

  console.error(`[mimo] chat request: endpoint=${endpoint}, model=${model}, text=${prompt.slice(0, 60)}...`);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": config.apiKey,
      },
      body,
      signal: AbortSignal.timeout(60000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return { ok: false, error: `MiMo API error ${resp.status}: ${errText.slice(0, 200)}` };
    }

    const result = await resp.json();
    const raw = result?.choices?.[0]?.message?.content;
    if (!raw) {
      return { ok: false, error: "MiMo returned empty response" };
    }

    console.error(`[mimo] chat raw response: ${raw.slice(0, 200)}...`);
    const parsed = extractJsonFromText(raw);
    if (!parsed) {
      return { ok: false, error: "MiMo response was not valid JSON", rawResponse: raw.slice(0, 500) };
    }

    const structured = validateMimoResult(parsed, lang);
    console.error(`[mimo] chat success: say=${structured.say.slice(0, 40)}, play=${structured.play.length}`);
    return { ok: true, result: structured };
  } catch (e) {
    return { ok: false, error: `MiMo chat request failed: ${e.message || e}` };
  }
}

function getTtsCachePath(text) {
  const folders = ensureCacheFolders();
  return path.join(folders.tts, `${sha1Hex(text)}.mp3`);
}

function cacheTtsAudio(text, audioB64) {
  const p = getTtsCachePath(text);
  try {
    const buf = Buffer.from(audioB64, "base64");
    if (buf.length > 4 * 1024 * 1024) return { ok: false, error: "audio too large" };
    fs.writeFileSync(p, buf);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function getCachedTts(text) {
  const p = getTtsCachePath(text);
  if (!fs.existsSync(p)) return { ok: true, hit: false };
  try {
    const size = fs.statSync(p).size;
    if (size <= 0 || size > 4 * 1024 * 1024) return { ok: true, hit: false };
    const buf = fs.readFileSync(p);
    const b64 = buf.toString("base64");
    // Detect format: WAV starts with "RIFF", MP3 starts with "ID3" or sync word 0xFF
    const isWav = buf.length > 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
    const mime = isWav ? "audio/wav" : "audio/mpeg";
    return { ok: true, hit: true, audio: { mime, base64: b64 }, path: p };
  } catch {
    return { ok: true, hit: false };
  }
}

let mediaServerPort = 0;
let mediaServerStarting = null;

function ensureMediaServer() {
  if (mediaServerPort) return Promise.resolve(mediaServerPort);
  if (mediaServerStarting) return mediaServerStarting;
  mediaServerStarting = new Promise((resolve) => {
    try {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1`);
        const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
        if (req.method === "OPTIONS") { res.writeHead(204, corsHeaders); res.end(); return; }

        if (url.pathname.startsWith("/tts/")) {
          const hash = url.pathname.replace(/^\/tts\//, "").replace(/[^a-f0-9]/gi, "");
          if (!hash) { res.writeHead(404); res.end(); return; }
          const folders = ensureCacheFolders();
          const filePath = path.join(folders.tts, `${hash}.mp3`);
          if (!fs.existsSync(filePath)) { res.writeHead(404); res.end(); return; }
          try {
            const buf = fs.readFileSync(filePath);
            const isWav = buf.length > 4 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46;
            res.writeHead(200, { ...corsHeaders, "Content-Type": isWav ? "audio/wav" : "audio/mpeg", "Content-Length": buf.length });
            res.end(buf);
          } catch { res.writeHead(500); res.end(); }
          return;
        }

        if (url.pathname.startsWith("/cover/")) {
          const id = url.pathname.replace(/^\/cover\//, "").replace(/[^a-f0-9]/gi, "");
          if (!id) { res.writeHead(404); res.end(); return; }
          const folders = ensureCacheFolders();
          const files = fs.readdirSync(folders.covers).filter((f) => f.startsWith(id));
          const coverFile = files[0];
          if (!coverFile) { res.writeHead(404); res.end(); return; }
          const filePath = path.join(folders.covers, coverFile);
          try {
            const buf = fs.readFileSync(filePath);
            const ext = coverFile.split(".").pop().toLowerCase();
            const ct = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
            res.writeHead(200, { ...corsHeaders, "Content-Type": ct, "Content-Length": buf.length, "Cache-Control": "public, max-age=86400" });
            res.end(buf);
          } catch { res.writeHead(500); res.end(); }
          return;
        }

        res.writeHead(404); res.end();
      });
      server.listen(0, "127.0.0.1", () => {
        mediaServerPort = server.address().port;
        console.error(`[media] server listening on 127.0.0.1:${mediaServerPort}`);
        resolve(mediaServerPort);
      });
    } catch (e) {
      console.error(`[media] failed to start server: ${e.message}`);
      mediaServerStarting = null;
      resolve(0);
    }
  });
  return mediaServerStarting;
}

async function getMediaServerUrl(path) {
  const port = await ensureMediaServer();
  if (!port) return "";
  return `http://127.0.0.1:${port}${path}`;
}

function normalizeTrackKey(name, artist) {
  const strip = (v) =>
    String(v || "")
      .toLowerCase()
      .trim()
      .replace(/[\s\-_–—·•、，,。.!！?？'"“”"‘’()（）【】[\]{}<>《》:：;；/\\|]+/g, "");
  return `${strip(name)}|${strip(artist)}`;
}

function guessCoverExt(contentType, url) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  const u = String(url || "").toLowerCase();
  for (const ext of [".jpg", ".jpeg", ".png", ".webp", ".gif"]) {
    if (u.endsWith(ext)) return ext === ".jpeg" ? ".jpg" : ext;
  }
  return ".jpg";
}

async function downloadCoverToPath(url, outPath, timeoutMs = 8000) {
  const u = String(url || "").trim();
  if (!u || !(u.startsWith("http://") || u.startsWith("https://"))) return { ok: false, error: "invalid cover url" };
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(u, { headers: { "user-agent": "ClaudefmHost/1.0" }, signal: controller.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, error: `http ${resp.status}` };
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) return { ok: false, error: "empty cover data" };
    if (buf.length > 900 * 1024) return { ok: false, error: "cover too large" };
    const ct = resp.headers.get("content-type") || "";
    const ext = guessCoverExt(ct, u);
    const finalPath = outPath.endsWith(ext) ? outPath : `${path.parse(outPath).name}${ext}`;
    const finalAbs = path.isAbsolute(finalPath) ? finalPath : path.join(path.dirname(outPath), finalPath);
    fs.writeFileSync(finalAbs, buf);
    return { ok: true, path: finalAbs, contentType: ct };
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    return { ok: false, error: message };
  }
}

function fileToDataUrl(p, contentTypeHint = "") {
  try {
    if (!fs.existsSync(p)) return "";
    const stat = fs.statSync(p);
    if (!stat.isFile()) return "";
    if (stat.size <= 0 || stat.size > 700 * 1024) return "";
    const buf = fs.readFileSync(p);
    const b64 = buf.toString("base64");
    let ct = String(contentTypeHint || "").trim().toLowerCase();
    if (!ct) {
      const lower = String(p).toLowerCase();
      if (lower.endsWith(".png")) ct = "image/png";
      else if (lower.endsWith(".webp")) ct = "image/webp";
      else if (lower.endsWith(".gif")) ct = "image/gif";
      else ct = "image/jpeg";
    }
    return `data:${ct};base64,${b64}`;
  } catch {
    return "";
  }
}

async function cacheTrackEntry(track, resolved) {
  const name = track && track.name ? String(track.name).trim() : "";
  const artist = track && track.artist ? String(track.artist).trim() : "";
  if (!name || !artist) return { ok: false, error: "missing name/artist" };
  const streamUrl = resolved && resolved.streamUrl ? String(resolved.streamUrl).trim() : "";
  if (!streamUrl) return { ok: false, error: "missing streamUrl" };

  const cover = resolved && resolved.cover ? String(resolved.cover).trim() : "";
  const durationMs = resolved && resolved.durationMs ? Number(resolved.durationMs) : 0;
  const provider = resolved && resolved.provider ? String(resolved.provider).trim() : "cached";
  const folders = ensureCacheFolders();
  const key = normalizeTrackKey(name, artist);
  const id = sha1Hex(key);
  const indexPath = path.join(folders.base, "index.json");
  const metaPath = path.join(folders.tracks, `${id}.json`);

  const index = safeJsonLoad(indexPath);
  const nextIndex = index && typeof index === "object" ? index : {};
  const existing = safeJsonLoad(metaPath);

  const entry = {
    name,
    artist,
    key,
    id,
    provider,
    streamUrl,
    cover,
    durationMs: Number.isFinite(durationMs) ? Math.floor(durationMs) : 0,
    updatedAt: new Date().toISOString().slice(0, 19),
    coverPath: existing && existing.coverPath ? String(existing.coverPath) : "",
    coverContentType: existing && existing.coverContentType ? String(existing.coverContentType) : "",
  };

  if (cover && !entry.coverPath) {
    const coverOut = path.join(folders.covers, `${id}.img`);
    const dl = await downloadCoverToPath(cover, coverOut, 6000);
    if (dl.ok) {
      entry.coverPath = dl.path || "";
      entry.coverContentType = dl.contentType || "";
    }
  }

  safeJsonWrite(metaPath, entry);
  nextIndex[key] = { id, metaPath, updatedAt: entry.updatedAt };
  safeJsonWrite(indexPath, nextIndex);
  return { ok: true, key, id, metaPath, coverPath: entry.coverPath || "" };
}

function getCachedTrackEntry(track) {
  const name = track && track.name ? String(track.name).trim() : "";
  const artist = track && track.artist ? String(track.artist).trim() : "";
  if (!name || !artist) return { ok: true, hit: false };
  const key = normalizeTrackKey(name, artist);
  const folders = ensureCacheFolders();
  const indexPath = path.join(folders.base, "index.json");
  const index = safeJsonLoad(indexPath);
  if (!index || typeof index !== "object") return { ok: true, hit: false };
  const ref = index[key];
  if (!ref || typeof ref !== "object") return { ok: true, hit: false };
  const meta = safeJsonLoad(ref.metaPath || "");
  if (!meta || typeof meta !== "object") return { ok: true, hit: false };
  const coverDataUrl = meta.coverPath ? fileToDataUrl(String(meta.coverPath), String(meta.coverContentType || "")) : "";
  return {
    ok: true,
    hit: true,
    resolved: {
      provider: meta.provider || "cached",
      track: { name: meta.name || "", artist: meta.artist || "" },
      streamUrl: meta.streamUrl || "",
      cover: coverDataUrl || meta.cover || "",
      durationMs: meta.durationMs || 0,
      cacheHit: true,
    },
  };
}

function invalidateCacheEntry(track) {
  const name = track && track.name ? String(track.name).trim() : "";
  const artist = track && track.artist ? String(track.artist).trim() : "";
  if (!name || !artist) return { ok: false, error: "missing name/artist" };
  const key = normalizeTrackKey(name, artist);
  const folders = ensureCacheFolders();
  const indexPath = path.join(folders.base, "index.json");
  const index = safeJsonLoad(indexPath);
  if (!index || typeof index !== "object") return { ok: true, removed: false };
  const ref = index[key];
  if (!ref) return { ok: true, removed: false };
  try {
    const metaPath = ref.metaPath || path.join(folders.tracks, `${ref.id}.json`);
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
  } catch {}
  delete index[key];
  safeJsonWrite(indexPath, index);
  return { ok: true, removed: true };
}

async function getCachedCoverUrls(tracks) {
  const folders = ensureCacheFolders();
  const result = {};
  const port = mediaServerPort || (await ensureMediaServer());
  if (!port) return { ok: false, error: "media server not running" };

  const indexPath = path.join(folders.base, "index.json");
  const index = safeJsonLoad(indexPath);
  const coverFiles = new Set(fs.readdirSync(folders.covers));

  for (const t of tracks) {
    const name = t?.name ? String(t.name).trim() : "";
    const artist = t?.artist ? String(t.artist).trim() : "";
    if (!name || !artist) continue;
    const key = normalizeTrackKey(name, artist);
    const id = sha1Hex(key);

    if (index && typeof index === "object" && index[key]) {
      const ref = index[key];
      const meta = ref.metaPath ? safeJsonLoad(ref.metaPath) : null;
      if (meta?.coverPath && fs.existsSync(String(meta.coverPath))) {
        result[key] = `http://127.0.0.1:${port}/cover/${id}`;
        continue;
      }
    }

    const match = [...coverFiles].find((f) => f.startsWith(id));
    if (match) {
      result[key] = `http://127.0.0.1:${port}/cover/${id}`;
    }
  }
  return { ok: true, covers: result };
}

async function cleanupExpiredCache() {
  const folders = ensureCacheFolders();
  const indexPath = path.join(folders.base, "index.json");
  const index = safeJsonLoad(indexPath);
  if (!index || typeof index !== "object") return { ok: true, cleaned: 0 };

  let cleaned = 0;
  const keys = Object.keys(index);
  for (const key of keys) {
    const ref = index[key];
    if (!ref || typeof ref !== "object") continue;
    const metaPath = ref.metaPath || path.join(folders.tracks, `${ref.id}.json`);
    const meta = safeJsonLoad(metaPath);
    if (!meta) {
      delete index[key];
      cleaned++;
      continue;
    }
    const streamUrl = meta.streamUrl || "";
    if (!streamUrl) {
      try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}
      delete index[key];
      cleaned++;
    }
  }
  if (cleaned > 0) safeJsonWrite(indexPath, index);
  return { ok: true, cleaned };
}

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`http ${resp.status}`);
  return await resp.json();
}

function normalizeLyricsText(text, maxChars = 2200) {
  let s = String(text || "").trim();
  if (!s) return "";
  s = s.replace(/\r\n|\r/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  if (maxChars && s.length > maxChars) s = s.slice(0, maxChars).trimEnd();
  return s;
}

async function fetchLyricsLrclib(trackName, artistName) {
  const name = String(trackName || "").trim();
  const artist = String(artistName || "").trim();
  if (!name || !artist) return "";
  const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(name)}&artist_name=${encodeURIComponent(artist)}`;
  try {
    const payload = await fetchJson(url, { headers: { accept: "application/json", "User-Agent": "ClaudefmHost/1.0" } });
    if (!payload || typeof payload !== "object") return "";
    const lyrics = payload.plainLyrics || payload.syncedLyrics || "";
    return normalizeLyricsText(lyrics, 2200);
  } catch {
    return "";
  }
}

async function fetchLyricsLyricsOvh(trackName, artistName) {
  const name = String(trackName || "").trim();
  const artist = String(artistName || "").trim();
  if (!name || !artist) return "";
  const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(name)}`;
  try {
    const payload = await fetchJson(url, { headers: { accept: "application/json", "User-Agent": "ClaudefmHost/1.0" } });
    if (!payload || typeof payload !== "object") return "";
    return normalizeLyricsText(payload.lyrics || "", 2200);
  } catch {
    return "";
  }
}

async function fetchLyricsForTrack(track) {
  const name = track && typeof track === "object" ? String(track.name || "").trim() : "";
  const artist = track && typeof track === "object" ? String(track.artist || "").trim() : "";
  if (!name || !artist) return "";
  const a = await fetchLyricsLrclib(name, artist);
  if (a) return a;
  return await fetchLyricsLyricsOvh(name, artist);
}

function buildLyricInterludePrompt(input, tracksWithLyrics) {
  const djRaw = input && typeof input === "object" ? input.djName ?? "Claudefm" : "Claudefm";
  const dj = String(djRaw).replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudefm";
  const profile = input && typeof input === "object" ? String(input.profileSummary || "") : "";
  const lang = input && typeof input === "object" ? (input.lang || "zh") : "zh";
  const isEn = lang === "en";

  const blocks = [];
  tracksWithLyrics.forEach((t, i) => {
    const name = String(t?.name || "").trim();
    const artist = String(t?.artist || "").trim();
    const lyrics = normalizeLyricsText(t?.lyrics || "", 1200);
    if (!name || !artist || !lyrics) return;
    blocks.push(`### ${i + 1}. ${name} - ${artist}\n${lyrics}`);
  });

  const instructions = [
    ht("host.interlude.role", lang, {0: dj}),
    ht("host.interlude.task", lang),
    isEn ? "Requirements:" : "要求：",
    `- ${ht("host.interlude.req1", lang)}`,
    `- ${ht("host.interlude.req2", lang)}`,
    `- ${ht("host.interlude.req3", lang)}`,
    `- ${ht("host.interlude.req4", lang)}`,
    `- ${ht("host.interlude.req5", lang)}`
  ];

  const empty = ht("host.empty", lang);

  return [
    instructions.join("\n"),
    "",
    isEn ? "[Profile Summary]" : "【画像摘要】",
    profile || empty,
    "",
    isEn ? "[Lyrics This Segment]" : "【本段歌词】",
    blocks.length ? blocks.join("\n\n") : empty
  ].join("\n");
}

function weatherCodeToZh(code) {
  return weatherCodeToLabel(code, "zh");
}

function getTimeSegment(date = new Date()) {
  return getLangTimeSegment(date, "zh");
}

function readMusicMemoryFile(maxChars = 6000) {
  try {
    const filePath = getMusicFilePath();
    if (!fs.existsSync(filePath)) return "";
    const content = String(fs.readFileSync(filePath, "utf8") || "").trim();
    if (!content) return "";
    return content.slice(-maxChars);
  } catch {
    return "";
  }
}

async function getLocationName(latitude, longitude) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(String(latitude))}&lon=${encodeURIComponent(String(longitude))}`;
    const data = await fetchJson(url, { headers: { "User-Agent": "Claudefm/0.0.1" } });
    const address = data && data.address ? data.address : null;
    if (address && typeof address === "object") {
      for (const key of ["city", "town", "village", "municipality", "county", "state"]) {
        const v = address[key];
        if (v) return String(v);
      }
    }
    return data && data.name ? String(data.name) : "";
  } catch {
    return "";
  }
}

async function getWeather(latitude, longitude) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(String(latitude))}&longitude=${encodeURIComponent(String(longitude))}&current_weather=true&timezone=auto`;
    const data = await fetchJson(url, { headers: { "User-Agent": "Claudefm/0.0.1" } });
    const cw = data && data.current_weather ? data.current_weather : null;
    if (!cw || typeof cw !== "object") return null;
    return { temperature: cw.temperature, windspeed: cw.windspeed, weathercode: cw.weathercode };
  } catch {
    return null;
  }
}

async function buildWelcomeScene(latitude, longitude, profileSummary, lang) {
  const isEn = lang === "en";
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const timeSeg = getLangTimeSegment(now, lang);
  const pieces = [ht("host.scene.date", lang, {0: dateStr, 1: timeSeg})];

  const lat = Number(latitude);
  const lon = Number(longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

  let location = "";
  let weather = null;
  if (hasCoords) {
    location = await getLocationName(lat, lon);
    weather = await getWeather(lat, lon);
  }

  const empty = ht("host.empty", lang);

  if (location) pieces.push(ht("host.scene.location", lang, {0: location}));
  if (weather) {
    const desc = weatherCodeToLabel(weather.weathercode, lang);
    const t = weather.temperature;
    const w = weather.windspeed;
    let wx = isEn ? "weather info" : "天气信息";
    if (desc && Number.isFinite(Number(t))) wx = `${desc}, ${t}℃`;
    else if (desc) wx = desc;
    else if (Number.isFinite(Number(t))) wx = `${t}℃`;
    if (Number.isFinite(Number(w))) wx = isEn ? ht("host.weather.wind", lang, {0: wx, 1: w}) : `${wx}，风速 ${w}`;
    pieces.push(ht("host.scene.weather", lang, {0: wx}));
  }

  const memFile = readMusicMemoryFile();
  const lines = [];
  lines.push(pieces.join(isEn ? "; " : "；"));
  lines.push("");
  lines.push(isEn ? "[History Memory (profileSummary)]" : "【历史记忆（profileSummary）】");
  lines.push(String(profileSummary || "").trim() || empty);
  if (memFile) {
    lines.push("");
    lines.push(isEn ? "[History Memory File (music.md summary)]" : "【历史记忆文件（music.md 摘要）】");
    lines.push(memFile);
  }
  return lines.join("\n").trim();
}

function appendDailyConversation(input) {
  const folder = getClaudefmFolder();
  fs.mkdirSync(folder, { recursive: true });
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateKey = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const timeStr = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const filePath = path.join(folder, `${dateKey}_music_memory.md`);

  const kind = input && input.kind ? String(input.kind) : "chat";
  const userText = input && input.userText ? String(input.userText).trim() : "";
  const result = input && input.result && typeof input.result === "object" ? input.result : {};
  const say = result.say ? String(result.say).trim() : "";
  const reason = result.reason ? String(result.reason).trim() : "";
  const assistantText = [say, reason].filter(Boolean).join("\n\n") || "(空)";

  const tracks = [];
  if (Array.isArray(result.play)) {
    for (const t of result.play) {
      if (!t || typeof t !== "object") continue;
      const name = t.name ? String(t.name).trim() : "";
      const artist = t.artist ? String(t.artist).trim() : "";
      const title = [name, artist].filter(Boolean).join(" - ").trim();
      tracks.push(title || "未知歌曲");
    }
  }

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# ${dateKey} Music Memory\n\n`, "utf8");
  }

  const lines = [];
  lines.push(`## ${timeStr}`);
  lines.push(`- type: ${kind}`);
  if (userText) {
    lines.push("", "### user", userText);
  }
  lines.push("", "### assistant", assistantText);
  if (tracks.length) {
    lines.push("", "### playlist");
    tracks.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  lines.push("");

  fs.appendFileSync(filePath, lines.join("\n"), "utf8");
  return { ok: true, path: filePath };
}

function readMemoryFile() {
  const filePath = getMusicFilePath();
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `file not found: ${filePath}` };
  }
  const content = String(fs.readFileSync(filePath, "utf8") || "");
  const maxChars = 20000;
  const sliced = content.length > maxChars ? content.slice(-maxChars) : content;
  return { ok: true, path: filePath, content: sliced };
}

function ensureListFile(lang) {
  const folder = getClaudefmFolder();
  const filePath = getListFilePath();
  if (fs.existsSync(filePath)) return { ok: true, path: filePath, created: false };
  fs.mkdirSync(folder, { recursive: true });
  const header = ht("host.list.header", lang) + "\n\n";
  fs.writeFileSync(filePath, header, "utf8");
  return { ok: true, path: filePath, created: true };
}

function readListFile() {
  const ensured = ensureListFile();
  if (!ensured.ok) return ensured;
  const filePath = ensured.path;
  const content = String(fs.readFileSync(filePath, "utf8") || "");
  const maxChars = 20000;
  const sliced = content.length > maxChars ? content.slice(0, maxChars) : content;
  return { ok: true, path: filePath, content: sliced, created: Boolean(ensured.created) };
}

function normalizeTrackKey(name, artist) {
  const n = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_–—·•、，,。.!！?？'"“”"‘’()（）【】[\]{}<>《》:：;；/\\|]+/g, "");
  const a = String(artist || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_–—·•、，,。.!！?？'"“”"‘’()（）【】[\]{}<>《》:：;；/\\|]+/g, "");
  return `${n}|${a}`;
}

function parseTracksLoose(text, maxTracks = 8000) {
  const tracks = [];
  const raw = String(text || "");
  if (!raw.trim()) return tracks;
  const lines = raw.split(/\r?\n/g);
  const patterns = [
    /^\s*-\s*(.+?)\s*[-–—]\s*(.+?)\s*$/u,
    /^\s*\d+[.、】【、)]\s*(.+?)\s*[-–—]\s*(.+?)\s*$/u,
    /^\s*[“”"](.+?)[“”"]\s*[-–—]\s*[“”"](.+?)[“”"]\s*$/u,
    /^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/u,
    /^\s*([^,\t|]+?)\s*[,|\t]\s*([^,\t|]+?)\s*$/u
  ];
  for (const rawLine of lines) {
    const line = String(rawLine || "").trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    let hit = null;
    for (const re of patterns) {
      const m = line.match(re);
      if (!m) continue;
      const name = String(m[1] || "").trim();
      const artist = String(m[2] || "").trim();
      if (!name || !artist) continue;
      if (["歌曲", "歌手", "name", "artist", "title"].includes(name)) continue;
      hit = { name, artist };
      break;
    }
    if (!hit) {
      const parts = line
        .split(/[,\t|]+/g)
        .map((p) => String(p || "").trim())
        .filter(Boolean);
      if (parts.length >= 2 && !["歌曲", "歌手", "name", "artist", "title"].includes(parts[0])) {
        hit = { name: parts[0], artist: parts[1] };
      }
    }
    if (hit) tracks.push(hit);
    if (tracks.length >= maxTracks) break;
  }
  return tracks;
}

function importListTracks(input) {
  const ensured = ensureListFile();
  if (!ensured.ok) return ensured;
  const filePath = ensured.path;
  let existing = "";
  try {
    existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  } catch {
    existing = "";
  }

  const existingTracks = parseTracksLoose(existing, 8000);
  const seen = new Set(existingTracks.map((t) => normalizeTrackKey(t.name, t.artist)));
  const incoming = Array.isArray(input && input.tracks ? input.tracks : null) ? input.tracks : [];

  const toAdd = [];
  let skipped = 0;
  for (const t of incoming) {
    if (!t || typeof t !== "object") {
      skipped += 1;
      continue;
    }
    const name = String(t.name || "").trim();
    const artist = String(t.artist || "").trim();
    if (!name || !artist) {
      skipped += 1;
      continue;
    }
    const key = normalizeTrackKey(name, artist);
    if (!key || seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    toAdd.push({ name, artist });
  }

  let added = 0;
  if (toAdd.length) {
    const parts = [];
    if (existing && !existing.endsWith("\n")) parts.push("\n");
    toAdd.forEach((t) => {
      parts.push(`- ${t.name} - ${t.artist}\n`);
      added += 1;
    });
    fs.appendFileSync(filePath, parts.join(""), "utf8");
  }

  return { ok: true, path: filePath, added, skipped, total: existingTracks.length + added };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatTimestamp(date = new Date()) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function buildListSection(tracks, stamp, kind, globalSeen) {
  const rows = [];
  const seen = new Set();
  const global = globalSeen instanceof Set ? globalSeen : new Set();
  const incoming = Array.isArray(tracks) ? tracks : [];
  for (const t of incoming) {
    if (!t || typeof t !== "object") continue;
    const name = String(t.name || "").trim();
    const artist = String(t.artist || "").trim();
    if (!name || !artist) continue;
    const key = normalizeTrackKey(name, artist);
    if (!key || seen.has(key) || global.has(key)) continue;
    seen.add(key);
    global.add(key);
    rows.push(`- ${name} - ${artist}`);
  }
  if (!rows.length) return "";
  const k = String(kind || "").trim().toLowerCase();
  const parts = [`## ${stamp}`];
  if (k) parts.push(`> kind: ${k}`);
  parts.push("", ...rows, "", "");
  return parts.join("\n");
}

function prependListSection(input) {
  const ensured = ensureListFile();
  if (!ensured.ok) return ensured;
  const filePath = ensured.path;
  const stamp = formatTimestamp(new Date());

  let existing = "";
  try {
    existing = fs.existsSync(filePath) ? String(fs.readFileSync(filePath, "utf8") || "") : "";
  } catch {
    existing = "";
  }

  const existingTracks = parseTracksLoose(existing, 50000);
  const globalSeen = new Set(existingTracks.map((t) => normalizeTrackKey(t.name, t.artist)));

  const kind = input && input.kind ? String(input.kind) : "";
  const section = buildListSection(input && input.tracks ? input.tracks : [], stamp, kind, globalSeen);
  if (!section) return { ok: true, path: filePath, skipped: true };

  let headerEnd = 0;
  if (existing.startsWith("#")) {
    const firstNewline = existing.indexOf("\n");
    headerEnd = firstNewline === -1 ? existing.length : firstNewline + 1;
    while (headerEnd < existing.length && (existing[headerEnd] === "\n" || existing[headerEnd] === "\r")) headerEnd += 1;
  }

  const nextContent = existing.slice(0, headerEnd) + section + existing.slice(headerEnd);
  try {
    fs.writeFileSync(filePath, nextContent, "utf8");
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    return { ok: false, error: `write failed: ${message}` };
  }

  return { ok: true, path: filePath, inserted: true, stamp, kind };
}

function ensureMusicFile(input) {
  const lang = input && input.lang ? String(input.lang) : "zh";
  const templatePath = resolveTemplatePath(input && input.templatePath ? String(input.templatePath) : "", lang);
  const folder = getClaudefmFolder();
  const filePath = getMusicFilePath();
  if (fs.existsSync(filePath)) return { ok: true, path: filePath, created: false };
  if (!templatePath || !fs.existsSync(templatePath)) {
    return { ok: false, error: `template not found: ${templatePath}` };
  }
  fs.mkdirSync(folder, { recursive: true });
  const template = String(fs.readFileSync(templatePath, "utf8") || "").trimEnd();
  fs.writeFileSync(filePath, template + "\n", "utf8");
  return { ok: true, path: filePath, created: true };
}

function exportMemoryMd(input) {
  const djRaw = input && input.djName ? String(input.djName) : "Claudefm";
  const dj = djRaw.replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudefm";
  const summary = input && input.profileSummary ? String(input.profileSummary).trim() : "";
  const folder = getClaudefmFolder();
  const filePath = getMusicFilePath();
  fs.mkdirSync(folder, { recursive: true });

  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;

  const lines = [];
  lines.push("# Claudefm Memory", "", `- DJ: ${dj}`, `- Exported: ${stamp}`, "", "## Profile Summary", "");
  if (summary) {
    for (const line of summary.split("\n")) lines.push(`> ${line}`);
  } else {
    lines.push("> (空)");
  }
  lines.push("");
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return { ok: true, path: filePath };
}

function optimizeMemoryFile(input) {
  const djRaw = input && input.djName ? String(input.djName) : "Claudefm";
  const dj = djRaw.replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudefm";
  const summary = input && input.profileSummary ? String(input.profileSummary).trim() : "";
  const lang = input && input.lang ? String(input.lang) : "zh";
  const isEn = lang === "en";
  const templatePath = resolveTemplatePath(input && input.templatePath ? String(input.templatePath) : "", lang);
  if (!templatePath || !fs.existsSync(templatePath)) {
    return Promise.resolve({ ok: false, error: ht("host.error.templateNotFound", lang, {0: templatePath}) });
  }

  const folder = getClaudefmFolder();
  const filePath = getMusicFilePath();
  fs.mkdirSync(folder, { recursive: true });

  let template = "";
  try {
    template = fs.readFileSync(templatePath, "utf8");
  } catch (e) {
    const message = e && e.message ? String(e.message) : String(e);
    return Promise.resolve({ ok: false, error: `read template failed: ${message}` });
  }

  let existing = "";
  try {
    if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, "utf8");
  } catch {
    existing = "";
  }

  const empty = ht("host.empty", lang);
  const prompt = [
    ht("host.memory.role", lang),
    ht("host.memory.req1", lang),
    ht("host.memory.req2", lang),
    ht("host.memory.req3", lang),
    ht("host.memory.req4", lang),
    ht("host.memory.dj", lang, {0: dj}),
    "",
    ht("host.memory.section.template", lang),
    template,
    "",
    ht("host.memory.section.existing", lang),
    (existing || "").trim() || empty,
    "",
    ht("host.memory.section.profile", lang),
    summary || empty,
    "",
    ht("host.memory.start", lang),
  ].join("\n");

  const claudePath = findClaudeBinary();
  const args = ["--bare", "-p", prompt];
  const env = buildExecEnv();

  const zhHeading = ht("host.heading.zh", lang);
  const enHeading = ht("host.heading.en", lang);

  return new Promise((resolve) => {
    const child = spawn(claudePath, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.on("error", (e) => {
      const message = e && e.message ? String(e.message) : String(e);
      resolve({ ok: false, error: ht("host.error.claudeNotFound", lang, {0: claudePath, 1: message}) });
    });
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: err || `claude exited ${code}` });
        return;
      }
      const mdZh = sanitizeMarkdownOutput(out || "", zhHeading);
      const mdEn = sanitizeMarkdownOutput(out || "", enHeading);
      const md = mdZh || mdEn;
      if (!md) {
        resolve({ ok: false, error: "empty output from claude" });
        return;
      }
      if (!md.startsWith(zhHeading) && !md.startsWith(enHeading)) {
        resolve({ ok: false, error: "output does not follow template heading" });
        return;
      }
      try {
        fs.writeFileSync(filePath, md + "\n", "utf8");
        resolve({ ok: true, path: filePath });
      } catch (e) {
        const message = e && e.message ? String(e.message) : String(e);
        resolve({ ok: false, error: `write failed: ${message}` });
      }
    });
  });
}

readNativeMessageStream(async (msg) => {
  try {
    if (!msg || typeof msg !== "object") return;
    const msgLang = msg.lang || "zh";
    if (msg.type === "cacheTrack") {
      const track = msg.track && typeof msg.track === "object" ? msg.track : {};
      const resolved = msg.resolved && typeof msg.resolved === "object" ? msg.resolved : {};
      const res = await cacheTrackEntry(track, resolved);
      sendNativeMessage(res);
      return;
    }
    if (msg.type === "getCachedTrack") {
      const track = msg.track && typeof msg.track === "object" ? msg.track : {};
      const res = getCachedTrackEntry(track);
      sendNativeMessage(res);
      return;
    }
    if (msg.type === "invalidateCache") {
      const track = msg.track && typeof msg.track === "object" ? msg.track : {};
      const res = invalidateCacheEntry(track);
      sendNativeMessage(res);
      return;
    }
    if (msg.type === "getCachedCoverUrls") {
      const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
      const res = await getCachedCoverUrls(tracks);
      sendNativeMessage(res);
      return;
    }
    if (msg.type === "cleanupExpiredCache") {
      const res = await cleanupExpiredCache();
      sendNativeMessage(res);
      return;
    }
    if (msg.type === "exportMemoryMd") {
      sendNativeMessage(exportMemoryMd(msg));
      return;
    }
    if (msg.type === "optimizeMemoryFile") {
      const res = await optimizeMemoryFile(msg);
      sendNativeMessage(res);
      return;
    }
    if (msg.type === "appendDailyConversation") {
      sendNativeMessage(appendDailyConversation(msg));
      return;
    }
    if (msg.type === "readMemoryFile") {
      sendNativeMessage(readMemoryFile());
      return;
    }
    if (msg.type === "readListFile") {
      sendNativeMessage(readListFile());
      return;
    }
    if (msg.type === "importListTracks") {
      sendNativeMessage(importListTracks(msg));
      return;
    }
    if (msg.type === "prependListSection") {
      sendNativeMessage(prependListSection(msg));
      return;
    }
    if (msg.type === "ensureMusicFile") {
      sendNativeMessage(ensureMusicFile(msg));
      return;
    }
    if (msg.type === "lyricInterlude") {
      const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
      const cleaned = [];
      for (const t of tracks) {
        if (!t || typeof t !== "object") continue;
        const name = String(t.name || "").trim();
        const artist = String(t.artist || "").trim();
        if (!name || !artist) continue;
        cleaned.push({ name, artist });
        if (cleaned.length >= 5) break;
      }

      if (cleaned.length < 3) {
        sendNativeMessage({ ok: true, skipped: true, error: "insufficient tracks" });
        return;
      }

      const tracksWithLyrics = [];
      for (const t of cleaned) {
        const lyrics = await fetchLyricsForTrack(t);
        if (lyrics) tracksWithLyrics.push({ ...t, lyrics });
      }

      if (!tracksWithLyrics.length) {
        sendNativeMessage({ ok: true, skipped: true, error: "lyrics not found" });
        return;
      }

      const schema = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };
      const prompt = buildLyricInterludePrompt(msg, tracksWithLyrics);
      const resp = await runClaude(prompt, schema);
      if (!resp.ok) {
        sendNativeMessage(resp);
        return;
      }
      const text = resp?.result?.text ? String(resp.result.text).trim() : "";
      if (!text) {
        sendNativeMessage({ ok: true, skipped: true, error: "empty interlude" });
        return;
      }
      sendNativeMessage({ ok: true, result: { text } });
      return;
    }
    if (msg.type === "tts") {
      const text = msg.text ? String(msg.text).trim() : "";
      if (!text) {
        sendNativeMessage({ ok: false, error: ht("host.error.emptyTtsText", msgLang) });
        return;
      }

      // 1) 缓存命中 — 通过本地 HTTP 服务返回 URL，避免 native messaging 大小限制
      const cached = getCachedTts(text);
      if (cached.ok && cached.hit) {
        const hash = sha1Hex(text);
        const serverUrl = await getMediaServerUrl(`/tts/${hash}`);
        console.error(`[tts] cache hit for text=${text.slice(0, 40)}, url=${serverUrl}`);
        sendNativeMessage({ ok: true, audioUrl: serverUrl, provider: "cache", path: cached.path || "" });
        return;
      }

      // 2) MiMo TTS
      const mimoCfg = loadTtsConfig();
      console.error(`[tts] mimoCfg loaded: ${mimoCfg ? "yes" : "no"}`);
      if (mimoCfg) {
        console.error(`[tts] calling mimo API, voice=${mimoCfg.voice}, text=${text.slice(0, 40)}`);
        const resp = await mimoTtsSynthesize(text, mimoCfg);
        console.error(`[tts] mimo response: ok=${resp.ok}, error=${resp.error || ""}`);
        if (resp.ok) {
          cacheTtsAudio(text, resp.audio.base64);
          sendNativeMessage({ ok: true, audio: resp.audio, provider: "mimo" });
          return;
        }
      }

      // 3) Claude TTS model fallback
      const schema = buildTtsSchema();
      const prompt = buildTtsPrompt(text);
      const models = pickTtsModels();
      const tried = [];
      let lastError = "";
      if (models.length) {
        for (const m of models.slice(0, 4)) {
          tried.push(m);
          const resp = await runClaudeWithOptionalModel(prompt, schema, m);
          if (!resp.ok) {
            lastError = resp.error ? String(resp.error) : "";
            continue;
          }
          const mime = resp?.result?.mime ? String(resp.result.mime).trim() : "";
          const b64 = resp?.result?.base64 ? String(resp.result.base64).trim() : "";
          const buf = decodeAudioBase64(b64);
          const guessed = sniffAudioMime(buf);
          if (!buf || !guessed) {
            lastError = "invalid audio base64";
            continue;
          }
          if (buf.length > 4 * 1024 * 1024) {
            lastError = "audio too large";
            continue;
          }
          cacheTtsAudio(text, b64);
          sendNativeMessage({ ok: true, audio: { mime: guessed || mime || "audio/wav", base64: b64 }, provider: "claude_tts", model: m });
          return;
        }
        sendNativeMessage({ ok: false, error: lastError || "tts synthesis failed", modelsTried: tried });
        return;
      }
      sendNativeMessage({ ok: false, error: "no tts provider available (set tts-config.json or configure a TTS model)" });
      return;
    }
    if (msg.type === "detectLocalAiTools") {
      const forceRefresh = Boolean(msg.forceRefresh);
      const result = detectLocalAiTools(forceRefresh);
      sendNativeMessage({ ok: true, ...result });
      return;
    }
    if (msg.type === "getResolvedLocalAiTool") {
      const detection = detectLocalAiTools();
      const resolved = resolveLocalAiTool(msg.preferences || {}, detection);
      sendNativeMessage({
        ok: true,
        tool: resolved.tool,
        mode: resolved.mode,
        resolvedToolId: resolved.resolvedToolId,
        detectionResult: detection,
      });
      return;
    }
    if (msg.type === "checkCloudAiStatus") {
      const config = loadTtsConfig();
      if (!config || !config.apiKey) {
        sendNativeMessage({ ok: false, error: ht("host.error.noApiKey", msgLang) });
        return;
      }
      sendNativeMessage({
        ok: true,
        model: "mimo-v2-flash",
        endpoint: config.endpoint || "https://api.xiaomimimo.com/v1/chat/completions",
        hasApiKey: true,
      });
      return;
    }
    if (msg.type === "welcome") {
      const schema = buildSchema();
      const profileSummary = msg.profileSummary ? String(msg.profileSummary) : "";
      const djRaw = msg.djName ?? "Claudefm";
      const dj = String(djRaw).replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudefm";
      const provider = msg.provider || "paojiao";

      const scene = await buildWelcomeScene(msg.latitude, msg.longitude, profileSummary, msgLang);
      const prompt = buildPrompt({
        provider,
        profileSummary,
        scene,
        djName: dj,
        forceProfileRefresh: false,
        forceRecommend: true,
        lang: msgLang,
        text: ht("host.welcome.text", msgLang)
      });

      const aiProvider = (msg.preferences && msg.preferences.aiProvider) || "local";
      let resp, toolContext;
      if (aiProvider === "cloud") {
        resp = await runMiMoChat(prompt, schema, msgLang);
        toolContext = { toolLabel: "MiMo 云端", mode: "cloud" };
      } else {
        const detection = detectLocalAiTools();
        const resolved = resolveLocalAiTool(msg.preferences || {}, detection);
        if (!resolved.tool) {
          sendNativeMessage({ ok: false, error: ht("host.error.noLocalAiTool", msgLang), toolContext: { mode: resolved.mode } });
          return;
        }
        resp = await runWithLocalAiTool(resolved.tool, prompt, schema);
        toolContext = { toolId: resolved.tool.id, toolLabel: resolved.tool.label, mode: resolved.mode };
      }
      if (!resp.ok) {
        sendNativeMessage({ ...resp, toolContext });
        return;
      }
      const nextProfile = applyMemory(profileSummary, resp.result.memory || []);
      sendNativeMessage({ ok: true, result: resp.result, profileSummary: nextProfile, toolContext });
      return;
    }
    if (msg.type === "nextBatch") {
      const schema = buildSchema();
      const profileSummary = msg.profileSummary ? String(msg.profileSummary) : "";
      const djRaw = msg.djName ?? "Claudefm";
      const dj = String(djRaw).replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudefm";
      const provider = msg.provider || "paojiao";
      const likedTracks = Array.isArray(msg.likedTracks) ? msg.likedTracks : [];
      const dislikedTracks = Array.isArray(msg.dislikedTracks) ? msg.dislikedTracks : [];
      const recentTracks = Array.isArray(msg.recentTracks) ? msg.recentTracks : [];

      const listFile = readListFile();
      const listMd = listFile && listFile.ok ? String(listFile.content || "") : "";
      const memMd = readMusicMemoryFile();

      const fmtTracks = (items, limit = 20) =>
        items
          .slice(0, limit)
          .map((t) => {
            const name = t && t.name ? String(t.name).trim() : "";
            const artist = t && t.artist ? String(t.artist).trim() : "";
            if (!name || !artist) return "";
            return `- ${name} - ${artist}`;
          })
          .filter(Boolean)
          .join("\n");

      const lang = msg.lang || "zh";
      const isEn = lang === "en";
      const empty = ht("host.empty", lang);
      const recentTracksText = fmtTracks(recentTracks, 20) || empty;

      const prompt = [
        ht("host.nextBatch.role", lang, {0: dj}),
        ht("host.nextBatch.task", lang),
        ht("host.djProvider", lang, {0: provider}),
        ht("host.djJsonSchema", lang),
        ht("host.nextBatch.sayHint", lang),
        ht("host.nextBatch.recommendHint", lang),
        ht("host.djDislikedConstraint", lang),
        ht("host.djLikedPreference", lang),
        ht("host.djOutputFormat", lang),
        ht("host.djMemoryHint", lang),
        "",
        isEn ? "[likedTracks (liked)]" : "【likedTracks（赞）】",
        fmtTracks(likedTracks) || empty,
        "",
        isEn ? "[dislikedTracks (disliked)]" : "【dislikedTracks（踩）】",
        fmtTracks(dislikedTracks) || empty,
        "",
        isEn ? "[Recently Played Tracks]" : "【刚才已播放的歌曲】",
        recentTracksText,
        "",
        isEn ? "[Playlist History (list.md summary)]" : "【历史播放歌单（list.md 摘要）】",
        listMd.trim() || empty,
        "",
        isEn ? "[Memory File (music.md summary)]" : "【历史记忆文件（music.md 摘要）】",
        (memMd || "").trim() || empty,
        "",
        isEn ? "[Profile Summary]" : "【画像摘要】",
        profileSummary || empty,
      ].join("\n");

      const aiProvider = (msg.preferences && msg.preferences.aiProvider) || "local";
      let resp, toolContext;
      if (aiProvider === "cloud") {
        resp = await runMiMoChat(prompt, schema, msgLang);
        toolContext = { toolLabel: "MiMo 云端", mode: "cloud" };
      } else {
        const detection = detectLocalAiTools();
        const resolved = resolveLocalAiTool(msg.preferences || {}, detection);
        if (!resolved.tool) {
          sendNativeMessage({ ok: false, error: ht("host.error.noLocalAiTool", msgLang), toolContext: { mode: resolved.mode } });
          return;
        }
        resp = await runWithLocalAiTool(resolved.tool, prompt, schema);
        toolContext = { toolId: resolved.tool.id, toolLabel: resolved.tool.label, mode: resolved.mode };
      }
      if (!resp.ok) {
        sendNativeMessage({ ...resp, toolContext });
        return;
      }
      const nextProfile = applyMemory(profileSummary, resp.result.memory || []);
      sendNativeMessage({ ok: true, result: resp.result, profileSummary: nextProfile, toolContext });
      return;
    }
    if (msg.type !== "chat") {
      sendNativeMessage({ ok: false, error: ht("host.error.unknownType", msgLang) });
      return;
    }

    const schema = buildSchema();
    const prompt = buildPrompt(msg);

    const aiProvider = (msg.preferences && msg.preferences.aiProvider) || "local";
    let resp, toolContext;
    if (aiProvider === "cloud") {
      resp = await runMiMoChat(prompt, schema, msgLang);
      toolContext = { toolLabel: "MiMo 云端", mode: "cloud" };
    } else {
      const detection = detectLocalAiTools();
      const resolved = resolveLocalAiTool(msg.preferences || {}, detection);
      if (!resolved.tool) {
        sendNativeMessage({ ok: false, error: ht("host.error.noLocalAiTool", msgLang), toolContext: { mode: resolved.mode } });
        return;
      }
      resp = await runWithLocalAiTool(resolved.tool, prompt, schema);
      toolContext = { toolId: resolved.tool.id, toolLabel: resolved.tool.label, mode: resolved.mode };
    }
    if (!resp.ok) {
      sendNativeMessage({ ...resp, toolContext });
      return;
    }

    const nextProfile = applyMemory(msg.profileSummary || "", resp.result.memory || []);
    sendNativeMessage({ ok: true, result: resp.result, profileSummary: nextProfile, toolContext });
  } catch (err) {
    sendNativeMessage({ ok: false, error: String(err) });
  }
});
