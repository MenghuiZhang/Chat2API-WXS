# 修改日志 (Changelog)

本项目的所有重要变更都会记录在此文件中。

## [1.6.11] - 2026-10-10

### ✨ 新功能 (Features)

- Qwen AI 账号自动化维护体系：
  - **临时邮箱服务**（`tempMail.ts`）：内置 1secmail / DuckMail / TempMail.plus 三种邮箱源，自动创建收件地址、轮询并解析验证码，支持在「临时邮箱设置」对话框中配置（TempMail.plus 需要 API Key）
  - **Qwen AI 自动注册**（`qwenRegister.ts`）：在内置浏览器注册窗口中自动完成邮箱填写、验证码收取与填写、协议勾选、提交注册，token 生成后自动捕获验证入库（凭证经 safeStorage 加密）
  - **批量注册**：批量注册对话框支持一次注册多个账号，可配置每个账号之间的注册间隔秒数（0-300 秒，默认 10 秒，降低风控概率）；批量注册数量上限从 20 提升至 999
  - **账户维护对话框**：手动一键批量检测所有供应商账号（带实时进度）；定时检验（5-1440 分钟可配，配置变更即时生效）；自动删除验证失败的问题账号（界面实时移除）；删除后自动等量补充注册；目标账户数量设置（低于目标值时自动注册补足，启动后 / 每次定时检测后 / 保存配置时三处触发；自动注册仅支持 Qwen AI）
  - 新增 IPC 通道：`accounts:batchValidate`（全量验证引擎，手动与定时器共用）、`accounts:removed`（删除实时推送界面）、`accounts:refillNeeded`（主进程 → 渲染端补充注册请求）
  - 注册由渲染端驱动（注册需要可见的内置浏览器窗口与临时邮箱流程）；`registeringRef` 防止手动批量注册与自动补充并发运行
- i18n：中 / 英 / 俄三语言同步新增全部维护相关文案

## [1.6.10] - 2026-10-09

### 🐛 修复 (Bug Fixes)

- 修复 Qwen AI（国际版）账号约 15 分钟后永久失效的问题：账号校验链路使用 `id:'temp'` 临时账号，token 刷新成功后写库找不到账号；而 Qwen 每次刷新都会轮换 `refresh_token`（旧值立即作废），导致新凭据从未持久化、下一次刷新必然失败。现在真实账号 ID 贯穿校验链路，轮换后的凭据正确落库
- 修复应用内登录时 Qwen AI 的 cookies 以对象（键值对）形态存储，与代理适配器、token 刷新、风控验证窗口的字符串处理逻辑冲突（`.match()`/`.split(';')` 抛错、refresh_token 提取失败）：登录采集时即序列化为标准 Cookie 头字符串（Perplexity 等依赖对象形态的 provider 不受影响），并新增 `normalizeCookies` 归一化兼容层，历史对象形态账号无需重新登录即可正常续期
- 修复全部账号不可用（503）或全部忙碌（429）时代理请求不写请求日志的问题：此前这两种路径直接返回错误，前端请求日志完全空白（"调用了但是日志无显示"）；现在 `chat.ts`/`completions.ts` 均补记请求日志与应用日志（含模型、延迟、错误信息）

### 📦 其他 (Other)

- 新增调试脚本 `scripts/inspect-store-accounts.cjs`（检查账号存储结构；注意凭据字段经 safeStorage 加密，外部脚本读取为密文属正常现象）

## [1.6.9] - 2026-09-28

### ✨ 新功能 (Features)

