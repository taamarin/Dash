# SingBox-Dash v1.0.4

## Catatan pembaruan

- Memperbaiki masalah halaman pengaturan dan diagnostik yang menampilkan “perintah operasi tidak ada” pada image OpenWrt ringkas seperti KWRt tanpa `base64`.
- Secara otomatis beralih ke kanal perintah Python Socket jika `base64` tidak tersedia.
- Memastikan frontend dan backend sama-sama menolak perintah kosong agar permintaan tidak valid tidak menghasilkan log kesalahan.
- Menambahkan pengujian regresi untuk OpenWrt 24.10.2 tanpa `base64`, mencakup `version`, `settings-get`, dan `diag`.
- Memperbarui pengenalan fitur proyek dan petunjuk pemasangan.
