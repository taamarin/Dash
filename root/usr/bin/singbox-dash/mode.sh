#!/bin/sh
# singbox-dash network runtime. Inputs are validated by manager.py first.
set -eu

STATE=/etc/sing-box/.dash-state
NFT_FILE=/etc/singbox-dash.nft
SYSCTL_FILE=/etc/sysctl.d/99-singbox-dash.conf
COMMAND="${1:-}"
MODE="${2:-}"
PORT="${3:-}"
LAN="${4:-br-lan}"
IFACE="${5:-singtun0}"
UDP_PORT="${6:-}"
BACKUP_DIR="$STATE/runtime-backup.$$"
TRANSACTION=""

log() { printf '%s\n' "$*" >&2; }

validate_common() {
    case "$MODE" in ebpf|tun|tproxy|redirect) :;; *) log "invalid mode"; exit 2;; esac
    [ -n "$LAN" ] && [ "${#LAN}" -le 15 ] || { log "invalid LAN interface"; exit 2; }
    [ -n "$IFACE" ] && [ "${#IFACE}" -le 15 ] || { log "invalid TUN interface"; exit 2; }
    case "$LAN$IFACE" in *[!A-Za-z0-9_.:-]*) log "invalid interface"; exit 2;; esac
    if [ "$MODE" = tproxy ] || [ "$MODE" = redirect ]; then
        case "$PORT" in ''|*[!0-9]*) log "invalid port"; exit 2;; esac
        [ "$PORT" -gt 0 ] && [ "$PORT" -lt 65535 ] || { log "invalid port"; exit 2; }
    fi
    if [ -n "$UDP_PORT" ]; then
        case "$UDP_PORT" in *[!0-9]*) log "invalid udp port"; exit 2;; esac
        [ "$UDP_PORT" -gt 0 ] && [ "$UDP_PORT" -lt 65535 ] || { log "invalid udp port"; exit 2; }
    fi
    if [ "$MODE" = redirect ]; then
        [ -n "$UDP_PORT" ] || { log "redirect mode requires UDP port"; exit 2; }
        [ "$UDP_PORT" != "$PORT" ] || { log "TCP and UDP ports must differ"; exit 2; }
    fi
}

backup_runtime() {
    rm -rf "$BACKUP_DIR"
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
    for source in /etc/config/network /etc/config/firewall "$NFT_FILE" "$SYSCTL_FILE"; do
        name=$(printf '%s' "$source" | sed 's#^/##; s#/#__#g')
        if [ -f "$source" ]; then
            cp -p "$source" "$BACKUP_DIR/$name"
            : > "$BACKUP_DIR/$name.present"
        fi
    done
    TRANSACTION=1
}

rollback_runtime() {
    [ -n "$TRANSACTION" ] || return 0
    log "restoring previous network runtime"
    for source in /etc/config/network /etc/config/firewall "$NFT_FILE" "$SYSCTL_FILE"; do
        name=$(printf '%s' "$source" | sed 's#^/##; s#/#__#g')
        if [ -f "$BACKUP_DIR/$name.present" ]; then
            cp -p "$BACKUP_DIR/$name" "$source"
        else
            rm -f "$source"
        fi
    done
    clear_live
    uci commit network >/dev/null 2>&1 || true
    uci commit firewall >/dev/null 2>&1 || true
    /etc/init.d/network reload >/dev/null 2>&1 || true
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
    if [ -f "$NFT_FILE" ]; then
        nft -c -f "$NFT_FILE" >/dev/null 2>&1 || true
        nft -f "$NFT_FILE" >/dev/null 2>&1 || true
    fi
    TRANSACTION=""
    trap - 0 1 2 15
    rm -rf "$BACKUP_DIR"
}

remove_policy_route() {
    while ip rule del priority 100 fwmark 0x1 lookup 100 2>/dev/null; do :; done
    while ip rule del priority 100 fwmark 1 lookup 100 2>/dev/null; do :; done
    while ip -6 rule del priority 100 fwmark 0x1 lookup 100 2>/dev/null; do :; done
    while ip -6 rule del priority 100 fwmark 1 lookup 100 2>/dev/null; do :; done
    ip route flush table 100 >/dev/null 2>&1 || true
    ip -6 route flush table 100 >/dev/null 2>&1 || true
}