- Qwen AI（国际版）access token 自动续期：token 有效期仅约 15 分钟，新增共享模块 `src/main/lib/qwenAiAuth.ts`，利用 cookies 中有效期约 300 天的 `refresh_token` 调用官方 `/api/v2/auths/refresh` 接口自动换新 token 并持久化；代理转发前临期自动续期（收到 `unauthorized`/`token has expired` 时强制续期并重试一次）、账号检测前自动续期、OAuth 适配器实现 `refreshToken`，长期挂机不再因 token 过期失效
- Qwen AI 风控（WAF）验证窗口：请求被阿里云 Baxia 拦截（`FAIL_SYS_USER_VALIDATE`/`RGV587_ERROR`）时自动弹出独立验证窗口，加载 punish 滑动验证码并尝试自动滑动（类人轨迹 + 跨 iframe 定位，最多 3 次，失败可手动完成），验证通过后自动合并窗口内 cookies 回账号存储并重试原请求；同时在窗口内注入状态条提示进度

### 🐛 修复 (Bug Fixes)

- 修复 Qwen AI 登录窗口有时"不能自动读取" token 的问题：页面反爬脚本阻塞渲染进程主线程时 `executeJavaScript` 读取 localStorage 会永久挂起，导致 cookie 分支永远得不到执行；现在优先直接通过 Electron cookies API 检查 token（不依赖页面脚本），localStorage 读取增加 3 秒超时与重入保护，卡死的检查不再阻塞后续轮询
- Qwen AI 代理请求移除失效的 `bx-v`/`bx-umidtoken`/`bx-ua` 指纹头（陈旧指纹反而会触发风控），并补齐 `cnaui`/`aui` cookie；风控空响应时返回明确错误信息而非静默失败

### 📦 其他 (Other)

- 新增 Qwen AI 调试探测脚本：`scripts/qwen-refresh-full.cjs`（完整官方请求头刷新验证）、`qwen-refresh-matrix.cjs`（请求头矩阵排查）、`qwen-refresh-probe.cjs`、`qwen-bundle-analyze.cjs`（官方前端 bundle 分析）、`qwen-completions-probe.mjs`（对话链路风控复现）
- 文档同步：`docs/providers/qwen-ai.md` 新增"Token 自动续期"与"风控验证窗口"章节，`lat.md/00-project-map.md` 补充新增模块说明

## [1.6.8] - 2026-09-28

### 🐛 修复 (Bug Fixes)

- 修复 Qwen AI（国际版）登录后获取账号信息失败：`getUserInfo` 调用 `/api/v2/user/info` 时未携带浏览器 cookies，可能被阿里云风控拦截返回空数据；现在从 credentials 中提取 cookies 一并发送，并增加诊断日志便于排查

## [1.6.6] - 2026-09-28

### ✨ 新功能 (Features)

- Qwen（国内版千问）支持真实图片上传：通过 `workspace-res.qianwen.com` 的 OSS 三步上传管线（oss_token → PUT → callback）与 `chat-side.qianwen.com` 会话文件登记，将 OpenAI 多模态请求中的图片（base64 data URL 或 http(s) URL，单图 ≤10MB、单次 ≤10 张）以官方客户端一致的 `image/url` 消息形态发送给模型；上传失败时自动降级为明确的"图片已省略"提示，不中断对话

### 🐛 修复 (Bug Fixes)

- 修复多模态图片输入导致的 `[object Object]` 与内容丢失问题：新增共享内容归一化工具 `utils/messageContent.ts`，Qwen AI/Kimi/MiniMax/Z.ai/DeepSeek/GLM 等适配器不再对数组型 `content` 直接字符串化；不支持图片输入的纯文本通道（Qwen AI、Kimi、MiniMax、Z.ai、Perplexity、Mimo）现在会向模型附加明确的"图片已省略"提示，而不是静默丢弃
- 修复 `streamToolHandler.ts` 从 `toolParser/index.ts` 导入不存在符号 `createBaseChunk` 的问题（Vite 打包时被掩盖，Node ESM 直接加载会抛错）；`parseToolCallsFromText` 的导入统一指向正确的 `utils/toolParser.ts`
- 修复应用内 OAuth 登录后账号信息（名称、邮箱、userId）不自动填充：`InAppLoginResult` 接口缺少 `accountInfo` 字段，`completeWithSuccess` 调用时未透传 `validation.accountInfo`，导致前端 `AddAccountDialog` 拿到的 `OAuthResult.accountInfo` 恒为 `undefined`。该修复惠及所有使用应用内登录的 provider（qwen-ai、kimi、minimax、mimo、deepseek、glm、zai、perplexity）

