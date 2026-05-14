"use strict";

// ---------------------------------------------------------------------------
// Host-side bilingual dictionary for prompts, weather, time, and errors
// ---------------------------------------------------------------------------

function t(key, lang, params) {
  const isEn = lang === "en";
  let val;
  if (isEn) {
    val = EN[key] || ZH[key + ".en"] || ZH[key] || key;
  } else {
    val = ZH[key] || key;
  }
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return val;
}

// Weather code → description
const ZH_WEATHER = {
  0: "晴", 1: "大部晴朗", 2: "多云", 3: "阴",
  45: "雾", 48: "雾凇", 51: "毛毛雨", 53: "毛毛雨", 55: "毛毛雨",
  56: "冻毛毛雨", 57: "冻毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨",
  66: "冻雨", 67: "冻雨", 71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
  80: "阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "强阵雪",
  95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
};

const EN_WEATHER = {
  0: "Clear", 1: "Mostly Clear", 2: "Partly Cloudy", 3: "Overcast",
  45: "Foggy", 48: "Freezing Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
  56: "Freezing Drizzle", 57: "Freezing Drizzle", 61: "Light Rain", 63: "Moderate Rain", 65: "Heavy Rain",
  66: "Freezing Rain", 67: "Freezing Rain", 71: "Light Snow", 73: "Moderate Snow", 75: "Heavy Snow", 77: "Snow Grains",
  80: "Rain Showers", 81: "Rain Showers", 82: "Heavy Showers", 85: "Snow Showers", 86: "Heavy Snow Showers",
  95: "Thunderstorm", 96: "Thunderstorm with Hail", 99: "Severe Thunderstorm",
};

function weatherCodeToLabel(code, lang) {
  const c = Number(code);
  if (!Number.isFinite(c)) return "";
  const map = lang === "en" ? EN_WEATHER : ZH_WEATHER;
  return map[String(c)] || map[c] || "";
}

function getTimeSegment(date, lang) {
  const d = date instanceof Date ? date : new Date();
  const h = d.getHours();
  const isEn = lang === "en";
  if (h >= 5 && h < 11) return isEn ? "morning" : "早上";
  if (h >= 11 && h < 14) return isEn ? "midday" : "中午";
  if (h >= 14 && h < 18) return isEn ? "afternoon" : "下午";
  if (h >= 18 && h < 23) return isEn ? "evening" : "晚上";
  return isEn ? "late night" : "深夜";
}

// ---------------------------------------------------------------------------
// Bilingual string dictionary
// ---------------------------------------------------------------------------

