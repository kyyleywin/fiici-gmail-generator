/* ════════════════════════════════════════════════════════
   FIICI GMAIL GENERATOR — GOOGLE APPS SCRIPT BACKEND
   ════════════════════════════════════════════════════════
   Fungsi: menyimpan & menyajikan data GLOBAL (menyeluruh,
   sama di semua device) untuk Dashboard:
     - Total Member (semua user yang pernah daftar)
     - Total Email (gabungan dari SEMUA user)
     - Sudah Login / Belum Login (gabungan semua user)
     - Tersimpan (gabungan semua user)
     - Sedang Online (gabungan semua user, aktif 5 menit terakhir)

   Data Profil (di halaman Profil) TIDAK memakai data ini —
   itu tetap dihitung dari data lokal milik user sendiri di
   browser/device tersebut (lihat script.js -> renderProfile()).

   CARA PASANG:
   1. Buka https://sheets.google.com, buat Spreadsheet baru.
   2. Menu Extensions > Apps Script.
   3. Hapus isi default, lalu tempel SELURUH isi file ini.
   4. Klik Deploy > New deployment.
      - Pilih tipe: "Web app"
      - Execute as: "Me"
      - Who has access: "Anyone"
      - Klik Deploy, izinkan akses yang diminta.
   5. Salin URL Web App yang muncul (diakhiri /exec).
   6. Tempel URL itu ke variabel SHEET_WEBHOOK_URL di script.js.
   ════════════════════════════════════════════════════════ */

const SHEET_MEMBERS = 'Members';
const SHEET_STATS    = 'Stats';
const SHEET_ONLINE   = 'Online';
const SHEET_LOG      = 'Log';
const SHEET_EMAILS   = 'EmailsData';
const SHEET_OTPLOG   = 'OtpLog';
const ONLINE_WINDOW_MS = 5 * 60 * 1000; // 5 menit dianggap "online"

/* ── FONNTE WA OTP (dipindah ke server supaya token aman & rate-limit bisa ditegakkan) ──
   Daftar gratis di https://fonnte.com, sambungkan nomor WA, lalu copy token API ke sini. */
const FONNTE_TOKEN = 'UpsFTSUoXfjmWKLztgif'; // <-- isi dengan token Fonnte kamu

/* ── Anti-spam: batas kirim OTP, supaya nomor WA Fonnte tidak dianggap spam & dibanned ── */
const MAX_OTP_PER_WA_PER_HOUR   = 3;   // maksimal 3x kirim OTP per nomor WA per jam
const MIN_SECONDS_BETWEEN_OTP   = 60;  // jeda minimal antar kirim OTP utk nomor yang sama
const MAX_OTP_GLOBAL_PER_HOUR   = 60;  // maksimal total kirim OTP per jam dari seluruh aplikasi
const RATE_WINDOW_HOUR_MS = 60 * 60 * 1000;
const RATE_WINDOW_DAY_MS  = 24 * 60 * 60 * 1000;

const EMAILS_HEADERS = ['id','userId','username','address','status','saved','createdAt','disetor','disetorAt','expired','expiredAt','firstName','lastName'];

function getOrCreateSheet_(name, headers){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else {
    // perbaiki header kalau berbeda (mis. sheet lama masih pakai header lama)
    const currentHeader = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    const isSame = headers.every((h,i)=>String(currentHeader[i]||'') === h);
    if(!isSame){
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }
  return sh;
}

const MEMBERS_HEADERS = ['userId','username','name','email','wa','password','createdAt','waVerified','photoData','lastActiveAt'];

function findRowByUserId_(sheet, userId){
  const data = sheet.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][0]) === String(userId)) return i+1; // 1-based row index
  }
  return -1;
}

