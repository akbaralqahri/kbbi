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

Sitemap sumber saat ini juga memuat sejumlah permalink yang menggabungkan lema
dan bentuk turunannya menjadi satu alamat yang tidak valid. Setelah crawl utama
selesai, audit dan perbaiki alamat tersebut, kemudian lanjutkan scraper:

```powershell
npm run repair:sitemap
node scripts/repair-sitemap.mjs --apply
node scripts/scrape.mjs --all --concurrency=2 --delay=2000
```

Perintah audit tidak mengubah database. Daftar KBBI Edisi IV dari repositori
`dyazincahya/KBBI-SQL-database` hanya dipakai untuk mengenali batas lema pada
alamat yang rusak; arti dan naskah definisi tetap diambil dari `kbbi.web.id`.

Scraper akan:

- memeriksa `robots.txt` sebelum bekerja;
- mengambil sekitar 39 ribu URL dari sitemap resmi;
- memakai satu pekerja dan jeda 1,5 detik secara bawaan;
- menyimpan progres ke SQLite sehingga aman dihentikan dengan `Ctrl+C` dan dilanjutkan dengan perintah yang sama;
- mencoba ulang kegagalan sementara hingga lima kali;
- memprioritaskan URL yang belum pernah dicoba sebelum mengulang kegagalan lama;
- melewati URL yang tidak memiliki definisi, bukan menyimpannya sebagai kata palsu.

Dengan batas yang sengaja sopan, crawl lengkap memerlukan sekitar 16–20 jam, tergantung respons server. Jangan menaikkan konkurensi tanpa izin pengelola situs. Untuk uji terbatas:

```powershell
node scripts/scrape.mjs --limit=100 --concurrency=1 --delay=1500
node scripts/scrape.mjs --slugs=ajar,cahaya,rumah
npm run status
```

## Struktur data

- `entries`: halaman lema utama dan naskah definisi yang sudah disanitasi.
- `lexemes`: lema serta bentuk turunan/gabungan agar semuanya dapat dicari.
- `relations`: relasi eksplisit KBBI dan relasi WordNet Bahasa.
- `crawl_queue`: antrean, percobaan, error, dan status resume.
- `entries_fts`: indeks teks definisi untuk pengembangan pencarian lanjutan.

Database berada di `data/kbbi.db` dan sengaja tidak dimasukkan Git.

## Sumber dan batas penggunaan

`kbbi.web.id` menjelaskan bahwa basis utamanya mengacu pada KBBI Edisi III, merupakan arsip tidak resmi, dan isi utamanya adalah hak cipta Badan Pengembangan dan Pembinaan Bahasa. Setiap entri di dashboard menyimpan atribusi serta tautan langsung ke halaman sumber. Pastikan memperoleh izin yang sesuai sebelum mendistribusikan ulang basis data penuh atau menggunakannya secara komersial.

Relasi semantik memakai entri Bahasa bersama dan entri khusus Indonesia berkualitas `Y`/`O` dari WordNet Bahasa melalui paket `id-wordnet` (MIT), ditambah struktur relasi Princeton WordNet. Relasi dipetakan pada tingkat *synset*, sehingga tetap perlu pemeriksaan konteks untuk kata yang mempunyai banyak makna.
