# PetLink · Mac 双人桌宠消息

把文字、链接、图片和文件送到朋友桌面的小猫气泡里。双方安装后，交换一次邀请码即可配对；不需要 Discord、账号或自建服务器。

## 下载

[下载最新版](https://github.com/Zy-zz/petlink-mac/releases/latest)

当前版本 **0.3.0**：

- [Mac 安装包 DMG](https://github.com/Zy-zz/petlink-mac/releases/download/v0.3.0/PetLink-0.3.0-mac-arm64.dmg)
- [Mac 应用 ZIP](https://github.com/Zy-zz/petlink-mac/releases/download/v0.3.0/PetLink-0.3.0-mac-arm64.zip)
- [源码 ZIP](https://github.com/Zy-zz/petlink-mac/releases/download/v0.3.0/PetLink-0.3.0-source.zip)
- [SHA-256 校验文件](https://github.com/Zy-zz/petlink-mac/releases/download/v0.3.0/PetLink-0.3.0-SHA256SUMS.txt)

## 安装与使用

当前安装包适用于 **Apple Silicon Mac，macOS 13 或更高版本**。

1. 从上方下载 DMG，打开后把 PetLink 拖入 Applications（应用程序）。升级时先退出旧版，再用新版替换原应用；配对和聊天记录会保留。建议双方都安装 0.3.0，Toss 功能最低需要 0.2.0。
2. 双方运行 PetLink。一方填写昵称，点击「邀请一个小伙伴」，复制邀请码发给对方。
3. 对方填写昵称，选择「我有邀请码」，粘贴后连接。邀请码只应交给想配对的人；第一位加入者会成为固定小伙伴。
4. 显示「小伙伴在线」后，发送文字、HTTP/HTTPS 链接或附件。对方的小猫旁直接出现气泡，点击「回一句」回复。

安装包使用本地 ad-hoc 签名，未用 Apple Developer ID 签名或公证。从网络下载时，macOS 可能要求在「系统设置 → 隐私与安全」选择「仍要打开」。无需辅助功能、屏幕录制或远程控制权限。

桌宠默认是 96 × 108 的像素小猫，比早期版本更小。聊天窗口的「桌宠」下拉框可切换像素小猫、像素小兔，或选择自己的图片（PNG/JPEG，最大 2 MiB，推荐透明背景 PNG）。自定义图片复制到本机配置，原文件移动或删除不影响桌宠；选择会在重启后保留。

拖住桌宠身体任意位置即可移动，松手保存位置；点一下小猫或菜单栏的 🐾 打开聊天。关闭聊天窗口会留在后台；从菜单栏选择「退出」才完全退出。聊天页的「暂停弹出」只暂停气泡，收到的内容仍保留在本机记录。

## 甩东西到对方桌面

1. 写文字或添加 PNG/JPEG/WebP/GIF 图片，点击「Toss」选择落点。
2. 在你自己的屏幕点一下。落点按对应屏幕的相对位置映射到 TA 的桌面；如果 TA 没有那块屏幕，使用主屏幕。边缘会自动调整以保持整个物件可见。
3. 点击发送区的「Toss」。TA 的宠物气泡和聊天记录会显示请求、内容预览、落点以及「确认接住 / 拒绝」按钮。
4. **只有 TA 本机点击确认后**，内容才会在落点播放甩入动画。拒绝不会创建桌面物件；发送方收到确认或拒绝反馈。

请求 5 分钟内有效，同一个请求只能处理一次。桌面物件只显示原文字和图片，没有卡片背景、边框、发送人或文件名；图片保持原文件及透明背景，按比例缩放显示。鼠标移到物件上才显示 ×，也可按 Esc 关闭。退出应用后不自动恢复物件。桌面同时最多放 8 个物件。对方离线时仍可以处理已收到的请求，但确认反馈可能暂时无法通知发送方。

这些物件是透明置顶显示，不会创建 Finder 文件、改壁纸或移动对方桌面上的文件图标。选落点无需截屏或远程控制权限。

## 内容与送达

- 文字：最多 4,000 个字符；链接由用户点击后在默认浏览器打开，不自动请求预览。
- 图片：PNG、JPEG、WebP、GIF；可以选文件、拖入或在输入框粘贴。保留原文件内容和透明背景，不自动转换成 JPEG；单个文件最多 5 MiB，静态图片最多 6,400 万像素。
- 其他附件：单个文件最多 **5 MiB**。支持保存任意文件；常见音频、MP4/WebM 可在气泡里手动播放，格式能否播放取决于 Electron 的解码器。
- 必须双方在线。「已送达」表示收方客户端已经验证并保存消息，然后发回确认；不表示对方已经阅读。断线或超时保留输入内容供重试。
- 本机保留最近最多 40 条消息，附件编码总量上限 24 MiB；超过时移除最旧消息。此版本没有云端离线收件箱，也不会自动保存全部收到的文件到 Downloads。

## 联机与隐私

消息经过 `nos.lol`、`nostr.mom`、`relay.snort.social` 公共 Nostr 中继转发。中继能看到连接 IP、公开身份标识、房间主题和发送时间，消息内容使用配对双方的 ECDH 密钥经 HKDF 派生后 AES-256-GCM 加密。事件还使用 Schnorr 签名并校验，配对后固定对方身份，第三个客户端不会被加入。

每条加密消息使用新的随机 12 字节 nonce 和 16 字节认证标签。ECDH 使用 secp256k1，HKDF 使用 SHA-256 与邀请码内随机 256 位 secret 作为 salt。甩东西的坐标、内容及确认结果同样在密文内；确认回执代表收方客户端已接收和保存，不代表人已确认甩东西。

当前配对使用固定身份密钥派生，未实现 Signal 双棘轮或前向保密；本机密钥和聊天记录也未做额外静态加密。

公共中继使用临时事件转发，不作为离线消息存储。收到消息使用收方确认，重传不会重复弹出。同一公网中继可访问是跨网络互通的前提；公共服务不可用时应用会重连，并拒绝声称消息已送达。最大文件需要分片，传输速度及成功率受中继限流影响。

身份密钥、配对信息及本机消息记录保存在 `~/Library/Application Support/PetLink/`，目录权限 0700、文件权限 0600；本机记录未做额外静态加密。「断开配对」会清空当前本机历史并停止接收原房间消息。

## 仓库权限

此仓库公开供浏览、下载和提交反馈，由 [Zy-zz](https://github.com/Zy-zz) 维护。未添加其他协作者，其他人不能直接推送代码、合并 PR 或发布新版本；Issue 和 PR 需要维护者处理。公开仓库仍可被 fork，fork 不会修改这里的代码。

## 开发和验证

使用 Node 22.22 或更高版本：

```sh
npm ci
npx install-electron
npm start
npm test
npm run test:ui
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron test/public-relay.cjs
npm run build:mac
```

`npm test` 包含真实 WebSocket 中继、身份固定、双向收发、分片、收方确认、重传去重、篡改拒绝、重连和 5 MiB 文件边界，以及拖动/点击事件区分和桌面坐标映射。`test:ui` 启动两个独立 Mac Electron 进程，通过真正的输入框与按钮完成配对和收发，检查气泡、附件保存、链接、HTML 转义、暂停弹出、重启恢复，桌宠缩小、内置桌宠切换、自定义图片与重启保持，以及甩东西的落点选择、确认前不显示、拒绝、确认后图片/文字落点和重复确认拦截。

`test/public-relay.cjs` 是主动公网测试，发送随机测试数据，不使用用户的配对信息；结果保存在 `test-output/public-relay-result.json`。`PETLINK_PROFILE` / `PETLINK_RELAYS` / `PETLINK_HIDDEN` 环境变量只用于隔离测试和指定测试中继。

## REA 分析依据

本项目按需求使用 [REA](https://github.com/morluto/rea) 分析了 [lolPing](https://github.com/darrenprx/lolPing) 发布的 **v0.5.1 Mac 安装包中的 app.asar**。报告、安装包身份摘要和实际使用的命令见 [research/REA-FINDINGS.md](research/REA-FINDINGS.md)。

借鉴的是桌面浮层、分离 preload/IPC 和通过公共中继连接房间的行为。小猫 SVG、文字/图片/文件消息协议、双人固定身份与收方回执属于 PetLink 的实现；没有复制英雄联盟的图片或音效。

本项目采用 MIT 许可证。第三方运行时与依赖保留其各自许可证。