clear_live() {
    remove_policy_route
    nft delete table inet singbox_dash >/dev/null 2>&1 || true
    nft delete table ip singbox_dash >/dev/null 2>&1 || true
    nft delete table ip6 singbox_dash >/dev/null 2>&1 || true
}

remove_managed_uci() {
    for key in \
        network.singbox_dash_rule4 network.singbox_dash_rule6 \
        network.singbox_dash_route4 network.singbox_dash_route6 \
        network.singbox_dash_rule network.singbox_dash_route \
        network.singbox_dash_tun firewall.singbox_dash_tun \
        firewall.singbox_dash_include firewall.singbox_dash_zone \
        firewall.singbox_dash_forward firewall.singbox_dash
    do
        uci -q delete "$key" >/dev/null 2>&1 || true
    done
}

commit_uci() {
    uci commit network
    uci commit firewall
}

reload_runtime() {
    /etc/init.d/network reload >/dev/null 2>&1 || true
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
    sleep 1
}

install_policy_route() {
    remove_policy_route
    ip rule add priority 100 fwmark 0x1 lookup 100
    ip route replace local default dev lo table 100
    ip -6 rule add priority 100 fwmark 0x1 lookup 100
    ip -6 route replace local default dev lo table 100

    uci set network.singbox_dash_rule4=rule
    uci set network.singbox_dash_rule4.mark=0x1
    uci set network.singbox_dash_rule4.lookup=100
    uci set network.singbox_dash_rule4.priority=100
    uci set network.singbox_dash_route4=route
    uci set network.singbox_dash_route4.interface=loopback
    uci set network.singbox_dash_route4.target=0.0.0.0/0
    uci set network.singbox_dash_route4.table=100
    uci set network.singbox_dash_route4.type=local

    uci set network.singbox_dash_rule6=rule
    uci set network.singbox_dash_rule6.mark=0x1
    uci set network.singbox_dash_rule6.lookup=100
    uci set network.singbox_dash_rule6.priority=100
    uci set network.singbox_dash_route6=route
    uci set network.singbox_dash_route6.interface=loopback
    uci set network.singbox_dash_route6.target=::/0
    uci set network.singbox_dash_route6.table=100
    uci set network.singbox_dash_route6.type=local
}

write_sysctl() {
    mkdir -p /etc/sysctl.d
    cat > "$SYSCTL_FILE" <<'EOF'
net.ipv4.conf.all.route_localnet=1
net.ipv4.conf.default.route_localnet=1
net.ipv6.conf.all.forwarding=1
EOF
    chmod 600 "$SYSCTL_FILE"
    sysctl -p "$SYSCTL_FILE" >/dev/null 2>&1 || true
}

write_nft() {
    WRITE_UDP_PORT="${UDP_PORT:-$PORT}"
    mkdir -p "$(dirname "$NFT_FILE")"
    {
        printf 'table inet singbox_dash {\n'
        printf '  define RESERVED_V4 = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 }\n'
        printf '  define RESERVED_V6 = { ::1/128, fc00::/7, fe80::/10, ff00::/8 }\n'
        if [ "$MODE" = redirect ]; then
            printf '  chain redirect_tcp {\n'
            printf '    type nat hook prerouting priority dstnat; policy accept;\n'
            printf '    iifname != "%s" return\n' "$LAN"
            printf '    ip daddr $RESERVED_V4 return\n'
            printf '    ip6 daddr $RESERVED_V6 return\n'
            printf '    meta mark 0x2 return\n'
            printf '    meta nfproto ipv4 meta l4proto tcp redirect to :%s\n' "$PORT"
            printf '    meta nfproto ipv6 meta l4proto tcp redirect to :%s\n' "$PORT"
            printf '  }\n'
            printf '  chain redirect_udp {\n'
            printf '    type filter hook prerouting priority mangle; policy accept;\n'
            printf '    iifname != "%s" return\n' "$LAN"
            printf '    ip daddr $RESERVED_V4 return\n'
            printf '    ip6 daddr $RESERVED_V6 return\n'
            printf '    meta mark 0x2 return\n'
            printf '    meta l4proto udp tproxy ip to 127.0.0.1:%s meta mark set 0x1 accept\n' "$WRITE_UDP_PORT"
            printf '    meta l4proto udp tproxy ip6 to [::1]:%s meta mark set 0x1 accept\n' "$WRITE_UDP_PORT"
            printf '  }\n'
        else
            printf '  chain prerouting {\n'
            printf '    type filter hook prerouting priority mangle; policy accept;\n'
            printf '    iifname != "%s" return\n' "$LAN"
            printf '    ip daddr $RESERVED_V4 return\n'
            printf '    ip6 daddr $RESERVED_V6 return\n'
            printf '    meta mark 0x2 return\n'
            printf '    meta l4proto tcp tproxy ip to 127.0.0.1:%s meta mark set 0x1 accept\n' "$PORT"
            printf '    meta l4proto udp tproxy ip to 127.0.0.1:%s meta mark set 0x1 accept\n' "$WRITE_UDP_PORT"
            printf '    meta l4proto tcp tproxy ip6 to [::1]:%s meta mark set 0x1 accept\n' "$PORT"
            printf '    meta l4proto udp tproxy ip6 to [::1]:%s meta mark set 0x1 accept\n' "$WRITE_UDP_PORT"
            printf '  }\n'
        fi
        printf '}\n'
    } > "$NFT_FILE"
    chmod 600 "$NFT_FILE"
    nft -c -f "$NFT_FILE"

    uci set firewall.singbox_dash_include=include
    uci set firewall.singbox_dash_include.type=nftables
    uci set firewall.singbox_dash_include.path="$NFT_FILE"
    uci set firewall.singbox_dash_include.position=ruleset-prepend
    uci set firewall.singbox_dash_include.enabled=1
    write_sysctl
}