const ZH = {
  "host.error.missingTool": "未指定工具",
  "host.error.unsupportedTool": "工具 {0} 暂不支持直接调用，仅支持安装检测",
  "host.error.unavailableTool": "工具 {0} 当前不可用",
  "host.error.noAdapter": "工具 {0} 暂无适配器",
  "host.error.claudeNotFound": "Claude CLI 未找到或启动失败 ({0}): {1}",
  "host.error.missingStructuredOutput": "claude 输出缺少 structured_output",
  "host.error.noLocalAiTool": "未发现可直接调用的本地 AI 工具",
  "host.error.emptyText": "空文本",
  "host.error.emptyTtsText": "空文本",
  "host.error.mimoHttpError": "MiMo API 错误 {0}: {1}",
  "host.error.mimoEmptyResponse": "MiMo 返回空响应",
  "host.error.mimoNotJson": "MiMo 响应不是有效 JSON",
  "host.error.mimoRequestFailed": "MiMo 请求失败: {0}",
  "host.error.mimoNoAudio": "MiMo 未返回音频数据",
  "host.error.templateNotFound": "模板未找到: {0}",
  "host.error.noApiKey": "未配置 API Key，请在 tts-config.json 中设置 api_key",
  "host.error.cloudUnavailable": "云端 AI 不可用：未配置 API Key（请在 tts-config.json 中设置 api_key）",
  "host.error.unknownType": "未知消息类型",
  "host.default.say": "正在为你准备歌单",
  "host.init.failed": "初始化 music.md 失败。",
  "host.init.created": "已初始化 music.md（模板来自 {0}）。你可以在本机 Claudefm 数据目录中找到它（macOS 默认 ~/Documents/Claudefm；Linux 默认 ~/.local/share/Claudefm；Windows 默认 %APPDATA%\\Claudefm）。",
  "host.welcome.text": "请用电台 DJ 的口吻对我说一句开场欢迎语，并根据时间/地点/天气/历史记忆推荐 3-5 首适合现在的歌。",
  "host.scene.date": "今天是 {0}，{1}",
  "host.scene.location": "你在 {0}",
  "host.scene.weather": "当前{0}",
  "host.weather.wind": "{0}，风速 {1}",
  "host.section.forceRecommend": "【forceRecommend】",
  "host.section.likedTracks": "【likedTracks（赞）】",
  "host.section.dislikedTracks": "【dislikedTracks（踩）】",
  "host.section.historyList": "【历史播放歌单（list.md 摘要）】",
  "host.section.memoryFile": "【历史记忆文件（music.md 摘要）】",
  "host.section.profile": "【画像摘要】",
  "host.section.scene": "【场景信息】",
  "host.section.userMsg": "【用户消息】",
  "host.section.recentTracks": "【刚才已播放的歌曲】",
  "host.section.profileHistory": "【历史记忆（profileSummary）】",
  "host.section.memoryFileHistory": "【历史记忆文件（music.md 摘要）】",
  "host.section.lyrics": "【本段歌词】",
  "host.empty": "(空)",
  "host.list.header": "# 历史播放歌单",
  "host.djRole": "你是 Claudefm 的 DJ {0}。回复必须是中文。",
  "host.djRole.en": "You are DJ {0} of Claudefm. Reply in English.",
  "host.djTask": "你的任务：根据用户消息、画像摘要、场景信息，给出电台式回应。",
  "host.djTask.en": "Your task: respond in a radio DJ style based on the user's message, profile summary, and scene info.",
  "host.djProvider": "当前音源来源偏好：{0}。",
  "host.djProvider.en": "Current audio source preference: {0}.",
  "host.djJsonSchema": "必须输出 JSON，字段遵循给定 schema。",
  "host.djJsonSchema.en": "You must output JSON following the given schema.",
  "host.djSayRequired": "无论 forceRecommend 是否为 true，say 都必须对用户消息做出明确回应，禁止输出空字符串或只包含空白。say 只输出 DJ 对用户的自然口语回应，禁止输出内部决策/分析/推理过程（如"用户询问天气…属于与音乐无关的对话…语义上可能想听歌"这类文字）。",
  "host.djSayRequired.en": "Whether forceRecommend is true or not, 'say' must explicitly respond to the user's message. Empty or whitespace-only strings are forbidden. 'say' must only contain the DJ's natural spoken reply to the user — never include internal reasoning/analysis (e.g., 'The user asked about weather... this is unrelated to music... but they might want music').",
  "host.djConfirmHint": "当 forceRecommend=false 且用户没有明确要求推荐歌单，但语义上看起来\"可能想听歌/想要推荐\"（例如：表达想听点音乐、想来点歌、情绪/场景暗示需要音乐但没说推荐）时：请先确认。",
  "host.djConfirmHint.en": "When forceRecommend=false and the user hasn't explicitly asked for a playlist, but semantically seems to want music (e.g., expressing desire to listen, scene/mood implies music): confirm first.",
  "host.djConfirmWay": "确认方式：confirmRecommend=true，confirmQuestion 用一句简短中文提问（例如\"要不要我给你推荐一份歌单并直接开始播放？\"），并且 play 输出空数组、segue 输出空字符串。",
  "host.djConfirmWay.en": "How to confirm: set confirmRecommend=true, write a short confirmQuestion (e.g., 'Would you like me to recommend a playlist?'), and return empty play array and empty segue.",
  "host.djConfirmNoSay": "当 confirmRecommend=true 时，不要在 say 里直接给出歌单内容，say 只要回应用户并引导对方确认即可。",
  "host.djConfirmNoSay.en": "When confirmRecommend=true, do not include playlist content in 'say'. Just respond and guide the user to confirm.",
  "host.djForceRecommend": "当 forceRecommend=true 时，必须推荐 3-5 首歌（play 长度 3-5），segue 必须是一段完整的电台 DJ 推荐语（100-200字），包含：开场问候、推荐理由、歌曲亮点介绍、情感共鸣点、自然过渡到播放。风格要像真实电台主播一样自然亲切、有感染力。",
  "host.djForceRecommend.en": "When forceRecommend=true, recommend 3-5 songs (play length 3-5). segue must be a complete DJ recommendation (100-200 words) with: opening greeting, recommendation reasons, song highlights, emotional resonance, and natural transition. Style should be warm, engaging, like a real radio host.",
  "host.djExplicitRecommend": "当 forceRecommend=false 且用户明确表示要推荐/要歌单/要新歌/要听歌时：直接推荐 3-5 首歌（play 长度 3-5），confirmRecommend=false，segue 必须是一段完整的电台 DJ 推荐语（100-200字）。",
  "host.djExplicitRecommend.en": "When forceRecommend=false and the user explicitly requests recommendations: recommend 3-5 songs (play length 3-5), confirmRecommend=false, segue must be a complete DJ recommendation (100-200 words).",
  "host.djNoMusic": "当 forceRecommend=false 且与音乐无关时：confirmRecommend=false，play 输出空数组，segue 输出空字符串。",
  "host.djNoMusic.en": "When forceRecommend=false and the message is unrelated to music: confirmRecommend=false, empty play array, empty segue.",
  "host.djDislikedConstraint": "强约束：dislikedTracks（踩过）里的歌曲，以及这些歌曲的同艺人/强相似风格，后续不要再推荐。",
  "host.djDislikedConstraint.en": "Hard constraint: never recommend songs from dislikedTracks, or songs by the same artist / similar style.",
  "host.djLikedPreference": "偏好：likedTracks（赞过）里的歌曲及其同风格/同艺人可提高推荐权重（更容易出现）。",
  "host.djLikedPreference.en": "Preference: songs from likedTracks and same-genre/same-artist songs should have higher recommendation weight.",
  "host.djOutputFormat": "每首歌只输出 name/artist；album/query/provider 可选。",
  "host.djOutputFormat.en": "For each song, only output name and artist. album/query/provider are optional.",
  "host.djMemoryHint": "memory 用于写回画像偏好，尽量输出 1-3 条可执行的偏好更新。",
  "host.djMemoryHint.en": "memory is used to update the user's taste profile. Output 1-3 actionable preference updates.",
  "host.djProfileRefresh": "这是一次画像自检更新，请务必输出 2-3 条高质量 memory 用于纠偏与巩固偏好。",
  "host.djProfileRefresh.en": "This is a profile self-check update. Please output 2-3 high-quality memory items for preference correction and reinforcement.",
  "host.nextBatch.role": "你是 Claudefm 的 DJ {0}。回复必须是中文。",
  "host.nextBatch.role.en": "You are DJ {0} of Claudefm. Reply in English.",
  "host.nextBatch.task": "电台正在持续播放中，你需要为下一个段落衔接推荐。",
  "host.nextBatch.task.en": "The radio is playing continuously. You need to recommend the next segment.",
  "host.nextBatch.sayHint": "say 输出简短衔接语（1-2句即可，不需要像开场那样长）。",
  "host.nextBatch.sayHint.en": "For 'say', output a brief transition (1-2 sentences, no need for a full opening).",
  "host.nextBatch.recommendHint": "推荐 3-5 首歌（play 长度 3-5），segue 必须是一段完整的电台 DJ 推荐语（100-200字），用自然的口吻衔接上段内容，风格延续但歌曲不要重复。像真实电台主播一样自然亲切。",
  "host.nextBatch.recommendHint.en": "Recommend 3-5 songs (play length 3-5). segue must be a complete DJ recommendation (100-200 words), naturally connecting to the previous segment. Style continues but songs must not repeat. Sound like a warm, natural radio host.",
  "host.interlude.role": "你是 Claudefm 的 DJ {0}。回复必须是中文。",
  "host.interlude.role.en": "You are DJ {0} of Claudefm. Reply in English.",
  "host.interlude.task": "你将做一段电台插播：基于本段 3-5 首歌的歌词，做一次\"合集情绪串讲\"。",
  "host.interlude.task.en": "You will do a radio interlude: based on the lyrics of these 3-5 songs, create an emotional narrative.",
  "host.interlude.req1": "只输出 JSON，字段遵循 schema（只有 text）。",
  "host.interlude.req1.en": "Output only JSON following the schema (only 'text' field).",
  "host.interlude.req2": "text 是可直接口播的一段话，约 120-220 个汉字。",
  "host.interlude.req2.en": "'text' should be a spoken piece, approximately 120-220 words.",
  "host.interlude.req3": "重点写情绪、意象、共鸣与转场，不要逐首念歌名清单。",
  "host.interlude.req3.en": "Focus on emotions, imagery, resonance, and transitions. Do not list song names one by one.",
  "host.interlude.req4": "可以点到为止引用少量短句（每句不超过 14 个汉字），避免大段原文。",
  "host.interlude.req4.en": "You may briefly quote short phrases (no more than 14 words each), avoid large blocks of original text.",
  "host.interlude.req5": "结尾要自然引出下一首，不要问问题。",
  "host.interlude.req5.en": "End by naturally leading into the next song. Do not ask questions.",
  "host.mimo.systemPrompt": "你是一个音乐电台DJ助手。你必须只输出一个合法的JSON对象，不要输出任何其他文字、解释、markdown标记或代码围栏。",
  "host.mimo.systemPrompt.en": "You are a music radio DJ assistant. You must output only a valid JSON object, no other text, explanations, markdown, or code fences.",
  "host.mimo.jsonSchema": "JSON schema:",
  "host.mimo.jsonSchema.en": "JSON schema:",
  "host.mimo.requiredFields": "say, play, memory 是必须字段。play 至少3首。memory 至少1条。",
  "host.mimo.requiredFields.en": "say, play, and memory are required fields. play must have at least 3 songs. memory must have at least 1 entry.",
  "host.memory.role": "你是一个音乐偏好画像整理器。请把\"现有记忆\"整理为严格遵循\"模板\"的 Markdown 文档。",
  "host.memory.role.en": "You are a music taste profile organizer. Organize the 'existing memories' into a Markdown document that strictly follows the 'template'.",
  "host.memory.req1": "输出必须是 Markdown，且结构与标题层级必须与模板一致。",
  "host.memory.req1.en": "Output must be Markdown, with structure and heading levels matching the template.",
  "host.memory.req2": "充分利用现有记忆信息补全模板中能补全的字段；无法确定的保持为空或占位符。",
  "host.memory.req2.en": "Fill in template fields as much as possible using existing memory info. Leave uncertain fields empty or as placeholders.",
  "host.memory.req3": "去重、归类、措辞简洁；不要输出与模板无关的说明文字。",
  "host.memory.req3.en": "Deduplicate, categorize, and keep wording concise. Do not output explanations unrelated to the template.",
  "host.memory.req4": "不要用任何代码块（不要输出 ```markdown 或 ```）。",
  "host.memory.req4.en": "Do not use any code blocks (no ```markdown or ```).",
  "host.memory.dj": "DJ 名称为：{0}",
  "host.memory.dj.en": "DJ name: {0}",
  "host.memory.section.template": "【模板】",
  "host.memory.section.template.en": "[Template]",
  "host.memory.section.existing": "【现有记忆】",
  "host.memory.section.existing.en": "[Existing Memories]",
  "host.memory.section.profile": "【profileSummary】",
  "host.memory.section.profile.en": "[Profile Summary]",
  "host.memory.start": "现在开始输出整理后的 Markdown：",
  "host.memory.start.en": "Now output the organized Markdown:",
  "host.heading.zh": "# 用户音乐记忆画像档案",
  "host.heading.en": "# User Music Memory Profile",
  "host.tts.role": "你是一个文本转语音（TTS）模型。",
  "host.tts.role.en": "You are a text-to-speech (TTS) model.",
  "host.tts.instruction": "请将【输入文本】合成为音频，并只输出 JSON，字段严格遵循 schema：",
  "host.tts.instruction.en": "Synthesize the [Input Text] into audio and output only JSON following the schema:",
  "host.tts.mime": "- mime: 音频 MIME 类型，优先使用 audio/wav（24kHz, mono, 16-bit PCM），也可用 audio/mpeg",
  "host.tts.mime.en": "- mime: audio MIME type, prefer audio/wav (24kHz, mono, 16-bit PCM), or audio/mpeg",
  "host.tts.base64": "- base64: 音频二进制数据的 base64（不要加 data: 前缀，不要换行）",
  "host.tts.base64.en": "- base64: base64 encoded audio binary data (no data: prefix, no line breaks)",
  "host.tts.req1": "- 语音为中文普通话，语气自然，适合电台 DJ 口播。",
  "host.tts.req1.en": "- Voice should be natural Mandarin Chinese, suitable for radio DJ delivery.",
  "host.tts.req2": "- 禁止输出任何额外说明文字。",
  "host.tts.req2.en": "- Do not output any additional explanatory text.",
  "host.tts.inputText": "【输入文本】",
  "host.tts.inputText.en": "[Input Text]",
};

