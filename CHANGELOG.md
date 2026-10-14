# 修改日志 (Changelog)

本项目的所有重要变更都会记录在此文件中。

## [1.7.6] - 2026-10-14

### 🐛 修复 (Bug Fixes)

- 修复 Linux 上拼图「Geepass 调用失败（计费但 ❌）、滑块始终不动」的问题：Linux 端 canvas 取图被跨域拦截后走回退链，提交给 Geepass 的是**原始字节**——原图超过 1024px 或为 WebP/AVIF 等格式时服务端直接拒绝（账单显示调用失败），识别永远抛错导致滑块一动不动；Windows 端 canvas 成功提交缩放后的 PNG 故正常，形成「Windows ✅ / Linux ❌」差异。现在主进程在提交前用 Electron `nativeImage` 统一**解码 → 转 PNG → 缩放至 50–1024px**（背景图与滑块块图都归一化），任何来源/格式的图像都能被服务端接受
- 页面端取图新增空白图检测：部分 Linux 构建下 canvas 不抛错而是输出全透明空白图（同样被服务端判失败），现在对 canvas 结果抽样像素，颜色种类过少即视为空白并改走 data: URL / fetch 回退链

## [1.7.5] - 2026-10-14

### 🐛 修复 (Bug Fixes)

- 修复 v1.7.4 引入的拼图「完全不识别、滑块不动」回归，两处自伤缺陷：① 向 Geepass 20110 单图识别额外传 `slide` 消歧义图反而导致识别报错或返回滑块块自身位置——恢复为纯单图调用（仅当连续两次失败且已取到滑块块图时才回退 20111 双图模式）；② 滑块块精灵选取按「面积最小」，而背景上的白色缺口剪影本身是独立精灵、面积与滑块块相当，误选缺口会使「缺口中心 − 滑块块位置」≈ 0，命中异常判定后**直接放弃不重试**——改为取**最左侧**精灵（初始态滑块块恒在缺口左侧），并增加合理性校验：检测到的「滑块块」若不在缺口左侧则回退为轨道起点假设
- 「识别结果异常」（distance < 5）不再直接放弃：自动点击刷新按钮换一张新图进入下一轮尝试，避免一次坏识别就整轮卡死
- 全局 watcher 检测到拼图但 Geepass 未启用（开关关闭或 token 未配置）时，注册窗口状态条每 30s 提示一次「检测到拼图验证，但 Geepass 未启用，请手动拖动滑块」，不再静默无反应，便于区分「没开开关」与「识别故障」

## [1.7.4] - 2026-10-14

### 🐛 修复 (Bug Fixes)

- 修复拼图验证「有时识别有时不识别」：此前注册流程只在两个等待节点（提交邮箱后、填写验证码后）内嵌检测拼图，其它阶段（初始表单加载、年龄确认弹窗、协议勾选等）弹出的拼图无人处理。现在注册全程挂载**全局拼图 watcher**（`startPuzzleWatcher`，每 2.5s 探测一次），窗口存活期间任意时刻出现的拼图都会被自动识别求解；watcher 与流程内嵌调用通过并发去重（同一窗口同一时刻只跑一个求解任务），注册结束自动停止
- 修复「识别经常出错」：① 拼图背景上同时存在可移动滑块块精灵与缺口剪影，单图识别（20110）经常锁定滑块块而非缺口——现在探测阶段额外提取滑块块图像，作为 `slide` 消歧义参数一并提交给 Geepass；② 此前拖动距离假设滑块块始终位于轨道最左端，而验证失败后滑块块停留在拖过的位置不回弹，导致重试时位移误差累积——现在探测滑块块的**当前中心位置**，按「缺口中心 - 滑块块当前位置」精确计算拖动距离
- 修复「出错也没有重试」：求解改为最多 3 次完整尝试（识别 → 拖动 → 校验），识别 API 调用失败时先点刷新按钮换图再重试一次；拖动后验证未通过（页面显示「验证失败，请重试」红色横幅）时自动点击拼图右上角**刷新按钮**换一张新图重新识别，不再对着失败横幅重复拖同一个错位距离；探测阶段还会识别失败横幅文案辅助日志诊断

### 📦 其他 (Other)

- 拼图日志增强：成功探测时记录滑块块位置与刷新按钮命中情况（`piece=… refresh=yes/no`），每次识别输出 `gap x=… scale=… pieceStart=… distance=… attempt=n`，失败重试输出 `attempt n/3 failed, refreshing puzzle`，便于定位剩余问题

