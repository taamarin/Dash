# Router E2E Regression

This suite drives the real LuCI page and manager. It is not intended for production routers.

## Requirements

```sh
npm install playwright
npx playwright install chromium
```

## Safe smoke

```sh
SBD_E2E_BASE=http://192.168.100.1/cgi-bin/luci/admin/services/singbox-dash \
SBD_E2E_USERNAME=root \
SBD_E2E_PASSWORD=... \
node tests/e2e/router-regression.js
```

## Destructive regression

Only use this on the dedicated test router. The suite creates a config backup before changes and restores it after the rule/config/mode tests.

```sh
SBD_E2E_DESTRUCTIVE=1 \
SBD_E2E_KERNEL_FILE=/path/to/compatible/sing-box \
node tests/e2e/router-regression.js
```

Covered flows:

- page load smoke
- local subscription/node import and provider file cleanup
- rule create, edit, delete
- config save and restore
- eBPF-Cgroup mode switch and restore
- backup deletion
- optional kernel upload and rollback

Output: `outputs/e2e/summary.json`.
