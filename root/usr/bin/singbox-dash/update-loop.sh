#!/bin/sh
# Schedule subscription updates without keeping a second Python runtime resident.
APP=/usr/bin/singbox-dash/manager.py
PYTHON=/usr/bin/python3
LOG=/tmp/singbox-dash-update.log
STATE=/etc/sing-box/.dash-state/update.json
next_run=0
last_interval=

while :; do
    interval="$(uci -q get singbox-dash.main.update_interval 2>/dev/null || echo 0)"
    case "$interval" in
        ''|*[!0-9]*) interval=0 ;;
    esac

    if [ "$interval" -le 0 ]; then
        next_run=0
        last_interval=0
        sleep 60
        continue
    fi

    last_run="$(jsonfilter -i "$STATE" -e '@.time' 2>/dev/null || echo 0)"
    case "$last_run" in
        ''|*[!0-9]*) last_run=0 ;;
    esac

    if [ "$interval" != "$last_interval" ]; then
        last_interval="$interval"
        next_run=$((last_run + interval * 60))
    fi

    now="$(date +%s)"
    if [ "$next_run" -eq 0 ] || [ "$now" -ge "$next_run" ]; then
        "$PYTHON" "$APP" subscription-update >"$LOG" 2>&1 || true
        now="$(date +%s)"
        next_run=$((now + interval * 60))
    fi

    sleep 60
done