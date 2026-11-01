#!/bin/sh
# Restricted service wrapper used by singbox-dash diagnostics and CLI.
set -eu
INIT=/etc/init.d/sing-box
[ -x "$INIT" ] || INIT=/etc/init.d/singbox-dash-core
case "${1:-}" in
    start|stop|restart|enable|disable) "$INIT" "$1" ;;
    status)
        if pidof sing-box >/dev/null 2>&1; then
            printf '{"ok":true,"running":true,"pids":"%s"}\n' "$(pidof sing-box)"
        else
            printf '{"ok":true,"running":false,"pids":""}\n'
        fi
        ;;
    *) echo "usage: core.sh start|stop|restart|enable|disable|status" >&2; exit 2 ;;
esac
