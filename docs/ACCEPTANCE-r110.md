# Status penerimaan seluruh tugas SingBox-Dash v1.0-r110

Tanggal verifikasi: 2026-10-26
GitHub: `56d17d0` (`main` privat; lokal dan remote cocok)
Router uji: aarch64 OpenWrt, Vantage; r110 telah dipasang, sing-box berjalan sebagai satu proses, dan mulai otomatis saat boot tetap `enabled=0`.

## Kesimpulan

Semua 22 item T01–T22 telah ditutup dan ditandai selesai.

T12 dan T16 dilewati dan ditutup berdasarkan keputusan pengguna; tidak diklaim telah menjalani verifikasi teknis. 20 item lainnya diselesaikan sesuai catatan pengujian yang ada.

## Daftar tugas

- [x] T01 Snapshot agregat UBUS satu kali di halaman beranda.
- [x] T02 CLS tampilan awal Argon.
  - Akar masalah: Argon `header.ut` menetapkan `display:none` inline pada `#mainmenu`, yang baru dihapus setelah JS menu dimuat.
  - Perbaikan: patch kompatibilitas Argon yang dapat dibalik; diterapkan saat instalasi, diterapkan ulang saat peningkatan, dan dipulihkan saat penghapusan.
  - CLS: `0.1480` → `0.0038`, di bawah ambang 0.1.
- [x] T03 Dukungan penuh mode gelap Argon.
- [x] T04 Navigasi atas otomatis membungkus baris dan menyesuaikan zoom.
- [x] T05 Jarak aman navigasi bawah pada lebar 390px.
- [x] T06 Nol pelanggaran axe pada kedua tema.
- [x] T07 Landmark main/banner/nav dan hierarki judul.
- [x] T08 9 halaman × 2 tema × 3 ukuran + desktop gelap, total 90 tangkapan layar; 18 set HAR/Trace/DOM/AX; 0 pengecualian aplikasi, 0 kesalahan runtime, 0 masalah axe.
- [x] T09 Impor, validasi, penyimpanan, pemulihan, dan penghapusan konfigurasi; unggah tanpa konfigurasi dan batas 10 cadangan lulus uji regresi otomatis.
- [x] T10 Unggah streaming, instalasi, dan rollback kernel ARM64 62.6 MB; verifikasi SHA256 dan versi; pencocokan aset MiChongs/reF1nd.
- [x] T11 Penyimpanan pengaturan/konfigurasi saat berhenti; berhenti, mulai, mulai ulang, keluar tak normal dengan kill -9; satu proses pada akhirnya.
- [x] T12 Verifikasi OpenWrt x86_64 nyata.
  - Dilewati dan ditutup berdasarkan keputusan pengguna; tidak diklaim telah menjalani verifikasi teknis.
- [x] T13 Tautan sakelar mulai otomatis untuk mengaktifkan/menonaktifkan telah diverifikasi; pengaturan asli pengguna `enabled=0` tetap dipertahankan.
- [x] T14 Kelima mode TUN, TProxy, Redirect, eBPF-Cgroup, dan eBPF-TC berhasil dimulai dengan HTTP 200; konfigurasi asli dipulihkan.
- [x] T15 SingBox DNS → 1153/223.5.5.5 → pemulihan otomatis SingBox DNS; DNS/HTTPS tetap normal saat inti berhenti.
- [x] T16 Verifikasi manual zoom UI native Chrome dengan jendela terlihat.
  - Dilewati dan ditutup berdasarkan keputusan pengguna; tidak diklaim telah menjalani verifikasi teknis.
- [x] T17 CSS 143,344 B → gzip 22,676 B (pengurangan sekitar 84.2%); hash konten `01f5e2a64e07`; jalur gzip dan CSS biasa berhasil.
- [x] T18 Layanan Manager dengan Unix Socket persisten.
  - Modul Manager hanya diimpor sekali; jalur cepat socat dan fallback aman Python Client.
  - Median pemanggilan hangat 75.55 ms, median CLI lama 1131.07 ms, peningkatan 93.3%.
  - Semua 16 permintaan / 8 konkurensi berhasil; layanan procd dan tautan mulai otomatis saat boot telah diverifikasi.
- [x] T19 Pemisahan modul halaman dan Schema.
  - `schema-form.js` 54,383 B → fasad 1,547 B; menambahkan `schema-model.js` dan `schema-editor.js`.
  - `config.js` 39,394 B → 22,932 B; editor Provider dipisahkan.
  - `rules.js` 36,818 B → 19,858 B; editor aturan dipisahkan.
  - Browser nyata mencakup Provider, aturan biasa, aturan lanjutan, dan pengaturan perutean; memperbaiki regresi `targetKey` yang hilang dari `rule-editor.js`.
- [x] T20 Pengelompokan kesalahan kernel/Clash API/konfigurasi/unggah/jaringan/langganan/layanan dan saran pemulihan.
- [x] T21 Router E2E di dalam repositori.
  - Uji asap aman dijalankan secara default.
  - `SBD_E2E_DESTRUCTIVE=1` mencakup impor node langganan, tambah/ubah/hapus aturan, simpan/pulihkan konfigurasi, alih/pulihkan eBPF-Cgroup, dan hapus cadangan.
  - `SBD_E2E_KERNEL_FILE` mencakup unggah dan rollback kernel 62.6 MB.
  - E2E penuh akhir lulus 5/5; eksekusi lengkap dengan kernel lulus 6/6.
- [x] T22 `/tmp` router 125.1 MiB → 6.4 MiB; menghapus baseline r99 yang tertimpa serta file sementara yang berisi konfigurasi secara lokal.

## Artefak terbaru

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
