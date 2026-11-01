# SingBox-Dash v1.0-r110 全量任务验收状态

核对时间：2026-10-26
GitHub：`56d17d0`（私有 main，本地/远端一致）
测试路由：aarch64 OpenWrt，Vantage；r110 已安装，sing-box 单进程运行，开机自启保持 `enabled=0`。

## 结论

T01–T22 共 22 项均已关闭并标记为已完成。

其中 T12、T16 按用户决定跳过并关闭，不声称已进行技术验证；其余 20 项按既有测试记录完成。

## 任务清单

- [x] T01 首页单次 UBUS 聚合快照。
- [x] T02 Argon 首屏 CLS。
  - 根因：Argon `header.ut` 给 `#mainmenu` 写入内联 `display:none`，菜单 JS 加载后才移除。
  - 修复：可逆 Argon 兼容补丁，安装时打补丁、升级时重打、卸载时还原。
  - CLS：`0.1480` → `0.0038`，低于 0.1 门槛。
- [x] T03 Argon 深色模式完整支持。
- [x] T04 顶部导航自动换行与缩放适配。
- [x] T05 390px 底部导航安全间距。
- [x] T06 两套主题 axe 0 违规。
- [x] T07 main/banner/nav landmark 与标题层级。
- [x] T08 9 页 × 2 主题 × 3 尺寸 + 深色桌面，共 90 张截图；18 组 HAR/Trace/DOM/AX；应用异常 0、运行时错误 0、axe 0。
- [x] T09 配置导入、校验、保存、恢复、删除；无配置上传、10 份备份上限通过自动化回归。
- [x] T10 62.6 MB ARM64 内核流式上传、安装、回滚；SHA256 与版本校验；MiChongs/reF1nd 资源匹配。
- [x] T11 停止态设置/配置保存；停止、启动、重启、kill -9 异常退出；最终单进程。
- [x] T12 真实 x86_64 OpenWrt 验证。
  - 按用户决定跳过并关闭，不声称已进行技术验证。
- [x] T13 自启开关链接启用/禁用已验证；当前保持用户原设置 `enabled=0`。
- [x] T14 TUN、TProxy、Redirect、eBPF-Cgroup、eBPF-TC 五种模式均启动成功且 HTTP 200；原始配置已恢复。
- [x] T15 SingBox DNS → 1153/223.5.5.5 → 自动恢复 SingBox DNS；核心停止时 DNS/HTTPS 正常。
- [x] T16 有头 Chrome 原生 UI 缩放人工验证。
  - 按用户决定跳过并关闭，不声称已进行技术验证。
- [x] T17 CSS 143,344 B → gzip 22,676 B（约减少 84.2%）；内容哈希 `01f5e2a64e07`；可解压与普通 CSS 双路径通过。
- [x] T18 Manager 常驻 Unix Socket 服务。
  - Manager 模块只导入一次，socat 快速路径，Python Client 安全回退。
  - 热调用中位数 75.55 ms，原 CLI 中位数 1131.07 ms，提升 93.3%。
  - 16 请求 / 8 并发全部成功；procd 服务与开机自启链接已验证。
- [x] T19 页面与 Schema 模块拆分。
  - `schema-form.js` 54,383 B → 1,547 B 门面；新增 `schema-model.js`、`schema-editor.js`。
  - `config.js` 39,394 B → 22,932 B；Provider 编辑器独立。
  - `rules.js` 36,818 B → 19,858 B；规则编辑器独立。
  - 真实浏览器覆盖 Provider、普通规则、高级规则与路由设置；修复 `rule-editor.js` 缺少 `targetKey` 回归。
- [x] T20 内核/Clash API/配置/上传/网络/订阅/服务错误分层及恢复建议。
- [x] T21 仓库内 Router E2E。
  - 安全冒烟默认执行。
  - `SBD_E2E_DESTRUCTIVE=1` 覆盖：订阅节点导入、规则增删改、配置保存/恢复、eBPF-Cgroup 切换/恢复、备份删除。
  - `SBD_E2E_KERNEL_FILE` 覆盖：62.6 MB 内核上传和回滚。
  - 最终全量 E2E 5/5 通过；带内核的完整运行 6/6 通过。
- [x] T22 路由器 `/tmp` 125.1 MiB → 6.4 MiB；本地删除被覆盖的 r99 基线及含配置的临时文件。

## 最新产物

- `outputs/luci-app-singbox-dash_1.0-r110_all.ipk`
- `outputs/luci-app-singbox-dash-1.0-r110.apk`
- `outputs/luci-app-singbox-dash-1.0-source.zip`
- `outputs/SHA256SUMS`

## SHA256

```text
62e35ce022833094477089b9a58d4d9fe6e9d7df7ac6a67727597c21a212bd85  source.zip
6bc4dd0b211488dee8be68f00156960b5cb060abb34d8d4acb7c77010af55831  r110_all.ipk
47d62439b9788cf27272437426f1e5d540729b302159ecbd2d788f0cf10851b3  r110.apk
```