/* ── doPost: menerima update dari setiap device ── */
function doPost(e){
  try{
    const body = JSON.parse(e.postData.contents);
    const type = body.type;

    if(type === 'register'){
      upsertMember_(body.userId, body.username, body.name, body.email, body.wa, body.password||'', body.waVerified, body.photoData||'');
      // PENTING: jangan timpa Stats yang sudah ada dgn 0 kalau user ini sudah punya baris
      // (mis. karena syncLocalUserToSheet ikut kirim 'register' tiap kali app dibuka).
      // Hanya inisialisasi 0 kalau memang baris Stats belum pernah ada, supaya total email
      // yang sudah tersimpan di Sheet tidak mendadak "ketimpa" jadi 0 di Dashboard.
      initStatsIfMissing_(body.userId, body.username);
      logEvent_(body);
    } else if(type === 'profile_update'){
      upsertMember_(body.userId, body.username, body.name, body.email, body.wa, '', body.waVerified, body.photoData||'');
      logEvent_(body);
    } else if(type === 'stats_update'){
      // body.loggedinEmails = jumlah "Proses", body.savedEmails = jumlah "Success" (lihat script.js)
      upsertStats_(body.userId, body.username, body.totalEmails||0, body.loggedinEmails||0, body.savedEmails||0);
    } else if(type === 'online_ping'){
      upsertOnline_(body.userId, body.username);
    } else if(type === 'login'){
      if(body.userId) upsertOnline_(body.userId, body.username);
      logEvent_(body);
    } else if(type === 'password_change'){
      if(body.userId) upsertMember_(body.userId, body.username, body.name||'', body.email||'', body.wa||'', body.password||'', body.waVerified, body.photoData||'');
      logEvent_(body);
    } else if(type === 'wa_verified'){
      // WA verified = sama dengan register ulang, update data terbaru
      if(body.userId) upsertMember_(body.userId, body.username, body.name||'', body.email||'', body.wa||'', body.password||'', true, body.photoData||'');
      logEvent_(body);
    } else if(type === 'delete_account'){
      if(body.userId) deleteAccountData_(body.userId);
      logEvent_(body);
    } else if(type === 'email_upsert'){
      if(body.userId && Array.isArray(body.items)) upsertEmails_(body.userId, body.username||'', body.items);
    } else if(type === 'email_delete'){
      if(body.userId && Array.isArray(body.ids)) deleteEmails_(body.userId, body.ids);
    } else if(type === 'send_otp'){
      return sendOtp_(body);
    } else {
      logEvent_(body);
    }

    return ContentService.createTextOutput(JSON.stringify({ok:true}))
      .setMimeType(ContentService.MimeType.JSON);
  }catch(err){
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(err)}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/* ── doGet: dipanggil semua device untuk ambil ringkasan GLOBAL ── */
function doGet(e){
  const params = e ? (e.parameter || {}) : {};

  /* ── Verifikasi login (cross-device) ── */
  if(params.action === 'login'){
    const sh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
    const data = sh.getDataRange().getValues();
    const username = String(params.username||'').toLowerCase().trim();
    const password = String(params.password||'').trim();
    for(let i=1;i<data.length;i++){
      if(String(data[i][1]).toLowerCase().trim() === username){
        const storedPass = String(data[i][5]||'').trim();
        if(storedPass === password || storedPass === ''){
          return ContentService.createTextOutput(JSON.stringify({
            ok: true, found: true,
            user: {
              userId:String(data[i][0]), username:String(data[i][1]), name:String(data[i][2]),
              email:String(data[i][3]), wa:String(data[i][4]), createdAt:Number(data[i][6])||Date.now(),
              waVerified: data[i][7]===true || String(data[i][7]).toLowerCase()==='true',
              photoData: String(data[i][8]||'')
            }
          })).setMimeType(ContentService.MimeType.JSON);
        } else {
          return ContentService.createTextOutput(JSON.stringify({ ok:true, found:false, reason:'wrong_password' })).setMimeType(ContentService.MimeType.JSON);
        }
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok:true, found:false, reason:'not_found' })).setMimeType(ContentService.MimeType.JSON);
  }

  /* ── Ambil data email milik satu user (dipakai saat login di device baru) ── */
  if(params.action === 'get_emails'){
    const items = getEmailsForUser_(params.userId||'');
    return jsonOut_({ ok:true, items: items });
  }

  /* ── Ambil profil terbaru milik satu user (dipakai saat refresh browser saja,
       tanpa perlu login ulang / edit profil dulu, supaya semua device selalu tersinkron) ── */
  if(params.action === 'get_profile'){
    const sh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
    const row = findRowByUserId_(sh, params.userId||'');
    if(row === -1) return jsonOut_({ ok:true, found:false });
    const d = sh.getRange(row, 1, 1, MEMBERS_HEADERS.length).getValues()[0];
    return jsonOut_({ ok:true, found:true, user:{
      userId:String(d[0]), username:String(d[1]), name:String(d[2]), email:String(d[3]),
      wa:String(d[4]), createdAt:Number(d[6])||Date.now(),
      waVerified: d[7]===true || String(d[7]).toLowerCase()==='true',
      photoData:String(d[8]||'')
    }});
  }

  /* ── Cek ketersediaan username/email/WA sebelum kirim OTP (cegah duplikat lintas device) ── */
  if(params.action === 'check_available'){
    const sh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
    const data = sh.getDataRange().getValues();
    const username = String(params.username||'').toLowerCase().trim();
    const email = String(params.email||'').toLowerCase().trim();
    const waDigits = String(params.wa||'').replace(/\D/g,'');
    let usernameTaken=false, emailTaken=false, waTaken=false;
    for(let i=1;i<data.length;i++){
      if(username && String(data[i][1]).toLowerCase().trim()===username) usernameTaken=true;
      if(email && String(data[i][3]).toLowerCase().trim()===email) emailTaken=true;
      if(waDigits && String(data[i][4]).replace(/\D/g,'')===waDigits) waTaken=true;
    }
    return jsonOut_({ ok:true, usernameTaken, emailTaken, waTaken });
  }

  /* ── Global dashboard stats ── */
  const membersSheet = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
  const statsSheet    = getOrCreateSheet_(SHEET_STATS, ['userId','username','totalEmails','Proses','Success','updatedAt']);
  const onlineSheet   = getOrCreateSheet_(SHEET_ONLINE, ['userId','username','lastSeen']);

  const totalMembers = Math.max(0, membersSheet.getLastRow() - 1);

  let totalEmails = 0, totalProses = 0, totalSuccess = 0;
  const statsData = statsSheet.getDataRange().getValues();
  for(let i=1;i<statsData.length;i++){
    totalEmails  += Number(statsData[i][2]) || 0; // totalEmails
    totalProses  += Number(statsData[i][3]) || 0; // kolom "Proses"
    totalSuccess += Number(statsData[i][4]) || 0; // kolom "Success"
  }

  let online = 0;
  const now = Date.now();
  const onlineData = onlineSheet.getDataRange().getValues();
  const staleRows = [];
  for(let i=1;i<onlineData.length;i++){
    const ts = Number(onlineData[i][2]) || 0;
    if(now - ts < ONLINE_WINDOW_MS) online++;
    else staleRows.push(i+1); // sudah lewat 5 menit -> tidak lagi online, buang dari tab
  }
  // Hapus baris yang sudah tidak online supaya tab "Online" di Sheet cuma berisi member
  // yang benar-benar sedang aktif (bukan riwayat semua orang yang pernah online).
  for(let i=staleRows.length-1;i>=0;i--) onlineSheet.deleteRow(staleRows[i]);

  const out = {
    ok: true,
    totalMembers: totalMembers,
    totalEmails: totalEmails,
    totalLoggedin: totalSuccess,      // dashboard "Success"
    totalNotLoggedin: totalProses,    // dashboard "Proses"
    totalSaved: totalSuccess,
    online: online,
    updatedAt: now
  };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function upsertMember_(userId, username, name, email, wa, password, waVerified, photoData){
  if(!userId) return;
  const sh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
  const row = findRowByUserId_(sh, userId);
  if(row === -1){
    sh.appendRow([userId, username||'', name||'', email||'', wa||'', password||'', Date.now(), !!waVerified, photoData||'', Date.now()]);
  } else {
    // update semua kolom kecuali createdAt, dan update password jika ada isian baru
    const range = sh.getRange(row, 2, 1, 5).getValues()[0];
    const existingPass = String(sh.getRange(row, 6).getValue()||'');
    const existingWaVerified = !!sh.getRange(row, 8).getValue();
    const existingPhoto = String(sh.getRange(row, 9).getValue()||'');
    sh.getRange(row, 2, 1, 5).setValues([[username||range[0], name||range[1], email||range[2], wa||range[3], password||existingPass]]);
    // jangan pernah menurunkan status dari sudah-terverifikasi ke belum, dan jangan hapus foto lama kalau tidak dikirim ulang
    sh.getRange(row, 8).setValue(!!waVerified || existingWaVerified);
    sh.getRange(row, 9).setValue(photoData || existingPhoto);
    // setiap kali data akun disinkron (mis. app dibuka), tandai member ini masih aktif
    sh.getRange(row, 10).setValue(Date.now());
  }
}

/* Inisialisasi baris Stats ke 0 HANYA kalau user ini belum pernah punya baris sama sekali.
   Dipakai oleh handler 'register' supaya register ulang / sync akun (dipanggil tiap app dibuka)
   tidak menimpa/mereset total email yang sudah ada. */
function initStatsIfMissing_(userId, username){
  if(!userId) return;
  const sh = getOrCreateSheet_(SHEET_STATS, ['userId','username','totalEmails','Proses','Success','updatedAt']);
  const row = findRowByUserId_(sh, userId);
  if(row === -1){
    sh.appendRow([userId, username||'', 0, 0, 0, Date.now()]);
  }
}

/* totalEmails -> kolom totalEmails | prosesCount -> kolom "Proses" | successCount -> kolom "Success" */
function upsertStats_(userId, username, totalEmails, prosesCount, successCount){
  if(!userId) return;
  const sh = getOrCreateSheet_(SHEET_STATS, ['userId','username','totalEmails','Proses','Success','updatedAt']);
  const row = findRowByUserId_(sh, userId);
  if(row === -1){
    sh.appendRow([userId, username||'', totalEmails, prosesCount, successCount, Date.now()]);
  } else {
    sh.getRange(row, 2, 1, 5).setValues([[username||'', totalEmails, prosesCount, successCount, Date.now()]]);
  }
}

function upsertOnline_(userId, username){
  if(!userId) return;
  const sh = getOrCreateSheet_(SHEET_ONLINE, ['userId','username','lastSeen']);
  const row = findRowByUserId_(sh, userId);
  if(row === -1){
    sh.appendRow([userId, username||'', Date.now()]);
  } else {
    sh.getRange(row, 2, 1, 2).setValues([[username||'', Date.now()]]);
  }
  // ping online = bukti member ini masih aktif -> catat di Members supaya bisa dipakai
  // untuk aturan pembersihan akun tidak aktif (lihat pruneInactiveMembers_)
  const membersSh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
  const mRow = findRowByUserId_(membersSh, userId);
  if(mRow !== -1) membersSh.getRange(mRow, 10).setValue(Date.now());
}

function logEvent_(body){
  const sh = getOrCreateSheet_(SHEET_LOG, ['timestamp','type','username','name','email','wa']);
  sh.appendRow([body.timestamp||new Date().toISOString(), body.type||'', body.username||'', body.name||'', body.email||'', body.wa||'']);
}

function jsonOut_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ══════════════════════════════
   DATA EMAIL PER USER (supaya ikut pindah kalau ganti device)
══════════════════════════════ */
function upsertEmails_(userId, username, items){
  if(!userId || !items.length) return;
  const sh = getOrCreateSheet_(SHEET_EMAILS, EMAILS_HEADERS);
  const data = sh.getDataRange().getValues();
  const rowById = {};
  for(let i=1;i<data.length;i++){
    if(String(data[i][1]) === String(userId)) rowById[String(data[i][0])] = i+1;
  }
  items.forEach(function(it){
    if(!it || !it.id) return;
    const row = rowById[String(it.id)];
    // PENTING: kolom "username" di sini adalah username Gmail hasil generate (it.username),
    // BUKAN username akun pemilik (parameter "username" di atas). Sebelumnya kedua hal ini
    // tertukar sehingga di device lain username email berubah jadi username akun.
    const rec = [it.id, userId, it.username||'', it.address||'', it.status||'created', !!it.saved, it.createdAt||Date.now(), !!it.disetor, it.disetorAt||'', !!it.expired, it.expiredAt||'', it.firstName||'', it.lastName||''];
    if(row){
      sh.getRange(row, 1, 1, EMAILS_HEADERS.length).setValues([rec]);
    } else {
      sh.appendRow(rec);
    }
  });
}

function deleteEmails_(userId, ids){
  if(!userId || !ids.length) return;
  const sh = getOrCreateSheet_(SHEET_EMAILS, EMAILS_HEADERS);
  const data = sh.getDataRange().getValues();
  const idSet = {}; ids.forEach(function(id){ idSet[String(id)] = true; });
  const rowsToDelete = [];
  for(let i=1;i<data.length;i++){
    if(String(data[i][1]) === String(userId) && idSet[String(data[i][0])]) rowsToDelete.push(i+1);
  }
  for(let i=rowsToDelete.length-1;i>=0;i--) sh.deleteRow(rowsToDelete[i]);
}

function deleteAllEmailsForUser_(userId){
  if(!userId) return;
  const sh = getOrCreateSheet_(SHEET_EMAILS, EMAILS_HEADERS);
  const data = sh.getDataRange().getValues();
  const rowsToDelete = [];
  for(let i=1;i<data.length;i++){
    if(String(data[i][1]) === String(userId)) rowsToDelete.push(i+1);
  }
  for(let i=rowsToDelete.length-1;i>=0;i--) sh.deleteRow(rowsToDelete[i]);
}

function getEmailsForUser_(userId){
  if(!userId) return [];
  const sh = getOrCreateSheet_(SHEET_EMAILS, EMAILS_HEADERS);
  const data = sh.getDataRange().getValues();
  const out = [];
  for(let i=1;i<data.length;i++){
    if(String(data[i][1]) === String(userId)){
      out.push({
        id: String(data[i][0]), username: String(data[i][2]), address: String(data[i][3]),
        status: String(data[i][4]||'created'), saved: !!data[i][5], createdAt: Number(data[i][6])||Date.now(),
        disetor: !!data[i][7], disetorAt: Number(data[i][8])||null,
        expired: !!data[i][9], expiredAt: Number(data[i][10])||null,
        firstName: String(data[i][11]||''), lastName: String(data[i][12]||'')
      });
    }
  }
  return out;
}

/* ══════════════════════════════
   MAINTENANCE OTOMATIS
   Jalankan fungsi setupTriggers() SEKALI SAJA secara manual dari editor
   Apps Script (pilih function "setupTriggers" di dropdown atas, lalu klik "Run")
   supaya jadwal di bawah ini aktif otomatis tanpa perlu ada yang buka web app-nya.
══════════════════════════════ */

// Reset tab "Log" setiap sekian jam (HANYA tab Log, tab lain tidak disentuh di sini).
// Nilai yang valid untuk trigger per-jam Apps Script: 1, 2, 4, 6, 8, atau 12.
// Rekomendasi: 12 jam cukup pas -> log cukup panjang utk lacak masalah 1 hari terakhir,
// tapi sheet tidak membengkak. Kalau trafik sangat ramai & sheet cepat penuh, pakai 6.
// Kalau justru ingin histori log lebih lama utk audit, pakai 24 -> ganti everyHours(12)
// di setupTriggers() menjadi .timeBased().everyDays(1) di bawah.
const LOG_RESET_INTERVAL_HOURS = 12;

function resetLogSheet_(){
  const sh = getOrCreateSheet_(SHEET_LOG, ['timestamp','type','username','name','email','wa']);
  const lastRow = sh.getLastRow();
  if(lastRow > 1) sh.getRange(2, 1, lastRow-1, sh.getLastColumn()).clearContent();
}

// Hapus baris di Stats / Online / EmailsData yang userId-nya sudah tidak ada lagi
// di Members (mis. akun sudah dihapus tapi ada baris tersisa krn sinkron gagal
// di tengah jalan, atau sheet pernah diedit manual). deleteAccountData_() sudah
// menghapus langsung saat user hapus akun dari app; ini lapisan pengaman tambahan.
function cleanupOrphanedData_(){
  const membersSh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
  const memberData = membersSh.getDataRange().getValues();
  const validIds = new Set();
  for(let i=1;i<memberData.length;i++){ if(memberData[i][0]) validIds.add(String(memberData[i][0])); }

  removeOrphanRows_(getOrCreateSheet_(SHEET_STATS, ['userId','username','totalEmails','Proses','Success','updatedAt']), validIds, 0);
  removeOrphanRows_(getOrCreateSheet_(SHEET_ONLINE, ['userId','username','lastSeen']), validIds, 0);
  removeOrphanRows_(getOrCreateSheet_(SHEET_EMAILS, EMAILS_HEADERS), validIds, 1); // kolom userId di EmailsData ada di index ke-2 (index 1)
}

function removeOrphanRows_(sheet, validIdSet, userIdColIndex){
  const data = sheet.getDataRange().getValues();
  const rowsToDelete = [];
  for(let i=1;i<data.length;i++){
    const uid = String(data[i][userIdColIndex]||'');
    if(uid && !validIdSet.has(uid)) rowsToDelete.push(i+1);
  }
  for(let i=rowsToDelete.length-1;i>=0;i--) sheet.deleteRow(rowsToDelete[i]);
}

// Berapa lama member dianggap "hantu" (tidak pernah buka app/online) sebelum dihapus otomatis.
// Ubah angka ini sesuai kebutuhan (mis. 30 untuk lebih agresif, 90 untuk lebih longgar).
const INACTIVE_MEMBER_DAYS = 180; // ≈ 6 bulan

// Hapus member yang sudah tidak aktif (tidak pernah buka app / online) lebih dari
// INACTIVE_MEMBER_DAYS hari. Dipakai buat bersihin akun "hantu" peninggalan sebelum
// fitur hapus-akun tersinkron dengan benar ke Sheet. Cascade ke Stats/Online/EmailsData
// lewat deleteAccountData_ (fungsi yang sama yang dipakai saat user hapus akun manual).
function pruneInactiveMembers_(){
  const sh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
  const data = sh.getDataRange().getValues();
  const now = Date.now();
  const cutoffMs = INACTIVE_MEMBER_DAYS * 24 * 60 * 60 * 1000;
  const staleUserIds = [];
  for(let i=1;i<data.length;i++){
    const userId = String(data[i][0]||'');
    if(!userId) continue;
    const lastActiveAt = Number(data[i][9]) || 0;
    if(!lastActiveAt){
      // Baris lama dari sebelum kolom lastActiveAt ada (atau belum pernah tercatat sama
      // sekali) -> JANGAN langsung anggap tidak aktif berdasarkan createdAt lama, itu bisa
      // salah hapus akun yang sebenarnya masih aktif. Cukup mulai catat dari sekarang, baru
      // dihitung tidak aktifnya mulai dari titik ini di pengecekan berikutnya.
      sh.getRange(i+1, 10).setValue(now);
      continue;
    }
    if((now - lastActiveAt) > cutoffMs) staleUserIds.push(userId);
  }
  staleUserIds.forEach(id => deleteAccountData_(id));
  return staleUserIds; // dikembalikan supaya bisa dicek manual lewat log eksekusi kalau perlu
}

// Ini fungsi yang dipanggil otomatis oleh trigger terjadwal.
function scheduledMaintenance(){
  resetLogSheet_();
  cleanupOrphanedData_();
  pruneInactiveMembers_();
}

/**
 * PERBAIKAN MANUAL: benerin tanggal "Bergabung pada" (createdAt) kalau kebetulan
 * kena reset akibat bug pruneInactiveMembers_ di atas.
 * Cara pakai: isi USERNAME dan TANGGAL_ASLI di bawah, lalu jalankan fungsi ini
 * SEKALI dari editor Apps Script (pilih fungsi "perbaikiTanggalBergabung" -> Run).
 */
function perbaikiTanggalBergabung(){
  const USERNAME = 'ganti_dengan_username_kamu';   // <-- ganti ini
  const TANGGAL_ASLI = '2026-05-10';                // <-- ganti ini, format: YYYY-MM-DD

  const sh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
  const data = sh.getDataRange().getValues();
  for(let i=1;i<data.length;i++){
    if(String(data[i][1]||'').toLowerCase() === USERNAME.toLowerCase()){
      const ts = new Date(TANGGAL_ASLI + 'T00:00:00').getTime();
      sh.getRange(i+1, 7).setValue(ts);   // kolom 7 = createdAt
      sh.getRange(i+1, 10).setValue(Date.now()); // tandai aktif sekarang juga
      Logger.log('Berhasil, createdAt untuk "' + USERNAME + '" diubah ke ' + TANGGAL_ASLI);
      return;
    }
  }
  Logger.log('Username "' + USERNAME + '" tidak ditemukan di tab Members.');
}

// Jalankan fungsi ini SATU KALI secara manual (Run > setupTriggers di editor Apps Script)
// untuk memasang jadwal otomatis di atas. Aman dijalankan berkali-kali (trigger lama
// dibersihkan dulu supaya tidak dobel).
function setupTriggers(){
  ScriptApp.getProjectTriggers().forEach(t=>{
    if(t.getHandlerFunction() === 'scheduledMaintenance') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('scheduledMaintenance')
    .timeBased()
    .everyHours(LOG_RESET_INTERVAL_HOURS)
    .create();
}

/* ══════════════════════════════
   OTP PROXY + ANTI-SPAM
   Fonnte token & pengiriman ditangani di server (bukan browser), supaya:
   1) tidak bisa dipanggil langsung dari luar tanpa lewat rate-limit di bawah,
   2) nomor WA Fonnte tidak dianggap spam & dibanned oleh WhatsApp.
══════════════════════════════ */
function normalizeWaServer_(wa){
  let d = String(wa||'').replace(/\D/g,'');
  if(d.startsWith('0')) d = '62' + d.slice(1);
  else if(!d.startsWith('62')) d = '62' + d;
  return d;
}

function checkAndLogOtpRateLimit_(wa){
  const sh = getOrCreateSheet_(SHEET_OTPLOG, ['timestamp','wa']);
  const now = Date.now();
  const data = sh.getDataRange().getValues();
  let waCount = 0, globalCount = 0, lastWaSent = 0;
  const rowsToDelete = [];
  for(let i=1;i<data.length;i++){
    const ts = Number(data[i][0]) || 0;
    const rowWa = String(data[i][1]||'');
    if(now - ts > RATE_WINDOW_DAY_MS){ rowsToDelete.push(i+1); continue; } // buang log lebih dari 24 jam
    if(now - ts <= RATE_WINDOW_HOUR_MS){
      globalCount++;
      if(rowWa === wa){ waCount++; if(ts > lastWaSent) lastWaSent = ts; }
    }
  }
  for(let i=rowsToDelete.length-1;i>=0;i--) sh.deleteRow(rowsToDelete[i]);

  if(lastWaSent && (now - lastWaSent) < MIN_SECONDS_BETWEEN_OTP*1000){
    return { ok:false, reason:'too_fast', retryAfterSeconds: Math.ceil((MIN_SECONDS_BETWEEN_OTP*1000 - (now-lastWaSent))/1000) };
  }
  if(waCount >= MAX_OTP_PER_WA_PER_HOUR){
    return { ok:false, reason:'wa_limit', retryAfterSeconds: 3600 };
  }
  if(globalCount >= MAX_OTP_GLOBAL_PER_HOUR){
    return { ok:false, reason:'global_limit', retryAfterSeconds: 3600 };
  }
  sh.appendRow([now, wa]);
  return { ok:true };
}

function sendOtp_(body){
  const wa = normalizeWaServer_(body.wa);
  if(!wa || wa.length < 9 || !body.otp){
    return jsonOut_({ ok:false, reason:'invalid_input' });
  }
  const rl = checkAndLogOtpRateLimit_(wa);
  if(!rl.ok) return jsonOut_(rl);

  const msg = body.message || ('Kode OTP kamu: ' + body.otp);
  try{
    const res = UrlFetchApp.fetch('https://api.fonnte.com/send', {
      method: 'post',
      headers: { Authorization: FONNTE_TOKEN },
      payload: { target: wa, message: msg, delay: '0', countryCode: '62' },
      muteHttpExceptions: true
    });
    const txt = res.getContentText() || '{}';
    let resData = {};
    try{ resData = JSON.parse(txt); }catch(e){ resData = { raw: txt }; }
    return jsonOut_({ ok: resData.status !== false, detail: resData });
  }catch(err){
    return jsonOut_({ ok:false, reason:'fonnte_error', error:String(err) });
  }
}

function deleteAccountData_(userId){
  if(!userId) return;
  // Hapus dari Members
  const membersSh = getOrCreateSheet_(SHEET_MEMBERS, MEMBERS_HEADERS);
  const mRow = findRowByUserId_(membersSh, userId);
  if(mRow !== -1) membersSh.deleteRow(mRow);
  // Hapus dari Stats
  const statsSh = getOrCreateSheet_(SHEET_STATS, ['userId','username','totalEmails','Proses','Success','updatedAt']);
  const sRow = findRowByUserId_(statsSh, userId);
  if(sRow !== -1) statsSh.deleteRow(sRow);
  // Hapus dari Online
  const onlineSh = getOrCreateSheet_(SHEET_ONLINE, ['userId','username','lastSeen']);
  const oRow = findRowByUserId_(onlineSh, userId);
  if(oRow !== -1) onlineSh.deleteRow(oRow);
  // Hapus semua baris email milik user ini
  deleteAllEmailsForUser_(userId);
}
