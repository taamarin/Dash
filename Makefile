include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-singbox-dash
PKG_VERSION:=1.0.4
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=singbox-dash

LUCI_TITLE:=SingBox-Dash
LUCI_DESCRIPTION:=Panel OpenWrt LuCI untuk mengelola operasi Sing-box, konfigurasi, aturan, langganan, dan kernel.
LUCI_DEPENDS:=+python3 +python3-yaml +cgi-io +socat
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

define Package/luci-app-singbox-dash/conffiles
/etc/config/singbox-dash
endef

define Package/luci-app-singbox-dash/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/usr/bin/python3 /usr/bin/singbox-dash/argon-cls-patch.py patch >/dev/null 2>&1
[ -x /etc/init.d/singbox-dash-manager ] && /etc/init.d/singbox-dash-manager enable >/dev/null 2>&1
[ -x /etc/init.d/singbox-dash-manager ] && /etc/init.d/singbox-dash-manager restart >/dev/null 2>&1
exit 0
endef

define Package/luci-app-singbox-dash/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/usr/bin/python3 /usr/bin/singbox-dash/argon-cls-patch.py restore >/dev/null 2>&1
[ -x /etc/init.d/singbox-dash-manager ] && /etc/init.d/singbox-dash-manager stop >/dev/null 2>&1
exit 0
endef

$(eval $(call BuildPackage,luci-app-singbox-dash))
