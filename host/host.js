#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { AI_TOOLS, getToolById } = require("./ai-tools.cjs");

function resolveTemplatePath(inputPath) {
  const provided = inputPath ? String(inputPath) : "";
  if (provided && fs.existsSync(provided)) return provided;
  const fallback = path.resolve(__dirname, "..", "docs", "superpowers", "specs", "music_user_memory.md");
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

function buildExecEnv() {
  const home = os.homedir();
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".cargo", "bin"),
  ];
  const current = String(process.env.PATH || "");
  const nextPath = Array.from(new Set([...extras, ...current.split(":").filter(Boolean)])).join(":");
  return { ...process.env, HOME: process.env.HOME || home, PATH: nextPath };
}

function findClaudeBinary() {
  const envBin = process.env.CLAUDE_BIN || process.env.CLAUDE_PATH;
  if (envBin && fs.existsSync(envBin)) return String(envBin);
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
  const home = os.homedir();
  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".npm-global", "bin", "claude"),
    path.join(home, "workspace", ".npm-global", "bin", "claude"),
    path.join(home, ".local", "bin", "claude"),
    path.join(home, ".bun", "bin", "claude"),
    path.join(home, ".cargo", "bin", "claude"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
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
  const home = os.homedir();
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
  if (tool.id === "claude_code") return runClaude(prompt, schema);
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

async function fetchJson(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error(`http ${resp.status}`);
  return await resp.json();
}

function weatherCodeToZh(code) {
  const c = Number(code);
  if (!Number.isFinite(c)) return "";
  const mapping = {
    0: "晴",
    1: "大部晴朗",
    2: "多云",
    3: "阴",
    45: "雾",
    48: "雾凇",
    51: "毛毛雨",
    53: "毛毛雨",
    55: "毛毛雨",
    56: "冻毛毛雨",
    57: "冻毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    66: "冻雨",
    67: "冻雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    77: "雪粒",
    80: "阵雨",
    81: "阵雨",
    82: "强阵雨",
    85: "阵雪",
    86: "强阵雪",
    95: "雷暴",
    96: "雷暴伴冰雹",
    99: "强雷暴伴冰雹",
  };
  return mapping[String(c)] || mapping[c] || "";
}

function getTimeSegment(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 11) return "早上";
  if (h >= 11 && h < 14) return "中午";
  if (h >= 14 && h < 18) return "下午";
  if (h >= 18 && h < 23) return "晚上";
  return "深夜";
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

function ensureMusicFile(templatePath) {
  const resolvedTemplatePath = resolveTemplatePath(templatePath);
  const folder = getClaudefmFolder();
  const filePath = getMusicFilePath();
  if (fs.existsSync(filePath)) return { ok: true, path: filePath, created: false };
  if (!resolvedTemplatePath || !fs.existsSync(resolvedTemplatePath)) {
    return { ok: false, error: `template not found: ${resolvedTemplatePath}` };
  }
  fs.mkdirSync(folder, { recursive: true });
  const template = String(fs.readFileSync(resolvedTemplatePath, "utf8") || "").trimEnd();
  fs.writeFileSync(filePath, template + "\n", "utf8");
  return { ok: true, path: filePath, created: true };
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

async function buildWelcomeScene(latitude, longitude, profileSummary) {
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const pieces = [`今天是 ${dateStr}，${getTimeSegment(now)}`];

  const lat = Number(latitude);
  const lon = Number(longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

  let location = "";
  let weather = null;
  if (hasCoords) {
    location = await getLocationName(lat, lon);
    weather = await getWeather(lat, lon);
  }

  if (location) pieces.push(`你在 ${location}`);
  if (weather) {
    const desc = weatherCodeToZh(weather.weathercode);
    const t = weather.temperature;
    const w = weather.windspeed;
    let wx = "天气信息";
    if (desc && Number.isFinite(Number(t))) wx = `${desc}，${t}℃`;
    else if (desc) wx = desc;
    else if (Number.isFinite(Number(t))) wx = `${t}℃`;
    if (Number.isFinite(Number(w))) wx = `${wx}，风速 ${w}`;
    pieces.push(`当前${wx}`);
  }

  const memFile = readMusicMemoryFile();
  const lines = [];
  lines.push(pieces.join("；"));
  lines.push("");
  lines.push("【历史记忆（profileSummary）】");
  lines.push(String(profileSummary || "").trim() || "(空)");
  if (memFile) {
    lines.push("");
    lines.push("【历史记忆文件（music.md 摘要）】");
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

function buildSchema() {
  return {
    type: "object",
    properties: {
      say: { type: "string" },
      reason: { type: "string" },
      play: {
        type: "array",
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
      segue: { type: "string", description: "电台 DJ 推荐语，1-2 句话，介绍歌单主题或推荐理由" },
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
    const type = m?.type ? String(m.type) : "taste";
    const text = m?.text ? String(m.text) : "";
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
  const provider = input.provider || "qq";
  const profile = input.profileSummary || "";
  const scene = input.scene || "";
  const force = Boolean(input.forceProfileRefresh);

  const instructions = [
    "你是 Claudefm 的 DJ Claudio。回复必须是中文。",
    "你的任务：根据用户消息、画像摘要、场景信息，给出电台式回应，并推荐 5-10 首适合当前场景的歌曲。",
    `当前音源来源偏好：${provider}。`,
    "必须输出 JSON，字段遵循给定 schema。",
    "play 数组长度必须在 5 到 10 之间。",
    "每首歌只输出 name/artist；album/query/provider 可选。",
    "segue 是你在推荐歌单前用电台 DJ 口吻说的一小段推荐语（1-2 句话），介绍接下来的歌单主题或推荐理由，必须输出。",
    "memory 用于写回画像偏好，尽量输出 1-3 条可执行的偏好更新。",
    force ? "这是一次画像自检更新，请务必输出 2-3 条高质量 memory 用于纠偏与巩固偏好。" : ""
  ].filter(Boolean);

  return [
    instructions.join("\n"),
    "",
    "【画像摘要】",
    profile || "(空)",
    "",
    "【场景信息】",
    scene || "(空)",
    "",
    "【用户消息】",
    input.text || ""
  ].join("\n");
}

function runClaude(prompt, schema) {
  return new Promise((resolve) => {
    const env = buildExecEnv();
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

    const child = spawn(claudePath, args, { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    child.on("error", (e) => {
      const message = e?.message ? String(e.message) : String(e);
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
      const structured = payload?.structured_output ?? null;
      if (!structured) {
        resolve({ ok: false, error: "claude output missing structured_output" });
        return;
      }
      resolve({ ok: true, result: structured });
    });
  });
}

readNativeMessageStream(async (msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "optimizeMemoryFile") {
    try {
      const djRaw = msg.djName ? String(msg.djName) : "Claudio";
      const dj = djRaw.replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudio";
      const summary = msg.profileSummary ? String(msg.profileSummary).trim() : "";
      const templatePath = resolveTemplatePath(msg.templatePath ? String(msg.templatePath) : "");
      if (!templatePath || !fs.existsSync(templatePath)) {
        sendNativeMessage({ ok: false, error: `template not found: ${templatePath}` });
        return;
      }

      const folder = getClaudefmFolder();
      const filePath = getMusicFilePath();
      fs.mkdirSync(folder, { recursive: true });
      const template = fs.readFileSync(templatePath, "utf8");
      const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";

      const prompt = [
        "你是一个音乐偏好画像整理器。请把“现有记忆”整理为严格遵循“模板”的 Markdown 文档。",
        "要求：",
        "1) 输出必须是 Markdown，且结构与标题层级必须与模板一致。",
        "2) 充分利用现有记忆信息补全模板中能补全的字段；无法确定的保持为空或占位符。",
        "3) 去重、归类、措辞简洁；不要输出与模板无关的说明文字。",
        "4) 不要用任何代码块（不要输出 ```markdown 或 ```）。",
        `4) DJ 名称为：${dj}`,
        "",
        "【模板】",
        template,
        "",
        "【现有记忆】",
        existing.trim() || "(空)",
        "",
        "【profileSummary】",
        summary || "(空)",
        "",
        "现在开始输出整理后的 Markdown："
      ].join("\n");

      const args = ["--bare", "-p", prompt];
      const env = buildExecEnv();
      const claudeBin = findClaudeBinary();
      const child = spawn(claudeBin, args, { stdio: ["ignore", "pipe", "pipe"], env });
      let out = "";
      let err = "";
      child.on("error", (e) => {
        const message = e?.message ? String(e.message) : String(e);
        sendNativeMessage({ ok: false, error: `Claude CLI not found or failed to start (${claudeBin}): ${message}` });
      });
      child.stdout.on("data", (d) => {
        out += d.toString("utf8");
      });
      child.stderr.on("data", (d) => {
        err += d.toString("utf8");
      });
      child.on("close", (code) => {
        if (code !== 0) {
          sendNativeMessage({ ok: false, error: err || `claude exited ${code}` });
          return;
        }
        const md = sanitizeMarkdownOutput(out || "", "# 用户音乐记忆画像档案");
        if (!md) {
          sendNativeMessage({ ok: false, error: "empty output from claude" });
          return;
        }
        if (!md.startsWith("# 用户音乐记忆画像档案")) {
          sendNativeMessage({ ok: false, error: "output does not follow template heading" });
          return;
        }
        fs.writeFileSync(filePath, md + "\n", "utf8");
        sendNativeMessage({ ok: true, path: filePath });
      });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type === "appendDailyConversation") {
    try {
      sendNativeMessage(appendDailyConversation(msg));
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type === "readMemoryFile") {
    try {
      const filePath = getMusicFilePath();
      if (!fs.existsSync(filePath)) {
        sendNativeMessage({ ok: false, error: `file not found: ${filePath}` });
        return;
      }
      const content = String(fs.readFileSync(filePath, "utf8") || "");
      const maxChars = 20000;
      const sliced = content.length > maxChars ? content.slice(-maxChars) : content;
      sendNativeMessage({ ok: true, path: filePath, content: sliced });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type === "ensureMusicFile") {
    try {
      const templatePath = msg.templatePath ? String(msg.templatePath) : "";
      sendNativeMessage(ensureMusicFile(templatePath));
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type === "detectLocalAiTools") {
    try {
      const forceRefresh = Boolean(msg.forceRefresh);
      const result = detectLocalAiTools(forceRefresh);
      sendNativeMessage({ ok: true, ...result });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type === "getResolvedLocalAiTool") {
    try {
      const detection = detectLocalAiTools();
      const resolved = resolveLocalAiTool(msg.preferences || {}, detection);
      sendNativeMessage({
        ok: true,
        tool: resolved.tool,
        mode: resolved.mode,
        resolvedToolId: resolved.resolvedToolId,
        detectionResult: detection,
      });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type === "welcome") {
    try {
      const schema = buildSchema();
      const djRaw = msg.djName ? String(msg.djName) : "Claudio";
      const dj = djRaw.replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudio";
      const provider = msg.provider || "paojiao";
      const profileSummary = msg.profileSummary ? String(msg.profileSummary) : "";

      const detection = detectLocalAiTools();
      const resolved = resolveLocalAiTool(msg.preferences || {}, detection);
      if (!resolved.tool) {
        sendNativeMessage({ ok: false, error: "未发现可直接调用的本地 AI 工具", toolContext: { mode: resolved.mode } });
        return;
      }

      const scene = await buildWelcomeScene(msg.latitude, msg.longitude, profileSummary);
      const prompt = buildPrompt({
        provider,
        profileSummary,
        scene,
        text: "请用电台 DJ 的口吻对我说一句开场欢迎语，并根据时间/地点/天气/历史记忆推荐 5-10 首适合现在的歌。",
        djName: dj,
        forceProfileRefresh: false
      });

      const resp = await runWithLocalAiTool(resolved.tool, prompt, schema);
      if (!resp.ok) {
        sendNativeMessage({ ...resp, toolContext: { toolId: resolved.tool.id, toolLabel: resolved.tool.label, mode: resolved.mode } });
        return;
      }
      const nextProfile = applyMemory(profileSummary, resp.result.memory || []);
      sendNativeMessage({ ok: true, result: resp.result, profileSummary: nextProfile, toolContext: { toolId: resolved.tool.id, toolLabel: resolved.tool.label, mode: resolved.mode } });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type === "exportMemoryMd") {
    try {
      const djRaw = msg.djName ? String(msg.djName) : "Claudio";
      const dj = djRaw.replace(/\r|\n/g, " ").trim().slice(0, 24) || "Claudio";
      const summary = msg.profileSummary ? String(msg.profileSummary).trim() : "";
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
      sendNativeMessage({ ok: true, path: filePath });
    } catch (e) {
      const message = e?.message ? String(e.message) : String(e);
      sendNativeMessage({ ok: false, error: message });
    }
    return;
  }
  if (msg.type !== "chat") {
    sendNativeMessage({ ok: false, error: "unknown message type" });
    return;
  }

  const schema = buildSchema();
  const prompt = buildPrompt(msg);

  const detection = detectLocalAiTools();
  const resolved = resolveLocalAiTool(msg.preferences || {}, detection);
  if (!resolved.tool) {
    sendNativeMessage({ ok: false, error: "未发现可直接调用的本地 AI 工具", toolContext: { mode: resolved.mode } });
    return;
  }

  const resp = await runWithLocalAiTool(resolved.tool, prompt, schema);
  if (!resp.ok) {
    sendNativeMessage({ ...resp, toolContext: { toolId: resolved.tool.id, toolLabel: resolved.tool.label, mode: resolved.mode } });
    return;
  }

  const nextProfile = applyMemory(msg.profileSummary || "", resp.result.memory || []);
  sendNativeMessage({ ok: true, result: resp.result, profileSummary: nextProfile, toolContext: { toolId: resolved.tool.id, toolLabel: resolved.tool.label, mode: resolved.mode } });
});
