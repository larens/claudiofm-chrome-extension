#!/usr/bin/env python3
import sys
import os
import json
import struct
import subprocess
import re
import datetime
import urllib.request
import urllib.parse
import shutil
import base64
import hashlib

# Load tool registry
_AI_TOOLS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ai-tools.json")
try:
    with open(_AI_TOOLS_PATH, "r", encoding="utf-8") as f:
        AI_TOOLS = json.load(f)
except Exception:
    AI_TOOLS = []

def get_tool_by_id(tool_id):
    if not tool_id:
        return None
    s = str(tool_id).strip()
    for t in AI_TOOLS:
        if t.get("id") == s:
            return t
    return None

def get_callable_tools():
    return [t for t in AI_TOOLS if t.get("executionMode") == "cli"]

def resolve_template_path(input_path):
    provided = str(input_path or "")
    if provided and os.path.isfile(provided):
        return provided
    base = os.path.dirname(os.path.abspath(__file__))
    fallback = os.path.abspath(os.path.join(base, "..", "docs", "superpowers", "specs", "music_user_memory.md"))
    if os.path.isfile(fallback):
        return fallback
    return ""

def build_exec_env():
    home = os.path.expanduser("~")
    sep = os.pathsep
    extras = [
        os.path.join(home, ".npm-global", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
    ]
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
        local_appdata = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        extras += [
            os.path.join(appdata, "npm"),
            os.path.join(local_appdata, "Microsoft", "WinGet", "Packages"),
        ]
    else:
        extras += [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
    current = os.environ.get("PATH", "")
    merged = []
    for p in extras + current.split(sep):
        if p and p not in merged:
            merged.append(p)
    env = dict(os.environ)
    env["HOME"] = os.environ.get("HOME", home)
    env["PATH"] = sep.join(merged)
    return env

def _find_binary_in_dirs(dirs, bin_name, extensions=("",)):
    """Search for a binary in a list of directories, optionally recursing into subdirs."""
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for ext in extensions:
            p = os.path.join(d, bin_name + ext)
            if os.path.isfile(p):
                return p
        try:
            for entry in os.scandir(d):
                if entry.is_dir():
                    for ext in extensions:
                        p = os.path.join(entry.path, bin_name + ext)
                        if os.path.isfile(p):
                            return p
        except OSError:
            pass
    return ""

def find_claude_binary():
    env_bin = os.environ.get("CLAUDE_BIN") or os.environ.get("CLAUDE_PATH")
    if env_bin and os.path.isfile(env_bin):
        return env_bin
    which = shutil.which("claude")
    if which:
        return which
    if sys.platform != "win32":
        for shell in ("zsh", "bash"):
            shell_path = shutil.which(shell)
            if not shell_path:
                continue
            try:
                result = subprocess.run(
                    [shell_path, "-lc", "command -v claude 2>/dev/null || true"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=5,
                    env=build_exec_env(),
                )
                candidate = str(result.stdout or "").strip()
                if candidate and os.path.isfile(candidate):
                    return candidate
            except Exception:
                pass
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        win_dirs = [
            os.path.join(os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"), "npm"),
            os.path.join(home, ".npm-global", "bin"),
            os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local"), "Microsoft", "WinGet", "Packages"),
        ]
        found = _find_binary_in_dirs(win_dirs, "claude", extensions=(".exe", ".cmd", ".bat", ""))
        if found:
            return found
    else:
        candidates = [
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
            os.path.join(home, ".npm-global", "bin", "claude"),
            os.path.join(home, "workspace", ".npm-global", "bin", "claude"),
            os.path.join(home, ".local", "bin", "claude"),
            os.path.join(home, ".bun", "bin", "claude"),
            os.path.join(home, ".cargo", "bin", "claude"),
        ]
        for p in candidates:
            if os.path.isfile(p):
                return p
    return ""

# ---------------------------------------------------------------------------
# Multi-tool detection & execution abstraction
# ---------------------------------------------------------------------------

def detect_binary_for_tool(tool_def):
    env_keys = tool_def.get("envKeys") or []
    for key in env_keys:
        val = os.environ.get(key, "").strip()
        if val and os.path.isfile(val):
            return {"found": True, "path": val}
    candidates = tool_def.get("binaryCandidates") or []
    for bin_name in candidates:
        which = shutil.which(bin_name)
        if which:
            return {"found": True, "path": which}
        if sys.platform != "win32":
            for shell in ("zsh", "bash"):
                shell_path = shutil.which(shell)
                if not shell_path:
                    continue
                try:
                    result = subprocess.run(
                        [shell_path, "-lc", f"command -v {bin_name} 2>/dev/null || true"],
                        capture_output=True, text=True, encoding="utf-8",
                        timeout=5, env=build_exec_env(),
                    )
                    found = str(result.stdout or "").strip()
                    if found and os.path.isfile(found):
                        return {"found": True, "path": found}
                except Exception:
                    pass
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        win_dirs = [
            os.path.join(os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming"), "npm"),
            os.path.join(home, ".npm-global", "bin"),
            os.path.join(os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local"), "Microsoft", "WinGet", "Packages"),
        ]
        for bin_name in candidates:
            found = _find_binary_in_dirs(win_dirs, bin_name, extensions=(".exe", ".cmd", ".bat", ""))
            if found:
                return {"found": True, "path": found}
    else:
        path_dirs = [
            "/opt/homebrew/bin", "/usr/local/bin",
            os.path.join(home, ".npm-global", "bin"),
            os.path.join(home, "workspace", ".npm-global", "bin"),
            os.path.join(home, ".local", "bin"),
            os.path.join(home, ".bun", "bin"),
            os.path.join(home, ".cargo", "bin"),
        ]
        for bin_name in candidates:
            for d in path_dirs:
                p = os.path.join(d, bin_name)
                if os.path.isfile(p):
                    return {"found": True, "path": p}
    return {"found": False, "path": ""}

def detect_app_for_tool(tool_def):
    app_candidates = tool_def.get("appCandidates") or []
    home = os.path.expanduser("~")
    platform = sys.platform
    for name in app_candidates:
        app_name = name if name.endswith(".app") else name + ".app"
        if platform == "darwin":
            for d in ("/Applications", os.path.join(home, "Applications")):
                p = os.path.join(d, app_name)
                if os.path.isdir(p):
                    return {"found": True, "path": p}
        elif platform == "win32":
            local_app_data = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
            p = os.path.join(local_app_data, "Programs", name)
            if os.path.isdir(p):
                return {"found": True, "path": p}
        else:
            p = os.path.join("/usr", "share", "applications", name.lower() + ".desktop")
            if os.path.isfile(p):
                return {"found": True, "path": p}
    # Also try binary detection for tools that have both app and binary candidates
    if tool_def.get("binaryCandidates"):
        bin_result = detect_binary_for_tool(tool_def)
        if bin_result["found"]:
            return bin_result
    return {"found": False, "path": ""}

_detection_cache = None
_detection_cache_ts = 0
DETECTION_CACHE_TTL_MS = 30000

def detect_local_ai_tools(force_refresh=False):
    global _detection_cache, _detection_cache_ts
    import time
    now = int(time.time() * 1000)
    if not force_refresh and _detection_cache is not None and now - _detection_cache_ts < DETECTION_CACHE_TTL_MS:
        return _detection_cache
    tools = []
    for defn in AI_TOOLS:
        detected = {"found": False, "path": ""}
        mode = defn.get("detectionMode", "")
        if mode == "binary":
            detected = detect_binary_for_tool(defn)
        elif mode == "app_bundle":
            detected = detect_app_for_tool(defn)
        elif mode == "path_probe":
            detected = detect_binary_for_tool(defn)
        installed = detected["found"]
        callable_ = installed and defn.get("executionMode") == "cli"
        status_text = "未安装"
        if installed and callable_:
            status_text = "已安装，可直接调用"
        elif installed:
            status_text = "已安装，仅检测展示"
        tools.append({
            "id": defn.get("id", ""),
            "label": defn.get("label", ""),
            "category": defn.get("category", ""),
            "installed": installed,
            "callable": callable_,
            "executionMode": defn.get("executionMode", ""),
            "statusText": status_text,
            "resolvedPath": detected.get("path", ""),
            "priority": defn.get("priority", 99),
            "description": defn.get("description", ""),
            "installHint": defn.get("installHint", ""),
        })
    callable_tools = sorted([t for t in tools if t["callable"]], key=lambda t: t["priority"])
    recommended_tool_id = callable_tools[0]["id"] if callable_tools else ""
    result = {"tools": tools, "recommendedToolId": recommended_tool_id, "resolvedToolId": recommended_tool_id}
    _detection_cache = result
    _detection_cache_ts = now
    return result

def resolve_local_ai_tool(preferences, detection_result):
    mode = str((preferences or {}).get("localAiToolMode", "auto") or "auto")
    if mode == "manual":
        tool_id = str((preferences or {}).get("localAiToolId", "") or "").strip()
        if tool_id:
            for t in detection_result.get("tools", []):
                if t.get("id") == tool_id:
                    return {"tool": t, "mode": "manual", "resolvedToolId": t["id"]}
        return {"tool": None, "mode": "manual", "resolvedToolId": ""}
    rec_id = detection_result.get("recommendedToolId", "")
    tool = None
    if rec_id:
        for t in detection_result.get("tools", []):
            if t.get("id") == rec_id:
                tool = t
                break
    return {"tool": tool, "mode": "auto", "resolvedToolId": rec_id}

def run_with_local_ai_tool(tool, prompt, schema):
    if not tool:
        return {"ok": False, "error": "未指定工具"}
    if not tool.get("callable"):
        if tool.get("executionMode") == "unsupported":
            return {"ok": False, "error": f"工具 {tool.get('label', '未知')} 暂不支持直接调用，仅支持安装检测"}
        return {"ok": False, "error": f"工具 {tool.get('label', '未知')} 当前不可用"}
    if tool.get("id") == "claude_code":
        return run_claude(prompt, schema)
    return {"ok": False, "error": f"工具 {tool.get('label', '未知')} 暂无适配器"}

def get_claude_timeout_seconds():
    raw = os.environ.get("CLAUDE_TIMEOUT_SECONDS") or os.environ.get("CLAUDE_TIMEOUT") or ""
    try:
        v = int(str(raw).strip())
        if v < 10:
            return 10
        if v > 600:
            return 600
        return v
    except Exception:
        return 180

def get_claude_model_flag():
    if hasattr(get_claude_model_flag, "_cached"):
        return getattr(get_claude_model_flag, "_cached")
    claude_path = find_claude_binary()
    if not claude_path:
        setattr(get_claude_model_flag, "_cached", "")
        return ""
    help_text = ""
    try:
        result = subprocess.run(
            [claude_path, "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=4,
            env=build_exec_env(),
        )
        help_text = "\n".join([str(result.stdout or ""), str(result.stderr or "")])
    except Exception:
        help_text = ""
    flag = ""
    if "--model" in help_text:
        flag = "--model"
    elif re.search(r"(^|\s)-m[,\s].*model", help_text, re.IGNORECASE):
        flag = "-m"
    setattr(get_claude_model_flag, "_cached", flag)
    return flag

def extract_model_strings(obj, out):
    if obj is None:
        return
    if isinstance(obj, str):
        s = obj.strip()
        if not s:
            return
        if re.search(r"tts", s, re.IGNORECASE):
            out.add(s)
            return
        if re.match(r"^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$", s):
            out.add(s)
            return
        return
    if isinstance(obj, list):
        for v in obj:
            extract_model_strings(v, out)
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            key = str(k or "").strip().lower()
            if key in (
                "model",
                "models",
                "default_model",
                "defaultmodel",
                "tts_model",
                "ttsmodel",
                "speech_model",
                "speechmodel",
            ):
                extract_model_strings(v, out)
            else:
                extract_model_strings(v, out)
        return

def list_configured_models():
    home = os.path.expanduser("~")
    paths = [
        os.path.join(home, ".config", "claude", "config.json"),
        os.path.join(home, ".config", "claude", "settings.json"),
        os.path.join(home, ".claude", "config.json"),
        os.path.join(home, ".claude.json"),
    ]
    found = set()
    for p in paths:
        try:
            if not os.path.isfile(p):
                continue
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            extract_model_strings(data, found)
        except Exception:
            continue
    env_model = os.environ.get("CLAUDEFM_TTS_MODEL") or os.environ.get("CLAUDE_TTS_MODEL") or os.environ.get("TTS_MODEL")
    if env_model:
        found.add(str(env_model).strip())
    return [m for m in sorted(found) if m]

def pick_tts_models():
    env_model = os.environ.get("CLAUDEFM_TTS_MODEL") or os.environ.get("CLAUDE_TTS_MODEL") or os.environ.get("TTS_MODEL")
    configured = list_configured_models()
    preferred = []
    if env_model:
        preferred.append(str(env_model).strip())
    exact = "xiaomi/mimo-v2.5-tts"
    if exact in configured and exact not in preferred:
        preferred.append(exact)
    for m in configured:
        if m in preferred:
            continue
        if re.search(r"tts", m, re.IGNORECASE):
            preferred.append(m)
    for m in configured:
        if m in preferred:
            continue
        preferred.append(m)
    return [m for m in preferred if m]

def build_tts_schema():
    return {
        "type": "object",
        "properties": {
            "mime": {"type": "string"},
            "base64": {"type": "string"}
        },
        "required": ["mime", "base64"]
    }

def build_tts_prompt(text):
    s = str(text or "").strip()
    if len(s) > 520:
        s = s[:520].rstrip()
    return "\n".join([
        "你是一个文本转语音（TTS）模型。",
        "请将【输入文本】合成为音频，并只输出 JSON，字段严格遵循 schema：",
        "- mime: 音频 MIME 类型，优先使用 audio/wav（24kHz, mono, 16-bit PCM），也可用 audio/mpeg",
        "- base64: 音频二进制数据的 base64（不要加 data: 前缀，不要换行）",
        "要求：",
        "- 语音为中文普通话，语气自然，适合电台 DJ 口播。",
        "- 禁止输出任何额外说明文字。",
        "",
        "【输入文本】",
        s
    ])

def sniff_audio_mime(b):
    if not b or len(b) < 16:
        return ""
    if b[:4] == b"RIFF" and b[8:12] == b"WAVE":
        return "audio/wav"
    if b[:3] == b"ID3" or b[:2] == b"\xff\xfb":
        return "audio/mpeg"
    if b[:4] == b"OggS":
        return "audio/ogg"
    return ""

def decode_audio_base64(b64):
    s = str(b64 or "").strip()
    if not s:
        return None
    s = re.sub(r"\s+", "", s)
    try:
        return base64.b64decode(s, validate=True)
    except Exception:
        try:
            return base64.b64decode(s, validate=False)
        except Exception:
            return None

def run_claude_with_optional_model(prompt, schema, model):
    claude_path = find_claude_binary()
    if not claude_path:
        return {
            "ok": False,
            "error": "Claude CLI not found: please install Claude Code so that `claude` is available in PATH, or set CLAUDE_PATH/CLAUDE_BIN to the full executable path.",
        }
    args = [
        claude_path,
        "--bare",
    ]
    model_flag = get_claude_model_flag()
    model_str = str(model or "").strip()
    if model_flag and model_str:
        args.extend([model_flag, model_str])
    args.extend([
        "-p", prompt,
        "--output-format", "json",
        "--json-schema", json.dumps(schema)
    ])
    timeout_seconds = get_claude_timeout_seconds()
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout_seconds,
            env=build_exec_env(),
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": f"claude timed out after {timeout_seconds}s. Try running `claude --bare -p \"你好\"` in Terminal, or increase CLAUDE_TIMEOUT_SECONDS.",
        }
    if result.returncode != 0:
        return {"ok": False, "error": result.stderr or f"claude exited {result.returncode}"}
    try:
        payload = json.loads(result.stdout)
    except Exception:
        return {"ok": False, "error": f"invalid json from claude: {str(result.stdout or '')[:500]}"}
    if isinstance(payload, dict) and (payload.get("is_error") is True or payload.get("subtype") in ("error", "failed")):
        message = payload.get("result") or payload.get("error") or payload.get("message") or "claude error"
        return {"ok": False, "error": str(message)}
    structured = extract_structured_from_claude_payload(payload)
    if structured:
        return {"ok": True, "result": structured}
    if isinstance(payload, dict) and isinstance(payload.get("structured_output"), dict):
        return {"ok": True, "result": payload.get("structured_output")}
    return {"ok": False, "error": "claude output missing structured_output"}

def sanitize_markdown_output(text, required_heading):
    raw = str(text or "").strip()
    if not raw:
        return ""

    m = re.search(r"```(?:markdown|md)?\s*\n([\s\S]*?)\n```", raw, re.IGNORECASE)
    if m:
        raw = m.group(1).strip()

    idx = raw.find(required_heading)
    if idx != -1:
        raw = raw[idx:].strip()

    lines = []
    for line in raw.splitlines():
        if line.strip().startswith("```"):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip()

def fetch_json(url, headers=None, timeout=12):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        data = resp.read().decode(charset, errors="replace")
        return json.loads(data)

def normalize_lyrics_text(text, max_chars=2000):
    s = str(text or "").strip()
    if not s:
        return ""
    s = re.sub(r"\r\n|\r", "\n", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    if max_chars and len(s) > max_chars:
        s = s[:max_chars].rstrip()
    return s

def fetch_lyrics_lrclib(track_name, artist_name, timeout=12):
    name = str(track_name or "").strip()
    artist = str(artist_name or "").strip()
    if not name or not artist:
        return ""
    params = urllib.parse.urlencode({"track_name": name, "artist_name": artist})
    url = f"https://lrclib.net/api/get?{params}"
    headers = {
        "accept": "application/json",
        "user-agent": "ClaudefmHost/1.0",
    }
    try:
        payload = fetch_json(url, headers=headers, timeout=timeout)
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    lyrics = payload.get("plainLyrics") or payload.get("syncedLyrics") or ""
    return normalize_lyrics_text(lyrics, 2200)

def fetch_lyrics_lyrics_ovh(track_name, artist_name, timeout=12):
    name = str(track_name or "").strip()
    artist = str(artist_name or "").strip()
    if not name or not artist:
        return ""
    url = "https://api.lyrics.ovh/v1/%s/%s" % (
        urllib.parse.quote(artist, safe=""),
        urllib.parse.quote(name, safe=""),
    )
    headers = {
        "accept": "application/json",
        "user-agent": "ClaudefmHost/1.0",
    }
    try:
        payload = fetch_json(url, headers=headers, timeout=timeout)
    except Exception:
        return ""
    if not isinstance(payload, dict):
        return ""
    lyrics = payload.get("lyrics") or ""
    return normalize_lyrics_text(lyrics, 2200)

def fetch_lyrics_for_track(track):
    name = str(track.get("name", "") if isinstance(track, dict) else "").strip()
    artist = str(track.get("artist", "") if isinstance(track, dict) else "").strip()
    if not name or not artist:
        return ""
    lyrics = fetch_lyrics_lrclib(name, artist)
    if lyrics:
        return lyrics
    return fetch_lyrics_lyrics_ovh(name, artist)

def build_lyric_interlude_schema():
    return {
        "type": "object",
        "properties": {
            "text": {"type": "string"}
        },
        "required": ["text"]
    }

def build_lyric_interlude_prompt(input_data, tracks_with_lyrics):
    dj_raw = input_data.get("djName", "Claudefm")
    dj = str(dj_raw).replace("\n", " ").replace("\r", " ").strip()[:24]
    if not dj:
        dj = "Claudefm"
    profile = str(input_data.get("profileSummary", "") or "")

    blocks = []
    for i, t in enumerate(tracks_with_lyrics):
        name = str(t.get("name", "")).strip()
        artist = str(t.get("artist", "")).strip()
        lyrics = normalize_lyrics_text(t.get("lyrics", ""), 1200)
        if not (name and artist and lyrics):
            continue
        blocks.append("\n".join([
            f"### {i + 1}. {name} - {artist}",
            lyrics
        ]))

    instructions = [
        f"你是 Claudefm 的 DJ {dj}。回复必须是中文。",
        "你将做一段电台插播：基于本段 3-5 首歌的歌词，做一次“合集情绪串讲“。",
        "要求：",
        "- 只输出 JSON，字段遵循 schema（只有 text）。",
        "- text 是可直接口播的一段话，约 120-220 个汉字。",
        "- 重点写情绪、意象、共鸣与转场，不要逐首念歌名清单。",
        "- 可以点到为止引用少量短句（每句不超过 14 个汉字），避免大段原文。",
        "- 结尾要自然引出下一首，不要问问题。",
    ]

    parts = [
        "\n".join(instructions),
        "",
        "【画像摘要】",
        profile or "(空)",
        "",
        "【本段歌词】",
        "\n\n".join(blocks) if blocks else "(空)",
    ]
    return "\n".join(parts)

def weather_code_to_zh(code):
    try:
        c = int(code)
    except Exception:
        return ""
    mapping = {
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
    }
    return mapping.get(c, "")

def get_time_segment(now=None):
    dt = now or datetime.datetime.now()
    h = dt.hour
    if 5 <= h < 11:
        return "早上"
    if 11 <= h < 14:
        return "中午"
    if 14 <= h < 18:
        return "下午"
    if 18 <= h < 23:
        return "晚上"
    return "深夜"

def read_music_memory_file(max_chars=6000):
    try:
        p = get_music_file_path()
        if not os.path.isfile(p):
            return ""
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()
        content = content.strip()
        if not content:
            return ""
        return content[-max_chars:]
    except Exception:
        return ""

def get_location_name(latitude, longitude):
    try:
        params = urllib.parse.urlencode({"format": "jsonv2", "lat": str(latitude), "lon": str(longitude)})
        url = f"https://nominatim.openstreetmap.org/reverse?{params}"
        data = fetch_json(url, headers={"User-Agent": "Claudefm/0.0.1"})
        address = data.get("address") if isinstance(data, dict) else None
        if not isinstance(address, dict):
            return ""
        for key in ("city", "town", "village", "municipality", "county", "state"):
            v = address.get(key)
            if v:
                return str(v)
        name = data.get("name") if isinstance(data, dict) else ""
        return str(name or "")
    except Exception:
        return ""

def get_weather(latitude, longitude):
    try:
        params = urllib.parse.urlencode(
            {
                "latitude": str(latitude),
                "longitude": str(longitude),
                "current_weather": "true",
                "timezone": "auto",
            }
        )
        url = f"https://api.open-meteo.com/v1/forecast?{params}"
        data = fetch_json(url, headers={"User-Agent": "Claudefm/0.0.1"})
        cw = data.get("current_weather") if isinstance(data, dict) else None
        if not isinstance(cw, dict):
            return None
        return {
            "temperature": cw.get("temperature"),
            "windspeed": cw.get("windspeed"),
            "weathercode": cw.get("weathercode"),
        }
    except Exception:
        return None

def build_welcome_scene(latitude, longitude, profile_summary):
    now = datetime.datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_seg = get_time_segment(now)

    pieces = [f"今天是 {date_str}，{time_seg}"]

    location = ""
    weather = None
    if latitude is not None and longitude is not None:
        location = get_location_name(latitude, longitude)
        weather = get_weather(latitude, longitude)

    if location:
        pieces.append(f"你在 {location}")
    if weather:
        desc = weather_code_to_zh(weather.get("weathercode"))
        t = weather.get("temperature")
        w = weather.get("windspeed")
        wx = "天气信息"
        if desc and t is not None:
            wx = f"{desc}，{t}℃"
        elif desc:
            wx = desc
        elif t is not None:
            wx = f"{t}℃"
        if w is not None:
            wx = f"{wx}，风速 {w}"
        pieces.append(f"当前{wx}")

    mem_file = read_music_memory_file()
    scene_lines = []
    scene_lines.append("；".join(pieces))
    scene_lines.append("")
    scene_lines.append("【历史记忆（profileSummary）】")
    scene_lines.append(str(profile_summary or "").strip() or "(空)")
    if mem_file:
        scene_lines.append("")
        scene_lines.append("【历史记忆文件（music.md 摘要）】")
        scene_lines.append(mem_file)

    return "\n".join(scene_lines).strip()

def get_platform_config_name():
    if sys.platform == "darwin":
        return "install-macos.json"
    if sys.platform.startswith("win"):
        return "install-windows.json"
    return "install-linux.json"

def read_install_config():
    base = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(base, "runtime-config.json"),
        os.path.join(base, get_platform_config_name()),
        os.path.join(base, "install-macos.json"),
    ]
    for p in candidates:
        try:
            if not os.path.isfile(p):
                continue
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception:
            continue
    return {}

def get_default_claudefm_folder():
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        return os.path.join(home, "Documents", "Claudefm")
    if sys.platform.startswith("win"):
        appdata = os.environ.get("APPDATA") or os.path.join(home, "AppData", "Roaming")
        return os.path.join(appdata, "Claudefm")
    data_home = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    return os.path.join(data_home, "Claudefm")

def get_claudefm_folder():
    env_dir = str(os.environ.get("CLAUDEFM_DATA_DIR") or "").strip()
    if env_dir and os.path.isabs(env_dir):
        return env_dir
    config = read_install_config()
    config_dir = str(config.get("dataDir", "") if isinstance(config, dict) else "").strip()
    if config_dir and os.path.isabs(config_dir):
        return config_dir
    return get_default_claudefm_folder()

def get_music_file_path():
    return os.path.join(get_claudefm_folder(), "music.md")

def get_list_file_path():
    return os.path.join(get_claudefm_folder(), "list.md")

def get_cache_folder():
    return os.path.join(get_claudefm_folder(), "cache")

def ensure_cache_folders():
    base = get_cache_folder()
    tracks_dir = os.path.join(base, "tracks")
    covers_dir = os.path.join(base, "covers")
    tts_dir = os.path.join(base, "tts")
    os.makedirs(tracks_dir, exist_ok=True)
    os.makedirs(covers_dir, exist_ok=True)
    os.makedirs(tts_dir, exist_ok=True)
    return {"base": base, "tracks": tracks_dir, "covers": covers_dir, "tts": tts_dir}

def sha1_hex(text):
    return hashlib.sha1(str(text or "").encode("utf-8")).hexdigest()

# ---------------------------------------------------------------------------
# MiMo TTS
# ---------------------------------------------------------------------------

def get_tts_config_path():
    return os.path.join(get_claudefm_folder(), "tts-config.json")

def load_tts_config():
    p = get_tts_config_path()
    data = safe_json_load(p)
    if not isinstance(data, dict):
        return None
    api_key = str(data.get("api_key", "") or "").strip()
    if not api_key:
        return None
    return {
        "provider": str(data.get("provider", "mimo") or "mimo").strip(),
        "api_key": api_key,
        "endpoint": str(data.get("endpoint", "https://api.xiaomimimo.com/v1/chat/completions") or "https://api.xiaomimimo.com/v1/chat/completions").strip(),
        "model": str(data.get("model", "mimo-v2.5-tts") or "mimo-v2.5-tts").strip(),
        "voice": str(data.get("voice", "冰糖") or "冰糖").strip(),
        "style": str(data.get("style", "") or "").strip(),
    }

def mimo_tts_synthesize(text, config):
    s = str(text or "").strip()
    if not s:
        return {"ok": False, "error": "empty text"}
    if len(s) > 2000:
        s = s[:2000]

    endpoint = config.get("endpoint", "") or "https://api.xiaomimimo.com/v1/chat/completions"
    style = config.get("style", "") or "温柔亲切的电台DJ风格，语速适中，带有感染力"

    messages = [
        {"role": "user", "content": style},
        {"role": "assistant", "content": s},
    ]

    body = json.dumps({
        "model": config.get("model", "mimo-v2.5-tts"),
        "messages": messages,
        "audio": {
            "format": "wav",
            "voice": config.get("voice", "冰糖"),
        },
    }).encode("utf-8")

    print(f"[mimo] tts request: endpoint={endpoint}, voice={config.get('voice')}, text={s[:40]}...", file=sys.stderr)

    try:
        req = urllib.request.Request(
            endpoint,
            data=body,
            headers={
                "Content-Type": "application/json",
                "api-key": config["api_key"],
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        return {"ok": False, "error": f"mimo request failed: {e}"}

    audio_data = None
    try:
        audio_data = result["choices"][0]["message"]["audio"]["data"]
    except (KeyError, IndexError, TypeError):
        pass

    if not audio_data:
        return {"ok": False, "error": "mimo returned no audio data"}

    print(f"[mimo] tts success: audio base64 length={len(audio_data)}", file=sys.stderr)
    return {"ok": True, "audio": {"mime": "audio/wav", "base64": audio_data}}

def get_tts_cache_path(text):
    folders = ensure_cache_folders()
    return os.path.join(folders["tts"], f"{sha1_hex(text)}.mp3")

def cache_tts_audio(text, audio_b64):
    path = get_tts_cache_path(text)
    try:
        data = base64.b64decode(audio_b64)
        if len(data) > 4 * 1024 * 1024:
            return {"ok": False, "error": "audio too large"}
        with open(path, "wb") as f:
            f.write(data)
        return {"ok": True, "path": path}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def get_cached_tts(text):
    path = get_tts_cache_path(text)
    if not os.path.isfile(path):
        return {"ok": True, "hit": False}
    try:
        size = os.path.getsize(path)
        if size <= 0 or size > 4 * 1024 * 1024:
            return {"ok": True, "hit": False}
        with open(path, "rb") as f:
            data = f.read()
        b64 = base64.b64encode(data).decode("ascii")
        # Detect format: WAV starts with "RIFF", MP3 starts with "ID3" or sync word
        is_wav = len(data) > 4 and data[:4] == b"RIFF"
        mime = "audio/wav" if is_wav else "audio/mpeg"
        return {"ok": True, "hit": True, "audio": {"mime": mime, "base64": b64}, "path": path}
    except Exception:
        return {"ok": True, "hit": False}

def safe_json_load(path):
    try:
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def safe_json_write(path, obj):
    folder = os.path.dirname(path)
    os.makedirs(folder, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)

def guess_cover_ext(content_type, url):
    ct = str(content_type or "").lower()
    if "png" in ct:
        return ".png"
    if "webp" in ct:
        return ".webp"
    if "gif" in ct:
        return ".gif"
    if "jpeg" in ct or "jpg" in ct:
        return ".jpg"
    u = str(url or "").lower()
    for ext in [".jpg", ".jpeg", ".png", ".webp", ".gif"]:
        if u.endswith(ext):
            return ".jpg" if ext == ".jpeg" else ext
    return ".jpg"

def download_cover_to_path(url, out_path, timeout=8):
    u = str(url or "").strip()
    if not u or not (u.startswith("http://") or u.startswith("https://")):
        return {"ok": False, "error": "invalid cover url"}
    try:
        req = urllib.request.Request(u, headers={"user-agent": "ClaudefmHost/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            ct = resp.headers.get("content-type", "")
            data = resp.read()
        if not data:
            return {"ok": False, "error": "empty cover data"}
        if len(data) > 900 * 1024:
            return {"ok": False, "error": "cover too large"}
        ext = guess_cover_ext(ct, u)
        final_path = out_path if out_path.endswith(ext) else (os.path.splitext(out_path)[0] + ext)
        with open(final_path, "wb") as f:
            f.write(data)
        return {"ok": True, "path": final_path, "contentType": ct}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def file_to_data_url(path, content_type_hint=""):
    try:
        if not os.path.isfile(path):
            return ""
        size = os.path.getsize(path)
        if size <= 0 or size > 700 * 1024:
            return ""
        with open(path, "rb") as f:
            data = f.read()
        b64 = base64.b64encode(data).decode("ascii")
        ct = str(content_type_hint or "").strip().lower()
        if not ct:
            p = str(path).lower()
            if p.endswith(".png"):
                ct = "image/png"
            elif p.endswith(".webp"):
                ct = "image/webp"
            elif p.endswith(".gif"):
                ct = "image/gif"
            else:
                ct = "image/jpeg"
        return f"data:{ct};base64,{b64}"
    except Exception:
        return ""

def cache_track_entry(track, resolved):
    name = str(track.get("name", "") if isinstance(track, dict) else "").strip()
    artist = str(track.get("artist", "") if isinstance(track, dict) else "").strip()
    if not name or not artist:
        return {"ok": False, "error": "missing name/artist"}
    stream_url = str(resolved.get("streamUrl", "") if isinstance(resolved, dict) else "").strip()
    cover = str(resolved.get("cover", "") if isinstance(resolved, dict) else "").strip()
    duration_ms = resolved.get("durationMs", 0) if isinstance(resolved, dict) else 0
    provider = str(resolved.get("provider", "") if isinstance(resolved, dict) else "").strip()
    if not stream_url:
        return {"ok": False, "error": "missing streamUrl"}

    folders = ensure_cache_folders()
    key = normalize_track_key(name, artist)
    hid = sha1_hex(key)
    index_path = os.path.join(folders["base"], "index.json")
    meta_path = os.path.join(folders["tracks"], f"{hid}.json")

    index = safe_json_load(index_path)
    if not isinstance(index, dict):
        index = {}

    entry = {
        "name": name,
        "artist": artist,
        "key": key,
        "id": hid,
        "provider": provider or "cached",
        "streamUrl": stream_url,
        "cover": cover,
        "durationMs": int(duration_ms) if isinstance(duration_ms, (int, float)) else 0,
        "updatedAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "coverPath": "",
        "coverContentType": "",
    }

    existing = safe_json_load(meta_path)
    if isinstance(existing, dict):
        for k in ["coverPath", "coverContentType"]:
            if existing.get(k):
                entry[k] = existing.get(k)

    if cover and not entry.get("coverPath"):
        cover_out = os.path.join(folders["covers"], f"{hid}.img")
        dl = download_cover_to_path(cover, cover_out, timeout=6)
        if dl.get("ok"):
            entry["coverPath"] = dl.get("path", "")
            entry["coverContentType"] = dl.get("contentType", "")

    safe_json_write(meta_path, entry)
    index[key] = {
        "id": hid,
        "metaPath": meta_path,
        "updatedAt": entry["updatedAt"],
    }
    safe_json_write(index_path, index)
    return {"ok": True, "key": key, "id": hid, "metaPath": meta_path, "coverPath": entry.get("coverPath", "")}

def get_cached_track_entry(track):
    name = str(track.get("name", "") if isinstance(track, dict) else "").strip()
    artist = str(track.get("artist", "") if isinstance(track, dict) else "").strip()
    if not name or not artist:
        return {"ok": True, "hit": False}
    key = normalize_track_key(name, artist)
    folders = ensure_cache_folders()
    index_path = os.path.join(folders["base"], "index.json")
    index = safe_json_load(index_path)
    if not isinstance(index, dict):
        return {"ok": True, "hit": False}
    ref = index.get(key)
    if not isinstance(ref, dict):
        return {"ok": True, "hit": False}
    meta_path = ref.get("metaPath", "")
    meta = safe_json_load(meta_path)
    if not isinstance(meta, dict):
        return {"ok": True, "hit": False}
    cover_data_url = ""
    cover_path = str(meta.get("coverPath", "") or "")
    if cover_path:
        cover_data_url = file_to_data_url(cover_path, str(meta.get("coverContentType", "") or ""))
    resolved = {
        "provider": meta.get("provider", "cached"),
        "track": {"name": meta.get("name", ""), "artist": meta.get("artist", "")},
        "streamUrl": meta.get("streamUrl", ""),
        "cover": cover_data_url or meta.get("cover", ""),
        "durationMs": meta.get("durationMs", 0),
        "cacheHit": True,
    }
    return {"ok": True, "hit": True, "resolved": resolved}

def ensure_list_file():
    folder = get_claudefm_folder()
    file_path = get_list_file_path()
    if os.path.isfile(file_path):
        return {"ok": True, "path": file_path, "created": False}
    os.makedirs(folder, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write("# 历史播放歌单\n\n")
    return {"ok": True, "path": file_path, "created": True}

def read_list_file(max_chars=20000):
    ensured = ensure_list_file()
    if not ensured.get("ok"):
        return ensured
    file_path = ensured.get("path")
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    content = str(content or "")
    if max_chars and len(content) > max_chars:
        content = content[:max_chars]
    return {"ok": True, "path": file_path, "content": content, "created": ensured.get("created", False)}

def normalize_track_key(name, artist):
    n = str(name or "").strip().lower()
    a = str(artist or "").strip().lower()
    n = re.sub(r"[\s\-_–—·•、，,。.!！?？'\"“”‘’()（）【】\[\]{}<>《》:：;；/\\\\|]+", "", n)
    a = re.sub(r"[\s\-_–—·•、，,。.!！?？'\"“”‘’()（）【】\[\]{}<>《》:：;；/\\\\|]+", "", a)
    return f"{n}|{a}"

def parse_tracks_loose(text, max_tracks=5000):
    tracks = []
    if not text:
        return tracks
    for raw_line in str(text).splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#"):
            continue
        patterns = [
            r"^\s*-\s*(.+?)\s*[-–—]\s*(.+?)\s*$",
            r"^\s*\d+[.、】【、)]\s*(.+?)\s*[-–—]\s*(.+?)\s*$",
            r'^\s*[""](.+?)["“]\s*[-–—]\s*["”](.+?)[""]\s*$',
            r"^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|",
            r"^\s*([^,\t|]+?)\s*[,|\t]\s*([^,\t|]+?)\s*$",
        ]
        hit = None
        for pattern in patterns:
            m = re.match(pattern, line)
            if not m:
                continue
            name = str(m.group(1) or "").strip()
            artist = str(m.group(2) or "").strip()
            if not name or not artist:
                continue
            if name in ("歌曲", "歌手", "name", "artist", "title"):
                continue
            hit = {"name": name, "artist": artist}
            break
        if hit:
            tracks.append(hit)
            if len(tracks) >= max_tracks:
                break
        else:
            parts = [p.strip() for p in re.split(r"[,|\t]+", line) if p and str(p).strip()]
            if len(parts) >= 2 and parts[0] not in ("歌曲", "歌手", "name", "artist", "title"):
                tracks.append({"name": parts[0], "artist": parts[1]})
                if len(tracks) >= max_tracks:
                    break
    return tracks

def import_list_tracks(tracks):
    ensured = ensure_list_file()
    if not ensured.get("ok"):
        return ensured
    file_path = ensured.get("path")

    existing = ""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            existing = f.read()
    except Exception:
        existing = ""

    existing_tracks = parse_tracks_loose(existing, max_tracks=8000)
    seen = set()
    for t in existing_tracks:
        seen.add(normalize_track_key(t.get("name"), t.get("artist")))

    added = 0
    skipped = 0
    to_add = []
    if isinstance(tracks, list):
        for t in tracks:
            if not isinstance(t, dict):
                skipped += 1
                continue
            name = str(t.get("name", "") or "").strip()
            artist = str(t.get("artist", "") or "").strip()
            if not name or not artist:
                skipped += 1
                continue
            key = normalize_track_key(name, artist)
            if not key or key in seen:
                skipped += 1
                continue
            seen.add(key)
            to_add.append({"name": name, "artist": artist})

    if to_add:
        with open(file_path, "a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            for t in to_add:
                f.write(f"- {t['name']} - {t['artist']}\n")
                added += 1

    total = len(existing_tracks) + added
    return {"ok": True, "path": file_path, "added": added, "skipped": skipped, "total": total}

def build_list_section(tracks, stamp, kind, seen_global=None):
    seen = set()
    global_seen = seen_global if isinstance(seen_global, set) else set()
    rows = []
    for t in tracks or []:
        if not isinstance(t, dict):
            continue
        name = str(t.get("name", "") or "").strip()
        artist = str(t.get("artist", "") or "").strip()
        if not name or not artist:
            continue
        key = normalize_track_key(name, artist)
        if not key or key in seen or key in global_seen:
            continue
        seen.add(key)
        global_seen.add(key)
        rows.append(f"- {name} - {artist}")
    if not rows:
        return ""
    k = str(kind or "").strip().lower()
    meta = f"> kind: {k}" if k else ""
    parts = [f"## {stamp}"]
    if meta:
        parts += [meta]
    parts += [""] + rows + ["", ""]
    return "\n".join(parts)

def prepend_list_section(kind, tracks):
    ensured = ensure_list_file()
    if not ensured.get("ok"):
        return ensured
    file_path = ensured.get("path")
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    existing = ""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            existing = f.read()
    except Exception:
        existing = ""

    existing_tracks = parse_tracks_loose(existing, max_tracks=50000)
    global_seen = set()
    for t in existing_tracks:
        global_seen.add(normalize_track_key(t.get("name"), t.get("artist")))

    section = build_list_section(tracks, stamp, kind, seen_global=global_seen)
    if not section:
        return {"ok": True, "path": file_path, "skipped": True}

    header_end = 0
    if existing.startswith("#"):
        lines = existing.splitlines(True)
        if lines:
            header_end = len(lines[0])
            while header_end < len(existing) and existing[header_end:header_end + 1] in ("\n", "\r"):
                header_end += 1

    next_content = existing[:header_end] + section + existing[header_end:]
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(next_content)
    except Exception as e:
        return {"ok": False, "error": f"write failed: {str(e)}"}

    return {"ok": True, "path": file_path, "inserted": True, "stamp": stamp, "kind": str(kind or "")}

def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack('I', header)[0]
    payload = sys.stdin.buffer.read(length)
    return json.loads(payload.decode('utf-8'))

def send_message(obj):
    json_bytes = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    header = struct.pack('I', len(json_bytes))
    sys.stdout.buffer.write(header + json_bytes)
    sys.stdout.buffer.flush()

def build_chat_only_schema():
    return {
        "type": "object",
        "properties": {
            "say": {"type": "string", "minLength": 1},
            "memory": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string"},
                        "text": {"type": "string"}
                    },
                    "required": ["type", "text"]
                }
            }
        },
        "required": ["say"]
    }

def build_schema():
    return {
        "type": "object",
        "properties": {
            "say": {"type": "string", "minLength": 1},
            "reason": {"type": "string"},
            "confirmRecommend": {"type": "boolean"},
            "confirmQuestion": {"type": "string"},
            "play": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "artist": {"type": "string"},
                        "album": {"type": "string"},
                        "provider": {"type": "string"},
                        "query": {"type": "string"},
                        "streamUrl": {"type": "string"}
                    },
                    "required": ["name", "artist"]
                }
            },
            "segue": {"type": "string", "description": "电台 DJ 推荐语，100-200字，包含开场问候、推荐理由、歌曲亮点、情感共鸣、自然过渡"},
            "memory": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string"},
                        "text": {"type": "string"}
                    },
                    "required": ["type", "text"]
                }
            }
        },
        "required": ["say", "play", "memory"]
    }

def apply_memory(profile_summary, memory):
    lines = (profile_summary or "").split("\n")
    existing = set(lines)
    for m in memory or []:
        mtype = m.get("type", "taste") if m else "taste"
        text = m.get("text", "") if m else ""
        line = f"- [{mtype}] {text}".strip()
        if text and line not in existing:
            existing.add(line)
            lines.append(line)
    return "\n".join(lines[-200:])

def build_chat_only_prompt(input_data):
    dj_raw = input_data.get("djName", "Claudefm")
    dj = str(dj_raw).replace("\n", " \u201c).replace(\u201d\r", " ").strip()[:24]
    if not dj:
        dj = "Claudefm"
    profile = input_data.get("profileSummary", "")

    instructions = [
        f"你是 Claudefm 的 DJ {dj}。回复必须是中文。",
        "你的任务：根据用户消息进行简短友好的对话回应。",
        "风格：电台 DJ，亲切自然，简洁有温度。",
        "禁止推荐歌单，只做对话回应。",
        "memory 用于写回画像偏好（可选，1-2 条）。",
    ]

    return "\n".join([
        "\n".join(instructions),
        "",
        "【画像摘要】",
        profile or "(空)",
        "",
        "【用户消息】",
        input_data.get("text", "")
    ])

def build_prompt(input_data):
    dj_raw = input_data.get("djName", "Claudefm")
    dj = str(dj_raw).replace("\n", " ").replace("\r", " ").strip()[:24]
    if not dj:
        dj = "Claudefm"
    provider = input_data.get("provider", "qq")
    profile = input_data.get("profileSummary", "")
    scene = input_data.get("scene", "")
    force = input_data.get("forceProfileRefresh", False)
    force_recommend = bool(input_data.get("forceRecommend", False))
    try:
        list_md = read_list_file(max_chars=6000).get("content", "")
    except Exception:
        list_md = ""
    try:
        mem_md = read_music_memory_file()
    except Exception:
        mem_md = ""

    liked = []
    disliked = []
    try:
        liked = input_data.get("likedTracks", []) if isinstance(input_data.get("likedTracks", []), list) else []
        disliked = input_data.get("dislikedTracks", []) if isinstance(input_data.get("dislikedTracks", []), list) else []
    except Exception:
        liked = []
        disliked = []

    def fmt_track_lines(items, limit=20):
        out = []
        for t in items[:limit]:
            if not isinstance(t, dict):
                continue
            name = str(t.get("name", "") or "").strip()
            artist = str(t.get("artist", "") or "").strip()
            if not name or not artist:
                continue
            out.append(f"- {name} - {artist}")
        return "\n".join(out)

    instructions = [
        f"你是 Claudefm 的 DJ {dj}。回复必须是中文。",
        "你的任务：根据用户消息、画像摘要、场景信息，给出电台式回应。",
        f"当前音源来源偏好：{provider}。",
        "必须输出 JSON，字段遵循给定 schema。",
        "无论 forceRecommend 是否为 true，say 都必须对用户消息做出明确回应，禁止输出空字符串或只包含空白。",
        "当 forceRecommend=false 且用户没有明确要求推荐歌单，但语义上看起来“可能想听歌/想要推荐”（例如：表达想听点音乐、想来点歌、情绪/场景暗示需要音乐但没说推荐）时：请先确认。",
        "确认方式：confirmRecommend=true，confirmQuestion 用一句简短中文提问（例如“要不要我给你推荐一份歌单并直接开始播放？”），并且 play 输出空数组、segue 输出空字符串。",
        "当 confirmRecommend=true 时，不要在 say 里直接给出歌单内容，say 只要回应用户并引导对方确认即可。",
        "当 forceRecommend=true 时，必须推荐 5-10 首歌（play 长度 5-10），segue 必须是一段完整的电台 DJ 推荐语（100-200字），包含：开场问候、推荐理由、歌曲亮点介绍、情感共鸣点、自然过渡到播放。风格要像真实电台主播一样自然亲切、有感染力。",
        "当 forceRecommend=false 且用户明确表示要推荐/要歌单/要新歌/要听歌时：直接推荐 5-10 首歌（play 长度 5-10），confirmRecommend=false，segue 必须是一段完整的电台 DJ 推荐语（100-200字）。",
        "当 forceRecommend=false 且与音乐无关时：confirmRecommend=false，play 输出空数组，segue 输出空字符串。",
        "强约束：dislikedTracks（踩过）里的歌曲，以及这些歌曲的同艺人/强相似风格，后续不要再推荐。",
        "偏好：likedTracks（赞过）里的歌曲及其同风格/同艺人可提高推荐权重（更容易出现）。",
        "每首歌只输出 name/artist；album/query/provider 可选。",
        "memory 用于写回画像偏好，尽量输出 1-3 条可执行的偏好更新。",
    ]
    if force:
        instructions.append("这是一次画像自检更新，请务必输出 2-3 条高质量 memory 用于纠偏与巩固偏好。")

    return "\n".join([
        "\n".join(instructions),
        "",
        "【forceRecommend】",
        "true" if force_recommend else "false",
        "",
        "【likedTracks（赞）】",
        fmt_track_lines(liked) or "(空)",
        "",
        "【dislikedTracks（踩）】",
        fmt_track_lines(disliked) or "(空)",
        "",
        "【历史播放歌单（list.md 摘要）】",
        str(list_md or "").strip() or "(空)",
        "",
        "【历史记忆文件（music.md 摘要）】",
        str(mem_md or "").strip() or "(空)",
        "",
        "【画像摘要】",
        profile or "(空)",
        "",
        "【场景信息】",
        scene or "(空)",
        "",
        "【用户消息】",
        input_data.get("text", "")
    ])
    def fmt_track_lines(items, limit=20):
        out = []
        for t in items[:limit]:
            if not isinstance(t, dict):
                continue
            name = str(t.get("name", "") or "").strip()
            artist = str(t.get("artist", "") or "").strip()
            if not name or not artist:
                continue
            out.append(f"- {name} - {artist}")
        return "\n".join(out)

    instructions = [
        f"你是 Claudefm 的 DJ {dj}。回复必须是中文。",
        "你的任务：根据用户消息、画像摘要、场景信息，给出电台式回应。",
        f"当前音源来源偏好：{provider}。",
        "必须输出 JSON，字段遵循给定 schema。",
        "无论 forceRecommend 是否为 true，say 都必须对用户消息做出明确回应，禁止输出空字符串或只包含空白。",
        "当 forceRecommend=false 且用户没有明确要求推荐歌单，但语义上看起来“可能想听歌/想要推荐”（例如：表达想听点音乐、想来点歌、情绪/场景暗示需要音乐但没说推荐）时：请先确认。",
        "确认方式：confirmRecommend=true，confirmQuestion 用一句简短中文提问（例如“要不要我给你推荐一份歌单并直接开始播放？“），并且 play 输出空数组、segue 输出空字符串。",
        "当 confirmRecommend=true 时，不要在 say 里直接给出歌单内容，say 只要回应用户并引导对方确认即可。",
        "当 forceRecommend=true 时，必须推荐 5-10 首歌（play 长度 5-10），segue 必须是一段完整的电台 DJ 推荐语（100-200字），包含：开场问候、推荐理由、歌曲亮点介绍、情感共鸣点、自然过渡到播放。风格要像真实电台主播一样自然亲切、有感染力。",
        "当 forceRecommend=false 且用户明确表示要推荐/要歌单/要新歌/要听歌时：直接推荐 5-10 首歌（play 长度 5-10），confirmRecommend=false，segue 必须是一段完整的电台 DJ 推荐语（100-200字）。",
        "当 forceRecommend=false 且与音乐无关时：confirmRecommend=false，play 输出空数组，segue 输出空字符串。",
        "强约束：dislikedTracks（踩过）里的歌曲，以及这些歌曲的同艺人/强相似风格，后续不要再推荐。",
        "偏好：likedTracks（赞过）里的歌曲及其同风格/同艺人可提高推荐权重（更容易出现）。",
        "每首歌只输出 name/artist；album/query/provider 可选。",
        "memory 用于写回画像偏好，尽量输出 1-3 条可执行的偏好更新。",
    ]
    if force:
        instructions.append("这是一次画像自检更新，请务必输出 2-3 条高质量 memory 用于纠偏与巩固偏好。")

    return "\n".join([
        "\n".join(instructions),
        "",
        "【forceRecommend】",
        "true" if force_recommend else "false",
        "",
        "【likedTracks（赞）】",
        fmt_track_lines(liked) or "(空)",
        "",
        "【dislikedTracks（踩）】",
        fmt_track_lines(disliked) or "(空)",
        "",
        "【历史播放歌单（list.md 摘要）】",
        str(list_md or "").strip() or "(空)",
        "",
        "【历史记忆文件（music.md 摘要）】",
        str(mem_md or "").strip() or "(空)",
        "",
        "【画像摘要】",
        profile or "(空)",
        "",
        "【场景信息】",
        scene or "(空)",
        "",
        "【用户消息】",
        input_data.get("text", "")
    ])

def parse_songs_from_text(text):
    songs = []
    lines = text.split("\n")
    for line in lines:
        line = line.strip()
        patterns = [
            r'^\d+[.、]\s*["\"](.+?)["\"]\s*[-–]\s*["\"](.+?)["\"]',
            r'^\d+[.、]\s*(.+?)\s*[-–]\s*(.+)',
            r'["\"](.+?)["\"]\s*[-–]\s*["\"](.+?)["\"]',
            r'^\|\s*\d+\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|',
        ]
        for pattern in patterns:
            m = re.match(pattern, line)
            if m:
                name = m.group(1).strip()
                artist = m.group(2).strip()
                if name and artist and len(name) > 0 and len(artist) > 0 and name not in ('歌曲', '歌手', 'name', 'artist'):
                    songs.append({"name": name, "artist": artist})
                    break
    return songs[:10]

def extract_structured_from_claude_payload(payload):
    if not isinstance(payload, dict):
        return None
    structured = payload.get("structured_output")
    if isinstance(structured, dict):
        return structured
    if "say" in payload and "play" in payload and "memory" in payload:
        return payload
    raw = payload.get("result", None)
    if isinstance(raw, str):
        s = raw.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                obj = json.loads(s)
                if isinstance(obj, dict) and "say" in obj and "play" in obj and "memory" in obj:
                    return obj
            except Exception:
                return None
    return None

def run_claude(prompt, schema):
    claude_path = find_claude_binary()
    if not claude_path:
        return {
            "ok": False,
            "error": "Claude CLI not found: please install Claude Code so that `claude` is available in PATH, or set CLAUDE_PATH/CLAUDE_BIN to the full executable path.",
        }
    args = [
        claude_path,
        "--bare",
        "-p", prompt,
        "--output-format", "json",
        "--json-schema", json.dumps(schema)
    ]
    timeout_seconds = get_claude_timeout_seconds()
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout_seconds,
            env=build_exec_env(),
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": f"claude timed out after {timeout_seconds}s. This usually means Claude CLI is not logged in, is blocked by network/proxy, or is taking too long to respond. Try running `claude --version` and `claude --bare -p \"你好\"` in Terminal, or increase CLAUDE_TIMEOUT_SECONDS.",
        }
    if result.returncode != 0:
        return {"ok": False, "error": result.stderr or f"claude exited {result.returncode}"}

    try:
        payload = json.loads(result.stdout)
        if isinstance(payload, dict):
            if payload.get("is_error") is True or payload.get("subtype") in ("error", "failed"):
                message = payload.get("result") or payload.get("error") or payload.get("message") or "claude error"
                return {"ok": False, "error": str(message)}

        structured = extract_structured_from_claude_payload(payload)
        if structured:
            return {"ok": True, "result": structured}

        text_result = payload.get("result", "") if isinstance(payload, dict) else ""
        songs = parse_songs_from_text(text_result)
        if songs:
            return {
                "ok": True,
                "result": {
                    "say": text_result[:500],
                    "reason": "",
                    "play": songs,
                    "segue": "",
                    "memory": []
                }
            }

        detail = ""
        if isinstance(payload, dict):
            detail = payload.get("result") or payload.get("message") or payload.get("subtype") or ""
        detail = str(detail)[:240]
        if detail:
            return {"ok": False, "error": f"No structured output and could not parse songs from text: {detail}"}
        return {"ok": False, "error": "No structured output and could not parse songs from text"}
    except json.JSONDecodeError:
        return {"ok": False, "error": f"invalid json from claude: {result.stdout[:500]}"}

def export_memory_md(dj_name, profile_summary):
    folder = get_claudefm_folder()
    path = get_music_file_path()
    os.makedirs(folder, exist_ok=True)

    dj = str(dj_name or "Claudefm").replace("\n", " ").replace("\r", " ").strip()[:24] or "Claudefm"
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    summary = str(profile_summary or "").strip()

    lines = []
    lines.append("# Claudefm Memory")
    lines.append("")
    lines.append(f"- DJ: {dj}")
    lines.append(f"- Exported: {now}")
    lines.append("")
    lines.append("## Profile Summary")
    lines.append("")
    if summary:
        for line in summary.splitlines():
            lines.append(f"> {line}")
    else:
        lines.append("> (空)")
    lines.append("")

    content = "\n".join(lines)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)

    return {"ok": True, "path": path}

def optimize_memory_file(dj_name, profile_summary, template_path):
    folder = get_claudefm_folder()
    out_path = get_music_file_path()
    os.makedirs(folder, exist_ok=True)

    template_path = resolve_template_path(template_path)
    if not template_path or not os.path.isfile(template_path):
        return {"ok": False, "error": f"template not found: {template_path}"}

    try:
        with open(template_path, "r", encoding="utf-8") as f:
            template = f.read()
    except Exception as e:
        return {"ok": False, "error": f"read template failed: {str(e)}"}

    existing = ""
    try:
        if os.path.isfile(out_path):
            with open(out_path, "r", encoding="utf-8") as f:
                existing = f.read()
    except Exception:
        existing = ""

    dj = str(dj_name or "Claudefm").replace("\n", " ").replace("\r", " ").strip()[:24] or "Claudefm"
    summary = str(profile_summary or "").strip()

    prompt = "\n".join([
        "你是一个音乐偏好画像整理器。请把\"现有记忆\"整理为严格遵循\"模板\"的 Markdown 文档。",
        "要求：",
        "1) 输出必须是 Markdown，且结构与标题层级必须与模板一致。",
        "2) 充分利用现有记忆信息补全模板中能补全的字段；无法确定的保持为空或占位符。",
        "3) 去重、归类、措辞简洁；不要输出与模板无关的说明文字。",
        "4) 不要用任何代码块（不要输出 ```markdown 或 ```）。",
        f"4) DJ 名称为：{dj}",
        "",
        "【模板】",
        template,
        "",
        "【现有记忆】",
        existing.strip() or "(空)",
        "",
        "【profileSummary】",
        summary or "(空)",
        "",
        "现在开始输出整理后的 Markdown："
    ])

    claude_path = find_claude_binary()
    args = [claude_path, "--bare", "-p", prompt]
    timeout_seconds = get_claude_timeout_seconds()
    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout_seconds,
            env=build_exec_env(),
        )
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "error": f"claude timed out after {timeout_seconds}s. Try running `claude --bare -p \"你好\"` in Terminal, or increase CLAUDE_TIMEOUT_SECONDS.",
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}

    if result.returncode != 0:
        return {"ok": False, "error": result.stderr or f"claude exited {result.returncode}"}

    md = sanitize_markdown_output(result.stdout or "", "# 用户音乐记忆画像档案")
    if not md:
        return {"ok": False, "error": "empty output from claude"}

    if not md.lstrip().startswith("# 用户音乐记忆画像档案"):
        return {"ok": False, "error": "output does not follow template heading"}

    try:
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(md + "\n")
    except Exception as e:
        return {"ok": False, "error": f"write failed: {str(e)}"}

    return {"ok": True, "path": out_path}

