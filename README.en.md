# Claudefm Music Assistant

English · [中文](./README.md)

Claudefm is a Chromium Side Panel extension that turns chat, playlist recommendations, and autoplay into a local-first DJ-style music assistant.

- Chat and recommendations: via Native Messaging to your local Claude Code CLI
- Local data: stored by the host on disk, while extension state stays in `chrome.storage.local`

<img src="https://github.com/larens/Claudefm/blob/main/docs/superpowers/specs/demo.png?raw=true" alt="Demo">

## Repo Layout

- `extension/`: Chrome extension and Side Panel UI
- `host/`: Native Messaging host, installer, and platform config templates
- `docs/`: templates and design notes

## Features

- **Top player bar**: playback controls (prev / play / next / progress) integrated into the header; queue button expands the current playlist drawer downward
- **Wave animation**: a flowing sound-wave visualizer displayed above the player, animating in real time
- Instant chat feedback with semantic confirmation before recommending playlists
- Read-only recommendation card ("新歌单推荐") with push-to-play (configurable autoplay or manual confirmation)
- Like/Dislike loop that affects future recommendations
- History playback list with detail view
- Local track and cover cache
- **TTS synthesis**: supports MiMo TTS with Claude TTS model fallback; DJ segue audio is pre-generated before queue push and served via a local HTTP server for fast playback
- **Document-to-Podcast**: send a URL or document text and the AI auto-splits it into multi-chapter podcast segments with TTS playback; chapter titles display as `(1/3) Topic Name`, progress bar syncs in real time, and chapters play continuously one after another
- **Silent URL fetching**: web page content is fetched via direct HTTP request first (no visible tab); falls back to WebBridge browser rendering when content is insufficient
- **Playback mutex**: music recommendations do not interrupt an active podcast — recommendations are display-only during podcast playback; the podcast automatically takes over the play queue when started
- Soul panel backed by a local music memory file
- Local AI tool auto-detection and invocation (Claude Code, etc.)
- Background playback: music continues playing after Side Panel is closed

## Architecture

```text
┌──────────────┐      Native Messaging      ┌─────────────────────────────┐
│ Side Panel UI│  ────────────────────────▶ │ Claudefm Host              │
│ extension/   │                            │ host.cjs / host.py         │
└──────┬───────┘                            └───────────┬────────────────┘
       │                                               │
       │ chrome.runtime.sendMessage / port             │ claude --bare
       │                                               │ + local files/cache
┌──────▼────────────────────┐         ┌────────────────▼────────────────┐
│ Background Service Worker │         │ TTS Local HTTP Server (lazy)   │
│ extension/background.js   │         │ 127.0.0.1:<random-port>/tts/   │
└──────────┬─────────────────┘         └────────────────────────────────┘
           │
           │ Provider Tab / Fetch
           ▼
      https://api.jamendo.com/*           Claudefm data dir

  Podcast URL fetch priority:
  1. Direct HTTP fetch (silent, no visible tab)
  2. WebBridge browser rendering fallback (localhost:10086)
```

## Quick Start

### Prerequisites

- Chrome / Edge / Brave / Arc / Chromium
- Node.js `>=18` (recommended)
- Python 3 (optional, fallback when Node.js is unavailable)
- Claude Code CLI available as `claude`

### 1. Load The Extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select the `extension/` directory
5. Copy the extension ID (looks like `abcdefghijklmnop`)

### 2. Install The Native Host

Run from the repo root (replace `<ID>` with your extension ID):

```bash
node host/install.mjs --extensionId <ID>
```

The installer will automatically:

- Install the Native Messaging manifest
- Write `host/runtime-config.json`
- Create the local data directory
- Create `music.md` and `list.md`
- Create `cache/`, `cache/tracks/`, `cache/covers/`, and `cache/tts/`

### 3. Configure TTS (DJ Voice)

DJ recommendation speech requires a TTS service. Configure MiMo TTS to enable voice playback.

Create `tts-config.json` in your local data directory:

- macOS: `~/Documents/Claudefm/tts-config.json`
- Linux: `~/.local/share/Claudefm/tts-config.json`
- Windows: `%APPDATA%\Claudefm\tts-config.json`

```json
{
  "provider": "mimo",
  "api_key": "your-api-key-here"
}
```

Only `api_key` is required; all other fields use sensible defaults. Restart the browser after configuration.

> When `api_key` is empty, MiMo TTS is skipped and the host falls back to Claude TTS models.

### 4. Open The Side Panel

Click the extension icon and open Side Panel → Claudefm.

## Settings

Click the gear icon in the top-right corner of the side panel to open settings:

