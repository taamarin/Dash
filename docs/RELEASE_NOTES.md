# SingBox-Dash v1.0.4

## 更新说明

- 修复 KWRt 等精简 OpenWrt 镜像缺少 `base64` 时，设置与诊断页显示“缺少操作命令”的问题。
- 无 `base64` 环境会自动切换到 Python Socket 命令通道。
- 前后端统一拦截空命令，避免无效请求写入错误日志。
- 增加 OpenWrt 24.10.2 无 `base64` 回归测试，覆盖 `version`、`settings-get` 和 `diag`。
- 更新项目功能介绍和安装说明。
