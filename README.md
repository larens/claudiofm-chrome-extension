# Claudefm Music Assistant

中文 · [English](./README.en.md)

Claudefm 是一个 Chromium Side Panel 扩展，把”DJ 对话 + 歌单推荐 + 自动播放”做成一个本地优先的音乐助手。

- 对话与推荐：通过 Native Messaging 调用本机 Claude Code CLI
- 本地数据：Host 落盘到本机目录，扩展状态保存在 `chrome.storage.local`

## 仓库结构

- `extension/`：Chrome 扩展与 Side Panel UI
- `host/`：Native Messaging Host、安装脚本、平台配置模板
- `docs/`：模板与设计文档

## 功能概览

- 即时对话反馈，支持按语义确认是否真的要推荐歌单
- 新歌单推荐卡片只读展示，推送后自动播放（可配置自动播放或手动确认）
- 点赞/踩闭环，影响后续推荐与过滤
- 历史歌单读取与详情查看，本地缓存歌曲与封面
- **TTS 语音合成**：支持 MiMo TTS 与 Claude TTS 模型回退，推荐语在推送前预生成音频并缓存，通过本地 HTTP 服务快速播放
- Soul 面板读取本地音乐记忆文件
- 本地 AI 工具自动检测与调用（Claude Code 等）
- 后台播放：Side Panel 关闭后音乐继续播放

## 架构

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
      https://music.pjmp3.com/*         Claudefm data dir
```

## 快速开始

### 前置条件

- Chrome / Edge / Brave / Arc / Chromium 等 Chromium 浏览器
- Node.js `>=18`（推荐）
- Python 3（可选，Node.js 不可用时回退使用）
- Claude Code CLI 可执行，命令为 `claude`

### 1. 加载扩展

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 选择 `Load unpacked`
4. 选择仓库中的 `extension/`
5. 复制扩展 ID

### 2. 配置安装文件

可以直接命令行传参：

```bash
node host/install.mjs --extensionId <YOUR_EXTENSION_ID>
```

高级用法：

```bash
node host/install.mjs --config host/install-linux.json
node host/install.mjs --extensionId <YOUR_EXTENSION_ID> --dataDir /absolute/path/to/data
```

也可以按平台编辑对应配置文件：

- macOS：`host/install-macos.json`
- Linux：`host/install-linux.json`
- Windows：`host/install-windows.json`

最小配置示例：

```json
{
  "extensionId": "YOUR_EXTENSION_ID"
}
```

可选字段：

```json
{
  "extensionId": "YOUR_EXTENSION_ID",
  "dataDir": "/absolute/path/to/Claudefm-data",
  "hostAbsolutePath": "/absolute/path/to/claudefm-host.sh"
}
```

### 3. 安装 Native Host 并生成初始化文件

```bash
cd host
node install.mjs
```

安装脚本会同时完成这些事情：

- 安装 Native Messaging manifest
- 写入运行期配置快照 `host/runtime-config.json`
- 创建本地数据目录
- 生成 `music.md`
- 生成 `list.md`
- 创建 `cache/`、`cache/tracks/`、`cache/covers/`、`cache/tts/`

### 4. 打开侧栏

点击扩展图标，打开 Side Panel → Claudefm。

## 设置

点击侧栏右上角齿轮图标打开设置面板：

| 设置项 | 说明 |
|--------|------|
| DJ 名称 | 自定义 DJ 角色名称（最多 8 字） |
| 收起侧边栏保留会话 | 关闭侧栏后是否保留对话历史 |
| DJ 推荐自动播放 | 开启时 DJ 推荐直接播放；关闭时显示确认按钮，手动点击后才播放 |
| 本地 AI 工具 | 自动检测或手动选择本地 AI CLI 工具 |

## TTS 语音合成配置

DJ 推荐语通过 TTS（Text-to-Speech）转换为语音播放。Host 按以下优先级获取音频：

1. **本地缓存**：命中 `cache/tts/` 中已有的音频文件时直接播放（通过本地 HTTP 服务传输，避免 Native Messaging 大小限制）
2. **MiMo TTS API**：调用小米 MiMo TTS 接口生成语音
3. **Claude TTS 模型回退**：使用本地配置的 Claude TTS 模型生成

### MiMo TTS 配置

在本地数据目录下创建 `tts-config.json`：

```json
{
  "provider": "mimo",
  "api_key": "your-api-key-here",
  "endpoint": "https://api.xiaomimimo.com/v1/chat/completions",
  "model": "mimo-v2.5-tts",
  "voice": "白桦",
  "style": "温柔亲切的电台DJ风格，语速适中，带有感染力"
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `provider` | 固定为 `mimo` | `mimo` |
| `api_key` | MiMo API 密钥（必填） | — |
| `endpoint` | API 地址 | `https://api.xiaomimimo.com/v1/chat/completions` |
| `model` | 模型名称 | `mimo-v2.5-tts` |
| `voice` | 音色名称 | `白桦` |
| `style` | 语音风格提示词 | 空 |

`api_key` 为空时 MiMo TTS 不会启用，Host 将直接尝试 Claude TTS 模型回退。

### 音频缓存

生成的 TTS 音频自动缓存到 `cache/tts/` 目录，文件名为文本内容的 SHA-1 哈希值。相同文本不会重复请求 API。Host 启动时懒加载一个本地 HTTP 服务（`127.0.0.1:<随机端口>`）用于向扩展传输缓存音频，绕过 Native Messaging 的消息大小限制。

## 默认本地数据目录

- macOS：`~/Documents/Claudefm`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/Claudefm`
- Windows：`%APPDATA%\Claudefm`

目录内容通常包括：

- `music.md`：用户音乐记忆画像
- `list.md`：历史歌单记录
- `cache/`：歌曲与封面缓存、TTS 音频缓存（`cache/tts/`）

## 平台说明

### macOS

- 安装配置：`host/install-macos.json`
- 日志：`~/Library/Logs/ClaudefmHost.log`
- Native Messaging Hosts：位于各 Chromium 浏览器的 `Library/Application Support/.../NativeMessagingHosts`

### Linux

- 安装配置：`host/install-linux.json`
- 日志：`${XDG_STATE_HOME:-~/.local/state}/Claudefm/ClaudefmHost.log`
- Native Messaging Hosts：位于各浏览器的 `~/.config/.../NativeMessagingHosts`

### Windows

- 安装配置：`host/install-windows.json`
- 日志：`%TEMP%\ClaudefmHost.log`
- Native Messaging：安装脚本会写入当前用户注册表 `HKCU\Software\...\NativeMessagingHosts`

## Troubleshooting

- `forbidden` / `Not allowed`
- 确认配置文件中的 `extensionId` 与 `chrome://extensions` 中显示的一致
- 重新执行 `node host/install.mjs`
- 完全退出并重启浏览器

- 找不到 `claude`
- 确认 Claude Code CLI 已安装，且 `claude` 在 `PATH` 中
- 或设置环境变量 `CLAUDE_BIN` 指向可执行文件绝对路径

- 想自定义数据目录
- 在安装配置里设置 `dataDir`
- 或执行安装命令时传 `--dataDir`

- 删除过本地文件后如何恢复
- 重新执行 `node host/install.mjs`
- Host 运行时也会对缺失的核心文件做兜底创建

## License

[MIT](./LICENSE)
