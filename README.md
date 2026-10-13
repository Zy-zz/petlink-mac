# PetLink · Mac 双人桌宠消息

把文字、链接、图片和文件送到朋友桌面的小猫气泡里。双方安装后，交换一次邀请码即可配对；不需要 Discord、账号或自建服务器。

## 下载

[下载最新版](https://github.com/Zy-zz/petlink-mac/releases/latest)

当前版本 **0.4.0**：

- [Mac 安装包 DMG](https://github.com/Zy-zz/petlink-mac/releases/download/v0.4.0/PetLink-0.4.0-mac-arm64.dmg)
- [Mac 应用 ZIP](https://github.com/Zy-zz/petlink-mac/releases/download/v0.4.0/PetLink-0.4.0-mac-arm64.zip)
- [源码 ZIP](https://github.com/Zy-zz/petlink-mac/releases/download/v0.4.0/PetLink-0.4.0-source.zip)
- [SHA-256 校验文件](https://github.com/Zy-zz/petlink-mac/releases/download/v0.4.0/PetLink-0.4.0-SHA256SUMS.txt)

## 安装与使用

当前安装包适用于 **Apple Silicon Mac，macOS 13 或更高版本**。

1. 从上方下载 DMG，打开后把 PetLink 拖入 Applications（应用程序）。升级时先退出旧版，再用新版替换原应用；配对和聊天记录会保留。建议双方都安装 0.4.0，Toss 功能最低需要 0.2.0。
2. 双方运行 PetLink。一方填写昵称，点击「邀请一个小伙伴」，复制邀请码发给对方。
3. 对方填写昵称，选择「我有邀请码」，粘贴后连接。邀请码只应交给想配对的人；第一位加入者会成为固定小伙伴。
4. 显示「小伙伴在线」后，发送文字、HTTP/HTTPS 链接或附件。对方的小猫旁直接出现气泡，点击「回一句」回复。

**已发布的 0.4.0 安装包**使用本地 ad-hoc 签名，未用 Apple Developer ID 签名或公证。从网络下载时，macOS 会提示无法验证安全性。如果信任下载来源，先尝试打开一次，再在「系统设置 → 隐私与安全性」找到 PetLink 并选择「仍要打开」，按提示确认。参见 [Apple 官方说明](https://support.apple.com/zh-cn/102445)。无需辅助功能、屏幕录制或远程控制权限。

桌宠默认是 96 × 108 的像素小猫，比早期版本更小。聊天窗口的「桌宠」下拉框可切换像素小猫、像素小兔，或选择自己的图片（PNG/JPEG，最大 2 MiB，推荐透明背景 PNG）。自定义图片复制到本机配置，原文件移动或删除不影响桌宠；选择会在重启后保留。

拖住桌宠身体任意位置即可移动，松手保存位置；点一下小猫或菜单栏的 🐾 打开聊天。收到消息时可直接在桌面气泡中回复，不必先打开聊天窗口。右键或双指点按桌宠可发送爱心、便便，或让对方的桌宠横穿屏幕后回到原位；快捷互动同样使用配对密钥加密，但不会写入聊天记录。关闭聊天窗口会留在后台；从菜单栏选择「退出」才完全退出。聊天页的「暂停弹出」只暂停气泡，收到的内容仍保留在本机记录。

## 应用内更新

安装包含更新功能的版本后，可在聊天窗口底部或菜单栏选择「检查更新」，再点击「下载更新」和「重启并更新」。应用只从本仓库最新正式 Release 下载对应的 Mac ZIP，校验 GitHub 提供的 SHA-256、应用身份、版本和代码签名后替换本机应用；无需每次下载或拖动 DMG。配对信息、桌宠设置和聊天记录保留在原来的本机配置目录。

临时签名更新会在安装前明确提示，保留 macOS 安全验证，因此可能仍需「系统设置 → 隐私与安全性 → 仍要打开」。已使用 Developer ID 签名的应用只接受同一 Apple 团队签名且公证通过的更新。更新不会静默安装或降级。应用目录不可写时，先将 PetLink 放到你自己的 `~/Applications` 目录。安装前保留旧应用备份，替换或启动命令失败时回退；新版本正常加载配置后才清理备份。

已发布的 0.4.0 尚无此入口，需要先安装一次包含更新功能的新版本。检查和下载更新时会连接 GitHub，不上传聊天或配对数据。后续 Release 必须包含版本一致的 `PetLink-版本-mac-arm64.zip`；现有打包及发布流程已生成这个文件。

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
npm run test:update
```

`npm test` 包含真实 WebSocket 中继、身份固定、双向收发、分片、收方确认、重传去重、篡改拒绝、重连和 5 MiB 文件边界，以及拖动/点击事件区分和桌面坐标映射。`test:ui` 启动两个独立 Mac Electron 进程，通过真正的输入框与按钮完成配对和收发，检查气泡、附件保存、链接、HTML 转义、暂停弹出、重启恢复，桌宠缩小、内置桌宠切换、自定义图片与重启保持，以及甩东西的落点选择、确认前不显示、拒绝、确认后图片/文字落点和重复确认拦截。

`test/public-relay.cjs` 是主动公网测试，发送随机测试数据，不使用用户的配对信息；结果保存在 `test-output/public-relay-result.json`。`PETLINK_PROFILE` / `PETLINK_RELAYS` / `PETLINK_HIDDEN` 环境变量只用于隔离测试和指定测试中继。

`test:update` 在临时目录用实际打包应用和新版本 ZIP 验证界面的检查、下载、校验、解压以及取消安装后配置和历史保留，同时读取真实 GitHub 最新发布信息。它不会替换已安装的应用，也不会自动放行 macOS 安全提示。`npm test` 另验证实际文件替换、启动命令失败时回退、篡改包和越界 ZIP 拒绝。

## 正式 Mac 发布

`npm run build:mac` 继续生成仅供本地开发的 ad-hoc 包。正式分发使用 `npm run build:mac:release`：通过 [Electron 官方签名工具](https://github.com/electron/osx-sign)对嵌套代码签名，启用 Hardened Runtime（强化运行时），提交 Apple 公证并附加公证票据（staple），最后用 Gatekeeper（macOS 门禁）检查应用和 DMG。ZIP 在应用附加票据后生成。缺少凭据、签名、公证或安全检查失败都会中止，不会退回 ad-hoc 签名。

需要先加入 [Apple Developer Program](https://developer.apple.com/programs/)，创建 [Developer ID Application 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)，并从钥匙串访问导出包含私钥的、带密码的 `.p12`。在仓库 **Settings → Secrets and variables → Actions** 配置以下 Secrets，勿把证书、私钥或密码提交到代码库：

| Secret | 内容 |
| --- | --- |
| `MAC_CERTIFICATE_P12` | `.p12` 文件的 Base64 内容 |
| `MAC_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `MAC_SIGNING_IDENTITY` | 完整证书名称，如 `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | 开发者 Apple 账号邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | [App 专用密码](https://support.apple.com/zh-cn/102654)，不是账号登录密码 |
| `APPLE_TEAM_ID` | Apple 开发者团队 ID |

合并发布流程后，更新 `package.json` 和 `package-lock.json` 的版本并推送对应新标签（例如 `v0.4.1`），在 **Actions → macOS release → Run workflow** 输入该标签。流程导入临时钥匙串、验证该标签的测试、签名并公证安装包，生成 SHA-256 校验文件，最后创建 **GitHub Release 草稿**。检查安装包与版本说明后再发布草稿。流程拒绝覆盖已有 Release；凭据会在结束后清理。修改仓库代码不会改变已下载或已发布的 0.4.0 安装包。

本机已有证书时，可先运行 `xcrun notarytool store-credentials petlink-notary` 并交互式填写公证凭据，再构建：

```sh
MAC_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
MAC_NOTARY_PROFILE=petlink-notary npm run build:mac:release
```

证书和公证配置都在自定义钥匙串时，另设 `MAC_SIGNING_KEYCHAIN` 为该钥匙串路径。

## REA 分析依据

本项目按需求使用 [REA](https://github.com/morluto/rea) 分析了 [lolPing](https://github.com/darrenprx/lolPing) 发布的 **v0.5.1 Mac 安装包中的 app.asar**。报告、安装包身份摘要和实际使用的命令见 [research/REA-FINDINGS.md](research/REA-FINDINGS.md)。

借鉴的是桌面浮层、分离 preload/IPC 和通过公共中继连接房间的行为。小猫 SVG、文字/图片/文件消息协议、双人固定身份与收方回执属于 PetLink 的实现；没有复制英雄联盟的图片或音效。

本项目采用 MIT 许可证。第三方运行时与依赖保留其各自许可证。
