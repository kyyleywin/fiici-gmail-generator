/* ── KEYS ── */
const STORAGE_KEY = 'fiici_emails';
const USERS_KEY   = 'fiici_users';
const SESSION_KEY = 'fiici_session';
const ONLINE_KEY  = 'fiici_online';
const GLOBAL_STATS_KEY = 'fiici_global_stats_cache';

/* ── GOOGLE SHEETS SYNC ──
   1. Buat Google Sheet baru.
   2. Extensions > Apps Script, tempel kode dari file "google-apps-script.js" yang disertakan.
   3. Deploy > New deployment > Web app, akses "Anyone", lalu deploy.
   4. Copy URL Web App yang muncul, tempel ke bawah ini. */
const SHEET_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyfO1wdT9Ijb1JwSdnLUc4CmPkFIeKdltPxputbQzLcIkYCfmcoWisBoWS-0fKkrD5C/exec'; // <-- isi dengan URL Web App Google Apps Script Anda

/* ── FONNTE WA OTP ──
   Pengiriman OTP sekarang diproses di server (google-apps-script.js), bukan
   langsung dari browser. Ini supaya token Fonnte tidak terekspos ke publik,
   dan supaya batas anti-spam OTP benar-benar bisa ditegakkan (tidak bisa
   dilewati lewat console browser). Isi token Fonnte di variabel FONNTE_TOKEN
   pada google-apps-script.js, bukan di sini. */

