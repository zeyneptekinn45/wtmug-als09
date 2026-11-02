/* ================= YAPILANDIRMA ================= */
const CHUNK_SIZE = 16 * 1024; // 16 KB
const CHUNK_HIGH_WATER = 64 * 1024; // DataChannel buffer üst sınırı

/* ================= YARDIMCILAR ================= */
function $(id) { return document.getElementById(id); }

function showView(name) {
  ['view-role', 'view-teacher', 'view-student'].forEach(v => $(v).classList.add('hidden'));
  if (name === 'role') $('view-role').classList.remove('hidden');
  if (name === 'teacher') $('view-teacher').classList.remove('hidden');
  if (name === 'student') $('view-student').classList.remove('hidden');
}

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(2) + ' MB';
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/* ================= HOCA MODU ================= */
const Teacher = {
  peer: null,
  file: null,
  fileMeta: null,       // { name, size, mime }
  students: new Map(),  // connId -> { conn, sent, total, done, name }
  logEl: null,

  init() {
    this.logEl = $('teacher-log');
    $('teacher-file-input').addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (!f) return;
      this.file = f;
      this.fileMeta = { name: f.name, size: f.size, mime: f.type || 'application/octet-stream' };
      $('btn-teacher-start').disabled = false;
      this.log(`Dosya seçildi: ${f.name} (${formatBytes(f.size)})`, 'ok');
    });
    $('btn-teacher-start').addEventListener('click', () => this.start());
  },

  log(msg, type) {
    const cls = type ? ` class="${type}"` : '';
    const time = new Date().toLocaleTimeString('tr-TR');
    this.logEl.innerHTML += `\n[${time}] <span${cls}>${msg}</span>`;
    this.logEl.scrollTop = this.logEl.scrollHeight;
  },

  start() {
    if (!this.file) return;
    $('btn-teacher-start').disabled = true;
    $('teacher-file-panel').classList.add('hidden');
    $('teacher-connection-panel').classList.remove('hidden');
    this.log('Bağlantı başlatılıyor...');

    // Rastgele 6 haneli ID (QR için daha okunabilir)
    const teacherId = 'hoca-' + Math.random().toString(36).substring(2, 8);
    this.peer = new Peer(teacherId, { debug: 0 });

    this.peer.on('open', (id) => {
      $('teacher-id').textContent = id;
      this.renderQR(id);
      this.log(`Hazır. ID: ${id}`, 'ok');
    });

    this.peer.on('error', (err) => {
      this.log('Peer hatası: ' + err.type + ' - ' + err.message, 'err');
      if (err.type === 'unavailable-id') {
        this.log('ID çakışması, yeniden deneniyor...', 'warn');
        this.peer.destroy();
        this.start();
      }
    });

    this.peer.on('connection', (conn) => this.handleStudent(conn));
  },

  renderQR(text) {
    const container = $('qr-code');
    container.innerHTML = '';
    // Basit QR üretimi (harici API kullanmadan: qrcode kütüphanesi yok,
    // bu yüzden Google Charts yerine canvas tabanlı bir çözüm gerekir.
    // En basit yol: QR kütüphanesini CDN'den yüklemek. Alternatif olarak
    // metni gösteriyoruz. Aşağıda qrcodejs CDN'i dinamik yüklenir.)
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js';
    script.onload = () => {
      new QRCode(container, {
        text: text,
        width: 220,
        height: 220,
        correctLevel: QRCode.CorrectLevel.M
      });
    };
    script.onerror = () => {
      container.textContent = '(QR yüklenemedi — ID yukarıda)';
    };
    document.head.appendChild(script);
  },

  handleStudent(conn) {
    const cid = conn.peer;
    this.students.set(cid, {
      conn,
      sent: 0,
      total: this.fileMeta.size,
      done: false,
      name: cid.slice(-6)
    });
    this.updateStats();
    this.log(`Öğrenci bağlandı: ${cid}`, 'ok');
    this.renderStudentList();

    conn.on('open', () => {
      this.log(`Veri kanalı açık: ${cid} — transfer başlıyor`, 'ok');
      // Önce meta bilgisini gönder
      conn.send({ type: 'meta', ...this.fileMeta });
      // Ardından chunk'ları gönder
      this.sendFile(conn, cid);
    });

    conn.on('data', (data) => {
      if (data && data.type === 'progress') {
        const s = this.students.get(cid);
        if (s) {
          s.sent = data.received;
          this.updateStats();
          this.renderStudentList();
        }
      }
      if (data && data.type === 'done') {
        const s = this.students.get(cid);
        if (s) { s.done = true; s.sent = s.total; }
        this.log(`✅ ${cid} transfer tamamlandı`, 'ok');
        this.updateStats();
        this.renderStudentList();
      }
    });

    conn.on('close', () => {
      this.log(`Bağlantı kapandı: ${cid}`, 'warn');
      this.students.delete(cid);
      this.updateStats();
      this.renderStudentList();
    });

    conn.on('error', (err) => {
      this.log(`Hata (${cid}): ${err.message || err}`, 'err');
      const s = this.students.get(cid);
      if (s) { s.done = true; }
      this.renderStudentList();
    });
  },

  sendFile(conn, cid) {
    const file = this.file;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let offset = 0;
    let chunkIndex = 0;

    const readNext = () => {
      if (offset >= file.size) {
        // Bitti sinyali
        try { conn.send({ type: 'end' }); } catch (e) {}
        this.log(`Gönderim bitti: ${cid}`, 'ok');
        return;
      }
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();
      reader.onload = (e) => {
        const buf = e.target.result; // ArrayBuffer
        // DataChannel buffer doluysa bekle
        if (conn.dataChannel && conn.dataChannel.bufferedAmount > CHUNK_HIGH_WATER) {
          setTimeout(() => sendChunk(buf), 20);
        } else {
          sendChunk(buf);
        }
      };
      reader.onerror = () => this.log(`Dosya okuma hatası (${cid})`, 'err');
      reader.readAsArrayBuffer(slice);
    };

    const sendChunk = (buf) => {
      try {
        conn.send({ type: 'chunk', index: chunkIndex, data: buf });
        offset += CHUNK_SIZE;
        chunkIndex++;
        // İlerlemeyi güncelle (yerel)
        const s = this.students.get(cid);
        if (s) {
          s.sent = Math.min(offset, file.size);
          this.updateStats();
          this.renderStudentList();
        }
        // Bir sonraki chunk (asenkron tampon için ufak gecikme)
        if (offset < file.size) {
          setTimeout(readNext, 0);
        } else {
          conn.send({ type: 'end' });
        }
      } catch (err) {
        this.log(`Chunk gönderme hatası (${cid}): ${err.message}`, 'err');
      }
    };

    readNext();
  },

  updateStats() {
    let connected = 0, done = 0, total = this.students.size;
    for (const s of this.students.values()) {
      connected++;
      if (s.done) done++;
    }
    $('stat-connected').textContent = connected;
    $('stat-done').textContent = done;
    $('stat-total').textContent = total;
  },

  renderStudentList() {
    const el = $('teacher-students');
    if (this.students.size === 0) {
      el.innerHTML = '<p class="info-text">Henüz bağlı öğrenci yok.</p>';
      return;
    }
    el.innerHTML = '';
    for (const [cid, s] of this.students) {
      const pct = s.total > 0 ? Math.round((s.sent / s.total) * 100) : 0;
      let badgeClass = 'connected', badgeText = 'Bağlı';
      if (s.done) { badgeClass = 'done'; badgeText = 'Tamam'; }
      else if (pct > 0) { badgeClass = 'transferring'; badgeText = 'Aktarılıyor'; }
      const div = document.createElement('div');
      div.className = 'student-item';
      div.innerHTML = `
        <div class="name">${cid} <span class="badge ${badgeClass}">${badgeText}</span></div>
        <div class="progress-bar" style="height:12px;">
          <div class="progress-fill" style="width:${pct}%;"></div>
        </div>
        <div class="progress-label">${pct}% (${formatBytes(s.sent)} / ${formatBytes(s.total)})</div>
      `;
      el.appendChild(div);
    }
  }
};

