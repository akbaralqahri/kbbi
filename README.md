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
turunannya menjadi satu alamat yang tidak valid, misalnya
`adikadik bungsuadik iparadik seayah…`. Setelah crawl utama selesai, audit dan
perbaiki alamat tersebut, kemudian lanjutkan scraper:

```powershell
npm run repair:sitemap
node scripts/repair-sitemap.mjs --apply
node scripts/scrape.mjs --all --concurrency=2 --delay=2000
```

Perbaikan mengantre **setiap** prefiks lema yang dikenal pada slug rusak, bukan
hanya yang terpanjang. Pada contoh di atas, prefiks yang sah adalah `adi`,
`adik`, dan `adika`; mengambil yang terpanjang saja membuat `adik` tidak pernah
diminta ke server.

Prefiks slug rusak tetap tidak menemukan semua lema. Untuk menyisir sisanya,
tambahkan `--probe-wordlist`, yang mengantre setiap kata daftar acuan yang belum
ada di koleksi:

```powershell
node scripts/repair-sitemap.mjs --probe-wordlist
node scripts/repair-sitemap.mjs --probe-wordlist --apply
```

Mode ini menambah sekitar 9.400 alamat, yaitu kira-kira 4 jam crawl pada jeda
bawaan. Perintah tanpa `--apply` tidak mengubah database.

Daftar KBBI Edisi IV dari repositori `dyazincahya/KBBI-SQL-database` hanya
dipakai untuk mengenali batas lema pada alamat yang rusak dan untuk menebak
alamat yang belum diminta; arti dan naskah definisi tetap diambil dari
`kbbi.web.id`.

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

Dua pola kepala lema juga dibetulkan di sini:

- **Halaman pengalihan ejaan.** Sebagian halaman hanya berisi `<b>ak·te ? akta</b>`
  (panah aslinya sudah hilang menjadi tanda tanya pada naskah sumber). Seluruh
  baris itu sebelumnya tersimpan sebagai nama kata, sehingga `akte` tidak dapat
  dicari sama sekali. Kini terurai menjadi lema `akte` beserta relasi rujukan ke
  `akta`, memulihkan 1.786 kata sekaligus menambah rujukan silang KBBI asli dari
  350 menjadi lebih dari 2.000.
- **Nomor homonim berupa teks biasa.** Halaman seperti `<b>aib 1 </b>` menulis
  nomor homonim di luar `<sup>`, sehingga tersimpan sebagai kata `aib 1`.

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

### Kenapa banyak entri petanya kosong

Hampir seluruh jejaring berasal dari WordNet Bahasa; halaman KBBI sendiri jarang
menyebut sinonim secara tertulis (350 rujukan eksplisit berbanding 1,8 juta relasi
WordNet). Kosakata WordNet jauh lebih sempit daripada KBBI, sehingga entri yang
jarang, arkais, kedaerahan, atau teknis memang tidak punya tetangga.

Ada satu ketidakcocokan struktural yang penting: **WordNet mendaftarkan bentuk
berimbuhan sebagai lema tersendiri, sedangkan KBBI menyimpannya di bawah lema
induk.** `bercahaya` punya entri sendiri di WordNet, tetapi di KBBI ia hanya
bagian dari entri `cahaya`. Dua penyesuaian menjembatani hal itu:

- Pencarian tautan relasi menelusuri tabel `lexemes`, bukan hanya `entries`,
  sehingga pil yang menunjuk bentuk turunan membuka entri induknya. Bagian relasi
  yang dapat diklik naik dari 40% menjadi 80%.
- Entri yang tidak dikenal WordNet menampilkan relasi milik bentuk turunannya
  pada bagian terpisah dan pada peta dengan garis putus-putus, selalu disertai
  keterangan asalnya. Jumlah entri yang petanya terisi naik dari 10.646 (30,9%)
  menjadi 11.711 (34,0%).

Sisanya, sekitar dua pertiga entri, memang berada di luar jangkauan WordNet.
Peta menyatakan hal itu apa adanya alih-alih menampilkan kanvas kosong.

## Cakupan terhadap KBBI

Diukur terhadap daftar KBBI Edisi IV (71.093 kata) sebagai acuan independen:

| | jumlah | |
|---|---|---|
| ada sebagai lema utama | 29.931 | 42,1% |
| ada sebagai bentuk turunan | 31.447 | 44,2% |
| belum ada | 9.715 | 13,7% |

Sebagian dari yang belum ada memang tambahan Edisi IV yang tidak dimuat arsip
Edisi III, tetapi tidak semuanya: `adik`, `amnesia`, dan `alih fungsi` punya
halaman lengkap di `kbbi.web.id` dan tetap terlewat karena sitemap hanya memuat
slug gabungannya. Menjalankan `repair:sitemap` versi baru dan
`--probe-wordlist` menutup sebagian besar sisa itu.

Perlu diingat bahwa `kbbi.web.id` hanya memuat halaman untuk lema pokok. Bentuk
turunan seperti `belajar` tidak punya halaman sendiri di sana — ia tercatat di
dalam halaman `ajar`, dan koleksi ini menyimpannya sebagai bentuk turunan di
entri yang sama. Mencarinya tetap ketemu.

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
npm test        # 45 pengujian: pengurai, robots.txt, dan API server
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
