// Kelas kata baku KBBI.
export const WORD_CLASSES = new Map([
  ['n', 'Nomina'], ['v', 'Verba'], ['a', 'Adjektiva'], ['adv', 'Adverbia'],
  ['num', 'Numeralia'], ['p', 'Partikel'], ['pron', 'Pronomina']
]);

// Singkatan label yang benar-benar muncul pada koleksi ini, dipetakan dari
// contoh entri nyata (bukan daftar teoretis) supaya tidak salah tafsir:
// "Min" adalah Mineralogi, bukan Minangkabau; "Bl" adalah Bali, bukan Belanda.
const TABLE = [
  // Ragam dan kurun pemakaian.
  ['ark', 'Arkais', 'ragam'], ['kl', 'Klasik', 'ragam'], ['cak', 'Cakapan', 'ragam'],
  ['ki', 'Kiasan', 'ragam'], ['kas', 'Kasar', 'ragam'], ['hor', 'Hormat', 'ragam'],
  ['ung', 'Ungkapan', 'ragam'], ['pb', 'Peribahasa', 'ragam'],

  // Bahasa asal dan dialek.
  ['ar', 'Arab', 'bahasa'], ['jw', 'Jawa', 'bahasa'], ['mk', 'Minangkabau', 'bahasa'],
  ['jk', 'Jakarta', 'bahasa'], ['sd', 'Sunda', 'bahasa'], ['bl', 'Bali', 'bahasa'],
  ['bt', 'Batak', 'bahasa'], ['bg', 'Banjar', 'bahasa'], ['cn', 'Cina', 'bahasa'],
  ['bld', 'Belanda', 'bahasa'], ['ing', 'Inggris', 'bahasa'], ['jp', 'Jepang', 'bahasa'],
  ['lt', 'Latin', 'bahasa'], ['skt', 'Sanskerta', 'bahasa'], ['skr', 'Sanskerta', 'bahasa'],
  ['mal', 'Malaysia', 'bahasa'], ['ach', 'Aceh', 'bahasa'], ['kal', 'Kalimantan', 'bahasa'],
  ['mnd', 'Manado', 'bahasa'], ['prc', 'Perancis', 'bahasa'], ['port', 'Portugis', 'bahasa'],
  ['it', 'Italia', 'bahasa'], ['sp', 'Spanyol', 'bahasa'], ['yn', 'Yunani', 'bahasa'],
  ['pl', 'Palembang', 'bahasa'],

  // Bidang ilmu, agama, dan profesi.
  ['kim', 'Kimia', 'bidang'], ['dok', 'Kedokteran', 'bidang'], ['bio', 'Biologi', 'bidang'],
  ['biol', 'Biologi', 'bidang'], ['ling', 'Linguistik', 'bidang'], ['fis', 'Fisika', 'bidang'],
  ['psi', 'Psikologi', 'bidang'], ['psikol', 'Psikologi', 'bidang'], ['isl', 'Islam', 'bidang'],
  ['kris', 'Kristen', 'bidang'], ['kat', 'Katolik', 'bidang'], ['hin', 'Hindu', 'bidang'],
  ['bud', 'Buddha', 'bidang'], ['geo', 'Geografi', 'bidang'], ['geol', 'Geologi', 'bidang'],
  ['geog', 'Geografi', 'bidang'], ['anat', 'Anatomi', 'bidang'], ['lay', 'Pelayaran', 'bidang'],
  ['sas', 'Sastra', 'bidang'], ['zool', 'Zoologi', 'bidang'], ['huk', 'Hukum', 'bidang'],
  ['met', 'Meteorologi', 'bidang'], ['bot', 'Botani', 'bidang'], ['mus', 'Musik', 'bidang'],
  ['olr', 'Olahraga', 'bidang'], ['mat', 'Matematika', 'bidang'], ['far', 'Farmasi', 'bidang'],
  ['el', 'Elektronika', 'bidang'], ['antr', 'Antropologi', 'bidang'], ['pol', 'Politik', 'bidang'],
  ['sen', 'Seni', 'bidang'], ['tan', 'Pertanian', 'bidang'], ['ek', 'Ekonomi', 'bidang'],
  ['tek', 'Teknik', 'bidang'], ['astron', 'Astronomi', 'bidang'], ['astrol', 'Astrologi', 'bidang'],
  ['graf', 'Grafika', 'bidang'], ['min', 'Mineralogi', 'bidang'], ['mil', 'Militer', 'bidang'],
  ['ikn', 'Perikanan', 'bidang'], ['dag', 'Perdagangan', 'bidang'], ['tern', 'Peternakan', 'bidang'],
  ['komp', 'Komputer', 'bidang'], ['kom', 'Komunikasi', 'bidang'], ['tas', 'Tasawuf', 'bidang'],
  ['man', 'Manajemen', 'bidang'], ['dik', 'Pendidikan', 'bidang'], ['stat', 'Statistik', 'bidang'],
  ['sos', 'Sosiologi', 'bidang'], ['fil', 'Filsafat', 'bidang'], ['filol', 'Filologi', 'bidang'],
  ['kap', 'Perkapalan', 'bidang'], ['adm', 'Administrasi', 'bidang'], ['arke', 'Arkeologi', 'bidang'],
  ['dirg', 'Dirgantara', 'bidang'], ['ent', 'Entomologi', 'bidang'], ['fisiol', 'Fisiologi', 'bidang'],
  ['hidro', 'Hidrologi', 'bidang'], ['hut', 'Kehutanan', 'bidang'], ['idt', 'Industri', 'bidang'],
  ['mek', 'Mekanika', 'bidang'], ['opt', 'Optika', 'bidang'], ['otom', 'Otomotif', 'bidang'],
  ['pet', 'Petrologi', 'bidang'], ['tbg', 'Pertambangan', 'bidang'], ['transp', 'Transportasi', 'bidang'],
  ['dem', 'Demografi', 'bidang'], ['keb', 'Kebudayaan', 'bidang'], ['adv-h', 'Advokasi', 'bidang'],

  // Penanda bentuk kata.
  ['bentukterikat', 'Bentuk terikat', 'bentuk'], ['akr', 'Akronim', 'bentuk'],
  ['akronim', 'Akronim', 'bentuk'], ['kependekan', 'Kependekan', 'bentuk'],
  ['sufiks', 'Sufiks', 'bentuk'], ['prefiks', 'Prefiks', 'bentuk'],
  ['infiks', 'Infiks', 'bentuk'], ['konfiks', 'Konfiks', 'bentuk'],
  ['klitika', 'Klitika', 'bentuk']
];

export const LABELS = new Map(TABLE.map(([code, label, kind]) => [code, { code, label, kind }]));

export const LABEL_KIND_NAMES = {
  ragam: 'Ragam', bahasa: 'Bahasa asal', bidang: 'Bidang', bentuk: 'Bentuk'
};

export function labelInfo(code) {
  return LABELS.get(code) ?? { code, label: code.replace(/^./, (c) => c.toUpperCase()), kind: 'bidang' };
}

export function isKnownToken(token) {
  return WORD_CLASSES.has(token) || LABELS.has(token);
}
