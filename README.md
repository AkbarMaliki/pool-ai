# Pool 3D — 8 Ball

Game biliar 8-ball 3D (Three.js) untuk browser dengan mode **Online** (Firebase Realtime Database), **Lawan Bot** (3 level), dan **2 Pemain di 1 perangkat**.

## Menjalankan

```bash
cd pool-3d
npx serve .        # atau: python -m http.server
```

Buka URL yang ditampilkan. Harus lewat server lokal (bukan `file://`) agar Firebase dan Web Worker bot bisa jalan.

Test engine (fisika, aturan, bot main satu game penuh):

```bash
node tests/engine.test.js
```

## Cara main

- **Bidik**: drag di layar ke kiri/kanan (Shift = halus) atau tombol ◀ ▶. Drag atas/bawah mengubah sudut kamera, scroll/pinch untuk zoom.
- **Pukul**: tarik bar **POWER** di kanan ke bawah lalu lepas. Keyboard: ↑/↓ power, Spasi pukul.
- **Efek**: klik lingkaran bola putih di kiri bawah — atas = follow, bawah = draw, samping = english (berpengaruh saat memantul di bantalan).
- **Bola di tangan**: drag bola putih. Saat break hanya boleh di belakang garis kepala.
- **Garis arah setelah tumbukan**: tombol 📐 atau G untuk ON/OFF (tersimpan di browser). Garis bidik ke bola hantu tetap tampil.
- **Kamera**: T / 🎥 untuk tampilan atas; di tampilan atas klik meja untuk membidik ke titik itu.
- **Online**: *Buat Room Baru* → bagikan kode / link `?room=KODE`. Game mulai otomatis saat 2 pemain masuk; orang ke-3 dst. menonton. Ada chat, *Main Lagi* (yang kalah break), dan tombol *Klaim Menang* jika lawan terputus > 30 detik. Keluar saat main = menyerah.

## Aturan 8-ball yang diterapkan

- Meja terbuka setelah break; bola pertama yang masuk sah menentukan grup (solid 1–7 / belang 9–15).
- Foul → lawan dapat bola di tangan di mana saja: bola putih masuk, tidak mengenai bola, bola pertama yang dikenai bukan grup sendiri (atau bola 8 saat meja terbuka), tidak ada bola masuk dan tidak ada bola yang menyentuh bantalan setelah kontak.
- Giliran lanjut jika memasukkan bola grup sendiri tanpa foul (saat break: bola apa pun).
- Bola 8 masuk saat break dikembalikan ke titik kaki. Bola 8 masuk sebelum grup habis, bersamaan dengan bola terakhir, atau bersama foul = kalah.

## Arsitektur

| File | Isi |
| --- | --- |
| `engine.js` | Logika murni: geometri meja & kantong, fisika (geser → gulir, spin, english, tumbukan), aturan 8-ball, AI bot, prediksi garis bidik. Dipakai browser, worker, dan test Node. |
| `scene.js` | Scene Three.js: ruangan, meja (bantalan & rel diekstrusi dari geometri fisika), bola bertekstur canvas, stik, garis bidik, kamera. |
| `game.js` | Controller: input, kamera, animasi pukulan, bot, online Firebase, HUD, suara WebAudio. |
| `bot-worker.js` | Web Worker untuk perhitungan bot. |
| `firebase-config.js` | Config Firebase (`window.POOL_FIREBASE_CONFIG`). |

**Fisika deterministik**: simulasi langkah tetap 1/600 detik dan hanya memakai `+ - * /` dan `sqrt`, jadi semua klien menghasilkan posisi yang sama dari parameter pukulan yang sama. Online hanya mengirim parameter pukulan (`shot`), lalu setiap klien menyimulasikan sendiri. Hasil akhir ditulis ke `st` lewat transaksi (hanya jika `seq` masih yang lama), sehingga state yang tersimpan menjadi acuan jika ada selisih.

Bot mencari kombinasi bola-kantong yang jalurnya bersih, lalu (level Sedang/Sulit) menyimulasikan beberapa variasi kecepatan/spin dan menilai hasilnya (bola masuk, foul, posisi bola putih untuk pukulan berikutnya). Jika tidak ada pukulan bagus, bot mencari pukulan aman tanpa foul.

Struktur data di `/pool/rooms/{KODE}`:

- `created`, `host`, `hn`, `status` (`lobby` / `playing`), `seats/{s0,s1}` (uid)
- `players/{uid}`: `{name, conn, t}` — `conn` menjadi `false` saat terputus (onDisconnect)
- `st`: state game (JSON string) dengan `seq`
- `shot`: pukulan terakhir `{seq, by, dx, dz, v, sx, sy, cx?, cz?}`
- `aim`: bidikan pemain yang sedang giliran (untuk ditampilkan ke lawan, ~8×/detik)
- `rematch/{s0,s1}`, `chat/{push}`

Room yang lebih tua dari 3 jam dihapus otomatis saat ada yang membuka daftar room.

## Firebase Rules

Saat ini database mengizinkan baca/tulis node `pool` (sudah dicek). Jika rules diperketat, tambahkan node `pool` **tanpa menghapus** rules lain (`tetris`, `chess`, `poker`, `frontier`, …):

```json
"pool": {
  ".read": true,
  ".write": true,
  "rooms": { ".indexOn": ["created"] }
}
```

## Keterbatasan

- Tidak ada otentikasi; klien pemukul dipercaya (tidak anti-cheat).
- Fisika disederhanakan: tidak ada lompatan bola, masse, squirt, atau throw.