## [1.6.5] - 2026-08-31

### 🐛 修复 (Bug Fixes)

- 修复托盘菜单代理状态不同步：代理随应用自启动时托盘仍显示"已停止/启动代理"，现自启动成功后同步托盘状态为"运行中"

## [1.6.4] - 2026-08-31

### 🐛 修复 (Bug Fixes)

- 修复 Linux 关机/重启后下次登录弹出"应用程序 Chat2API 已意外关闭"崩溃报告：主进程新增 SIGTERM/SIGINT/SIGHUP 优雅退出处理，避免主进程被信号杀死后 Chromium 子进程异常中止被 apport 记录为崩溃

## [1.6.3] - 2026-08-30

### 🐛 修复 (Bug Fixes)

- 开机自启增强：应用启动时按已存配置幂等同步自启注册（旧版本保存的 `autoStart` 设置更新后无需重拨开关即生效）；Linux autostart `.desktop` 文件添加可执行位，避免部分桌面环境忽略自启项

## [1.6.2] - 2026-08-30

### 🐛 修复 (Bug Fixes)

- 修复"开机自启"设置不生效：新增操作系统级自启注册（Linux 写入 `~/.config/autostart/chat2api.desktop`，Windows/macOS 使用系统登录项），Linux root 用户自启时自动附加 `--no-sandbox`

## [1.6.1] - 2026-08-30

### 🐛 修复 (Bug Fixes)

- 修复 Linux root 用户启动崩溃：检测到 root 时实际调用 `app.commandLine.appendSwitch('no-sandbox')`（之前只打日志未生效）
- 修复应用内 OAuth 登录窗口加载 `https://chat.z.ai/` 时 `ERR_CONNECTION_CLOSED` 错误：为 BrowserWindow session 设置标准 Chrome User-Agent，并添加自动重试机制（最多 3 次）

## [1.6.0] - 2026-08-30

### ✨ 新功能 (Features)

- 解锁自定义供应商功能，支持配置自定义 API 端点、认证方式、请求头和模型列表
- 添加供应商对话框新增受控 tab 状态，自定义 tab 下可直接打开创建表单

## [1.5.3] - 2026-08-29

### 🐛 修复 (Bug Fixes)

- 重构发布工作流，先创建唯一 Release 再并行构建，修复重复 Release 导致资产 404 (`7ecfb3f`)

## [1.5.2] - 2026-08-29

### 🐛 修复 (Bug Fixes)

- 设置 releaseType 为 release，使 CI 发布正式 Release 而非 draft (`ca00811`)

## [1.5.1] - 2026-08-29

### 🐛 修复 (Bug Fixes)

- 修正 linux.desktop 配置为 electron-builder 26.x 的 entry 格式，修复 CI 全平台构建失败 (`ea03168`)

## [1.5.0] - 2026-08-29

### ✨ 新功能 (Features)

- 新增自动版本发布脚本，支持按 Conventional Commits 自动生成版本号和修改日志 (`
fc5823`)

### 🐛 修复 (Bug Fixes)

- 修复发布失败——同步 package-lock.json 版本号并修正 vite 依赖版本 (`7e53264`)
- 修复首次无 tag 发布时只统计根提交导致漏记后续提交的问题 (`
08fe4c`)
- 修复 auto-release 脚本 git log 分隔符在 execSync 中的 null 字节报错 (`
87b32e`)

### 📦 其他 (Other)

- 将项目迁移到 wxs0625/Chat2API-WXS 仓库，清除 xiaoY233 源仓库信息 (`
ce2b9f`)
