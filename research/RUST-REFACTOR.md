# PetLink Rust 重构与方案比较

检索及本机验证日期：2026-10-13。基线：main 的 `5a7ab58`（0.4.1）。已发布资产的体积基线来自 本次查询的 GitHub 最新 Release v0.4.0；该 Release 的 DMG 是 150,033,773 字节、ZIP 是 130,031,696 字节。Rust 0.5.0 发布包来自重构 PR 的提交，Release 发布与 PR 合并是分别处理的状态。

## 为什么原安装包大

本机原 Electron 0.4.1 app 的 Frameworks 占约 287 MiB，Resources 约 17.5 MiB。主要成本是运行时，与小猫 SVG 和业务逻辑大小无关。Electron 随包携带 Chromium 和 Node.js，单纯精简 JavaScript 或压缩图片不能去掉它们。[Electron 官方说明](https://www.electronjs.org/docs/latest/)

## 框架选择

| 方案 | 对这个项目的适用性 | 本次决定 |
| --- | --- | --- |
| Rust + Tauri 2 | 使用系统 WKWebView，复用现有 HTML/CSS；Rust 管理通信、文件、窗口和更新 | 采用。避免携带浏览器运行时，迁移时保留已经验证的 UI |
| Rust + objc2/AppKit | 直接使用 macOS 控件和窗口，进一步减少 WebView 的需求 | 可行，但需重写聊天、附件、媒体预览等整个界面；实际包体积不能凭框架名称推算 |
| Rust + egui/eframe | 适合自绘工具和图形界面，有 wgpu/glow 渲染后端 | 会重写界面，并需要处理原有网页媒体和 macOS 浮层行为；这里收益不足 |
| Rust + Slint | 支持原生 UI，有软件渲染等后端可选 | 需要新 UI 描述和附件媒体实现；无已有 Slint 代码可复用 |
| 保留 Electron | 迁移成本最低 | 可以优化依赖，但仍然携带运行时，无法实现本次主要体积目标 |

依据：[Tauri 系统 WebView](https://v2.tauri.app/reference/webview-versions/)、[Tauri 进程模型](https://v2.tauri.app/concept/process-model/)、[objc2 AppKit 示例](https://docs.rs/objc2/latest/objc2/)、[eframe](https://github.com/emilk/egui/blob/main/crates/eframe/README.md)、[Slint 渲染后端](https://docs.slint.dev/latest/docs/slint/guide/backends-and-renderers/backends_and_renderers/)。选型是结合本项目的判断，不是所有 Mac 应用的通用排名。

## 各模块的取舍

| 模块 | 审核结果与实现 |
| --- | --- |
| UI / 桌宠 / 气泡 | 保留原网页布局；只替换 IPC bridge。窗口、菜单和对话框交给 Rust/Tauri；有权修改配对或安装更新的操作仅允许聊天窗口调用。网页不能任意跳转或创建外部窗口 |
| 透明浮层 | AppKit 窗口级别和 collection behavior 保留全屏及所有 Spaces 上的显示。Tauri macOS 透明窗口需要 `macos-private-api`。这个构建面向 GitHub 直接分发；Mac App Store 路线需重新审核。正常显示屏工作区使用 NSScreen visibleFrame，坐标不包含 Dock 和菜单栏 |
| 配对与加密 | 保留 PL1、现有 kind 24747 和 secp256k1 ECDH → HKDF-SHA256 → AES-256-GCM，兼容旧版。使用成熟密码库而非自己实现算法；校验事件 ID、Schnorr 签名、AAD、nonce、片段大小、时效和固定对方身份 |
| 在线状态 | 不把 relay 的 OK 或历史 hello 当作对方在线；继续使用新鲜挑战响应。断线重连后重新证明在线；机器从长时间睡眠恢复时重建会话 |
| 消息送达 | 收方持久化成功之后才发 ACK。失败不返回 ACK，发送端保留输入供重试。传输使用有界队列，并保留重传和去重。状态没有变化时不重复广播，不会每收一个文件分片就复制消息到所有窗口 |
| 图片 / 文件 | 保留原图及透明度，最大 5 MiB；继续通过中继分片，没有增加附件存储服务器。Base64 嵌套使 5 MiB 文件的密文传输量约 8.9 MiB，速率仍受公共中继限制 |
| 本机存储 | 沿用 Application Support/PetLink 的 config.json、history.json 以直接迁移。每个文件临时写入、fsync 后替换；目录 0700、文件 0600。用配置目录锁限制 Rust 多实例。最多 40 条记录和 24 MiB 附件编码，暂不引入数据库。损坏文件报错并保留，不自动生成新身份覆盖 |
| Toss | 落点相对工作区映射；必须收方本机确认，5 分钟过期，同请求不能重复创建，最多 8 个物件。处理时中断重启后回到待处理，因为桌面物件本身不跨会话恢复 |
| 更新 | Rust 移植原 GitHub ZIP 更新流程：限域名、限制重定向、流式下载、SHA-256/大小/版本/架构/签名校验；正式签名应用只接受同一团队且通过公证的包。ZIP 禁止越界路径、特殊文件和越界符号链接。保留安装确认、备份、失败回滚和 quarantine |
| 发布 | Tauri 构建 app；现有 Developer ID / notarytool 凭据用于签名、公证和 stapling；无凭据时正式发布直接失败。Node 只用于开发/CI，不在安装包里。Release 用 opt-level=s、LTO、单 codegen unit 和 strip，实际体积由产物测量 |

更新替代方案：Tauri 官方 updater 支持强制更新签名，但需要新的签名密钥和 macOS tar.gz 资产体系；这里保留已有 ZIP 校验和迁移行为，避免同时更换用户升级渠道。以后可以单独切换，不能直接用未配置的 updater 冒充可用自动更新。[Tauri Updater](https://v2.tauri.app/plugin/updater/)

通信替代方案：NIP-17 + NIP-44 + gift wrap 可以改善元数据隐私，但会改变现有协议，并不能提供前向保密。Rust 改写也不会自动获得前向保密。本次没有引入 ratchet 或 MLS。[NIP-17](https://nips.nostr.com/17)、[NIP-44 限制](https://nips.nostr.com/44)

大附件的标准方向是客户端加密后交给 blob 存储，再传 URL/hash。Nostr 索引已把 NIP-96 标为不推荐、由 Blossom 替代；Blossom 使用 SHA-256 内容寻址。它能减少中继负担，但引入存储、配额、删除、可用性和新隐私边界，当前“双方在线、无需自建服务器、5 MiB”场景不强行增加。[NIPs 索引](https://nips.nostr.com/)、[Blossom 服务实现](https://github.com/hzrd149/blossom-server)

构建参数依据：[Cargo profiles](https://doc.rust-lang.org/cargo/reference/profiles.html)。透明窗口依据：[Tauri Window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/)。

## 实测体积

本地 ad-hoc arm64 构建；未计为正式 Apple 公证包。

| 产物 | 已发布 Electron v0.4.0 | Rust v0.5.0 |
| --- | ---: | ---: |
| DMG | 150,033,773 字节 | 3,731,102 字节（缩小 97.51%） |
| ZIP | 130,031,696 字节 | 3,349,029 字节（缩小 97.42%） |

应用 bundle 实测约 9.47 MiB；该数字来自 Tauri 打包输出。

源码体积、压缩下载体积与安装后应用大小是不同指标；不据此声称内存减少了相同比例。Rust WKWebView 仍使用系统 WebKit 进程。

## 验证记录

- Rust 协议/持久化/坐标/权限/更新 ZIP 测试；真实 WebSocket 互通、旧版邀请方和加入方、中文、Toss、快捷互动、完整 5 MiB 文件、重传去重、第三人拒绝和断线重连。
- 两个真实 macOS app 进程 + WKWebView：通过实际输入框和按钮配对、收发、气泡回复、图片 FileReader/原字节、Toss 选屏/确认/关闭/重复确认、重启保持状态及 IPC 权限拦截。测试求值桥仅在 debug build 编译，release 没有此入口。
- 保留旧 peer 实现在 `test/legacy/`，只用于协议回归和互通验证，不进入应用包。没有保留第二套应用后台。
- 本机打包 app 的 UI 经实际 accessibility / screenshot 检查；真实 GitHub 更新查询另行验证。DMG 校验和和 ad-hoc 代码签名验证。
- 两个隔离 Rust 客户端在公网各连通全部 3 个默认中继；真实 WSS TLS、签名加密配对、文字及 1 KiB 二进制附件的 ACK / 持久化通过。
- 尚无本次真实 Developer ID 签名/公证证据，也没有把新版本安装进用户现有 Applications/PetLink.app。不同 macOS 版本的解码器能力以及混合 DPI 外接显示器/全屏 Spaces 仍需真实设备覆盖。

## 安装注意

从 Electron 0.4.x 首次升级需要先退出旧版，手动替换应用。旧更新器限定 CFBundleExecutable=Electron，不能直接安装 Rust 包。Rust 版仍使用同一个数据目录和身份，已有配对双方无需重新交换邀请码。旧版未实现目录锁，所以替换前退出旧应用仍是必要步骤。

媒体播放能力改为系统 WebKit；某些旧 Chromium 能播放的音视频可能只提供保存，需要实际格式和系统版本确认。公共中继仍无离线收件箱，端到端内容加密不隐藏连接 IP/身份/房间主题，也不加密本机历史。

## 术语

| 术语 | 英文全称 / 中文 | 本项目中的作用 |
| --- | --- | --- |
| [WKWebView](https://v2.tauri.app/reference/webview-versions/) | WebKit Web View / 系统网页视图 | 使用 macOS 已安装的渲染引擎 |
| [IPC](https://v2.tauri.app/concept/process-model/) | Inter-Process Communication / 进程间通信 | 网页请求 Rust 后台执行受限制操作 |
| [ECDH](https://nips.nostr.com/44) | Elliptic Curve Diffie-Hellman / 椭圆曲线密钥协商 | 配对双方计算共享密钥材料 |
| [HKDF](https://nips.nostr.com/44) | HMAC-based Key Derivation Function / 基于 HMAC 的密钥派生 | 从共享材料和邀请 salt 派生消息密钥 |
| [ACK](../src-tauri/src/peer.rs) | Acknowledgement / 确认回执 | 证明收方客户端已保存消息，不代表人已阅读 |
| [LTO](https://doc.rust-lang.org/cargo/reference/profiles.html) | Link-Time Optimization / 链接时优化 | 让编译器跨依赖优化和删除未用代码 |
