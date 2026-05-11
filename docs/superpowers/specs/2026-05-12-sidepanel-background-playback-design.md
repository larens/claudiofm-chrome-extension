# Side Panel Background Playback Design

## 背景

当前播放器实现集中在 `extension/sidepanel.js` 中：

- `Audio` 实例与预加载逻辑运行在 side panel 页面
- 队列、当前播放索引、播放状态、TTS 插播状态都保存在 side panel 内存中
- side panel 关闭或被浏览器收起后，页面会被销毁，正在播放的音频也会一起中断

用户希望浏览器侧边栏被收起后，播放器仍然继续播放当前歌单；重新打开侧边栏时，界面需要精确恢复当前歌曲、播放进度和播放状态。

## 目标

- 在浏览器收起整个侧边栏后，当前播放不中断
- 重新打开侧边栏时，精确恢复当前歌曲、实时进度和播放状态
- 将播放核心从 side panel UI 生命周期中解耦
- 保持现有聊天、推荐歌单、队列、TTS 插播和中断感知能力

## 非目标

- 不要求浏览器或扩展整体重启后自动无缝续播当前流媒体
- 不重做聊天、历史、Soul、设置等 UI 布局
- 不改变推荐逻辑、音源解析逻辑或 Native Host 协议
- 不在本次设计中引入新的播放来源或新的队列模型

## 方案选择

采用 `offscreen` 播放内核 + `side panel` 遥控 UI + `background` 协调层 的结构。

不采用以下方案：

- 仅把状态移动到 `background.js`
  原因：MV3 service worker 不能可靠承载真实音频播放，无法保证侧边栏销毁后继续发声。
- 收起侧边栏时迁移到隐藏标签页
  原因：行为不稳定、用户感知差、恢复链路复杂，且容易引入额外权限与生命周期问题。

## 总体架构

### Offscreen 播放内核

新增一个 offscreen 文档，作为唯一的播放宿主。它负责：

- 管理真实 `Audio` 实例
- 管理队列、当前索引、预加载、自动切歌
- 管理 TTS 插播与歌词情绪解读插入
- 处理播放/暂停/上一首/下一首/跳转进度等控制命令
- 周期性产出播放状态快照

只要扩展进程仍在，offscreen 文档就不依赖 side panel 是否打开，因此可以在侧边栏收起后继续播放。

### Background 协调层

`background.js` 负责：

- 确保 offscreen 文档存在且可用
- 接收 side panel 的控制消息并转发给 offscreen
- 接收 offscreen 的状态更新并广播给所有前端连接
- 在 side panel 新连接时提供一次完整快照
- 保留现有 Native Host、推荐、音源解析与中断感知入口

### Side Panel UI

`sidepanel.js` 不再直接拥有真实播放实体，只负责：

- 展示当前播放状态
- 渲染队列、进度、曲目信息和按钮状态
- 把用户操作转换为控制消息
- 在首次打开或重新打开时请求最新播放快照并订阅增量更新

## 状态模型

### 单一真相源

播放相关状态以 offscreen 内存为唯一真相源，至少包括：

- `queue`
- `queueIndex`
- `activeTrack`
- `playing`
- `currentTime`
- `duration`
- `speechActive`
- `speechPaused`
- `userPaused`
- `interrupted`
- `preloadIndex`
- `preloadStatus`

### 可恢复快照

offscreen 会把一份轻量快照同步到 `chrome.storage.local`，用于 side panel 新实例快速恢复 UI。该快照是镜像，不驱动真实播放。

快照至少包括：

- 当前队列与当前索引
- 当前曲目标题、封面、时长
- 当前播放状态与最新时间戳
- 是否处于 speech/TTS 插播
- 最近一次状态更新时间

### UI 本地状态

side panel 只保留非播放核心的界面状态，例如：

- 输入框内容
- 聊天临时节点
- 历史、Soul、设置面板的开关
- 纯展示型提示文案

## 通信协议

### 控制消息

由 side panel 发起，经 `background.js` 转发到 offscreen，包括但不限于：

- `player.getState`
- `player.replaceQueueAndPlay`
- `player.playAt`
- `player.play`
- `player.pause`
- `player.next`
- `player.prev`
- `player.seek`

### 状态广播

由 offscreen 发起，经 `background.js` 广播到已连接 UI，包括但不限于：

- `player.state`
- `player.progress`
- `player.queueChanged`
- `player.error`

### 设计原则

- side panel 不直接访问另一页面中的播放器对象
- background 不复制播放状态机，只协调消息与连接
- offscreen 不直接操作聊天 UI 或面板 UI

## 生命周期

### 首次打开侧边栏

