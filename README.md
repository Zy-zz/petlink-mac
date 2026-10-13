# PetLink · Mac 双人桌宠消息

把文字、链接、图片和文件送到朋友桌面的小猫气泡里。双方安装后，交换一次邀请码即可配对；不需要 Discord、账号或自建服务器。

## 安装与使用

当前安装包适用于 **Apple Silicon Mac，macOS 13 或更高版本**。

1. 打开 `dist/PetLink-0.1.0-mac-arm64.dmg`，把 PetLink 拖入 Applications。
2. 双方运行 PetLink。一方填写昵称，点击「邀请一个小伙伴」，复制邀请码发给对方。
3. 对方填写昵称，选择「我有邀请码」，粘贴后连接。邀请码只应交给想配对的人；第一位加入者会成为固定小伙伴。
4. 显示「小伙伴在线」后，发送文字、HTTP/HTTPS 链接或附件。对方的小猫旁直接出现气泡，点击「回一句」回复。

安装包使用本地 ad-hoc 签名，未用 Apple Developer ID 签名或公证。从网络下载时，macOS 可能要求在「系统设置 → 隐私与安全」选择「仍要打开」。无需辅助功能、屏幕录制或远程控制权限。

宠物头顶可拖动；点击小猫或菜单栏的 🐾 打开聊天。关闭聊天窗口会留在后台；从菜单栏选择「退出」才完全退出。聊天页的「暂停弹出」只暂停气泡，收到的内容仍保留在本机记录。

## 内容与送达

- 文字：最多 4,000 个字符；链接由用户点击后在默认浏览器打开，不自动请求预览。
- 图片：PNG、JPEG、WebP、GIF；可以选文件、拖入或在输入框粘贴。较大的静态图片会缩到最长边 1,280 像素并转为 JPEG。
- 其他附件：单个文件最多 **5 MiB**。支持保存任意文件；常见音频、MP4/WebM 可在气泡里手动播放，格式能否播放取决于 Electron 的解码器。
- 必须双方在线。「已送达」表示收方客户端已经验证并保存消息，然后发回确认；不表示对方已经阅读。断线或超时保留输入内容供重试。
- 本机保留最近最多 40 条消息，附件编码总量上限 24 MiB；超过时移除最旧消息。此版本没有云端离线收件箱，也不会自动保存全部收到的文件到 Downloads。

## 联机与隐私

消息经过 `nos.lol`、`nostr.mom`、`relay.snort.social` 公共 Nostr 中继转发。中继能看到连接 IP、公开身份标识、房间主题和发送时间，消息内容使用配对双方的 ECDH 密钥经 HKDF 派生后 AES-256-GCM 加密。事件还使用 Schnorr 签名并校验，配对后固定对方身份，第三个客户端不会被加入。

公共中继使用临时事件转发，不作为离线消息存储。收到消息使用收方确认，重传不会重复弹出。同一公网中继可访问是跨网络互通的前提；公共服务不可用时应用会重连，并拒绝声称消息已送达。最大文件需要分片，传输速度及成功率受中继限流影响。

身份密钥、配对信息及本机消息记录保存在 `~/Library/Application Support/PetLink/`，目录权限 0700、文件权限 0600；本机记录未做额外静态加密。「断开配对」会清空当前本机历史并停止接收原房间消息。

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

`npm test` 包含真实 WebSocket 中继、身份固定、双向收发、分片、收方确认、重传去重、篡改拒绝、重连和 5 MiB 文件边界。`test:ui` 启动两个独立 Mac Electron 进程，通过真正的输入框与按钮完成配对和收发，检查气泡、附件保存、链接、HTML 转义、暂停弹出和重启恢复。

`test/public-relay.cjs` 是主动公网测试，发送随机测试数据，不使用用户的配对信息；结果保存在 `test-output/public-relay-result.json`。`PETLINK_PROFILE` / `PETLINK_RELAYS` / `PETLINK_HIDDEN` 环境变量只用于隔离测试和指定测试中继。

## REA 分析依据

本项目按需求使用 [REA](https://github.com/morluto/rea) 分析了 [lolPing](https://github.com/darrenprx/lolPing) 发布的 **v0.5.1 Mac 安装包中的 app.asar**。报告、安装包身份摘要和实际使用的命令见 [research/REA-FINDINGS.md](research/REA-FINDINGS.md)。

借鉴的是桌面浮层、分离 preload/IPC 和通过公共中继连接房间的行为。小猫 SVG、文字/图片/文件消息协议、双人固定身份与收方回执属于 PetLink 的实现；没有复制英雄联盟的图片或音效。

本项目采用 MIT 许可证。第三方运行时与依赖保留其各自许可证。