function syncToSheet(type, data, retriesLeft){
  if(!SHEET_WEBHOOK_URL) return Promise.resolve(false); // belum dikonfigurasi, lewati diam-diam
  const payload = Object.assign({ type, timestamp: new Date().toISOString() }, data);
  // Catatan: sebelumnya pakai mode:'no-cors' yang membuat SEMUA kegagalan (URL Apps Script
  // salah/berubah, kuota habis, dll) tersembunyi total dan tidak pernah di-retry — ini salah
  // satu penyebab dashboard/data kadang tidak sinkron ("0 semua"). Sekarang pakai fetch biasa
  // (Apps Script Web App ber-akses "Anyone" sudah mengirim header CORS yang benar) supaya
  // kegagalan bisa dideteksi dan dicoba ulang.
  return fetch(SHEET_WEBHOOK_URL, {
    method:'POST',
    headers:{ 'Content-Type':'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  }).then(r=>r.json()).then(d=>{
    if(d && d.ok) return true;
    throw new Error('sync_failed');
  }).catch(()=>{
    const left = retriesLeft==null ? 2 : retriesLeft;
    if(left>0){
      return new Promise(res=>setTimeout(res, 1500)).then(()=>syncToSheet(type, data, left-1));
    }
    console.warn('Gagal sinkron ke Sheet:', type, data);
    markSyncIssue();
    return false;
  });
}

/* Tandai kalau ada masalah sinkron, supaya kita tahu kenapa dashboard bisa beda dari Sheet
   (misalnya URL SHEET_WEBHOOK_URL sudah tidak valid setelah redeploy baru). */
let _syncIssueFlagged = false;
function markSyncIssue(){
  if(_syncIssueFlagged) return;
  _syncIssueFlagged = true;
  console.warn('[Fiici] Sinkronisasi ke Google Sheet gagal berulang kali. Cek apakah SHEET_WEBHOOK_URL di script.js masih URL deployment yang aktif (redeploy Apps Script membuat URL /exec BARU kecuali Anda pilih "Manage deployments > Edit > New version" pada deployment yang sama).');
}

/* ── STATE ── */
let emails = [];
let currentUser = null;
let captchaAnswer = 0;
let globalStats = null;          // data dashboard MENYELURUH (semua device)
let globalStatsTimer = null;
let _lastStatsPush = 0;
/* OTP sementara saat pendaftaran */
let _otpPending = null; // { otp, expiresAt, userData }
let _otpTimer   = null;

/* ══════════════════════════════
   GLOBAL DASHBOARD STATS (sama di semua device)
   Diambil dari Google Sheet via Apps Script (lihat google-apps-script.js).
   Profil TIDAK memakai ini — profil tetap dari data lokal (loadData()).
══════════════════════════════ */
function loadCachedGlobalStats(){
  try{ const raw = localStorage.getItem(GLOBAL_STATS_KEY); if(raw) globalStats = JSON.parse(raw); }catch{}
}
function fetchGlobalStats(){
  if(!SHEET_WEBHOOK_URL) return;
  fetch(SHEET_WEBHOOK_URL, { method:'GET' })
    .then(r=>r.json())
    .then(d=>{
      if(d && d.ok){
        globalStats = d;
        try{ localStorage.setItem(GLOBAL_STATS_KEY, JSON.stringify(d)); }catch{}
        renderStats();
      }
    })
    .catch(()=>{ /* offline / webhook belum dipasang, pakai data lokal sbg cadangan */ });
}
function startGlobalStatsPolling(){
  fetchGlobalStats();
  if(globalStatsTimer) clearInterval(globalStatsTimer);
  globalStatsTimer = setInterval(fetchGlobalStats, 15000);
}
function pushStatsToServer(force){
  if(!SHEET_WEBHOOK_URL || !currentUser) return;
  const now = Date.now();
  if(!force && now - _lastStatsPush < 2000) return; // throttle biar tidak spam
  _lastStatsPush = now;
  syncToSheet('stats_update', {
    userId: currentUser.userId,
    username: currentUser.username,
    totalEmails: emails.length,
    loggedinEmails: emails.filter(e=>e.status!=='loggedin').length, // -> kolom "Proses" di Sheet
    savedEmails: emails.filter(e=>e.status==='loggedin').length      // -> kolom "Success" di Sheet
  });
  // beri jeda sebentar lalu refresh tampilan dashboard agar device ini pun sinkron
  setTimeout(fetchGlobalStats, 1200);
}

/* ── Sinkronkan daftar email (proses & tersimpan) ke server, supaya ikut pindah ke device lain ── */
function syncEmailsUpsert(items){
  if(!SHEET_WEBHOOK_URL || !currentUser || !items || !items.length) return;
  syncToSheet('email_upsert', {
    userId: currentUser.userId,
    username: currentUser.username,
    items: items.map(e=>({ id:e.id, username:e.username, address:e.address, firstName:e.firstName||'', lastName:e.lastName||'', status:e.status, saved:!!e.saved, expired:!!e.expired, expiredAt: e.expiredAt ? (e.expiredAt instanceof Date ? e.expiredAt.getTime() : e.expiredAt) : null, disetor:!!e.disetor, disetorAt: e.disetorAt ? (e.disetorAt instanceof Date ? e.disetorAt.getTime() : e.disetorAt) : null, createdAt: e.createdAt instanceof Date ? e.createdAt.getTime() : e.createdAt }))
  });
}
function syncEmailsDelete(ids){
  if(!SHEET_WEBHOOK_URL || !currentUser || !ids || !ids.length) return;
  syncToSheet('email_delete', { userId: currentUser.userId, username: currentUser.username, ids });
}
/* ── Tarik data email dari server saat login (mis. di device baru datanya kosong) ── */
async function syncEmailsFromServer(){
  if(!SHEET_WEBHOOK_URL || !currentUser) return;
  try{
    const r = await fetch(`${SHEET_WEBHOOK_URL}?action=get_emails&userId=${encodeURIComponent(currentUser.userId)}`);
    const d = await r.json();
    if(!d || !d.ok || !Array.isArray(d.items)) return;
    const serverMap = new Map(d.items.map(it=>[it.id,it]));
    const localMap  = new Map(emails.map(e=>[e.id,e]));
    let changed = false;
    const GRACE_MS = 20000; // beri jeda 20 detik utk email baru yg belum sempat ke-push ke server

    // 1) Tambahkan / perbarui dari server (server = sumber kebenaran untuk username, address, status)
    d.items.forEach(it=>{
      const local = localMap.get(it.id);
      if(!local){
        emails.push({ id:it.id, username:it.username, address:it.address, firstName:it.firstName||'', lastName:it.lastName||'', status:it.status||'created', saved:!!it.saved, expired:!!it.expired, expiredAt:it.expiredAt?new Date(it.expiredAt):null, disetor:!!it.disetor, disetorAt:it.disetorAt?new Date(it.disetorAt):null, createdAt:new Date(it.createdAt||Date.now()) });
        changed = true;
      } else {
        if(local.username!==it.username || local.address!==it.address){ local.username=it.username; local.address=it.address; changed=true; }
        if((it.firstName && local.firstName!==it.firstName) || (it.lastName && local.lastName!==it.lastName)){ local.firstName=it.firstName||local.firstName; local.lastName=it.lastName||local.lastName; changed=true; }
        if(it.status==='loggedin' && local.status!=='loggedin'){
          // status di server sudah Login -> jangan biarkan device ini mundur ke status lama
          local.status = 'loggedin'; changed = true;
        }
        if(it.saved && !local.saved){
          local.saved = true; changed = true;
        }
        if(it.expired && !local.expired){
          // ditandai Session Expired di device lain -> ikut tandai di sini juga (pakai waktu asli)
          local.expired = true; local.expiredAt = it.expiredAt ? new Date(it.expiredAt) : new Date(); changed = true;
        }
        if(!it.expired && local.expired){
          // dipulihkan / disetor di device lain -> ikut hilangkan status expired di sini juga
          local.expired = false; local.expiredAt = null; changed = true;
        }
        if(it.disetor && !local.disetor){
          // sudah disetor di device lain -> ikut pindahkan di sini juga (pakai waktu setor asli)
          local.disetor = true; local.disetorAt = it.disetorAt ? new Date(it.disetorAt) : new Date(); changed = true;
        }
      }
    });

    // 2) Buang data lokal yang sudah dihapus di device lain (tidak ada lagi di server),
    //    kecuali baru saja dibuat di device ini & belum sempat sinkron (dalam masa GRACE_MS).
    const now = Date.now();
    const before = emails.length;
    emails = emails.filter(e=>{
      if(serverMap.has(e.id)) return true;
      const age = now - new Date(e.createdAt).getTime();
      return age < GRACE_MS; // masih dalam masa tunggu upload, jangan dibuang dulu
    });
    if(emails.length !== before) changed = true;

    if(changed){
      emails.sort((a,b)=> new Date(b.createdAt) - new Date(a.createdAt));
      try{ localStorage.setItem(userKey(), JSON.stringify(emails)); }catch{}
      renderTable(); renderSavedTable(); renderDisetorTable(); renderStats();
    }
  }catch{ /* offline, pakai data lokal saja */ }
}

/* ── Tarik profil terbaru dari server setiap kali app dibuka/di-refresh, supaya profil
   selalu sama di semua device TANPA harus mengedit profil dulu di device tersebut. ── */
async function syncProfileFromServer(){
  if(!SHEET_WEBHOOK_URL || !currentUser) return;
  try{
    const r = await fetch(`${SHEET_WEBHOOK_URL}?action=get_profile&userId=${encodeURIComponent(currentUser.userId)}`);
    const d = await r.json();
    if(!d || !d.ok || !d.found || !d.user) return;
    const users = getUsers();
    const idx = users.findIndex(u=>u.id===currentUser.userId);
    const su = d.user;
    if(idx===-1){
      users.push({ id:su.userId, username:su.username, name:su.name||'', email:su.email||'', wa:su.wa||'', password:'', photoData:su.photoData||'', createdAt:su.createdAt||Date.now(), waVerified:!!su.waVerified });
    } else {
      users[idx].name  = su.name  || users[idx].name;
      users[idx].email = su.email || users[idx].email;
      users[idx].wa    = su.wa    || users[idx].wa;
      if(su.photoData) users[idx].photoData = su.photoData;
      if(su.waVerified) users[idx].waVerified = true;
      if(su.createdAt) users[idx].createdAt = su.createdAt;
    }
    saveUsers(users);
    renderProfile();
  }catch{ /* offline, pakai data lokal saja */ }
}

/* ══════════════════════════════
   HELPERS
══════════════════════════════ */
function getUsers(){ try{ return JSON.parse(localStorage.getItem(USERS_KEY)||'[]'); }catch{ return []; } }
function saveUsers(u){ localStorage.setItem(USERS_KEY, JSON.stringify(u)); }
function getSession(){
  try{
    const l = localStorage.getItem(SESSION_KEY);
    if(l) return JSON.parse(l);
    const s = sessionStorage.getItem(SESSION_KEY);
    if(s) return JSON.parse(s);
    return null;
  }catch{ return null; }
}
function saveSession(s, keep){
  const d = JSON.stringify(s);
  if(keep){ localStorage.setItem(SESSION_KEY, d); sessionStorage.removeItem(SESSION_KEY); }
  else     { sessionStorage.setItem(SESSION_KEY, d); localStorage.removeItem(SESSION_KEY); }
}
function clearSession(){ localStorage.removeItem(SESSION_KEY); sessionStorage.removeItem(SESSION_KEY); }
function hashPass(p){ return btoa(p + '_fiici'); }

function pingOnline(id){
  try{ const o=JSON.parse(localStorage.getItem(ONLINE_KEY)||'{}'); o[id]=Date.now(); localStorage.setItem(ONLINE_KEY,JSON.stringify(o)); }catch{}
  if(SHEET_WEBHOOK_URL && currentUser){
    syncToSheet('online_ping', { userId: currentUser.userId, username: currentUser.username });
  }
}
function getOnlineCount(){ try{ const o=JSON.parse(localStorage.getItem(ONLINE_KEY)||'{}'); const n=Date.now(); return Object.values(o).filter(t=>n-t<5*60*1000).length; }catch{ return 0; } }

/* ══════════════════════════════
   CAPTCHA
══════════════════════════════ */
function refreshCaptcha(){
  const ops = ['+','-','×'];
  const op = ops[Math.floor(Math.random()*3)];
  let a = Math.floor(Math.random()*10)+1;
  let b = Math.floor(Math.random()*10)+1;
  if(op==='-' && b>a){ [a,b]=[b,a]; }
  captchaAnswer = op==='+'? a+b : op==='-'? a-b : a*b;
  document.getElementById('captchaQuestion').textContent = `${a} ${op} ${b} = ?`;
  const inp = document.getElementById('captchaAnswer');
  if(inp) inp.value = '';
}

/* ══════════════════════════════
   AUTH
══════════════════════════════ */
function togglePw(inputId, btn){
  const input = document.getElementById(inputId);
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.querySelector('.eye-icon').style.display    = isHidden ? 'none'  : '';
  btn.querySelector('.eye-off-icon').style.display = isHidden ? ''     : 'none';
}

function showOtpCard(){
  document.getElementById('loginCard').style.display    = 'none';
  document.getElementById('registerCard').style.display = 'none';
  document.getElementById('otpCard').style.display      = 'block';
}
function showLogin(){
  document.getElementById('loginCard').style.display    = 'block';
  document.getElementById('registerCard').style.display = 'none';
  document.getElementById('otpCard').style.display      = 'none';
  document.getElementById('loginError').textContent     = '';
}
function showRegister(){
  document.getElementById('loginCard').style.display    = 'none';
  document.getElementById('registerCard').style.display = 'block';
  document.getElementById('otpCard').style.display      = 'none';
  document.getElementById('registerError').textContent  = '';
  refreshCaptcha();
}

/* ── OTP helpers ── */
function genOtp(){ return String(Math.floor(100000 + Math.random() * 900000)); }

function normalizeWa(wa){
  wa = wa.replace(/\D/g,'');
  if(wa.startsWith('0')) wa = '62' + wa.slice(1);
  if(!wa.startsWith('62')) wa = '62' + wa;
  return wa;
}

async function sendWaOtp(waRaw, otp){
  const wa = normalizeWa(waRaw);
  const msg = `Halo! Kode OTP pendaftaran Fiici Gmail Generator kamu adalah:\n\n*${otp}*\n\nKode berlaku 5 menit. Jangan bagikan kode ini ke siapapun.`;
  if(!SHEET_WEBHOOK_URL){
    // Belum ada backend terpasang -> mode dev, OTP ditampilkan di layar saja
    return { ok:true, dev:true };
  }
  try{
    const r = await fetch(SHEET_WEBHOOK_URL, {
      method:'POST',
      headers:{ 'Content-Type':'text/plain;charset=utf-8' },
      body: JSON.stringify({ type:'send_otp', wa, otp, message: msg, timestamp: new Date().toISOString() })
    });
    const d = await r.json();
    if(d && d.ok) return { ok:true };
    let message = 'Gagal mengirim OTP ke WhatsApp. Coba lagi nanti.';
    if(d){
      if(d.reason==='too_fast') message = `Terlalu cepat, tunggu ${d.retryAfterSeconds||60} detik sebelum kirim ulang OTP.`;
      else if(d.reason==='wa_limit') message = 'Nomor ini sudah mencapai batas pengiriman OTP per jam. Coba lagi nanti.';
      else if(d.reason==='global_limit') message = 'Sistem sedang menerima banyak permintaan OTP. Coba lagi dalam beberapa menit.';
      else if(d.reason==='invalid_input') message = 'Nomor WhatsApp tidak valid.';
    }
    console.error('sendWaOtp gagal:', d);
    return { ok:false, message };
  }catch(err){
    console.error('sendWaOtp fetch error:', err);
    return { ok:false, message:'Gagal terhubung ke server OTP. Periksa koneksi internet.' };
  }
}

function startOtpTimer(seconds){
  clearInterval(_otpTimer);
  const el = document.getElementById('otpTimer');
  const resendRow = document.getElementById('otpResendRow');
  resendRow.style.display = 'none';
  function tick(){
    if(seconds <= 0){
      clearInterval(_otpTimer);
      el.textContent = 'Kode sudah kadaluarsa.';
      resendRow.style.display = 'block';
      return;
    }
    const m = String(Math.floor(seconds/60)).padStart(2,'0');
    const s = String(seconds%60).padStart(2,'0');
    el.textContent = `Kode berlaku ${m}:${s}`;
    seconds--;
  }
  tick();
  _otpTimer = setInterval(tick, 1000);
}

function otpInput(el, idx){
  el.value = el.value.replace(/\D/g,'').slice(-1);
  el.classList.toggle('filled', el.value !== '');
  if(el.value && idx < 5) document.querySelectorAll('.otp-digit')[idx+1].focus();
}
function otpKey(e, idx){
  if(e.key==='Backspace' && !document.querySelectorAll('.otp-digit')[idx].value && idx > 0){
    const prev = document.querySelectorAll('.otp-digit')[idx-1];
    prev.value = ''; prev.classList.remove('filled'); prev.focus();
  }
}
function getOtpValue(){ return Array.from(document.querySelectorAll('.otp-digit')).map(i=>i.value).join(''); }

async function resendOtp(){
  if(!_otpPending) return;
  const otp = genOtp();
  _otpPending.otp = otp;
  _otpPending.expiresAt = Date.now() + 5*60*1000;
  document.getElementById('otpError').textContent = '';
  const res = await sendWaOtp(_otpPending.userData.wa, otp);
  if(!res.ok){ document.getElementById('otpError').textContent = res.message || 'Gagal mengirim ulang OTP. Coba lagi.'; return; }
  startOtpTimer(300);
  document.querySelectorAll('.otp-digit').forEach(i=>{ i.value=''; i.classList.remove('filled'); });
  document.querySelectorAll('.otp-digit')[0].focus();
  if(res.dev) document.getElementById('otpError').textContent = `[DEV MODE] OTP: ${otp}`;
}

/* ── LOGIN (cross-device: cek Sheet, fallback lokal) ── */
async function doLogin(){
  const username = document.getElementById('loginUsername').value.trim().toLowerCase();
  const password = document.getElementById('loginPassword').value;
  const errEl    = document.getElementById('loginError');
  const btn      = document.querySelector('#loginCard .auth-btn');
  errEl.textContent = '';
  if(!username||!password){ errEl.textContent='Username dan password wajib diisi.'; return; }

  // Coba verifikasi ke Sheet dulu (cross-device)
  let verified = false;
  let serverUser = null;
  if(SHEET_WEBHOOK_URL){
    btn.textContent = 'Memeriksa…'; btn.disabled = true;
    try{
      const r = await fetch(`${SHEET_WEBHOOK_URL}?action=login&username=${encodeURIComponent(username)}&password=${encodeURIComponent(hashPass(password))}`);
      const d = await r.json();
      if(d.ok && d.found){
        verified = true;
        serverUser = d.user; // { userId, username, name, email, wa, waVerified, photoData, createdAt }
        // Simpan/perbarui data user ini di lokal supaya fitur profil tetap jalan
        const users = getUsers();
        const idx = users.findIndex(u=>u.username===username||u.id===serverUser.userId);
        if(idx===-1){
          users.push({
            id:serverUser.userId, username:serverUser.username, name:serverUser.name||'',
            email:serverUser.email||'', wa:serverUser.wa||'', password:hashPass(password),
            photoData:serverUser.photoData||'', createdAt:serverUser.createdAt||Date.now(),
            waVerified: !!serverUser.waVerified
          });
        } else {
          users[idx].password = hashPass(password);
          if(!users[idx].id) users[idx].id = serverUser.userId;
          // samakan profil dengan data terbaru dari server (device lain mungkin sudah mengubahnya)
          users[idx].name  = serverUser.name  || users[idx].name;
          users[idx].email = serverUser.email || users[idx].email;
          users[idx].wa    = serverUser.wa    || users[idx].wa;
          if(serverUser.photoData) users[idx].photoData = serverUser.photoData;
          if(serverUser.waVerified) users[idx].waVerified = true;
          if(serverUser.createdAt) users[idx].createdAt = serverUser.createdAt;
        }
        saveUsers(users);
      }
    }catch{/* jika server tidak bisa diakses, jatuh ke lokal */}
    btn.textContent = 'Masuk'; btn.disabled = false;
  }

  // Fallback: periksa data lokal
  if(!verified){
    const users = getUsers();
    const user  = users.find(u=>u.username===username);
    if(!user||user.password!==hashPass(password)){ errEl.textContent='Username atau password salah.'; return; }
    serverUser = { userId:user.id, username:user.username };
    verified = true;
  }

  if(!verified){ errEl.textContent='Username atau password salah.'; return; }
  const keep = document.getElementById('keepLogin').checked;
  const session = { userId:serverUser.userId, username:serverUser.username };
  saveSession(session, keep);
  syncToSheet('login', { userId:serverUser.userId, username:serverUser.username, name:serverUser.name||'', email:serverUser.email||'', wa:serverUser.wa||'' });
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  startApp(session);
}

/* ── REGISTER (OTP step 1: validasi form, kirim OTP ke WA) ── */
async function doRegister(){
  const username  = document.getElementById('regUsername').value.trim();
  const name      = document.getElementById('regName').value.trim();
  const email     = document.getElementById('regEmail').value.trim().toLowerCase();
  const wa        = document.getElementById('regWa').value.trim();
  const password  = document.getElementById('regPassword').value;
  const password2 = document.getElementById('regPassword2').value;
  const capInput  = parseInt(document.getElementById('captchaAnswer').value);
  const errEl     = document.getElementById('registerError');
  const btn       = document.querySelector('#registerCard .auth-btn');
  errEl.textContent = '';

  if(!username)                          { errEl.textContent='Username wajib diisi.'; return; }
  if(username.length<3)                  { errEl.textContent='Username minimal 3 karakter.'; return; }
  if(/[^a-z0-9_]/.test(username))        { errEl.textContent='Username hanya boleh huruf kecil, angka, dan underscore.'; return; }
  if(!name)                              { errEl.textContent='Nama lengkap wajib diisi.'; return; }
  if(!email||!email.includes('@'))       { errEl.textContent='Email tidak valid.'; return; }
  if(!wa||wa.replace(/\D/g,'').length<8) { errEl.textContent='No. WhatsApp tidak valid.'; return; }
  if(!password)                          { errEl.textContent='Password wajib diisi.'; return; }
  if(password.length<6)                  { errEl.textContent='Password minimal 6 karakter.'; return; }
  if(password!==password2)               { errEl.textContent='Konfirmasi password tidak cocok.'; return; }
  if(isNaN(capInput)||capInput!==captchaAnswer){ errEl.textContent='Jawaban captcha salah.'; refreshCaptcha(); return; }

  const users = getUsers();
  if(users.find(u=>u.username===username))  { errEl.textContent='Username sudah digunakan.'; return; }
  if(users.find(u=>u.email===email))        { errEl.textContent='Email sudah terdaftar.'; return; }
  if(users.find(u=>u.wa&&u.wa.replace(/\D/g,'')===wa.replace(/\D/g,''))) { errEl.textContent='No. WhatsApp sudah terdaftar.'; return; }

  // Cek juga ke server (bukan cuma device ini) supaya tidak ada akun duplikat lintas device
  if(SHEET_WEBHOOK_URL){
    btn.textContent = 'Memeriksa…'; btn.disabled = true;
    try{
      const cr = await fetch(`${SHEET_WEBHOOK_URL}?action=check_available&username=${encodeURIComponent(username)}&email=${encodeURIComponent(email)}&wa=${encodeURIComponent(wa)}`);
      const cd = await cr.json();
      if(cd && cd.ok){
        if(cd.usernameTaken){ errEl.textContent='Username sudah digunakan.'; btn.textContent='Kirim Kode OTP via WA'; btn.disabled=false; return; }
        if(cd.emailTaken){ errEl.textContent='Email sudah terdaftar.'; btn.textContent='Kirim Kode OTP via WA'; btn.disabled=false; return; }
        if(cd.waTaken){ errEl.textContent='No. WhatsApp sudah terdaftar.'; btn.textContent='Kirim Kode OTP via WA'; btn.disabled=false; return; }
      }
    }catch{ /* offline, lanjut dengan pengecekan lokal saja */ }
  }

  // Kirim OTP
  const otp = genOtp();
  btn.textContent = 'Mengirim OTP…'; btn.disabled = true;
  const res = await sendWaOtp(wa, otp);
  btn.textContent = 'Kirim Kode OTP via WA'; btn.disabled = false;

  if(!res.ok){
    errEl.textContent = res.message || 'Gagal mengirim OTP ke WhatsApp.'; return;
  }

  _otpPending = {
    otp,
    expiresAt: Date.now() + 5*60*1000,
    userData: { id: crypto.randomUUID(), username, name, email, wa, password: hashPass(password), photoData:'', createdAt: Date.now(), waVerified: true }
  };

  document.getElementById('otpWaDisplay').textContent = wa;
  document.querySelectorAll('.otp-digit').forEach(i=>{ i.value=''; i.classList.remove('filled'); });
  document.getElementById('otpError').textContent = '';
  showOtpCard();
  startOtpTimer(300);
  setTimeout(()=>document.querySelectorAll('.otp-digit')[0].focus(), 100);
  if(res.dev) document.getElementById('otpError').textContent = `[DEV MODE] OTP kamu: ${otp}`;
}

/* ── REGISTER (OTP step 2: verifikasi kode, simpan akun) ── */
function verifyOtp(){
  const entered = getOtpValue();
  const errEl   = document.getElementById('otpError');
  errEl.textContent = '';
  if(entered.length < 6){ errEl.textContent='Masukan 6 digit kode OTP.'; return; }
  if(!_otpPending){ errEl.textContent='Sesi OTP tidak ditemukan. Daftar ulang.'; return; }
  if(Date.now() > _otpPending.expiresAt){ errEl.textContent='Kode OTP sudah kadaluarsa. Kirim ulang.'; return; }
  if(entered !== _otpPending.otp){ errEl.textContent='Kode OTP salah. Coba lagi.'; return; }

  clearInterval(_otpTimer);
  const newUser = _otpPending.userData;
  _otpPending = null;
  const users = getUsers();
  users.push(newUser);
  saveUsers(users);
  // Kirim ke Sheet: sertakan password (plain) supaya admin bisa lihat di Excel
  syncToSheet('register', { userId:newUser.id, username:newUser.username, name:newUser.name, email:newUser.email, wa:newUser.wa, password:newUser.password, waVerified:true, photoData:'' });
  const session = { userId:newUser.id, username:newUser.username };
  saveSession(session, false);
  ['regUsername','regName','regEmail','regWa','regPassword','regPassword2','captchaAnswer'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  startApp(session);
}

function doLogout(){
  showConfirmModal({
    title:'Keluar dari akun?',
    message:'Apakah kamu yakin ingin keluar dari akun ini?',
    confirmText:'Keluar',
    confirmClass:'btn-danger',
    onConfirm:()=>{
      clearSession(); currentUser=null; emails=[]; globalStats=null;
      if(globalStatsTimer){ clearInterval(globalStatsTimer); globalStatsTimer=null; }
      document.getElementById('appScreen').style.display  = 'none';
      document.getElementById('authScreen').style.display = 'flex';
      showLogin();
    }
  });
}

/* ══════════════════════════════
   PROFILE
══════════════════════════════ */
function compressPhotoForSync_(file, maxChars){
  maxChars = maxChars || 32000; // aman di bawah batas 50.000 karakter per sel Google Sheets
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onerror = ()=>reject(new Error('read failed'));
    reader.onload = (e)=>{
      const img = new Image();
      img.onerror = ()=>reject(new Error('image load failed'));
      img.onload = ()=>{
        let dim = 220, quality = 0.75;
        function attempt(){
          const scale = Math.min(1, dim / Math.max(img.width, img.height));
          const cw = Math.max(1, Math.round(img.width * scale));
          const ch = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          canvas.getContext('2d').drawImage(img, 0, 0, cw, ch);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          if(dataUrl.length > maxChars && (quality > 0.3 || dim > 80)){
            if(quality > 0.3) quality -= 0.15; else dim = Math.round(dim * 0.8);
            attempt();
          } else {
            resolve(dataUrl);
          }
        }
        attempt();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handlePhotoUpload(input){
  const file = input.files[0]; if(!file) return;
  if(file.size > 8*1024*1024){ showAlertModal('Foto terlalu besar, maksimal 8MB.','Ukuran Foto Tidak Valid'); return; }
  let data;
  try{
    data = await compressPhotoForSync_(file);
  }catch{
    showAlertModal('Gagal memproses foto. Coba foto lain.','Terjadi Kesalahan'); return;
  }
  const users = getUsers();
  const idx   = users.findIndex(u=>u.id===currentUser.userId);
  if(idx===-1) return;
  users[idx].photoData = data;
  saveUsers(users);
  renderProfile();
  updateBnProfilePhoto(data, users[idx].name||currentUser.username);
  // sinkronkan ke server supaya foto ikut muncul di device lain
  syncToSheet('profile_update', { userId:users[idx].id, username:users[idx].username, name:users[idx].name||'', email:users[idx].email||'', wa:users[idx].wa||'', waVerified:!!users[idx].waVerified, photoData:data });
}

function saveProfileEdit(){
  const newName = document.getElementById('editName').value.trim();
  const errEl   = document.getElementById('editProfileError');
  errEl.textContent='';
  if(!newName){ errEl.textContent='Nama tidak boleh kosong.'; return; }
  const users = getUsers();
  const idx = users.findIndex(u=>u.id===currentUser.userId);
  if(idx===-1) return;
  users[idx].name = newName;
  saveUsers(users);
  syncToSheet('profile_update', { userId:users[idx].id, username:users[idx].username, name:newName, email:users[idx].email||'', wa:users[idx].wa||'', waVerified:!!users[idx].waVerified, photoData:users[idx].photoData||'' });
  showSuccessModal('Profil Berhasil Diperbarui');
  renderProfile();
}

function changePassword(){
  const op  = document.getElementById('oldPassword').value;
  const np  = document.getElementById('newPassword').value;
  const np2 = document.getElementById('newPassword2').value;
  const errEl = document.getElementById('changePassError');
  errEl.textContent='';
  const users = getUsers();
  const idx   = users.findIndex(u=>u.id===currentUser.userId);
  if(idx===-1) return;
  if(!op){ errEl.textContent='Password lama wajib diisi.'; return; }
  if(users[idx].password!==hashPass(op)){ errEl.textContent='Password lama salah.'; return; }
  if(!np){ errEl.textContent='Password baru wajib diisi.'; return; }
  if(np.length<6){ errEl.textContent='Password minimal 6 karakter.'; return; }
  if(np!==np2){ errEl.textContent='Konfirmasi password tidak cocok.'; return; }
  if(np===op){ errEl.textContent='Password baru tidak boleh sama dengan password lama.'; return; }
  users[idx].password = hashPass(np);
  saveUsers(users);
  syncToSheet('password_change', { userId:users[idx].id, username:users[idx].username, name:users[idx].name||'', email:users[idx].email||'', wa:users[idx].wa||'', password:hashPass(np) });
  document.getElementById('oldPassword').value  = '';
  document.getElementById('newPassword').value  = '';
  document.getElementById('newPassword2').value = '';
  showSuccessModal('Password Berhasil Diubah');
}

/* ── Verifikasi WA untuk akun lama (dari halaman Profil) ── */
let _profileOtp = null;
let _profileOtpTimer = null;

async function startProfileWaVerif(){
  if(!currentUser) return;
  const users = getUsers();
  const user = users.find(u=>u.id===currentUser.userId);
  if(!user||!user.wa){ showAlertModal('Nomor WhatsApp tidak ditemukan di profil kamu.','WA Tidak Ada'); return; }
  const otp = genOtp();
  const btn = document.querySelector('#waVerifSection button');
  if(btn){ btn.textContent='Mengirim OTP…'; btn.disabled=true; }
  const res = await sendWaOtp(user.wa, otp);
  if(btn){ btn.textContent='Verifikasi WhatsApp Sekarang'; btn.disabled=false; }
  if(!res.ok){ showAlertModal(res.message || 'Gagal mengirim OTP.','Gagal Kirim'); return; }
  _profileOtp = { otp, expiresAt: Date.now()+5*60*1000 };
  document.getElementById('waOtpInfo').textContent = `Kode OTP dikirim ke ${user.wa}`;
  document.getElementById('waOtpError').textContent = '';
  document.querySelectorAll('#waOtpInputs .otp-digit').forEach(i=>{ i.value=''; i.classList.remove('filled'); });
  document.getElementById('waOtpOverlay').classList.add('show');
  startWaOtpTimer(300);
  setTimeout(()=>document.querySelector('#waOtpInputs .otp-digit').focus(), 100);
  if(res.dev) document.getElementById('waOtpError').textContent=`[DEV MODE] OTP: ${otp}`;
}
function startWaOtpTimer(seconds){
  clearInterval(_profileOtpTimer);
  const el=document.getElementById('waOtpTimer'), rr=document.getElementById('waOtpResendRow');
  rr.style.display='none';
  function tick(){ if(seconds<=0){ clearInterval(_profileOtpTimer); el.textContent='Kode sudah kadaluarsa.'; rr.style.display='block'; return; }
    const m=String(Math.floor(seconds/60)).padStart(2,'0'), s=String(seconds%60).padStart(2,'0');
    el.textContent=`Kode berlaku ${m}:${s}`; seconds--; }
  tick(); _profileOtpTimer=setInterval(tick,1000);
}
function waOtpInput(el,idx){ el.value=el.value.replace(/\D/g,'').slice(-1); el.classList.toggle('filled',el.value!==''); if(el.value&&idx<5) document.querySelectorAll('#waOtpInputs .otp-digit')[idx+1].focus(); }
function waOtpKey(e,idx){ if(e.key==='Backspace'&&!document.querySelectorAll('#waOtpInputs .otp-digit')[idx].value&&idx>0){ const p=document.querySelectorAll('#waOtpInputs .otp-digit')[idx-1]; p.value=''; p.classList.remove('filled'); p.focus(); } }
function closeWaOtpModal(){ document.getElementById('waOtpOverlay').classList.remove('show'); clearInterval(_profileOtpTimer); _profileOtp=null; }
async function resendWaOtp(){
  if(!currentUser) return;
  const users=getUsers(); const user=users.find(u=>u.id===currentUser.userId);
  if(!user||!user.wa) return;
  const otp=genOtp(); _profileOtp={otp, expiresAt:Date.now()+5*60*1000};
  const res=await sendWaOtp(user.wa,otp);
  if(!res.ok){ document.getElementById('waOtpError').textContent=res.message||'Gagal kirim ulang. Coba lagi.'; return; }
  document.getElementById('waOtpError').textContent='';
  document.querySelectorAll('#waOtpInputs .otp-digit').forEach(i=>{ i.value=''; i.classList.remove('filled'); });
  startWaOtpTimer(300);
  if(res.dev) document.getElementById('waOtpError').textContent=`[DEV MODE] OTP: ${otp}`;
}
function verifyWaOtp(){
  const entered=Array.from(document.querySelectorAll('#waOtpInputs .otp-digit')).map(i=>i.value).join('');
  const errEl=document.getElementById('waOtpError');
  if(entered.length<6){ errEl.textContent='Masukan 6 digit kode OTP.'; return; }
  if(!_profileOtp){ errEl.textContent='Sesi OTP tidak ditemukan.'; return; }
  if(Date.now()>_profileOtp.expiresAt){ errEl.textContent='Kode sudah kadaluarsa. Kirim ulang.'; return; }
  if(entered!==_profileOtp.otp){ errEl.textContent='Kode OTP salah. Coba lagi.'; return; }
  clearInterval(_profileOtpTimer); _profileOtp=null;
  // Simpan status terverifikasi
  const users=getUsers(); const idx=users.findIndex(u=>u.id===currentUser.userId);
  if(idx===-1) return;
  users[idx].waVerified=true; saveUsers(users);
  syncToSheet('wa_verified', { userId:users[idx].id, username:users[idx].username, name:users[idx].name||'', email:users[idx].email||'', wa:users[idx].wa||'', password:users[idx].password||'', waVerified:true, photoData:users[idx].photoData||'' });
  closeWaOtpModal();
  renderProfile();
  showSuccessModal('WhatsApp Berhasil Diverifikasi');
}

/* ── Hapus Akun ── */
function confirmDeleteAccount(){
  showConfirmModal({
    title: 'Hapus Akun?',
    message: 'Semua data akun dan email akan dihapus <b>permanen</b>. Nomor WA kamu bisa didaftarkan ulang setelah ini. Tindakan tidak bisa dibatalkan.',
    confirmText: 'Hapus Akun',
    confirmClass: 'btn-danger',
    onConfirm: doDeleteAccount
  });
}
function doDeleteAccount(){
  const users=getUsers();
  const user=users.find(u=>u.id===currentUser.userId);
  if(!user) return;
  // Kirim ke Sheet untuk hapus data member
  syncToSheet('delete_account', { userId:currentUser.userId, username:currentUser.username });
  // Hapus data email lokal
  localStorage.removeItem(userKey());
  // Hapus dari daftar user lokal
  saveUsers(users.filter(u=>u.id!==currentUser.userId));
  // Clear session & state
  clearSession();
  const prevUser=currentUser;
  currentUser=null; emails=[]; globalStats=null;
  if(globalStatsTimer){ clearInterval(globalStatsTimer); globalStatsTimer=null; }
  document.getElementById('appScreen').style.display='none';
  document.getElementById('authScreen').style.display='flex';
  showLogin();
  showSuccessModal(`Akun @${prevUser.username} berhasil dihapus`);
}

function renderProfile(){
  if(!currentUser) return;
  const users = getUsers();
  const user  = users.find(u=>u.id===currentUser.userId);
  if(!user) return;
  const displayName = user.name || user.username;
  const avatarEl = document.getElementById('profileAvatar');
  if(user.photoData){
    avatarEl.style.backgroundImage = `url(${user.photoData})`;
    avatarEl.style.backgroundSize  = 'cover';
    avatarEl.style.backgroundPosition = 'center';
    avatarEl.textContent = '';
  } else {
    avatarEl.style.backgroundImage = '';
    avatarEl.textContent = displayName.charAt(0).toUpperCase();
  }
  document.getElementById('profileName').textContent = displayName;
  document.getElementById('profileMeta').textContent = `@${user.username}`;
  document.getElementById('editName').value = user.name||'';
  document.getElementById('profileStats').innerHTML = `
    <div class="stat"><b>${emails.length}</b><span>Total Email</span></div>
    <div class="stat"><b style="color:#f59e0b">${emails.filter(e=>e.status!=='loggedin').length}</b><span>Proses</span></div>
    <div class="stat"><b style="color:var(--green)">${emails.filter(e=>e.status==='loggedin').length}</b><span>Login</span></div>
    <div class="stat"><b style="color:var(--purple)">${emails.filter(e=>e.saved && !e.disetor).length}</b><span>Tersimpan</span></div>
    <div class="stat"><b style="color:#e53935">${emails.filter(e=>e.expired && !e.disetor).length}</b><span>Session Expired</span></div>
  `;
  updateBnProfilePhoto(user.photoData, displayName);

  // WA verifikasi section
  const waSection = document.getElementById('waVerifSection');
  if(user.waVerified){
    waSection.innerHTML=`<div style="display:flex;align-items:center;gap:8px;padding:12px 0;">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      <span style="color:var(--green);font-weight:600;">WhatsApp Terverifikasi</span>
      <span style="color:var(--muted);font-size:0.82rem;">(${user.wa||''})</span>
    </div>`;
  } else {
    const wa = user.wa||'';
    waSection.innerHTML=`<p class="small-note" style="margin-bottom:10px;">Nomor WA kamu belum diverifikasi${wa?' ('+wa+')':''}. Verifikasi untuk mengaktifkan login lintas device.</p>
      <button onclick="startProfileWaVerif()">Verifikasi WhatsApp Sekarang</button>`;
  }
}

function updateBnProfilePhoto(photoData, displayName){
  const circle = document.getElementById('bnProfileCircle');
  if(!circle) return;
  if(photoData){
    circle.style.backgroundImage    = `url(${photoData})`;
    circle.style.backgroundSize     = 'cover';
    circle.style.backgroundPosition = 'center';
    circle.innerHTML = '';
  } else {
    circle.style.backgroundImage = '';
    circle.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>`;
  }
}

/* ══════════════════════════════
   DATA
══════════════════════════════ */
function userKey(){ return currentUser ? `${STORAGE_KEY}_${currentUser.userId}` : STORAGE_KEY; }
function saveData(){ try{ localStorage.setItem(userKey(), JSON.stringify(emails)); }catch{ showAlertModal('Gagal menyimpan data.','Terjadi Kesalahan'); } pushStatsToServer(true); }
function autosave(){ try{ localStorage.setItem(userKey(), JSON.stringify(emails)); }catch{} pushStatsToServer(false); }
function loadData(){
  try{
    const raw = localStorage.getItem(userKey());
    emails = raw ? JSON.parse(raw).map(e=>({...e,createdAt:new Date(e.createdAt),saved:!!e.saved,expired:!!e.expired,expiredAt:e.expiredAt?new Date(e.expiredAt):null,disetor:!!e.disetor,disetorAt:e.disetorAt?new Date(e.disetorAt):null,baseName:e.baseName||null})) : [];
  }catch{ emails=[]; }
}

/* ══════════════════════════════
   APP START
══════════════════════════════ */
/* ══════════════════════════════
   AUTO-HIDE TOPBAR & BOTTOM NAV SAAT SCROLL (gaya tab Chrome)
   Scroll ke bawah -> langsung sembunyi. Scroll ke atas -> langsung muncul lagi.
   Tidak pakai timer/delay, murni ngikutin arah scroll.
══════════════════════════════ */
function initScrollHideNav(){
  const topbar = document.querySelector('.topbar');
  const bottomNav = document.getElementById('bottomNav');
  if(!topbar || !bottomNav || topbar.dataset.hideNavBound) return;
  topbar.dataset.hideNavBound = '1';
  let lastY = window.scrollY;
  let ticking = false;
  function onScroll(){
    const y = Math.max(window.scrollY, 0);
    const diff = y - lastY;
    if(Math.abs(diff) > 3){ // ambang kecil biar gak jitter krn scroll bounce/subpixel
      if(diff > 0 && y > 40){
        // scroll ke bawah -> sembunyikan
        topbar.classList.add('nav-hidden');
        bottomNav.classList.add('nav-hidden');
      } else {
        // scroll ke atas (atau balik dekat paling atas) -> munculkan lagi
        topbar.classList.remove('nav-hidden');
        bottomNav.classList.remove('nav-hidden');
      }
      lastY = y;
    }
    ticking = false;
  }
  window.addEventListener('scroll', ()=>{
    if(!ticking){ requestAnimationFrame(onScroll); ticking = true; }
  }, { passive:true });
}

function startApp(session){
  currentUser = session;
  loadCachedGlobalStats();
  pingOnline(session.userId);
  setInterval(()=>pingOnline(session.userId), 60000);
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appScreen').style.display  = 'block';
  initScrollHideNav();
  loadData(); cleanupExpiredDisetor(); cleanupExpiredSessionExpired(); renderTable(); renderSavedTable(); renderExpiredTable(); renderDisetorTable(); renderProfile();
  pushStatsToServer(true);
  // Cek berkala kalau ada email "Sudah Disetor" yang sudah lewat 15 hari, biar otomatis
  // terhapus walau app dibiarkan terbuka lama tanpa reload.
  setInterval(()=>{ cleanupExpiredDisetor(); renderDisetorTable(); }, 60*60*1000);
  // Cek lebih sering (tiap 5 menit) untuk email "Session Expired" karena batas waktunya
  // cuma 24 jam, biar terhapus otomatis tepat waktu walau app dibiarkan terbuka lama.
  setInterval(()=>{ cleanupExpiredSessionExpired(); renderExpiredTable(); }, 5*60*1000);
  syncProfileFromServer();   // supaya profil sama di semua device hanya dgn refresh, tanpa perlu edit dulu
  syncEmailsFromServer();
  // Tarik ulang data email dari Sheet tiap 20 detik. Ini yang bikin penghapusan email
  // LANGSUNG DARI EXCEL (baris di tab EmailsData dihapus manual) otomatis ikut hilang
  // juga di website, walau lagi tidak pindah-pindah menu / tidak reload halaman.
  // Aman utk email "Simpan/Success": reconciliation di syncEmailsFromServer() tidak
  // membedakan status, jadi kalau baris itu hilang dari Sheet ya ikut hilang di sini.
  setInterval(syncEmailsFromServer, 20000);
  startGlobalStatsPolling();
  goSection('dashboard'); syncIndicatorToActive();
  setTimeout(syncIndicatorToActive, 50);
  // Sinkronkan akun lokal ke Sheet supaya bisa login di device lain
  syncLocalUserToSheet();
}

function syncLocalUserToSheet(){
  if(!SHEET_WEBHOOK_URL || !currentUser) return;
  const users = getUsers();
  const u = users.find(x=>x.id===currentUser.userId);
  if(!u) return;
  // PENTING: pakai 'profile_update', BUKAN 'register'. Fungsi ini dipanggil setiap kali
  // app dibuka/session di-restore (lihat startApp()) hanya untuk memastikan akun lokal
  // juga ada di Sheet (supaya bisa login dari device lain) — bukan untuk mendaftar ulang.
  // Sebelumnya pakai 'register', dan handler 'register' di server me-reset baris Stats
  // (Total Email/Proses/Success) user ini ke 0 setiap kali dipanggil. Karena fungsi ini
  // jalan bersamaan (race) dengan pushStatsToServer() setiap kali app dibuka, itu yang
  // menyebabkan angka di Dashboard kadang "ketimpa" jadi 0 tanpa disadari. 'profile_update'
  // hanya menyentuh data profil (Members), tidak pernah menyentuh Stats.
  syncToSheet('profile_update', {
    userId: u.id, username: u.username, name: u.name||'',
    email: u.email||'', wa: u.wa||'', password: u.password||'',
    waVerified: !!u.waVerified, photoData: u.photoData||''
  });
}

/* ══════════════════════════════
   GENERATION
══════════════════════════════ */
const NAME_POOL = [
  // Nama Indonesia
  'budi','siti','agus','dewi','joko','rina','wahyu','fajar','putri','bagus',
  'ayu','dedi','indra','yanti','hendra','maya','rizky','sinta','arif','wulan',
  'eko','fitri','gunawan','hesti','ilham','juwita','kurnia','lina','maulana','nia',
  'oki','puji','rian','sari','taufik','umi','vino','wati','yusuf','zahra',
  'bambang','citra','doni','elin','farhan','gita','hadi','ika','jamal','karin',
  // Nama Barat
  'james','michael','robert','david','william','joseph','daniel','matthew','anthony','mark',
  'steven','andrew','justin','kevin','brian','george','edward','jason','ryan','jacob',
  'emma','olivia','sophia','isabella','charlotte','amelia','harper','evelyn','abigail','emily',
  'elizabeth','madison','avery','ella','scarlett','grace','chloe','victoria','riley','aria',
  'lily','natalie','hannah','audrey','claire','eleanor','stella','violet','mila','caroline',
  // Anime & Manga (nama karakter, bukan judul)
  'naruto','sasuke','sakura','kakashi','itachi','hinata','gaara','shikamaru','boruto','minato',
  'luffy','zoro','nami','sanji','usopp','chopper','robin','franky','brook','jinbe','ace','sabo','shanks','kaido','garp',
  'ichigo','rukia','orihime','uryu','renji','byakuya','toshiro','rangiku','aizen',
  'eren','mikasa','armin','levi','historia','erwin','hange','reiner','annie','zeke','ymir',
  'tanjiro','nezuko','zenitsu','inosuke','giyu','shinobu','kanao','rengoku','tengen','muzan','akaza','douma',
  'yuji','megumi','nobara','gojo','sukuna','nanami','maki','todo','yuta','mahito',
  'denji','power','makima','aki','himeno','kobeni','angel',
  'loid','anya','yor','bond',
  'edward','alphonse','winry','roymustang','riza','envy','greed',
  'saitama','genos','bang','tatsumaki','fubuki','mumen',
  'deku','bakugo','todoroki','ochaco','iida','allmight','endeavor','denki','shoto','tsuyu',
  'light','misa','ryuk','near','mello','matsuda',
  'kaneki','touka','hide','rize','arima',
  'subaru','emilia','rem','ram','beatrice','puck','otto',
  'kazuma','aqua','megumin','darkness','wiz',
  'rimuru','shion','benimaru','shuna','milim','veldora','diablo',
  'kirito','asuna','sinon','leafa','klein','yuuki',
  'natsu','lucy','erza','gray','wendy','happy','gajeel','juvia',
  'goku','vegeta','gohan','piccolo','bulma','trunks','krillin','frieza','beerus','whis',
  'gon','killua','kurapika','leorio','hisoka','chrollo','meruem',
  'asta','yuno','noelle','yami','mereoleona',
  'mob','reigen','dimple',
  'lelouch','suzaku','kallen','nunnally',
  'guts','griffith','casca',
  'inuyasha','kagome','sesshomaru','miroku','sango',
  'spike','faye','jet','ein',
  'alucard','integra','seras',
  'allen','lenalee','kanda',
  'gintoki','kagura','shinpachi',
  'kenshin','kaoru','sanosuke',
  'yusuke','kurama','hiei','kuwabara',
  'monkeydluffy','roronoazoro','nicorobin','kamadotanjiro','kochouhinatsuru','agatsumazenitsu',
  'itadoriyuuji','fushiguro','gojousatoru','kugisaki','denjichainsaw','powerdevil','ayamakima',
  'yorforger','anyaforger','loidforger','edwardelric','alphonseelric','satoukazuma',
  // Genshin Impact — nama karakter
  'diluc','kaeya','venti','klee','zhongli','xiao','hutao','ganyu','albedo','ayaka','ayato','yoimiya',
  'itto','gorou','yaemiko','raidenshogun','nahida','alhaitham','cyno','nilou','wanderer','scaramouche',
  'dehya','kirara','freminet','lyney','lynette','neuvillette','wriothesley','furina','navia','chevreuse',
  'arlecchino','clorinde','sigewinne','xilonen','chiori','emilie','kinich','mualani','kachina','mavuika',
  'citlali','ororon','xianyun','gaming','chasca','mizuki',
  'amber','lisa','jean','barbara','noelle2','bennett','xiangling','xingqiu','chongyun','ningguang',
  'beidou','xinyan','keqing','sucrose','diona','mona','qiqi','tartaglia','yanfei','rosaria',
  'kazuha','sayu','sara','kokomi','thoma','yunjin','shenhe','yaoyao','faruzan','layla',
  'candace','dori','tighnari','collei','aether','lumine','paimon',
  // Wuthering Waves — nama karakter
  'rover','jiyan','encore','verina','calcharo','jinhsi','changli','yinlin','xiangliyao','zhezhi',
  'danjin','mortefi','baizhi','sanhua','chixia','taoqi','yangyang','aalto','lingyang','camellya',
  'carlotta','cantarella','roccia','phoebe','brant','cartethyia','shorekeeper','youhu','ciaccona','galbrena',
  // Honkai Star Rail — nama karakter
  'march7th','danheng','kafka','silverwolf','blade','jingliu','herta','sushang','gepard','natasha',
  'pela','arlan','serval','tingyun','luocha','yanqing','bailu','sampo','hook','clara',
  'svarog','ratio','aventurine','topaz','blackswan','sunday','robin2','boothill','firefly','misha',
  'jade','gallagher','jiaoqiu','feixiao','moze','lingsha','rappa','tribbie','hyacine','mydei',
  'castorice','cipher','anaxa','phainon',
  // Blue Archive — nama karakter
  'hoshino','shiroko','serika','momoi','midori','yuuka','hina','asuna','ako','chinatsu',
  'iroha','hifumi','izuna','junko','miyako','mari','saki','sumire','koharu','moe',
  'nagisa','kotori','karin','wakamo','miyu','rin','koyuki','hasumi','hare','airi',
  'noa','kayoko','izumi','ushio','wakana','yukino','toki','neru','misaki','haruka',
  'nozomi','plana','shun','aru','nonomi','mika','ayane','iori','shizuko'
];
/* ── Pool Nama Depan & Nama Belakang (identitas untuk isi form Nama saat login Gmail),
   TERPISAH dari NAME_POOL di atas (yang dipakai untuk bagian username/alamat email). ── */
const LAST_NAME_POOL = [
  'Saputra','Wijaya','Kusuma','Pratama','Santoso','Hidayat','Kurniawan','Setiawan','Firmansyah','Gunawan',
  'Permadi','Utomo','Nugraha','Suryanto','Wibowo','Handoko','Yulianto','Wardana','Susanto','Kusnadi',
  'Ramadhan','Hartono','Siregar','Nasution','Simatupang','Pasaribu','Situmorang','Halim','Sanjaya','Budianto',
  'Rahman','Maulana','Iskandar','Prasetya','Suherman','Tanjung','Wahyudi','Zulkarnain','Efendi','Rusdi',
  'Lubis','Panjaitan','Simanjuntak','Marpaung','Sihombing','Batubara','Harahap','Damanik','Sitompul','Manurung'
];
function pickRandom(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function capitalize(s){ return s ? s.charAt(0).toUpperCase()+s.slice(1) : s; }

/* ── Nama yang sudah dipakai pada email yang sudah Success/Disetor, disimpan permanen
   supaya nama itu tidak dipilih lagi walau emailnya nanti sudah otomatis terhapus
   dari menu Disetor setelah 15 hari. ── */
const USED_NAMES_KEY = 'fiici_used_names';
function usedNamesKey(){ return currentUser ? `${USED_NAMES_KEY}_${currentUser.userId}` : USED_NAMES_KEY; }
function loadUsedNames(){
  try{ const raw=localStorage.getItem(usedNamesKey()); return raw ? new Set(JSON.parse(raw)) : new Set(); }catch{ return new Set(); }
}
function markNameUsed(baseName){
  if(!baseName) return;
  const set=loadUsedNames(); set.add(baseName);
  try{ localStorage.setItem(usedNamesKey(), JSON.stringify(Array.from(set))); }catch{}
}
function getExcludedNames(){
  // Gabungkan nama yang tersimpan permanen + nama email yang saat ini masih Success/Disetor
  const set=loadUsedNames();
  emails.forEach(e=>{ if((e.saved||e.disetor) && e.baseName) set.add(e.baseName); });
  return set;
}
function pickRandomName(excludeSet){
  const available = NAME_POOL.filter(n=>!excludeSet.has(n));
  const pool = available.length ? available : NAME_POOL; // kalau semua nama sudah pernah dipakai, ulang dari awal
  return pool[Math.floor(Math.random()*pool.length)];
}
function randomSuffix(hasSuffix, excludeSet){
  const name = pickRandomName(excludeSet||new Set());
  if(hasSuffix) return { text:name, baseName:name };
  const l='abcdefghijklmnopqrstuvwxyz'; let r='';
  for(let i=0;i<3;i++) r+=l[Math.floor(Math.random()*l.length)];
  return { text:`${name}${r}`, baseName:name };
}
function adjustGenCount(delta){
  const el=document.getElementById('genCount');
  el.value=Math.max(1,Math.min(50,(parseInt(el.value)||1)+delta));
}
function generateEmails(){
  const count  = Math.max(1,Math.min(50,parseInt(document.getElementById('genCount').value)||1));
  const prefix = (document.getElementById('genPrefix').value||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
  const suffix = (document.getElementById('genSuffix').value||'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
  const excludeSet = getExcludedNames();
  const created = [];
  for(let i=0;i<count;i++){
    let username,address,baseName;
    do {
      const picked = randomSuffix(suffix.length>0, excludeSet);
      baseName = picked.baseName;
      username=`${prefix}${picked.text}${suffix}`; address=`${username}@gmail.com`;
    }
    while(emails.some(e=>e.address===address));
    const firstName = capitalize(baseName);
    const lastName  = capitalize(pickRandom(LAST_NAME_POOL));
    const item = {id:crypto.randomUUID(),username,address,baseName,firstName,lastName,status:'created',saved:false,expired:false,expiredAt:null,disetor:false,disetorAt:null,createdAt:new Date()};
    emails.unshift(item);
    created.push(item);
    excludeSet.add(baseName); // biar dalam 1x generate banyak email, nama yang baru dipakai juga tidak dobel
  }
  autosave(); renderTable();
  syncEmailsUpsert(created);
  showSuccessModal('Buat Gmail Berhasil', ()=>goSection('daftar'));
}

/* ══════════════════════════════
   MODALS
══════════════════════════════ */
let _okCb = null;
function showSuccessModal(msg, onOk){
  const o=document.getElementById('successOverlay');
  o.querySelector('.success-title').textContent = msg||'Berhasil';
  _okCb = typeof onOk==='function'?onOk:null;
  const c=o.querySelector('.success-check-circle'), k=o.querySelector('.success-check-mark');
  c.style.animation='none'; k.style.animation='none';
  o.classList.add('show');
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ c.style.animation=''; k.style.animation=''; }));
}
function closeSuccessModal(){ document.getElementById('successOverlay').classList.remove('show'); const cb=_okCb; _okCb=null; if(cb) cb(); }

let _alertOkCb = null;
function showAlertModal(message, title, onOk){
  document.getElementById('alertTitle').textContent = title || 'Pemberitahuan';
  document.getElementById('alertMessage').textContent = message || '';
  _alertOkCb = typeof onOk==='function'?onOk:null;
  document.getElementById('alertOverlay').classList.add('show');
}
function closeAlertModal(){ document.getElementById('alertOverlay').classList.remove('show'); const cb=_alertOkCb; _alertOkCb=null; if(cb) cb(); }

let _confirmYesCb = null;
function showConfirmModal(opts){
  const { title='Konfirmasi', message='', confirmText='Ya', confirmClass='btn-danger', onConfirm } = opts||{};
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').innerHTML = message;
  const btn = document.getElementById('confirmDeleteBtn');
  btn.textContent = confirmText;
  btn.className = confirmClass;
  _confirmYesCb = typeof onConfirm==='function'?onConfirm:null;
  btn.onclick = ()=>{ closeConfirmModal(); const cb=_confirmYesCb; _confirmYesCb=null; if(cb) cb(); };
  document.getElementById('confirmOverlay').classList.add('show');
}
function openDeleteConfirm(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  if(e.saved){ showAlertModal('Email yang sudah Tersimpan tidak bisa dihapus.','Tidak Bisa Dihapus'); return; }
  showConfirmModal({
    title:'Hapus email ini?',
    message:`Apakah kamu ingin menghapus email <b>${e.address}</b> ini?`,
    confirmText:'Hapus',
    confirmClass:'btn-danger',
    onConfirm:()=>{ deleteEmail(id); showSuccessModal('Gmail Berhasil Dihapus'); }
  });
}
function closeConfirmModal(){ document.getElementById('confirmOverlay').classList.remove('show'); }

/* ══════════════════════════════
   EMAIL ACTIONS
══════════════════════════════ */
/* Tahap 1: Login. Email baru (status "Proses") ditandai sudah berhasil login
   ke akun Gmail-nya. Masih tampil di menu Daftar Gmail (belum terkunci/tersimpan). */
function confirmLoginEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  if(e.status==='loggedin') return;
  showConfirmModal({
    title:'Tandai email ini sudah Login?',
    message:`Email <b>${e.address}</b> akan ditandai <b>Login</b> setelah berhasil login ke akun Gmail-nya.`,
    confirmText:'Login',
    confirmClass:'btn-ok',
    onConfirm:()=>loginEmail(id)
  });
}
function loginEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  e.status='loggedin';
  saveData(); renderTable();
  syncEmailsUpsert([e]);
  showSuccessModal('Gmail Berhasil Ditandai Login');
}
/* Tahap 2: Simpan. Email yang sudah Login dikunci & dipindahkan ke menu
   Email Tersimpan. Setelah ini baru bisa lanjut ke Setor (atau ditandai
   Session Expired kalau akunnya tiba-tiba nonaktif/keluar sendiri). */
function confirmFinishEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  if(e.saved) return;
  if(e.status!=='loggedin'){ showAlertModal('Tandai email ini <b>Login</b> terlebih dahulu sebelum bisa disimpan.','Belum Login'); return; }
  showConfirmModal({
    title:'Simpan email ini?',
    message:`Email <b>${e.address}</b> akan dipindahkan ke menu <b>Tersimpan</b> dan terkunci, tidak bisa dihapus lagi setelah ini.`,
    confirmText:'Simpan',
    confirmClass:'btn-ok',
    onConfirm:()=>finishEmail(id)
  });
}
/* Setor langsung dari menu Daftar Gmail, tanpa perlu mampir dulu ke menu Tersimpan.
   Hanya bisa dipakai kalau email sudah ditandai Login (tombol ini memang baru
   muncul di UI setelah status Login). */
function confirmDirectSetor(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  if(e.status!=='loggedin'){ showAlertModal('Tandai email ini <b>Login</b> terlebih dahulu sebelum bisa disetor.','Belum Login'); return; }
  showConfirmModal({
    title:'Setor langsung email ini?',
    message:`Email <b>${e.address}</b> akan otomatis ditandai <b>Tersimpan</b> lalu langsung dipindahkan ke menu <b>Sudah Disetor</b>.`,
    confirmText:'Setor',
    confirmClass:'btn-ok',
    onConfirm:()=>directSetorEmail(id)
  });
}
function directSetorEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  if(!e.saved){ e.saved=true; markNameUsed(e.baseName); }
  e.disetor=true; e.disetorAt=new Date();
  e.expired=false; e.expiredAt=null;
  saveData(); renderTable();
  syncEmailsUpsert([e]);
  showSuccessModal('Email Berhasil Langsung Disetor');
}
function finishEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  e.status='loggedin';
  e.saved=true; // otomatis tersimpan & terkunci, tidak bisa dihapus
  markNameUsed(e.baseName); // nama ini tidak akan muncul lagi di generate berikutnya
  saveData(); renderTable();
  syncEmailsUpsert([e]);
  showSuccessModal('Gmail Berhasil Disimpan');
}
/* Tahap 3 (opsional): Session Expired. Kalau akun Gmail yang sudah Tersimpan
   tiba-tiba nonaktif/keluar sendiri, tandai di sini. Email dipindahkan ke menu
   "Session Expired" dan otomatis terhapus permanen kalau dalam 24 jam tidak
   segera di-Setor atau di-Pulihkan. */
function confirmMarkExpired(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  showConfirmModal({
    title:'Tandai Session Expired?',
    message:`Email <b>${e.address}</b> akan dipindahkan ke menu <b>Session Expired</b> dan <b>otomatis terhapus permanen dalam 24 jam</b> jika tidak segera di-Setor atau dipulihkan.`,
    confirmText:'Tandai Expired',
    confirmClass:'btn-danger',
    onConfirm:()=>markExpired(id)
  });
}
function markExpired(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  e.expired=true; e.expiredAt=new Date();
  saveData(); renderTable();
  syncEmailsUpsert([e]);
  showSuccessModal('Email Ditandai Session Expired');
}
function confirmRestoreExpired(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  showConfirmModal({
    title:'Pulihkan email ini?',
    message:`Email <b>${e.address}</b> akan dikembalikan ke menu <b>Email Tersimpan</b>.`,
    confirmText:'Pulihkan',
    confirmClass:'btn-ok',
    onConfirm:()=>restoreExpiredEmail(id)
  });
}
function restoreExpiredEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  e.expired=false; e.expiredAt=null;
  saveData(); renderTable();
  syncEmailsUpsert([e]);
  showSuccessModal('Email Berhasil Dipulihkan ke Tersimpan');
}
function deleteEmail(id){
  const e=emails.find(x=>x.id===id);
  if(e && e.saved) return; // terkunci, tidak bisa dihapus
  emails=emails.filter(x=>x.id!==id); autosave(); renderTable();
  if(e) syncEmailsDelete([id]);
}
function copyText(text,chipEl){
  function ok(){ if(!chipEl) return; chipEl.classList.add('copied'); const i=chipEl.querySelector('.icon'),old=i.textContent; i.textContent='✓'; setTimeout(()=>{ chipEl.classList.remove('copied'); i.textContent=old; },1200); }
  function fb(){
    try{
      const t=document.createElement('textarea'); t.value=text; t.style.cssText='position:fixed;left:-9999px';
      document.body.appendChild(t); t.focus(); t.select();
      document.execCommand('copy') ? ok() : showAlertModal(text,'Salin Teks');
      document.body.removeChild(t);
    }catch{ showAlertModal(text,'Salin Teks'); }
  }
  navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(text).then(ok).catch(fb):fb();
}
function getSelectedIds(){ return Array.from(document.querySelectorAll('.row-check:checked')).map(c=>c.dataset.id); }
function toggleSelectAll(cb){ document.querySelectorAll('.row-check').forEach(c=>c.checked=cb.checked); updateBulkBar(); }
function updateBulkBar(){ document.getElementById('bulkActions').style.display=document.querySelectorAll('.row-check:checked').length?'flex':'none'; }
function confirmBulkLogin(){
  const ids=getSelectedIds(); if(!ids.length) return;
  const targets = emails.filter(e=>ids.includes(e.id) && e.status!=='loggedin');
  if(!targets.length){ showAlertModal('Semua email terpilih sudah berstatus Login.','Tidak Ada Perubahan'); return; }
  showConfirmModal({
    title:'Tandai Login email terpilih?',
    message:`${targets.length} email akan ditandai <b>Login</b>.`,
    confirmText:'Tandai Login',
    confirmClass:'btn-ok',
    onConfirm:()=>{
      targets.forEach(e=>{ e.status='loggedin'; });
      saveData(); renderTable();
      syncEmailsUpsert(targets);
      showSuccessModal(`${targets.length} Email Berhasil Ditandai Login`);
    }
  });
}
function confirmBulkFinish(){
  const ids=getSelectedIds(); if(!ids.length) return;
  const targets = emails.filter(e=>ids.includes(e.id) && e.status==='loggedin' && !e.saved);
  const skipped = ids.length - targets.length;
  if(!targets.length){ showAlertModal('Tandai email terpilih <b>Login</b> terlebih dahulu sebelum bisa disimpan.','Belum Login'); return; }
  showConfirmModal({
    title:'Simpan email terpilih?',
    message:`${targets.length} email akan dipindahkan ke menu Tersimpan dan terkunci, tidak bisa dihapus lagi setelah ini.${skipped?` (${skipped} email lain dilewati karena belum Login)`:''}`,
    confirmText:'Simpan',
    confirmClass:'btn-ok',
    onConfirm:()=>{
      targets.forEach(e=>{ e.saved=true; markNameUsed(e.baseName); });
      saveData(); renderTable();
      syncEmailsUpsert(targets);
      showSuccessModal(`${targets.length} Email Berhasil Disimpan`);
    }
  });
}
function confirmBulkDelete(){
  const ids=getSelectedIds(); if(!ids.length) return;
  showConfirmModal({
    title:'Hapus email terpilih?',
    message:`Apakah kamu ingin menghapus ${ids.length} email terpilih ini?`,
    confirmText:'Hapus',
    confirmClass:'btn-danger',
    onConfirm:()=>{
      const deletableIds = emails.filter(e=>ids.includes(e.id) && !e.saved).map(e=>e.id);
      emails=emails.filter(e=>!ids.includes(e.id)||e.saved);
      autosave(); renderTable();
      syncEmailsDelete(deletableIds);
      showSuccessModal('Email Terpilih Berhasil Dihapus');
    }
  });
}

/* ══════════════════════════════
   RENDER
══════════════════════════════ */
function renderStats(){
  // Dashboard = data MENYELURUH (gabungan semua device), bukan hanya device ini.
  // Jika belum ada koneksi/cache dari server, tampilkan dulu data lokal sbg sementara.
  const localTotal = emails.length;
  const localLi     = emails.filter(e=>e.status==='loggedin').length;
  const localMembers = getUsers().length;
  const localOnline  = getOnlineCount();

  const useGlobal = !!globalStats;
  const total    = useGlobal ? globalStats.totalEmails       : localTotal;
  const li       = useGlobal ? globalStats.totalLoggedin     : localLi;
  const notLi    = useGlobal ? globalStats.totalNotLoggedin  : (localTotal-localLi);
  const members  = useGlobal ? globalStats.totalMembers      : localMembers;
  const online   = useGlobal ? globalStats.online            : localOnline;

  const localSaved = emails.filter(e=>e.saved && !e.disetor).length;
  const localExpired = emails.filter(e=>e.expired && !e.disetor).length;
  document.getElementById('stats').innerHTML=`
    <div class="stat"><b>${total}</b><span>Total Email</span></div>
    <div class="stat"><b style="color:var(--muted)">${notLi}</b><span>Proses</span></div>
    <div class="stat"><b style="color:var(--green)">${li}</b><span>Login</span></div>
    <div class="stat"><b style="color:var(--purple)">${localSaved}</b><span>Tersimpan</span></div>
    <div class="stat"><b style="color:#e53935">${localExpired}</b><span>Session Expired</span></div>
    <div class="stat"><b style="color:var(--purple)">${members}</b><span>Total Member</span></div>
    <div class="stat"><b style="color:var(--green)">${online}</b><span>Sedang Online</span></div>`;
}
function renderTable(){
  renderStats();
  const search=document.getElementById('searchBox').value.toLowerCase();
  const allDaftar=emails.filter(e=>!e.saved);
  const list=allDaftar.filter(e=>(e.address.toLowerCase().includes(search)||(e.firstName||'').toLowerCase().includes(search)||(e.lastName||'').toLowerCase().includes(search)));

  // Badge notifikasi jumlah email di menu Daftar (sama kayak badge di menu Simpan),
  // dihitung dari semua email yg belum tersimpan, tidak ikut kepengaruh oleh kotak pencarian.
  const daftarBadge=document.getElementById('daftarBadge');
  if(daftarBadge){
    if(allDaftar.length){ daftarBadge.textContent = allDaftar.length>99 ? '99+' : String(allDaftar.length); daftarBadge.style.display='flex'; }
    else { daftarBadge.style.display='none'; }
  }

  const body=document.getElementById('tableBody'), empty=document.getElementById('emptyState');
  if(!list.length){ body.innerHTML=''; empty.style.display='block'; document.getElementById('emailTable').style.display='none'; }
  else {
    empty.style.display='none'; document.getElementById('emailTable').style.display='block';
    body.innerHTML=list.map(e=>`
      <div class="email-card">
        <div class="email-card-top">
          <input type="checkbox" class="row-check" data-id="${e.id}" onclick="updateBulkBar()">
          <span class="badge ${e.status==='loggedin'?'loggedin':'created'}"><span class="dot"></span>${e.status==='loggedin'?'Login':'Proses'}</span>
        </div>
        <div class="email-card-row"><span class="email-card-label">Nama Depan</span><span class="copy-chip" onclick="copyText('${e.firstName||''}',this)"><span class="icon">⧉</span>${e.firstName||'-'}</span></div>
        <div class="email-card-row"><span class="email-card-label">Nama Belakang</span><span class="copy-chip" onclick="copyText('${e.lastName||''}',this)"><span class="icon">⧉</span>${e.lastName||'-'}</span></div>
        <div class="email-card-row"><span class="email-card-label">Email</span><span class="copy-chip" onclick="copyText('${e.address}',this)"><span class="icon">⧉</span>${e.address}</span></div>
        <div class="actions">
          ${e.status==='loggedin'
            ? `<button onclick="confirmFinishEmail('${e.id}')">Simpan</button><button class="ghost" onclick="confirmDirectSetor('${e.id}')">Setor</button>`
            : `<button onclick="confirmLoginEmail('${e.id}')">Login</button>`}
          <button class="ghost" onclick="openDeleteConfirm('${e.id}')">Hapus</button>
        </div>
      </div>`).join('');
  }
  updateBulkBar(); renderSavedTable(); renderExpiredTable(); renderDisetorTable(); renderProfile();
}
function renderSavedTable(){
  const list=emails.filter(e=>e.saved && !e.disetor && !e.expired);

  // Badge notifikasi jumlah email tersimpan di ikon menu Simpan (kayak notif pesan di HP)
  const badge=document.getElementById('savedBadge');
  if(badge){
    if(list.length){ badge.textContent = list.length>99 ? '99+' : String(list.length); badge.style.display='flex'; }
    else { badge.style.display='none'; }
  }

  const body=document.getElementById('savedTableBody'), empty=document.getElementById('savedEmptyState');
  if(!list.length){ body.innerHTML=''; empty.style.display='block'; document.getElementById('savedTable').style.display='none'; }
  else {
    empty.style.display='none'; document.getElementById('savedTable').style.display='table';
    body.innerHTML=list.map(e=>`
      <tr>
        <td><span class="copy-chip" onclick="copyText('${e.address}',this)"><span class="icon">⧉</span>${e.address}</span></td>
        <td><span class="badge ${e.status==='loggedin'?'loggedin':'created'}"><span class="dot"></span>${e.status==='loggedin'?'Success':'Proses'}</span></td>
        <td><div class="actions"><span class="locked-note">🔒 Terkunci</span><button class="ghost" onclick="confirmMarkExpired('${e.id}')">Session Expired</button><button onclick="confirmSetorEmail('${e.id}')">Setor</button></div></td>
      </tr>`).join('');
  }

  // List gmail-nya saja (tanpa username), buat disalin sekaligus lewat tombol "Salin Semua"
  const gmailBlock=document.getElementById('savedGmailOnlyBlock'), gmailList=document.getElementById('savedGmailOnlyList');
  if(gmailBlock && gmailList){
    if(!list.length){ gmailBlock.style.display='none'; gmailList.innerHTML=''; }
    else {
      gmailBlock.style.display='block';
      gmailList.innerHTML=list.map(e=>`<div class="gmail-only-row">${e.address}</div>`).join('');
    }
  }
}
function copyAllSavedGmails(){
  const list=emails.filter(e=>e.saved && !e.disetor && !e.expired).map(e=>e.address);
  if(!list.length) return;
  const text=list.join('\n');
  function ok(){ showSuccessModal(`${list.length} Gmail berhasil disalin sekaligus`); }
  function fb(){
    try{
      const t=document.createElement('textarea'); t.value=text; t.style.cssText='position:fixed;left:-9999px';
      document.body.appendChild(t); t.focus(); t.select();
      document.execCommand('copy') ? ok() : showAlertModal(text,'Salin Semua Gmail');
      document.body.removeChild(t);
    }catch{ showAlertModal(text,'Salin Semua Gmail'); }
  }
  navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(text).then(ok).catch(fb):fb();
}

/* ══════════════════════════════
   SUDAH DISETOR (auto-hapus 15 hari)
══════════════════════════════ */
const DISETOR_EXPIRY_MS = 15*24*60*60*1000; // 15 hari

function confirmSetorEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  showConfirmModal({
    title:'Pindahkan ke Sudah Disetor?',
    message:`Email <b>${e.address}</b> akan dipindahkan ke menu <b>Sudah Disetor</b> dan otomatis terhapus setelah <b>15 hari</b>.`,
    confirmText:'Setor',
    confirmClass:'btn-ok',
    onConfirm:()=>setorEmail(id)
  });
}
function setorEmail(id){
  const e=emails.find(x=>x.id===id); if(!e) return;
  e.disetor=true; e.disetorAt=new Date();
  e.expired=false; e.expiredAt=null; // bersihkan status Session Expired kalau disetor langsung dari menu itu
  saveData(); renderTable();
  syncEmailsUpsert([e]);
  showSuccessModal('Email Berhasil Dipindahkan ke Sudah Disetor');
}
function daysLeftText(disetorAt){
  const deadline = new Date(disetorAt).getTime() + DISETOR_EXPIRY_MS;
  const msLeft = deadline - Date.now();
  if(msLeft<=0) return 'Akan segera terhapus';
  const daysLeft = Math.ceil(msLeft/(24*60*60*1000));
  return `${daysLeft} hari lagi`;
}
function fmtDate(d){
  try{ return new Date(d).toLocaleDateString('id-ID',{ day:'2-digit', month:'short', year:'numeric' }); }catch{ return '-'; }
}
function renderDisetorTable(){
  cleanupExpiredDisetor();
  const list=emails.filter(e=>e.disetor);

  const badge=document.getElementById('disetorBadge');
  if(badge){
    if(list.length){ badge.textContent = list.length>99 ? '99+' : String(list.length); badge.style.display='flex'; }
    else { badge.style.display='none'; }
  }

  const body=document.getElementById('disetorTableBody'), empty=document.getElementById('disetorEmptyState');
  if(!list.length){ body.innerHTML=''; empty.style.display='block'; document.getElementById('disetorTable').style.display='none'; }
  else {
    empty.style.display='none'; document.getElementById('disetorTable').style.display='table';
    body.innerHTML=list.map(e=>`
      <tr>
        <td><span class="copy-chip" onclick="copyText('${e.address}',this)"><span class="icon">⧉</span>${e.address}</span></td>
        <td>${fmtDate(e.disetorAt)}</td>
        <td><span class="locked-note">${daysLeftText(e.disetorAt)}</span></td>
      </tr>`).join('');
  }
}
/* Hapus otomatis email yang sudah disetor lebih dari 15 hari. Dijalankan setiap kali
   render Sudah Disetor / Tersimpan, saat app dibuka, dan berkala lewat setInterval. */
function cleanupExpiredDisetor(){
  const now=Date.now();
  const expiredIds=[];
  const before=emails.length;
  emails=emails.filter(e=>{
    if(e.disetor && e.disetorAt){
      const age = now - new Date(e.disetorAt).getTime();
      if(age >= DISETOR_EXPIRY_MS){ expiredIds.push(e.id); return false; }
    }
    return true;
  });
  if(emails.length!==before){
    autosave();
    syncEmailsDelete(expiredIds);
  }
}

/* ══════════════════════════════
   SESSION EXPIRED (auto-hapus 24 jam)
══════════════════════════════ */
const EXPIRED_EXPIRY_MS = 24*60*60*1000; // 24 jam

function hoursLeftText(expiredAt){
  const deadline = new Date(expiredAt).getTime() + EXPIRED_EXPIRY_MS;
  const msLeft = deadline - Date.now();
  if(msLeft<=0) return 'Akan segera terhapus';
  const h = Math.floor(msLeft/(60*60*1000));
  const m = Math.floor((msLeft%(60*60*1000))/(60*1000));
  if(h<=0) return `${m} menit lagi`;
  return `${h} jam ${m} menit lagi`;
}
function fmtDateTime(d){
  try{ return new Date(d).toLocaleString('id-ID',{ day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }catch{ return '-'; }
}
function renderExpiredTable(){
  cleanupExpiredSessionExpired();
  const list=emails.filter(e=>e.expired && !e.disetor);

  const badge=document.getElementById('expiredBadge');
  if(badge){
    if(list.length){ badge.textContent = list.length>99 ? '99+' : String(list.length); badge.style.display='flex'; }
    else { badge.style.display='none'; }
  }

  const body=document.getElementById('expiredTableBody'), empty=document.getElementById('expiredEmptyState');
  if(!list.length){ body.innerHTML=''; empty.style.display='block'; document.getElementById('expiredTable').style.display='none'; }
  else {
    empty.style.display='none'; document.getElementById('expiredTable').style.display='table';
    body.innerHTML=list.map(e=>`
      <tr>
        <td><span class="copy-chip" onclick="copyText('${e.address}',this)"><span class="icon">⧉</span>${e.address}</span></td>
        <td>${fmtDateTime(e.expiredAt)}</td>
        <td><span class="locked-note" style="color:#e53935;">${hoursLeftText(e.expiredAt)}</span></td>
        <td><div class="actions"><button class="ghost" onclick="confirmRestoreExpired('${e.id}')">Pulihkan</button><button onclick="confirmSetorEmail('${e.id}')">Setor</button></div></td>
      </tr>`).join('');
  }
}
/* Hapus otomatis PERMANEN email yang ditandai Session Expired lebih dari 24 jam
   dan belum sempat di-Setor atau dipulihkan. Dijalankan setiap kali render menu
   Session Expired / Tersimpan, saat app dibuka, dan berkala lewat setInterval. */
function cleanupExpiredSessionExpired(){
  const now=Date.now();
  const expiredIds=[];
  const before=emails.length;
  emails=emails.filter(e=>{
    if(e.expired && !e.disetor && e.expiredAt){
      const age = now - new Date(e.expiredAt).getTime();
      if(age >= EXPIRED_EXPIRY_MS){ expiredIds.push(e.id); return false; }
    }
    return true;
  });
  if(emails.length!==before){
    autosave();
    syncEmailsDelete(expiredIds);
  }
}

/* ══════════════════════════════
   NAVIGATION
══════════════════════════════ */
function setActiveBn(btn){ document.querySelectorAll('.bn-item').forEach(n=>n.classList.remove('active','elevated')); if(btn){ btn.classList.add('active','elevated'); } }
function syncIndicatorToActive(){ const a=document.querySelector('.bn-item.active')||document.querySelector('.bn-item[data-section="dashboard"]'); if(a) setActiveBn(a); }
function goSection(id){
  setActiveBn(document.querySelector(`.bn-item[data-section="${id}"]`));
  document.querySelectorAll('.view-section').forEach(s=>s.classList.remove('active-view'));
  const el=document.getElementById(id);
  if(el){ el.classList.add('active-view'); window.scrollTo({top:0,behavior:'instant' in window?'instant':'auto'}); }
  if(id==='profile') renderProfile();
  if(id==='dashboard') fetchGlobalStats();
  // Kalau lagi lihat menu Daftar/Simpan, tarik ulang data dari Sheet supaya kalau ada email
  // yang barusan dihapus langsung dari Excel, langsung hilang juga di sini tanpa perlu refresh.
  if(id==='daftar' || id==='simpan' || id==='expired' || id==='disetor') syncEmailsFromServer();
  if(id==='expired') renderExpiredTable();
  if(id==='disetor') renderDisetorTable();
}

/* ══════════════════════════════
   INIT
══════════════════════════════ */
(function(){
  const session=getSession();
  if(session){ startApp(session); }
  else { document.getElementById('authScreen').style.display='flex'; }
})();

(function(){
  function pin(){
    const nav=document.getElementById('bottomNav'); if(!nav) return;
    if(window.visualViewport){ const vv=window.visualViewport; nav.style.bottom=Math.max(0,window.innerHeight-vv.height-vv.offsetTop)+'px'; }
    else nav.style.bottom='0px';
  }
  window.addEventListener('resize',pin); window.addEventListener('orientationchange',pin);
  if(window.visualViewport){ window.visualViewport.addEventListener('resize',pin); window.visualViewport.addEventListener('scroll',pin); }
  window.addEventListener('load',()=>{ pin(); syncIndicatorToActive(); });
})();
