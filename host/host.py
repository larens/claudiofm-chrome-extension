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
    extras = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        os.path.join(home, ".npm-global", "bin"),
        os.path.join(home, ".local", "bin"),
        os.path.join(home, ".bun", "bin"),
        os.path.join(home, ".cargo", "bin"),
    ]
    current = os.environ.get("PATH", "")
    merged = []
    for p in extras + current.split(":"):
        if p and p not in merged:
            merged.append(p)
    env = dict(os.environ)
    env["HOME"] = os.environ.get("HOME", home)
    env["PATH"] = ":".join(merged)
    return env

def find_claude_binary():
    env_bin = os.environ.get("CLAUDE_BIN") or os.environ.get("CLAUDE_PATH")
    if env_bin and os.path.isfile(env_bin):
        return env_bin
    which = shutil.which("claude")
    if which:
        return which
    for shell in ("zsh", "bash"):
        shell_path = shutil.which(shell)
        if not shell_path:
            continue
        try:
            result = subprocess.run(
                [shell_path, "-lc", "command -v claude 2>/dev/null || true"],
                capture_output=True,
                text=True,
                timeout=5,
                env=build_exec_env(),
            )
            candidate = str(result.stdout or "").strip()
            if candidate and os.path.isfile(candidate):
                return candidate
        except Exception:
            pass
    home = os.path.expanduser("~")
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
    env_model = os.environ.get("CLAUDIOFM_TTS_MODEL") or os.environ.get("CLAUDE_TTS_MODEL") or os.environ.get("TTS_MODEL")
    if env_model:
        found.add(str(env_model).strip())
    return [m for m in sorted(found) if m]

def pick_tts_models():
    env_model = os.environ.get("CLAUDIOFM_TTS_MODEL") or os.environ.get("CLAUDE_TTS_MODEL") or os.environ.get("TTS_MODEL")
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
        "user-agent": "ClaudiofmHost/1.0",
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
        "user-agent": "ClaudiofmHost/1.0",
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
    dj_raw = input_data.get("djName", "Claudio")
    dj = str(dj_raw).replace("\n", " ").replace("\r", " ").strip()[:24]
    if not dj:
        dj = "Claudio"
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
        f"你是 Claudiofm 的 DJ {dj}。回复必须是中文。",
        "你将做一段电台插播：基于本段 3-5 首歌的歌词，做一次“合集情绪串讲”。",
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
        home = os.path.expanduser("~")
        p = os.path.join(home, "Documents", "Claudiofm", "music.md")
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
        data = fetch_json(url, headers={"User-Agent": "Claudiofm/0.0.1"})
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
        data = fetch_json(url, headers={"User-Agent": "Claudiofm/0.0.1"})
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

def get_claudiofm_folder():
    home = os.path.expanduser("~")
    return os.path.join(home, "Documents", "Claudiofm")

def ensure_list_file():
    folder = get_claudiofm_folder()
    file_path = os.path.join(folder, "list.md")
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
            r'^\s*["“](.+?)["”]\s*[-–—]\s*["“](.+?)["”]\s*$',
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