/* ================= ÖĞRENCİ MODU ================= */
const Student = {
  peer: null,
  conn: null,
  fileMeta: null,
  chunks: [],
  received: 0,
  done: false,
  qrScanner: null,
  deviceIsMobile: false,

  init() {
    // Cihaz algılama
    this.deviceIsMobile = this.detectMobile();
    $('student-device-hint').textContent = this.deviceIsMobile
      ? '📱 Mobil cihaz algılandı — QR kod ile hızlı bağlanabilirsiniz.'
      : '💻 Masaüstü cihaz algılandı — Hoca ID\'sini girin.';
    if (this.deviceIsMobile) {
      $('student-qr-section').classList.remove('hidden');
    }

    $('btn-student-connect').addEventListener('click', () => this.connect());
    $('btn-open-scanner').addEventListener('click', () => this.openScanner());
    $('btn-download').addEventListener('click', () => this.download());
  },

  detectMobile() {
    const ua = navigator.userAgent || '';
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
    const smallScreen = window.innerWidth <= 768 && 'ontouchstart' in window;
    return mobileUA || smallScreen;
  },

  connect() {
    const id = $('student-teacher-id').value.trim();
    if (!id) { alert('Lütfen hoca ID girin.'); return; }
    $('btn-student-connect').disabled = true;
    $('student-connect-panel').classList.add('hidden');
    $('student-transfer-panel').classList.remove('hidden');
    $('student-status').textContent = 'Hocaya bağlanılıyor...';

    this.peer = new Peer({ debug: 0 });
    this.peer.on('open', () => {
      this.conn = this.peer.connect(id, { reliable: true });
      this.conn.on('open', () => {
        $('student-status').textContent = 'Bağlandı. Dosya bekleniyor...';
      });
      this.conn.on('data', (data) => this.handleData(data));
      this.conn.on('close', () => {
        $('student-status').textContent = 'Bağlantı kapandı.';
      });
      this.conn.on('error', (err) => {
        $('student-status').textContent = 'Bağlantı hatası: ' + (err.message || err);
      });
    });
    this.peer.on('error', (err) => {
      $('student-status').textContent = 'Peer hatası: ' + err.type;
    });
  },

  handleData(data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'meta') {
      this.fileMeta = { name: data.name, size: data.size, mime: data.mime };
      this.chunks = [];
      this.received = 0;
      this.done = false;
      $('student-status').textContent = `Dosya alınıyor: ${data.name}`;
      this.updateProgress();
    } else if (data.type === 'chunk') {
      this.chunks.push(data.data); // ArrayBuffer
      this.received += data.data.byteLength;
      this.updateProgress();
      // Hocaya ilerleme bildir
      try { this.conn.send({ type: 'progress', received: this.received }); } catch (e) {}
    } else if (data.type === 'end') {
      this.done = true;
      this.updateProgress();
      $('student-status').textContent = '✅ Transfer tamamlandı! Dosyayı indirebilirsiniz.';
      $('btn-download').classList.remove('hidden');
      try { this.conn.send({ type: 'done' }); } catch (e) {}
    }
  },

  updateProgress() {
    const total = this.fileMeta ? this.fileMeta.size : 0;
    const pct = total > 0 ? Math.min(100, Math.round((this.received / total) * 100)) : 0;
    $('student-progress').style.width = pct + '%';
    $('student-progress-label').textContent = `${pct}% (${formatBytes(this.received)} / ${formatBytes(total)})`;
  },

  download() {
    if (!this.fileMeta || this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, { type: this.fileMeta.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.fileMeta.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    $('btn-download').classList.add('hidden');
    $('student-status').textContent = '💾 Dosya indirildi.';
  },

  openScanner() {
    if (!this.qrScanner) {
      this.qrScanner = new Html5Qrcode('reader');
    }
    this.qrScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 250, height: 250 } },
      (decodedText) => {
        // QR içinde hoca ID'si var (ör: hoca-abc123)
        $('student-teacher-id').value = decodedText.trim();
        this.qrScanner.stop().catch(() => {});
        $('reader').innerHTML = '';
        this.connect();
      },
      () => {} // hata sessiz
    ).catch((err) => {
      alert('Kamera başlatılamadı: ' + err);
    });
  }
};

/* ================= BAŞLAT ================= */
window.addEventListener('load', () => {
  // Rol butonları
  $('btn-role-teacher').addEventListener('click', () => {
    showView('teacher');
    Teacher.init();
  });
  $('btn-role-student').addEventListener('click', () => {
    showView('student');
    Student.init();
  });

  // Service Worker kaydı
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW kayıt hatası:', e));
  }
});