## [1.7.3] - 2026-10-12

### 🐛 修复 (Bug Fixes)

- 修复 Qwen AI 注册页拼图在 Linux 上升级 v1.7.2 后仍不自动求解的问题：旧探测脚本仅依赖固定类名选择器定位拖柄（注册页类名为哈希化、无法匹配），且要求拼图背景必须是 `canvas` 或宽高比大于 1.5 的图片，探测失败时静默返回空、Geepass 全程不参与。现探测改为**三层策略**——① 已知选择器；② 文本扫描（依据「拖动滑块完成拼图 / drag the slider」等提示文案定位轨道容器，取其内最左侧方形子元素为拖柄）；③ 结构扫描（在拼图背景图附近查找横向长条，取其内最左侧小方块旋钮）。背景图候选放宽为任意横向 `img`/`canvas`，并取距拖柄最近者
- 背景图提取新增回退链：`canvas` 提取因跨域污染（`drawImage` + `toDataURL` 抛错）失败时，自动回退为直接读取 `img` 的 `data:` URL，或 `fetch` 图片原始字节转 base64；配套新增图片头解析（PNG / JPEG / WebP）从原始字节解码真实像素宽度，保证缺口坐标按正确比例换算为 DOM 拖动距离
- 拼图探测诊断增强：探测失败时主进程日志输出 `[PuzzleSolver] probe: frame(...): no-bg / no-handle / bg-extract-failed` 及命中路径（`via=selector/text/structure`、`bgVia=canvas/dataurl/fetch`），可在应用日志页查看以定位具体原因；成功时记录背景显示宽度、提交宽度与轨道宽度

## [1.7.2] - 2026-10-12

### ✨ 新功能 (Features)

- Qwen AI **自动注册流程**接入 Geepass 拼图滑块自动过验证：此前 Geepass 识别仅作用于风控验证窗口，注册窗口内弹出的「访问验证 / 拖动滑块完成拼图」拼图不会自动处理（即使已开启 Geepass 开关并配置 token）。现在注册流程在两个关键节点自动检测并求解拼图——① 提交邮箱后等待 6 位验证码输入框出现时；② 填写验证码后等待页面跳转完成登录时。拼图出现即自动识别缺口并以类人轨迹拖动，进度通过注册窗口状态实时提示（`检测到拼图验证，Geepass 正在识别缺口…` → `Geepass 识别成功，正在拖动滑块…` → `拼图验证通过`）；为容纳识别 + 拖动耗时，验证码输入框等待超时从 30s 放宽至 60s

### 📦 其他 (Other)

- 拼图求解逻辑抽取为共享模块 `src/main/lib/puzzleSolver.ts`（跨 iframe 探测拼图背景与拖柄、base64 提取并自动缩放至 Geepass 要求的 50–1024px、缺口识别、类人轨迹拖动：缓出 + 过冲回纠 + y 抖动 + 随机微停顿、失败自动重试并在缺口刷新时重新识别），风控验证窗口与注册流程统一复用，删除风控窗口中约 340 行重复实现

## [1.7.1] - 2026-10-12

### 🐛 修复 (Bug Fixes)

- 修复内嵌 mihomo 核心在 Linux / macOS 上无法使用的问题：此前内核下载与解压逻辑为 Windows 专属（powershell.exe 解压、`.exe` 二进制名、windows zip 资产），Linux 端报 `解压 mihomo 失败: spawn powershell.exe ENOENT`。现在按平台选择对应发布资产（Windows 取 zip；Linux / macOS 取单二进制 `.gz`，用 node 内置 zlib 直接解压、不依赖任何外部命令；zip 在非 Windows 平台回退 `unzip`），二进制名按平台区分（`mihomo` / `mihomo.exe`），非 Windows 平台解压后自动赋予可执行权限（chmod 755）

## [1.7.0] - 2026-10-12

### ✨ 新功能 (Features)

