# Sing-Box-Dash

Sing-Box-Dash 是面向 OpenWrt LuCI 的 Sing-box 管理面板，用于集中管理运行模式、配置、规则、订阅、节点、内核与诊断。面板适配 MiChongs 和 reF1nd 内核资源，并根据设备架构自动选择可安装版本。

## 功能

### 运行与状态

- 在首页查看核心状态、运行模式、配置、流量和连接概况。
- 支持 TUN、TProxy、Redirect、eBPF-Cgroup 和 eBPF-TC 模式。
- 启动前检查设备能力，不可用的模式会直接标记并禁用。
- 支持启动、停止、重启、运行日志和异常配置回滚。

### 配置与规则

- 导入、上传、编辑、校验和保存 Sing-box 配置。
- 配置修改采用事务流程，校验或启动失败时恢复原配置。
- 保留配置备份和快照，支持手动恢复与清理。
- 可视化编辑常用配置字段，并保留原始 JSON 编辑入口。
- 规则中心支持新增、修改、删除、排序和规则链路查询。
- 可查看一条域名或 IP 最终命中的出站与策略组。

### 订阅与节点

- 管理远程订阅、解析订阅链接和导入本地节点。
- 支持 VLESS、Reality 等常见节点信息解析。
- 展示节点、策略组、当前选择和 Clash API 延迟。
- 订阅与节点状态按当前配置动态读取，不写死节点列表。

### 内核与面板

- 支持 MiChongs 和 reF1nd 内核的识别、下载、更新和回滚。
- 自动匹配设备架构和内核版本，避免安装错误架构。
- 显示上游内核更新提醒，可跳过单次提醒或永久关闭。
- 支持 Zashboard / Clash API 配置读取、策略切换和规则修改。
- 提供独立的 Zashboard 面板快捷入口。

### 网络与兼容性

- 提供 Sing-box DNS 与备份 DNS 自动切换，核心停止时维持基础域名解析。
- 支持 Argon、Vantage 主题适配和移动端页面。
- 支持 IPK 与 APK 包，安装时自动处理运行依赖。
- 适配 OpenWrt 24.10 及 KWRt 等精简镜像，不依赖系统自带 `base64`。

## 安装

从 [Releases](https://github.com/DistantSK/Sing-Box-Dash/releases/latest) 下载与固件包管理器对应的文件：

```sh
# opkg 固件
opkg install /tmp/luci-app-singbox-dash_*.ipk

# apk 固件
apk add --allow-untrusted /tmp/luci-app-singbox-dash-*.apk
```

安装完成后刷新 LuCI，在“服务 > SingBox-Dash”中打开面板。

## 环境要求

- OpenWrt + LuCI
- Python 3、PyYAML
- nftables、ip-full、cgi-io、socat
- 与当前配置兼容的 Sing-box 内核

## 开发

重新生成运行样式：

```sh
python3 tools/build_css.py
```

执行本地检查：

```sh
python3 tests/test_refactor.py
python3 tests/test_dns_guard.py
python3 tests/test_css_modules.py
python3 tests/test_config_backups.py
python3 tests/test_manager_daemon.py
python3 tests/test_argon_cls_patch.py
python3 tests/test_module_split.py
node tests/test_frontend_models.js
python3 tools/build_css.py --check
ruff check root/usr/bin/singbox-dash tests tools
```

## 目录

- `root/`：OpenWrt 运行文件、服务和 Python 管理端
- `htdocs/`：LuCI JavaScript、CSS 和图片资源
- `src/styles/`：按模块拆分的样式源码
- `tools/`：样式与安装包构建工具
- `tests/`：后端、前端模型和路由回归测试

路由端到端测试说明见 `tests/e2e/README.md`。