| Setting | Description |
|---------|-------------|
| DJ Name | Customize the DJ persona name (max 8 chars) |
| Keep session on close | Preserve chat history when side panel is closed |
| DJ auto-play | When ON, DJ recommendations play immediately; when OFF, shows confirm buttons before playing |
| Local AI Tool | Auto-detect or manually select a local AI CLI tool |

## TTS Voice Synthesis

DJ segue text is converted to speech via TTS (Text-to-Speech). The host retrieves audio in the following priority:

1. **Local cache**: served directly from `cache/tts/` via a local HTTP server (bypasses Native Messaging size limits)
2. **MiMo TTS API**: calls the Xiaomi MiMo TTS endpoint to generate speech
3. **Claude TTS model fallback**: uses a locally configured Claude TTS model

### MiMo TTS Full Configuration

```json
{
  "provider": "mimo",
  "api_key": "your-api-key-here",
  "endpoint": "https://api.xiaomimimo.com/v1/chat/completions",
  "model": "mimo-v2.5-tts",
  "voice": "Milo",
  "style": "Voice style prompt"
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `provider` | Fixed to `mimo` | `mimo` |
| `api_key` | MiMo API key (required) | — |
| `endpoint` | API URL | `https://api.xiaomimimo.com/v1/chat/completions` |
| `model` | Model name | `mimo-v2.5-tts` |
| `voice` | Voice name | `Milo` |
| `style` | Voice style prompt | empty |

### Audio Cache

Generated TTS audio is automatically cached in `cache/tts/` with SHA-1 hashed filenames. Identical text will not re-trigger an API request. On startup the host lazily boots a local HTTP server (`127.0.0.1:<random port>`) to serve cached audio to the extension, bypassing Native Messaging message size limits.

## Advanced Install Options

By default `--extensionId` is all you need. For custom data directories or host paths:

### CLI Arguments

```bash
node host/install.mjs --extensionId <ID> --dataDir /absolute/path/to/data
node host/install.mjs --config host/install-linux.json
```

### Platform Config Files

- macOS: `host/install-macos.json`
- Linux: `host/install-linux.json`
- Windows: `host/install-windows.json`

Minimal config:

```json
{
  "extensionId": "YOUR_EXTENSION_ID"
}
```

Full config:

```json
{
  "extensionId": "YOUR_EXTENSION_ID",
  "dataDir": "/absolute/path/to/Claudefm-data",
  "hostAbsolutePath": "/absolute/path/to/claudefm-host.sh"
}
```

## Default Local Data Directories

- macOS: `~/Documents/Claudefm`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/Claudefm`
- Windows: `%APPDATA%\Claudefm`

Typical contents:

- `music.md`: user music memory profile
- `list.md`: playlist history
- `cache/`: cached tracks, covers, and TTS audio (`cache/tts/`)

## Platform Notes

### macOS

- Config file: `host/install-macos.json`
- Log file: `~/Library/Logs/ClaudefmHost.log`
- Native Messaging manifests: under Chromium browser `Library/Application Support/.../NativeMessagingHosts`

### Linux

- Config file: `host/install-linux.json`
- Log file: `${XDG_STATE_HOME:-~/.local/state}/Claudefm/ClaudefmHost.log`
- Native Messaging manifests: under browser-specific `~/.config/.../NativeMessagingHosts`

### Windows

- Config file: `host/install-windows.json`
- Log file: `%TEMP%\ClaudefmHost.log`
- Native Messaging registration: installer writes current-user registry keys under `HKCU\Software\...\NativeMessagingHosts`

## Troubleshooting

- `forbidden` or `Not allowed`
- Make sure the `extensionId` in the install config matches `chrome://extensions`
- Re-run `node host/install.mjs`
- Fully quit and restart the browser

- `claude` not found
- Install Claude Code CLI and ensure `claude` is available in `PATH`
- Or set `CLAUDE_BIN` to the absolute executable path

- DJ recommendation speech has no sound
- Confirm `api_key` is set in `tts-config.json`
- Confirm the file is in the correct directory (macOS default: `~/Documents/Claudefm/tts-config.json`)
- Restart the browser to apply the configuration

- Document-to-Podcast generation fails
- URL content fetching tries direct HTTP first; most SSR pages work without extra setup
- For JS-heavy pages, start Kimi WebBridge (localhost:10086) as a fallback renderer
- Podcast TTS synthesis depends on the TTS config — confirm `tts-config.json` is set up

- Need a custom data directory
- Set `dataDir` in the install config
- Or pass `--dataDir` to the installer

- Core files were deleted
- Re-run `node host/install.mjs`
- The host also keeps lightweight runtime safeguards for missing core files

## License

[MIT](./LICENSE)
