# Ruang Kata

Dashboard lokal untuk menjelajahi lema, bentuk turunan, definisi, dan jejaring semantik bahasa Indonesia. Definisi diambil secara bertahap dari sitemap publik `kbbi.web.id`; sinonim, antonim, hipernim, hiponim, meronim, dan holonim diperkaya dengan WordNet Bahasa.

## Menjalankan

Persyaratan: Node.js 22.5 atau lebih baru (proyek ini menggunakan SQLite bawaan Node).

```powershell
npm install
npm run relations
npm run scrape:sample
npm start
```

Buka `http://127.0.0.1:4173`.

## Mengambil seluruh data

```powershell
npm run scrape
```

Sitemap sumber memuat sejumlah permalink yang menggabungkan lema dan bentuk
turunannya menjadi satu alamat yang tidak valid. Setelah crawl utama selesai,
audit dan perbaiki alamat tersebut, kemudian lanjutkan scraper:

```powershell
npm run repair:sitemap
node scripts/repair-sitemap.mjs --apply
node scripts/scrape.mjs --all --concurrency=2 --delay=2000
```

Perintah audit tidak mengubah database. Daftar KBBI Edisi IV dari repositori
`dyazincahya/KBBI-SQL-database` hanya dipakai untuk mengenali batas lema pada
alamat yang rusak; arti dan naskah definisi tetap diambil dari `kbbi.web.id`.

Scraper akan:

- membaca `robots.txt` secara utuh: aturan `Allow`/`Disallow` per alamat, pola `*` dan `$`, blok khusus agen, serta `Crawl-delay` yang menaikkan jeda bawaan bila diminta;
- mengambil sekitar 48 ribu URL dari sitemap resmi;
- memakai satu pekerja dan jeda 1,5 detik secara bawaan;
- menyimpan progres ke SQLite sehingga aman dihentikan dengan `Ctrl+C` dan dilanjutkan dengan perintah yang sama;
- mencoba ulang kegagalan sementara hingga lima kali, tetapi **tidak** mengulang galat permanen seperti 404 dan 410;
- memprioritaskan URL yang belum pernah dicoba sebelum mengulang kegagalan lama;
- menandai halaman tanpa definisi dan alamat yang hilang permanen sebagai `skipped`, bukan menyimpannya sebagai kata palsu.

Dengan batas yang sengaja sopan, crawl lengkap memerlukan sekitar 16–20 jam, tergantung respons server. Jangan menaikkan konkurensi tanpa izin pengelola situs. Untuk uji terbatas:

```powershell
node scripts/scrape.mjs --limit=100 --concurrency=1 --delay=1500
node scripts/scrape.mjs --slugs=ajar,cahaya,rumah
npm run status
```

## Memugar entri lama

Naskah definisi setiap entri tersimpan lengkap di basis data, sehingga perbaikan
pengurai dapat diterapkan **tanpa mengambil ulang dari jaringan**. Jalankan audit
dahulu untuk melihat apa yang akan berubah:

```powershell
npm run backfill
```

Perintah itu hanya membaca. Bila hasilnya sesuai, terapkan:

```powershell
npm run backfill:apply
```

Pemugaran memperbaiki kelas kata yang sebelumnya terbaca dari bentuk turunan,
mengisi kelas kata pada entri berlabel majemuk seperti `Ar n` atau `n kim`,
memisahkan lafal `/afdéling/`, mencatat label bidang/ragam/bahasa asal, dan
membersihkan naskah makna dari sisa kepala lema.

## Peta hubungan kata

Peta hanya sanggup memuat sekitar enam belas simpul sebelum labelnya bertindih,
jadi jatah simpul dibagi menurut bobot tiap kategori. Dua kendali mengatur apa
yang tampil:

- **Legenda sebagai saklar.** Klik Sinonim, Antonim, atau Hierarki untuk
  menyembunyikan kategori itu. Jatah yang ditinggalkan langsung dipakai kategori
  yang tersisa, sehingga mematikan dua kategori berarti kategori ketiga tampil
  penuh sampai enam belas simpul.
- **Kotak saring teks.** Ketik sebagian kata untuk menyaring simpul. Pencarian
  menelusuri **seluruh** relasi entri, bukan hanya simpul yang sedang tampak,
  sehingga tetangga yang semula terpotong oleh batas jatah bisa ikut muncul.
  `Esc` mengosongkan kotak tanpa menutup lembar kata.

Tombol **Atur ulang** muncul begitu salah satu kendali dipakai dan mengembalikan
peta ke tampilan bawaan.

## Struktur data

- `entries`: halaman lema utama, naskah definisi yang sudah disanitasi, kelas kata, lafal, dan label.
- `lexemes`: lema serta bentuk turunan/gabungan agar semuanya dapat dicari.
- `entry_labels`: label bidang ilmu, ragam, bahasa asal, dan penanda bentuk sebagai indeks penyaring.
- `relations`: relasi eksplisit KBBI dan relasi WordNet Bahasa.
- `crawl_queue`: antrean, percobaan, error, dan status resume.
- `entries_fts`: indeks FTS5 yang dipakai langsung oleh pencarian definisi di dashboard.

Skema membawa nomor versi pada tabel `metadata`, sehingga migrasi lama hanya
dijalankan sekali dan tidak memindai ulang tabel pada setiap perintah.

Database berada di `data/kbbi.db` dan sengaja tidak dimasukkan Git.

## Pengembangan

```powershell
npm run dev     # server dengan muat ulang otomatis
npm test        # 32 pengujian: pengurai, robots.txt, dan API server
```

Pengujian server menjalankan salinan `server.mjs` pada basis data sementara,
jadi `data/kbbi.db` tidak tersentuh.

Variabel lingkungan: `PORT` (bawaan 4173), `HOST` (bawaan 127.0.0.1), dan
`KBBI_DB_PATH` untuk menunjuk berkas basis data lain.

## Sumber dan batas penggunaan

`kbbi.web.id` menjelaskan bahwa basis utamanya mengacu pada KBBI Edisi III, merupakan arsip tidak resmi, dan isi utamanya adalah hak cipta Badan Pengembangan dan Pembinaan Bahasa. Setiap entri di dashboard menyimpan atribusi serta tautan langsung ke halaman sumber. Pastikan memperoleh izin yang sesuai sebelum mendistribusikan ulang basis data penuh atau menggunakannya secara komersial.

Relasi semantik memakai entri Bahasa bersama dan entri khusus Indonesia berkualitas `Y`/`O` dari WordNet Bahasa melalui paket `id-wordnet` (MIT), ditambah struktur relasi Princeton WordNet. Relasi dipetakan pada tingkat *synset*, sehingga tetap perlu pemeriksaan konteks untuk kata yang mempunyai banyak makna.

Singkatan label (`Ar`, `Jw`, `Min`, `Kim`, `Dok`, dan seterusnya) dipetakan di
`lib/labels.mjs`. Pemetaan disusun dari contoh entri yang benar-benar ada pada
koleksi, bukan daftar teoretis: `Min` berarti Mineralogi dan `Bl` berarti Bali.
Singkatan yang belum terdaftar tetap ditampilkan apa adanya.