def build_schema():
    return {
        "type": "object",
        "properties": {
            "say": {"type": "string", "minLength": 1},
            "reason": {"type": "string"},
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
            "segue": {"type": "string"},
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

def build_prompt(input_data):
    dj_raw = input_data.get("djName", "Claudio")
    dj = str(dj_raw).replace("\n", " ").replace("\r", " ").strip()[:24]
    if not dj:
        dj = "Claudio"
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

    instructions = [
        f"你是 Claudiofm 的 DJ {dj}。回复必须是中文。",
        "你的任务：根据用户消息、画像摘要、场景信息，给出电台式回应。",
        f"当前音源来源偏好：{provider}。",
        "必须输出 JSON，字段遵循给定 schema。",
        "无论 forceRecommend 是否为 true，say 都必须对用户消息做出明确回应，禁止输出空字符串或只包含空白。",
        "当 forceRecommend=true 时，必须推荐 5-10 首歌（play 长度 5-10，segue 需要可口播）。",
        "当 forceRecommend=false 时：只有在用户明确在聊音乐/想听歌/要推荐/要歌单时才推荐 5-10 首歌；否则 play 输出空数组，segue 输出空字符串。",
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
    home = os.path.expanduser("~")
    folder = os.path.join(home, "Documents", "Claudiofm")
    path = os.path.join(folder, "music.md")
    os.makedirs(folder, exist_ok=True)

    dj = str(dj_name or "Claudio").replace("\n", " ").replace("\r", " ").strip()[:24] or "Claudio"
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    summary = str(profile_summary or "").strip()

    lines = []
    lines.append("# Claudiofm Memory")
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
    home = os.path.expanduser("~")
    folder = os.path.join(home, "Documents", "Claudiofm")
    out_path = os.path.join(folder, "music.md")
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

    dj = str(dj_name or "Claudio").replace("\n", " ").replace("\r", " ").strip()[:24] or "Claudio"
    summary = str(profile_summary or "").strip()

    prompt = "\n".join([
        "你是一个音乐偏好画像整理器。请把“现有记忆”整理为严格遵循“模板”的 Markdown 文档。",
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
    home = os.path.expanduser("~")
    folder = os.path.join(home, "Documents", "Claudiofm")
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
    home = os.path.expanduser("~")
    file_path = os.path.join(home, "Documents", "Claudiofm", "music.md")
    if not os.path.isfile(file_path):
        return {"ok": False, "error": f"file not found: {file_path}"}
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
    content = str(content or "")
    if max_chars and len(content) > max_chars:
        content = content[-max_chars:]
    return {"ok": True, "path": file_path, "content": content}

def ensure_music_file(template_path):
    home = os.path.expanduser("~")
    folder = os.path.join(home, "Documents", "Claudiofm")
    file_path = os.path.join(folder, "music.md")
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
    while True:
        msg = read_message()
        if not msg:
            break
        mtype = msg.get("type")
        if mtype == "tts":
            try:
                text = str(msg.get("text", "") or "").strip()
                if not text:
                    send_message({"ok": False, "error": "empty text"})
                    continue
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
                        send_message({"ok": True, "audio": {"mime": guessed or mime or "audio/wav", "base64": b64}, "model": m})
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
                        "error": "no tts model configured",
                        "models": list_configured_models(),
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
                resp = export_memory_md(msg.get("djName", "Claudio"), msg.get("profileSummary", ""))
                send_message(resp)
            except Exception as e:
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "optimizeMemoryFile":
            try:
                resp = optimize_memory_file(
                    msg.get("djName", "Claudio"),
                    msg.get("profileSummary", ""),
                    msg.get("templatePath", ""),
                )
                send_message(resp)
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

                scene = build_welcome_scene(lat, lon, profile)
                payload = {
                    "djName": msg.get("djName", "Claudio"),
                    "provider": msg.get("provider", "paojiao"),
                    "profileSummary": profile,
                    "scene": scene,
                    "text": "请用电台 DJ 的口吻对我说一句开场欢迎语，并根据时间/地点/天气/历史记忆推荐 5-10 首适合现在的歌。",
                    "forceProfileRefresh": False,
                    "forceRecommend": True,
                }
                prompt = build_prompt(payload)
                resp = run_claude(prompt, schema)
                if not resp.get("ok"):
                    send_message(resp)
                    continue
                next_profile = apply_memory(profile, resp["result"].get("memory", []))
                send_message({"ok": True, "result": resp["result"], "profileSummary": next_profile})
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
                send_message({"ok": False, "error": str(e)})
            continue
        if mtype == "readListFile":
            try:
                resp = read_list_file()
                send_message(resp)
            except Exception as e:
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

        schema = build_schema()
        prompt = build_prompt(msg)
        resp = run_claude(prompt, schema)

        if not resp.get("ok"):
            send_message(resp)
            continue

        next_profile = apply_memory(msg.get("profileSummary", ""), resp["result"].get("memory", []))
        send_message({"ok": True, "result": resp["result"], "profileSummary": next_profile})

if __name__ == "__main__":
    main()