- 网络代理（上游代理）设置体系：设置页新增「网络代理」区块，代理转发的上游请求可统一走指定代理，支持三种代理来源：
  - **手动输入**：直接填写代理地址（如 `http://127.0.0.1:7890`）
  - **本机 Clash**：填写 Clash 订阅链接，自动拉取并解析订阅（兼容 gzip / deflate / base64 编码与 flow 内联 YAML；IP + 自签证书的面板亦可正常拉取），据此探测本机 Clash 的 mixed-port；未检测到本机 Clash 时自动回退内嵌核心拨号
  - **内嵌 mihomo 核心**：应用内置 Clash Meta（mihomo）核心生命周期管理——首次使用自动下载对应架构的 Windows 内核到用户数据目录 `clash-core/`（优先 GitHub API，不可达时回退解析 releases 页面拼直链，也可手动放入内核或用环境变量 `CHAT2API_MIHOMO_ZIP_URL` 指定安装包），基于订阅内容生成独立配置并在随机空闲端口拨号，应用退出自动回收
- 订阅出口节点选择：自动解析订阅中的全部节点，可在设置中指定固定出口节点（向配置注入 `CHAT2API-SELECT` 策略组 + `MATCH` 规则实现定向）；不指定则沿用订阅自带策略
- Geepass 拼图滑块自动过验证：Qwen AI 风控滑块为拼图 / 滑动类型时，可配置 Geepass 服务 token 自动识别缺口并完成滑动（20110 图片拼图 / 20111 滑动条两种方案），验证窗口按设备 DPI 自动缩放保证轨迹坐标准确；设置页提供 token 配置与连通性测试入口

### 📦 其他 (Other)

- i18n：中 / 英 / 俄三语言同步新增网络代理与 Geepass 相关全部文案

## [1.6.13] - 2026-10-11

### ✨ 新功能 (Features)

- Qwen AI 自动注册优先复用已有临时邮箱：注册前先列出临时邮箱服务中 `chat2api` 前缀的地址，排除掉已绑定账户的地址后复用第一个空闲邮箱，只有全部被占用（或列表查询失败）时才新建。复用地址无需地址 JWT（读取邮件走管理端点），可减少临时邮箱服务中的地址堆积与频繁新建触发的限流；若复用的邮箱被 Qwen 判定为已注册 / 被拒绝，会自动新建一个邮箱重试一次。注册进度提示会显示「复用临时邮箱: xxx」以区分本次是复用还是新建

### 🐛 修复 (Bug Fixes)

- 修复网络故障导致账户被批量误删的问题：此前 DNS 解析失败、连接超时、连接被拒绝等**网络层错误**与「凭据失效」共用同一条失败路径，账户会被标记为 error，随后被自动删除逻辑清除（一次网络抖动即可导致 20+ 个账户被全部删空，自动注册的补充入口也随之消失）。现在新增网络错误识别（`ENOTFOUND` / `EAI_AGAIN` / `ECONNREFUSED` / `ECONNRESET` / `ECONNABORTED` / `ETIMEDOUT` / `ENETUNREACH` / `EHOSTUNREACH` / `ENETDOWN` 及 axios `Network Error`），并以 `networkError` 标记贯穿「token 校验 → 验证器 → 账户状态更新 → 定时全量检测」整条链路：网络错误时不降级账户状态、全量检测跳过该账户并记 warn 日志、绝不触发自动删除，网络恢复后下一次检测即可正常判定
- Qwen AI 账户校验失败时先尝试重新认证：验证不通过会先用 cookies 中的 `refresh_token` 强制续期（轮换后的凭据立即持久化），再以新 token 重试一次验证，成功即恢复 active，避免仅因 access token 过期（有效期约 15 分钟）就把可用账户判为失效

## [1.6.12] - 2026-10-11

### 🐛 修复 (Bug Fixes)

- 修复自动注册流程"卡死"问题：自动注册失败时（临时邮箱服务不可达、验证码超时、页面被风控拦截等），注册窗口此前会一直保持打开直到 5 分钟全局超时才返回失败，导致批量注册 / 自动补充循环长时间挂起。现在失败后仅保留 30 秒宽限期（期间仍可在窗口中手动完成注册），超时未捕获到 token 即立即失败并继续下一个账号
- 修复设置自动注册后无法手动停止：此前「停止」按钮只存在于批量注册对话框中，由目标账户数量 / 删除后补充触发的自动注册无法中断。现在账户列表头部在任意注册进行中（手动单个 / 批量 / 自动补充）都会显示常驻的红色「停止」按钮
- 自动补充流程现在响应取消信号：每次迭代前检查取消标志，注册间隔等待改为可中断（每 500ms 检查一次），点击停止后立即退出等待，不再空转到间隔结束

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