- background 先确保 offscreen 已创建
- side panel 建立连接后立刻请求完整播放状态
- 如果当前已有播放任务，直接恢复 UI；如果没有，则显示空闲态

### 开始播放

- side panel 在推荐歌单或点播时发送队列替换/播放命令
- offscreen 接管队列并开始播放
- offscreen 广播最新状态，side panel 更新 UI

### 收起整个浏览器侧边栏

- side panel 页面可能被浏览器销毁
- offscreen 保持运行，继续持有 `Audio` 实例、预加载逻辑、自动切歌逻辑与 TTS 状态
- 不因 side panel 消失而触发暂停或清队列

### 重新打开侧边栏

- 新的 side panel 实例启动
- 先拉取完整快照，再订阅增量更新
- UI 立即恢复当前曲目、播放态、当前时间和队列
- 之后由进度广播持续刷新进度条

## 精确恢复要求

- 重新打开侧边栏时显示正在播放的同一首歌曲
- 进度条和时间文本应接近真实进度，不允许回到 `00:00`
- 播放/暂停按钮状态应与真实状态一致
- 如果处于 TTS 插播或暂停态，UI 必须恢复对应状态

为保证精确恢复，offscreen 需要以固定心跳频率上报 `currentTime`。推荐范围是 250ms 到 1000ms，具体可在实现阶段根据性能和 UI 平滑度决定。

## 现有逻辑迁移边界

以下逻辑应从 `sidepanel.js` 迁入 offscreen：

- `audioA` / `audioB`
- `queue` / `queueIndex`
- `playAt()` / `playNext()` / `playPrev()`
- 预加载与 `activatePreloadedTrack()`
- `SpeechSynthesis` 插播与恢复
- 播放完成后的歌词情绪解读插入
- 播放进度、元数据、错误事件监听

以下逻辑应保留在 side panel：

- DOM 查询与 UI 渲染
- 聊天消息展示
- 队列列表的点击入口
- 内部 overlay 面板开关
- 设置表单与用户输入

## 错误处理

### Offscreen 缺失或崩溃

- background 在收到控制命令或 UI 连接时应先做存在性检查
- 若 offscreen 不存在，则自动重建
- 若无法恢复真实播放上下文，则向 UI 广播“播放内核已重置”，并恢复到安全空闲态

### Side Panel 重连失败

- 不影响后台继续播放
- 仅影响用户当前看到的控制界面
- 用户再次打开侧边栏时应自动重试连接

### 音源或播放错误

- 仍由 offscreen 统一处理并上报错误
- side panel 只展示错误提示，不自行推断状态机下一步

### 扩展整体重启

- 本次范围内仅保证状态恢复，不保证当前流媒体自动续播
- 恢复时可展示最近一份队列与曲目信息，但是否自动恢复播放不属于本次需求

## 兼容与约束

- `manifest.json` 需要声明 offscreen 能力
- offscreen 页面必须只承载播放内核相关能力，不混入 side panel UI
- 现有 `interruptStart` / `interruptEnd` 机制应继续生效，但其播放控制执行者改为 offscreen
- Native Host、音源解析、歌单推荐接口保持不变

## 风险

- 迁移过程中若播放状态机同时存在于 side panel 和 offscreen，会出现双写和状态竞争
- `SpeechSynthesis` 迁移后若事件桥接不完整，可能导致 UI 与真实状态不同步
- 心跳广播过于频繁会增加消息噪声；过于稀疏又会影响“精确恢复”体验
- 如果 offscreen 初始化失败，用户会看到能打开侧边栏但无法播放的半可用状态，因此需要明确兜底提示

## 验证方案

- 开始播放一首歌后收起整个浏览器侧边栏，确认音频持续输出
- 收起 5 到 10 秒后重新打开，确认歌曲、进度和播放状态正确恢复
- 在播放中切到下一首，再收起和重开，确认队列索引同步正确
- 在暂停态下收起和重开，确认仍显示暂停态且不会自动播放
- 在 TTS 插播过程中收起和重开，确认插播状态恢复正确
- 在外部标签页触发中断开始/结束时收起和重开，确认中断恢复行为不重复执行
- 验证聊天、历史、Soul、设置等现有界面功能仍可用

## 验收标准

- 收起整个浏览器侧边栏后，当前播放不中断
- 重新打开侧边栏后，显示当前正在播放的真实歌曲
- 重新打开侧边栏后，进度与播放状态与真实状态一致或近似实时一致
- 队列、上一首、下一首、暂停、恢复、拖动进度在重开后都可继续使用
- 侧边栏 UI 生命周期不再决定播放器是否存活
