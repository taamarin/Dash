# Sing-Box-Dash

Sing-Box-Dash adalah panel pengelolaan Sing-box untuk OpenWrt LuCI yang memusatkan pengelolaan mode operasi, konfigurasi, aturan, langganan, node, kernel, dan diagnostik. Panel ini mendukung sumber kernel MiChongs dan reF1nd serta memilih versi yang dapat dipasang secara otomatis berdasarkan arsitektur perangkat.

## Fitur

### Operasi dan status

- Lihat status inti, mode operasi, konfigurasi, lalu lintas, dan ringkasan koneksi di halaman beranda.
- Mendukung mode TUN, TProxy, Redirect, eBPF-Cgroup, dan eBPF-TC.
- Memeriksa kemampuan perangkat sebelum memulai; mode yang tidak tersedia akan ditandai dan dinonaktifkan.
- Mendukung mulai, berhenti, mulai ulang, log operasi, dan rollback konfigurasi yang gagal.

### Konfigurasi dan aturan

- Impor, unggah, edit, validasi, dan simpan konfigurasi Sing-box.
- Perubahan konfigurasi menggunakan alur transaksional; konfigurasi asli dipulihkan jika validasi atau proses mulai gagal.
- Menyimpan cadangan dan snapshot konfigurasi serta mendukung pemulihan dan pembersihan manual.
- Edit kolom konfigurasi umum secara visual, dengan tetap menyediakan editor JSON mentah.
- Pusat aturan mendukung penambahan, pengubahan, penghapusan, pengurutan, dan penelusuran rantai aturan.
- Lihat outbound dan grup kebijakan yang akhirnya cocok untuk sebuah domain atau alamat IP.

### Langganan dan node

- Kelola langganan jarak jauh, uraikan tautan langganan, dan impor node lokal.
- Mendukung penguraian informasi node umum seperti VLESS dan Reality.
- Tampilkan node, grup kebijakan, pilihan saat ini, dan latensi Clash API.
- Status langganan dan node dibaca secara dinamis dari konfigurasi saat ini; daftar node tidak ditetapkan secara statis.

### Kernel dan panel

- Mendukung deteksi, pengunduhan, pembaruan, dan rollback kernel MiChongs dan reF1nd.
- Mencocokkan arsitektur perangkat dan versi kernel secara otomatis untuk mencegah pemasangan arsitektur yang salah.
- Menampilkan pemberitahuan pembaruan kernel upstream; pemberitahuan dapat dilewati sekali atau dinonaktifkan secara permanen.
- Mendukung pembacaan konfigurasi, pergantian kebijakan, dan pengubahan aturan melalui Zashboard / Clash API.
- Menyediakan pintasan khusus ke panel Zashboard.

### Jaringan dan kompatibilitas

- Menyediakan peralihan otomatis antara DNS Sing-box dan DNS cadangan agar resolusi domain dasar tetap tersedia saat inti berhenti.
- Mendukung tema Argon dan Vantage serta tampilan seluler.
- Mendukung paket IPK dan APK, dengan penanganan dependensi runtime otomatis saat pemasangan.
- Kompatibel dengan OpenWrt 24.10 dan image ringkas seperti KWRt, tanpa bergantung pada `base64` bawaan sistem.

## Pemasangan

Unduh file yang sesuai dengan manajer paket firmware Anda dari [Releases](https://github.com/DistantSK/Sing-Box-Dash/releases/latest):

```sh
# Firmware opkg
opkg install /tmp/luci-app-singbox-dash_*.ipk

# Firmware apk
apk add --allow-untrusted /tmp/luci-app-singbox-dash-*.apk
```

Setelah pemasangan, muat ulang LuCI dan buka panel melalui “Layanan > SingBox-Dash”.

## Persyaratan

- OpenWrt + LuCI
- Python 3、PyYAML
- nftables、ip-full、cgi-io、socat
- Kernel Sing-box yang kompatibel dengan konfigurasi saat ini

## Pengembangan

Bangun ulang stylesheet runtime:

```sh
python3 tools/build_css.py
```

Jalankan pemeriksaan lokal:

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

## Struktur direktori

- `root/`: file runtime OpenWrt, layanan, dan backend pengelolaan Python
- `htdocs/`: aset JavaScript, CSS, dan gambar LuCI
- `src/styles/`: sumber stylesheet yang dibagi berdasarkan modul
- `tools/`: alat untuk membangun stylesheet dan paket instalasi
- `tests/`: pengujian regresi backend, model frontend, dan router

Lihat `tests/e2e/README.md` untuk petunjuk pengujian end-to-end router.