const EN = {
  "host.error.missingTool": "No tool specified",
  "host.error.unsupportedTool": "Tool {0} does not support direct invocation, detection only",
  "host.error.unavailableTool": "Tool {0} is currently unavailable",
  "host.error.noAdapter": "Tool {0} has no adapter yet",
  "host.error.claudeNotFound": "Claude CLI not found or failed to start ({0}): {1}",
  "host.error.missingStructuredOutput": "Claude output missing structured_output",
  "host.error.noLocalAiTool": "No callable local AI tool found",
  "host.error.emptyText": "Empty text",
  "host.error.emptyTtsText": "Empty text",
  "host.error.mimoHttpError": "MiMo API error {0}: {1}",
  "host.error.mimoEmptyResponse": "MiMo returned empty response",
  "host.error.mimoNotJson": "MiMo response was not valid JSON",
  "host.error.mimoRequestFailed": "MiMo request failed: {0}",
  "host.error.mimoNoAudio": "MiMo returned no audio data",
  "host.error.templateNotFound": "Template not found: {0}",
  "host.error.noApiKey": "API Key not configured, please set api_key in tts-config.json",
  "host.error.cloudUnavailable": "Cloud AI unavailable: API Key not configured (set api_key in tts-config.json)",
  "host.error.unknownType": "Unknown message type",
  "host.default.say": "Preparing your playlist",
  "host.init.failed": "Failed to initialize music.md.",
  "host.init.created": "Initialized music.md (template from {0}). You can find it in your local Claudefm data directory (macOS: ~/Documents/Claudefm; Linux: ~/.local/share/Claudefm; Windows: %APPDATA%\\Claudefm).",
  "host.welcome.text": "Give me a radio DJ opening greeting and recommend 3-5 songs suitable for now based on time, location, weather, and history.",
  "host.scene.date": "Today is {0}, {1}",
  "host.scene.location": "You are in {0}",
  "host.scene.weather": "Currently {0}",
  "host.weather.wind": "{0}, wind speed {1}",
  "host.empty": "(empty)",
  "host.list.header": "# Playlist History",
};

module.exports = { t, weatherCodeToLabel, getTimeSegment, ZH, EN };