install_tun_firewall() {
    uci set network.singbox_dash_tun=interface
    uci set network.singbox_dash_tun.proto=none
    uci set network.singbox_dash_tun.device="$IFACE"
    uci set network.singbox_dash_tun.auto=1
    uci set firewall.singbox_dash_zone=zone
    uci set firewall.singbox_dash_zone.name=singbox_dash
    uci set firewall.singbox_dash_zone.input=ACCEPT
    uci set firewall.singbox_dash_zone.output=ACCEPT
    uci set firewall.singbox_dash_zone.forward=REJECT
    uci set firewall.singbox_dash_zone.masq=1
    uci add_list firewall.singbox_dash_zone.device="$IFACE"
    uci set firewall.singbox_dash_forward=forwarding
    uci set firewall.singbox_dash_forward.src=lan
    uci set firewall.singbox_dash_forward.dest=singbox_dash
}

ensure_policy_route() {
    ip rule show | grep -Eq '^100:.*fwmark 0x1.*lookup 100' || ip rule add priority 100 fwmark 0x1 lookup 100
    ip route replace local default dev lo table 100
    ip -6 rule show | grep -Eq '^100:.*fwmark 0x1.*lookup 100' || ip -6 rule add priority 100 fwmark 0x1 lookup 100
    ip -6 route replace local default dev lo table 100
}