def append_daily_conversation(kind, user_text, result):
    folder = get_claudefm_folder()
    os.makedirs(folder, exist_ok=True)
    date_key = datetime.datetime.now().strftime("%Y%m%d")
    file_path = os.path.join(folder, f"{date_key}_music_memory.md")

    time_str = datetime.datetime.now().strftime("%H:%M:%S")
    k = str(kind or "chat").strip() or "chat"
    user_text = str(user_text or "").strip()
    data = result if isinstance(result, dict) else {}

    say = str(data.get("say", "") or "").strip()
    reason = str(data.get("reason", "") or "").strip()
    assistant_text = "\n\n".join([p for p in [say, reason] if p])
    if not assistant_text:
        assistant_text = "(空)"

    play = data.get("play", [])
    tracks = []
    if isinstance(play, list):
        for t in play:
            if not isinstance(t, dict):
                continue
            name = str(t.get("name", "") or "").strip()
            artist = str(t.get("artist", "") or "").strip()
            title = " - ".join([p for p in [name, artist] if p]).strip()
            tracks.append(title or "未知歌曲")

    if not os.path.isfile(file_path):
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(f"# {date_key} Music Memory\n\n")

    lines = []
    lines.append(f"## {time_str}")
    lines.append(f"- type: {k}")
    if user_text:
        lines.append("")
        lines.append("### user")
        lines.append(user_text)
    lines.append("")
    lines.append("### assistant")
    lines.append(assistant_text)
    if tracks:
        lines.append("")
        lines.append("### playlist")
        for i, t in enumerate(tracks, start=1):
            lines.append(f"{i}. {t}")
    lines.append("")

    with open(file_path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines))

    return {"ok": True, "path": file_path}