verify_runtime() {
    validate_common
    case "$MODE" in
        ebpf)
            command -v /usr/bin/sing-box >/dev/null 2>&1 || { log "sing-box binary is missing"; exit 3; }
            EBPF_OUTPUT=$(/usr/bin/sing-box tools ebpf status 2>&1) || {
                printf '%s\n' "$EBPF_OUTPUT" >&2
                exit 3
            }
            printf '%s\n' "$EBPF_OUTPUT" | grep -q 'FAIL=0' || { log "eBPF preflight reports failures"; exit 3; }
            printf '%s\n' "$EBPF_OUTPUT" | grep -q 'REQUIRED_FAILURES=0' || { log "eBPF required checks failed"; exit 3; }
            ;;
        tun)
            ip link show dev "$IFACE" >/dev/null 2>&1 || { log "TUN interface $IFACE is missing"; exit 3; }
            ip route show table all 2>/dev/null | grep -F "dev $IFACE" >/dev/null || {
                log "TUN routes are missing"; exit 3;
            }
            ;;
        tproxy|redirect)
            nft list table inet singbox_dash >/dev/null 2>&1 || { log "nft table is missing"; exit 3; }
            NFT_OUTPUT=$(nft list table inet singbox_dash 2>&1)
            ip rule show | grep -Eq '^100:.*fwmark 0x1.*lookup 100' || { log "IPv4 policy rule is missing"; exit 3; }
            ip -6 rule show | grep -Eq '^100:.*fwmark 0x1.*lookup 100' || { log "IPv6 policy rule is missing"; exit 3; }
            ip route show table 100 | grep -Eq '(^|[[:space:]])local (default|0\.0\.0\.0/0)([[:space:]]|$)' || { log "IPv4 local route is missing"; exit 3; }
            ip -6 route show table 100 | grep -Eq '(^|[[:space:]])local (default|::/0)([[:space:]]|$)' || { log "IPv6 local route is missing"; exit 3; }
            if [ "$MODE" = redirect ]; then
                printf '%s\n' "$NFT_OUTPUT" | grep -F "redirect to :$PORT" >/dev/null || { log "TCP redirect rule is missing"; exit 3; }
                printf '%s\n' "$NFT_OUTPUT" | grep -F "tproxy ip to 127.0.0.1:$UDP_PORT" >/dev/null || { log "UDP tproxy rule is missing"; exit 3; }
            else
                UDP_CHECK_PORT="${UDP_PORT:-$PORT}"
                printf '%s\n' "$NFT_OUTPUT" | grep -F "tproxy ip to 127.0.0.1:$PORT" >/dev/null || { log "TCP tproxy rule is missing"; exit 3; }
                printf '%s\n' "$NFT_OUTPUT" | grep -F "tproxy ip to 127.0.0.1:$UDP_CHECK_PORT" >/dev/null || { log "UDP tproxy rule is missing"; exit 3; }
            fi
            ;;
    esac
    printf '{"ok":true,"mode":"%s","port":%s,"udp_port":%s}\n' \
        "$MODE" "${PORT:-null}" "${UDP_PORT:-null}"
}

apply_mode() {
    validate_common
    mkdir -p "$STATE"
    backup_runtime
    trap 'rollback_runtime' 0 1 2 15
    clear_live
    remove_managed_uci
    rm -f "$NFT_FILE" "$SYSCTL_FILE"
    case "$MODE" in
        ebpf) : ;;
        tun) install_tun_firewall ;;
        tproxy|redirect) install_policy_route; write_nft ;;
    esac
    commit_uci
    reload_runtime
    case "$MODE" in
        tproxy|redirect)
            ensure_policy_route
            nft delete table inet singbox_dash >/dev/null 2>&1 || true
            nft -f "$NFT_FILE"
            verify_runtime >/dev/null
            ;;
    esac
    TRANSACTION=""
    trap - 0 1 2 15
    rm -rf "$BACKUP_DIR"
    printf '{"ok":true,"mode":"%s","port":%s,"udp_port":%s}\n' \
        "$MODE" "${PORT:-null}" "${UDP_PORT:-null}"
}

clear_runtime() {
    mkdir -p "$STATE"
    backup_runtime
    trap 'rollback_runtime' 0 1 2 15
    clear_live
    remove_managed_uci
    rm -f "$NFT_FILE" "$SYSCTL_FILE"
    commit_uci
    reload_runtime
    TRANSACTION=""
    trap - 0 1 2 15
    rm -rf "$BACKUP_DIR"
    printf '{"ok":true,"mode":"none"}\n'
}

restore_runtime() {
    clear_live
    uci commit network >/dev/null 2>&1 || true
    uci commit firewall >/dev/null 2>&1 || true
    /etc/init.d/network reload >/dev/null 2>&1 || true
    /etc/init.d/firewall reload >/dev/null 2>&1 || true
    if uci -q get network.singbox_dash_rule4 >/dev/null 2>&1; then
        ensure_policy_route
    fi
    if [ -f "$NFT_FILE" ]; then
        nft -c -f "$NFT_FILE" >/dev/null 2>&1 || { log "nft restore validation failed"; exit 3; }
        nft delete table inet singbox_dash >/dev/null 2>&1 || true
        nft -f "$NFT_FILE"
    fi
    printf '{"ok":true,"mode":"restored"}\n'
}

case "$COMMAND" in
    apply) apply_mode ;;
    clear-live) clear_live ;;
    clear-runtime) clear_runtime ;;
    restore-runtime) restore_runtime ;;
    verify-runtime) verify_runtime ;;
    *) log "managed by singbox-dash"; exit 2 ;;
esac

exit 0