def read_memory_file(max_chars=20000):
    file_path = get_music_file_path()
    if not os.path.isfile(file_path):
        return {"ok": False, "error": f"file not found: {file_path}"}
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    content = str(content or "")
    if max_chars and len(content) > max_chars:
        content = content[-max_chars:]
    return {"ok": True, "path": file_path, "content": content}

def ensure_music_file(template_path):
    folder = get_claudefm_folder()
    file_path = get_music_file_path()
    if os.path.isfile(file_path):
        return {"ok": True, "path": file_path, "created": False}
    template_path = resolve_template_path(template_path)
    if not template_path or not os.path.isfile(template_path):
        return {"ok": False, "error": f"template not found: {template_path}"}
    os.makedirs(folder, exist_ok=True)
    with open(template_path, "r", encoding="utf-8") as f:
        template = f.read()
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(str(template or "").rstrip() + "\n")
    return {"ok": True, "path": file_path, "created": True}

def main():
    import sys; print(f"[host.py] started with {sys.executable}", file=sys.stderr)
    while True:
        msg = read_message()
        if not msg:
            break
        mtype = msg.get("type")
        if mtype == "cacheTrack":
            try:
                track = msg.get("track", {}) if isinstance(msg, dict) else {}
                resolved = msg.get("resolved", {}) if isinstance(msg, dict) else {}
                resp = cache_track_entry(track, resolved)
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "getCachedTrack":
            try:
                track = msg.get("track", {}) if isinstance(msg, dict) else {}
                resp = get_cached_track_entry(track)
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "tts":
            try:
                text = str(msg.get("text", "") or "").strip()
                if not text:
                    send_message({"ok": False, "error": "empty text"})
                    continue

                # 1) 缓存命中
                cached = get_cached_tts(text)
                if cached.get("ok") and cached.get("hit"):
                    send_message({"ok": True, "audio": cached["audio"], "provider": "cache", "path": cached.get("path", "")})
                    continue

                # 2) MiMo TTS
                mimo_cfg = load_tts_config()
                if mimo_cfg:
                    resp = mimo_tts_synthesize(text, mimo_cfg)
                    if resp.get("ok"):
                        audio = resp["audio"]
                        cache_tts_audio(text, audio["base64"])
                        send_message({"ok": True, "audio": audio, "provider": "mimo"})
                        continue

                # 3) Claude TTS model fallback
                schema = build_tts_schema()
                prompt = build_tts_prompt(text)
                models = pick_tts_models()
                tried = []
                last_error = ""
                if models:
                    for m in models[:4]:
                        tried.append(m)
                        resp = run_claude_with_optional_model(prompt, schema, m)
                        if not resp.get("ok"):
                            last_error = str(resp.get("error") or "")
                            continue
                        result = resp.get("result", {}) if isinstance(resp.get("result"), dict) else {}
                        mime = str(result.get("mime", "") or "").strip()
                        b64 = str(result.get("base64", "") or "").strip()
                        data = decode_audio_base64(b64)
                        guessed = sniff_audio_mime(data)
                        if data is None or not guessed:
                            last_error = "invalid audio base64"
                            continue
                        if len(data) > 4 * 1024 * 1024:
                            last_error = "audio too large"
                            continue
                        cache_tts_audio(text, b64)
                        send_message({"ok": True, "audio": {"mime": guessed or mime or "audio/wav", "base64": b64}, "provider": "claude_tts", "model": m})
                        break
                    else:
                        send_message({
                            "ok": False,
                            "error": last_error or "tts synthesis failed",
                            "modelsTried": tried,
                        })
                else:
                    send_message({
                        "ok": False,
                        "error": "no tts provider available (set tts-config.json or configure a TTS model)",
                    })
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "lyricInterlude":
            try:
                tracks = msg.get("tracks", [])
                if not isinstance(tracks, list):
                    tracks = []
                cleaned = []
                for t in tracks:
                    if not isinstance(t, dict):
                        continue
                    name = str(t.get("name", "") or "").strip()
                    artist = str(t.get("artist", "") or "").strip()
                    if not name or not artist:
                        continue
                    cleaned.append({"name": name, "artist": artist})
                    if len(cleaned) >= 5:
                        break

                if len(cleaned) < 3:
                    send_message({"ok": True, "skipped": True, "error": "insufficient tracks"})
                    continue

                tracks_with_lyrics = []
                for t in cleaned:
                    lyrics = fetch_lyrics_for_track(t)
                    if lyrics:
                        tracks_with_lyrics.append({**t, "lyrics": lyrics})

                if not tracks_with_lyrics:
                    send_message({"ok": True, "skipped": True, "error": "lyrics not found"})
                    continue

                schema = build_lyric_interlude_schema()
                prompt = build_lyric_interlude_prompt(msg, tracks_with_lyrics)
                resp = run_claude(prompt, schema)
                if not resp.get("ok"):
                    send_message(resp)
                    continue
                text = str(resp.get("result", {}).get("text", "") or "").strip()
                if not text:
                    send_message({"ok": True, "skipped": True, "error": "empty interlude"})
                    continue
                send_message({"ok": True, "result": {"text": text}})
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "exportMemoryMd":
            try:
                resp = export_memory_md(msg.get("djName", "Claudefm"), msg.get("profileSummary", ""))
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "optimizeMemoryFile":
            try:
                resp = optimize_memory_file(
                    msg.get("djName", "Claudefm"),
                    msg.get("profileSummary", ""),
                    msg.get("templatePath", ""),
                )
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "detectLocalAiTools":
            try:
                force_refresh = bool(msg.get("forceRefresh", False))
                result = detect_local_ai_tools(force_refresh)
                send_message({"ok": True, **result})
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "getResolvedLocalAiTool":
            try:
                detection = detect_local_ai_tools()
                resolved = resolve_local_ai_tool(msg.get("preferences", {}), detection)
                send_message({
                    "ok": True,
                    "tool": resolved["tool"],
                    "mode": resolved["mode"],
                    "resolvedToolId": resolved["resolvedToolId"],
                    "detectionResult": detection,
                })
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "welcome":
            try:
                schema = build_schema()
                profile = str(msg.get("profileSummary", "") or "")
                lat = msg.get("latitude", None)
                lon = msg.get("longitude", None)
                try:
                    lat = float(lat) if lat is not None else None
                    lon = float(lon) if lon is not None else None
                except Exception:
                    lat = None
                    lon = None

                detection = detect_local_ai_tools()
                resolved = resolve_local_ai_tool(msg.get("preferences", {}), detection)
                if not resolved["tool"]:
                    send_message({"ok": False, "error": "未发现可直接调用的本地 AI 工具", "toolContext": {"mode": resolved["mode"]}})
                    continue

                scene = build_welcome_scene(lat, lon, profile)
                payload = {
                    "djName": msg.get("djName", "Claudefm"),
                    "provider": msg.get("provider", "paojiao"),
                    "profileSummary": profile,
                    "scene": scene,
                    "text": "请用电台 DJ 的口吻对我说一句开场欢迎语，并根据时间/地点/天气/历史记忆推荐 5-10 首适合现在的歌。",
                    "forceProfileRefresh": False,
                    "forceRecommend": True,
                }
                prompt = build_prompt(payload)
                resp = run_with_local_ai_tool(resolved["tool"], prompt, schema)
                if not resp.get("ok"):
                    resp["toolContext"] = {"toolId": resolved["tool"]["id"], "toolLabel": resolved["tool"]["label"], "mode": resolved["mode"]}
                    send_message(resp)
                    continue
                next_profile = apply_memory(profile, resp["result"].get("memory", []))
                send_message({"ok": True, "result": resp["result"], "profileSummary": next_profile, "toolContext": {"toolId": resolved["tool"]["id"], "toolLabel": resolved["tool"]["label"], "mode": resolved["mode"]}})
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "appendDailyConversation":
            try:
                resp = append_daily_conversation(
                    msg.get("kind", "chat"),
                    msg.get("userText", ""),
                    msg.get("result", {}),
                )
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "readMemoryFile":
            try:
                resp = read_memory_file()
                send_message(resp)
            except Exception as e:
                import traceback; print(f"[readMemoryFile error] {e}\n{traceback.format_exc()}", file=sys.stderr)
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "readListFile":
            try:
                resp = read_list_file()
                send_message(resp)
            except Exception as e:
                import traceback; print(f"[readListFile error] {e}\n{traceback.format_exc()}", file=sys.stderr)
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "importListTracks":
            try:
                resp = import_list_tracks(msg.get("tracks", []))
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "prependListSection":
            try:
                resp = prepend_list_section(msg.get("kind", "chat"), msg.get("tracks", []))
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "ensureMusicFile":
            try:
                resp = ensure_music_file(msg.get("templatePath", ""))
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype != "chat":
            send_message({"ok": False, "error": "unknown message type"})
            continue

        chat_only = bool(msg.get("chatOnly", False))
        if chat_only:
            schema = build_chat_only_schema()
            prompt = build_chat_only_prompt(msg)
        else:
            schema = build_schema()
            prompt = build_prompt(msg)

        detection = detect_local_ai_tools()
        resolved = resolve_local_ai_tool(msg.get("preferences", {}), detection)
        if not resolved["tool"]:
            send_message({"ok": False, "error": "未发现可直接调用的本地 AI 工具", "toolContext": {"mode": resolved["mode"]}})
            continue

        resp = run_with_local_ai_tool(resolved["tool"], prompt, schema)

        if not resp.get("ok"):
            resp["toolContext"] = {"toolId": resolved["tool"]["id"], "toolLabel": resolved["tool"]["label"], "mode": resolved["mode"]}
            send_message(resp)
            continue

        next_profile = apply_memory(msg.get("profileSummary", ""), resp["result"].get("memory", []))
        send_message({"ok": True, "result": resp["result"], "profileSummary": next_profile, "toolContext": {"toolId": resolved["tool"]["id"], "toolLabel": resolved["tool"]["label"], "mode": resolved["mode"]}})

if __name__ == "__main__":
    main()
