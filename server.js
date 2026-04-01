const { DatabaseSync } = require('node:sqlite');
const { google }       = require('googleapis');
const express          = require('express');
const path             = require('path');
const fs               = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ════════════════════════════════════════
   SQLite 설정
════════════════════════════════════════ */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT    NOT NULL,
    gender             TEXT    NOT NULL,
    age                INTEGER NOT NULL,
    condition          TEXT    NOT NULL,
    presentation       TEXT    NOT NULL DEFAULT 'visual',
    max_digits         INTEGER NOT NULL,
    total_levels       INTEGER NOT NULL,
    successful_levels  INTEGER NOT NULL,
    duration_sec       REAL,
    attempt_no         INTEGER NOT NULL DEFAULT 1,
    results            TEXT    NOT NULL,
    created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 기존 DB에 컬럼이 없을 경우 추가 (마이그레이션)
try { db.exec('ALTER TABLE sessions ADD COLUMN duration_sec REAL'); } catch (_) {}
try { db.exec('ALTER TABLE sessions ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
try { db.exec("ALTER TABLE sessions ADD COLUMN presentation TEXT NOT NULL DEFAULT 'visual'"); } catch (_) {}

const insertStmt = db.prepare(`
  INSERT INTO sessions
    (name, gender, age, condition, presentation, max_digits, total_levels, successful_levels, duration_sec, attempt_no, results)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const allStmt = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC');
const allAsc  = db.prepare('SELECT * FROM sessions ORDER BY created_at ASC');

/* ════════════════════════════════════════
   Google Sheets 설정
════════════════════════════════════════ */
const CREDS_PATH  = path.join(__dirname, 'google-credentials.json');
const CONFIG_PATH = path.join(__dirname, 'sheets.config.json');

let sheetsClient   = null;
let SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';

// 로컬 실행 시 sheets.config.json 에서도 로드
if (!SPREADSHEET_ID && fs.existsSync(CONFIG_PATH)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    SPREADSHEET_ID = cfg.spreadsheetId || '';
  } catch (e) {
    console.warn('sheets.config.json 파싱 오류:', e.message);
  }
}

async function initGoogleSheets() {
  if (!SPREADSHEET_ID) return;

  // 환경변수(Render) 또는 파일(로컬) 둘 다 지원
  const hasEnvCreds  = !!process.env.GOOGLE_CREDENTIALS_JSON;
  const hasFileCreds = fs.existsSync(CREDS_PATH);
  if (!hasEnvCreds && !hasFileCreds) return;

  try {
    let authConfig = { scopes: ['https://www.googleapis.com/auth/spreadsheets'] };
    if (hasEnvCreds) {
      authConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } else {
      authConfig.keyFile = CREDS_PATH;
    }
    const auth = new google.auth.GoogleAuth(authConfig);
    const client = await auth.getClient();
    sheetsClient = google.sheets({ version: 'v4', auth: client });

    // 헤더 행 확인 및 추가
    const check = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A1:K1',
    });
    const headerRow = (check.data.values || [[]])[0] || [];
    if (headerRow.length === 0) {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId:    SPREADSHEET_ID,
        range:            'Sheet1!A1',
        valueInputOption: 'RAW',
        resource: { values: [[
          'ID', '세션ID', '언어', '성별', '출생년도', '자극 조건',
          '최고 Digit', '성공 레벨', '전체 레벨', '소요 시간', '시도 차수', '일시'
        ]] }
      });
    }

    // Meta 시트 확인/생성 (누적 카운트 오프셋 저장용)
    try {
      await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Meta!A1',
      });
    } catch (_) {
      // Meta 시트가 없으면 생성
      try {
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          resource: { requests: [{ addSheet: { properties: { title: 'Meta' } } }] }
        });
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Meta!A1:B1',
          valueInputOption: 'RAW',
          resource: { values: [['count_offset', '0']] }
        });
      } catch (e2) { console.warn('Meta sheet setup:', e2.message); }
    }

    console.log('✓ Google Sheets 연결 완료');
    console.log(`  시트 ID: ${SPREADSHEET_ID}`);
  } catch (e) {
    console.warn('⚠ Google Sheets 연결 실패:', e.message);
    sheetsClient = null;
  }
}

async function getCountOffset() {
  if (!sheetsClient || !SPREADSHEET_ID) return 0;
  try {
    const res = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Meta!B1',
    });
    return parseInt((res.data.values || [[0]])[0][0], 10) || 0;
  } catch (_) { return 0; }
}

async function setCountOffset(val) {
  if (!sheetsClient || !SPREADSHEET_ID) return;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Meta!B1',
    valueInputOption: 'RAW',
    resource: { values: [[String(val)]] }
  });
}

async function appendToSheet(rowData) {
  if (!sheetsClient || !SPREADSHEET_ID) return;
  try {
    // Sheets 행 수로 순차 ID 계산 (SQLite ID 대신 사용 — 재배포 후에도 연속)
    const countRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:A',
    });
    const totalRows = (countRes.data.values || []).length; // 헤더 포함
    const nextId = totalRows; // 헤더=1, 첫 데이터=ID 1, 두 번째=ID 2, ...
    rowData[0] = nextId;

    await sheetsClient.spreadsheets.values.append({
      spreadsheetId:    SPREADSHEET_ID,
      range:            'Sheet1!A1',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [rowData] },
    });
  } catch (e) {
    console.warn('Sheet append 오류:', e.message);
  }
}

/* ════════════════════════════════════════
   Express 미들웨어
════════════════════════════════════════ */
app.use(express.json());
app.use(express.static(__dirname));

/* ════════════════════════════════════════
   API: 세션 저장
════════════════════════════════════════ */
app.post('/api/save', async (req, res) => {
  try {
    const { name, gender, age, condition, duration_sec, attempt_no, results, lang, session_id } = req.body;
    if (!gender || !age || !condition || !Array.isArray(results)) {
      return res.status(400).json({ ok: false, error: '필수 항목 누락' });
    }

    const successes  = results.filter(r => r.success);
    const max_digits = successes.length > 0
      ? Math.max(...successes.map(r => r.level)) : 0;
    const dur  = typeof duration_sec === 'number' ? Math.round(duration_sec) : null;

    // SQLite 저장
    const info = insertStmt.run(
      name.trim(), gender, parseInt(age, 10), condition, 'visual',
      max_digits, results.length, successes.length,
      dur,
      parseInt(attempt_no, 10) || 1,
      JSON.stringify(results)
    );
    const id = info.lastInsertRowid;

    // 소요 시간 표시용 문자열
    const durLabel = dur != null
      ? `${Math.floor(dur / 60)}분 ${dur % 60}초`
      : '–';

    // Google Sheets 저장 (비동기, 응답 블로킹 안 함)
    appendToSheet([
      id, session_id || '', lang || 'ko', gender, parseInt(age, 10),
      condition === '40hz' ? '40Hz' : '핑크노이즈',
      max_digits > 0 ? `${max_digits}-Digit` : '–',
      successes.length, results.length,
      durLabel,
      parseInt(attempt_no, 10) || 1,
      new Date().toLocaleString('ko-KR')
    ]).catch(() => {});

    res.json({ ok: true, id });
  } catch (e) {
    console.error('Save error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════
   API: 전체 세션 JSON
════════════════════════════════════════ */
app.get('/api/status', (req, res) => {
  res.json({
    sheets_connected: !!sheetsClient,
    spreadsheet_id_set: !!SPREADSHEET_ID,
    has_env_creds: !!process.env.GOOGLE_CREDENTIALS_JSON,
  });
});

app.get('/api/rank', async (req, res) => {
  const score = parseFloat(req.query.score);
  if (!score || score <= 0) return res.json({ rank: 0, total: 0, percentile: 0 });

  let allScores = [];

  // Google Sheets에서 최고 Digit 컬럼(G) 읽기
  if (sheetsClient && SPREADSHEET_ID) {
    try {
      const result = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1!G2:G',  // 헤더 제외, '최고 Digit' 컬럼
      });
      const rows = result.data.values || [];
      allScores = rows
        .map(r => parseInt(r[0], 10))  // "5-Digit" → 5
        .filter(n => n > 0);
    } catch (e) {
      console.warn('Sheets rank error:', e.message);
    }
  }

  // Sheets 실패 시 SQLite fallback
  if (allScores.length === 0) {
    allScores = db.prepare('SELECT max_digits FROM sessions WHERE max_digits > 0').all()
      .map(r => r.max_digits);
  }

  const total = allScores.length;
  if (total === 0) return res.json({ rank: 0, total: 0, percentile: 0 });

  const beaten = allScores.filter(s => s < score).length;
  const percentile = Math.round((beaten / total) * 100);
  const rank = allScores.filter(s => s > score).length + 1;

  const mean = allScores.reduce((a, b) => a + b, 0) / total;
  const std  = Math.sqrt(allScores.reduce((a, b) => a + (b - mean) ** 2, 0) / total) || 1;

  res.json({ rank, total, percentile, mean, std });
});

app.get('/api/count', async (req, res) => {
  if (sheetsClient && SPREADSHEET_ID) {
    try {
      const result = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Sheet1!A:A',
      });
      const rows = result.data.values || [];
      const current = Math.max(0, rows.length - 1);
      const offset  = await getCountOffset();
      return res.json({ count: current + offset });
    } catch (e) {
      console.warn('Sheets count error:', e.message);
    }
  }
  const row = db.prepare('SELECT COUNT(*) as n FROM sessions').get();
  res.json({ count: row.n });
});

app.get('/api/sessions', (req, res) => {
  res.json(allStmt.all());
});

/* ════════════════════════════════════════
   API: CSV 다운로드
════════════════════════════════════════ */
app.get('/api/export.csv', (req, res) => {
  const rows    = allAsc.all();
  const headers = ['id','name','gender','age','condition','max_digits',
                   'total_levels','successful_levels','duration_sec','attempt_no','created_at'];
  const escape  = v =>
    (typeof v === 'string' && /[,"\n]/.test(v)) ? `"${v.replace(/"/g,'""')}"` : (v ?? '');
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => escape(r[h])).join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="digit-span-results.csv"');
  res.send('\uFEFF' + csv);
});

/* ════════════════════════════════════════
   API: 시트 클리어 & 헤더 재설정
════════════════════════════════════════ */
app.post('/admin/clear-sheet', async (req, res) => {
  if (!sheetsClient || !SPREADSHEET_ID) {
    return res.status(400).json({ ok: false, error: 'Google Sheets 미연결' });
  }
  try {
    // 현재 행 수를 오프셋에 누적
    const countRes = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:A',
    });
    const currentRows = Math.max(0, (countRes.data.values || []).length - 1);
    const prevOffset  = await getCountOffset();
    await setCountOffset(prevOffset + currentRows);

    // 전체 데이터 클리어
    await sheetsClient.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1',
    });
    // 헤더 재설정
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId:    SPREADSHEET_ID,
      range:            'Sheet1!A1',
      valueInputOption: 'RAW',
      resource: { values: [[
        'ID', '세션ID', '언어', '성별', '출생년도', '자극 조건',
        '최고 Digit', '성공 레벨', '전체 레벨', '소요 시간', '시도 차수', '일시'
      ]] }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Clear sheet error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ════════════════════════════════════════
   관리자 페이지
════════════════════════════════════════ */
app.get('/admin', (req, res) => {
  const rows   = allStmt.all();
  const total  = rows.length;
  const n8     = rows.filter(r => r.condition === '8hz').length;
  const n40    = rows.filter(r => r.condition === '40hz').length;
  const nPink  = rows.filter(r => r.condition === 'pink_noise').length;
  const avgMax = total > 0
    ? (rows.reduce((s, r) => s + r.max_digits, 0) / total).toFixed(2) : '–';

  const condBadge = c =>
    c === '8hz'  ? '<span class="c8">8Hz</span>' :
    c === '40hz' ? '<span class="c40">40Hz</span>' :
                   '<span class="cpink">핑크</span>';

  const fmtDur = sec => sec != null
    ? `${Math.floor(sec / 60)}분 ${sec % 60}초`
    : '–';

  const tableRows = rows.map(r => `
    <tr>
      <td>${r.id}</td><td>${r.name}</td><td>${r.gender}</td><td>${r.age}</td>
      <td>${condBadge(r.condition)}</td>
      <td><b>${r.max_digits > 0 ? r.max_digits + '-Digit' : '–'}</b></td>
      <td>${r.successful_levels} / ${r.total_levels}</td>
      <td>${fmtDur(r.duration_sec)}</td>
      <td style="text-align:center">${r.attempt_no ?? 1}</td>
      <td>${new Date(r.created_at).toLocaleString('ko-KR')}</td>
    </tr>`).join('') ||
    '<tr><td colspan="10" style="text-align:center;color:#555;padding:2rem">데이터 없음</td></tr>';

  const sheetLink = SPREADSHEET_ID
    ? `<a class="btn btn-sheet" href="https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}" target="_blank">Google 시트 열기</a>`
    : `<span style="color:#f4a45e;font-size:.82rem">⚠ Google Sheets 미연결 — sheets.config.json 확인</span>`;

  res.send(`<!DOCTYPE html>
<html lang="ko"><head>
  <meta charset="UTF-8"/><title>Digit Span — 관리자</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui;background:#0d0d1a;color:#e8e8f0;padding:2rem}
    h1{font-size:1.4rem;letter-spacing:.06em;margin-bottom:1.5rem}
    .stats{display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
    .stat{background:#13132b;border:1px solid #222244;border-radius:12px;padding:.8rem 1.4rem;min-width:110px}
    .stat-val{font-size:1.7rem;font-weight:900;line-height:1}
    .stat-lbl{font-size:.7rem;color:#6b6b90;letter-spacing:.08em;text-transform:uppercase;margin-top:.2rem}
    .actions{display:flex;gap:.8rem;margin-bottom:1.2rem;flex-wrap:wrap;align-items:center}
    .btn{border:none;border-radius:8px;padding:.5rem 1.2rem;cursor:pointer;font-weight:700;font-size:.88rem;text-decoration:none;display:inline-block}
    .btn-csv{background:#4ade80;color:#0d1a10}
    .btn-sheet{background:#34a853;color:#fff}
    .btn-ref{background:#5e81f4;color:#fff}
    .btn-clear{background:#f45e81;color:#fff}
    .btn-back{background:#222244;color:#e8e8f0}
    table{border-collapse:collapse;width:100%;font-size:.88rem}
    th{text-align:left;padding:.4rem .7rem;border-bottom:2px solid #1e1e3a;color:#6b6b90;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase}
    td{padding:.45rem .7rem;border-bottom:1px solid #1a1a30}
    tr:hover td{background:#13132b}
    .c8{color:#4ade80;font-weight:700}.c40{color:#5e81f4;font-weight:700}.cpink{color:#f4a45e;font-weight:700}
    .count{color:#6b6b90;font-size:.82rem;margin-bottom:.8rem}
  </style>
</head><body>
<h1>Digit Span Test — 결과 데이터</h1>
<div class="stats">
  <div class="stat"><div class="stat-val">${total}</div><div class="stat-lbl">총 세션</div></div>
  <div class="stat"><div class="stat-val" style="color:#4ade80">${n8}</div><div class="stat-lbl">8Hz</div></div>
  <div class="stat"><div class="stat-val" style="color:#5e81f4">${n40}</div><div class="stat-lbl">40Hz</div></div>
  <div class="stat"><div class="stat-val" style="color:#f4a45e">${nPink}</div><div class="stat-lbl">핑크노이즈</div></div>
  <div class="stat"><div class="stat-val">${avgMax}</div><div class="stat-lbl">평균 최고 Digit</div></div>
</div>
<div class="actions">
  <a class="btn btn-csv" href="/api/export.csv">CSV 다운로드</a>
  ${sheetLink}
  <button class="btn btn-ref" onclick="location.reload()">새로고침</button>
  <button class="btn btn-clear" onclick="clearSheet()">시트 클리어</button>
  <a class="btn btn-back" href="/">← 테스트</a>
</div>
<p class="count">총 ${total}개 세션</p>
<table>
  <thead><tr><th>#</th><th>이름</th><th>성별</th><th>나이</th><th>자극</th><th>최고</th><th>성공/전체</th><th>소요 시간</th><th>차수</th><th>일시</th></tr></thead>
  <tbody>${tableRows}</tbody>
</table>
<script>
async function clearSheet() {
  if (!confirm('Google 시트의 모든 데이터를 삭제하고 헤더를 초기화합니다. 계속하시겠습니까?')) return;
  const res = await fetch('/admin/clear-sheet', { method: 'POST' });
  const data = await res.json();
  if (data.ok) { alert('시트가 초기화되었습니다.'); location.reload(); }
  else alert('오류: ' + data.error);
}
</script>
</body></html>`);
});

/* ════════════════════════════════════════
   서버 시작
════════════════════════════════════════ */
initGoogleSheets().then(() => {
  app.listen(PORT, () => {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Digit Span Test 서버 실행 중');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  테스트  →  http://localhost:${PORT}`);
    console.log(`  관리자  →  http://localhost:${PORT}/admin`);
    console.log(`  CSV     →  http://localhost:${PORT}/api/export.csv`);

    if (!fs.existsSync(CREDS_PATH) || !SPREADSHEET_ID) {
      console.log('\n  ── Google Sheets 연결 방법 ──────────────');
      console.log('  1. https://console.cloud.google.com 접속');
      console.log('  2. 프로젝트 생성 → "Google Sheets API" 활성화');
      console.log('  3. 서비스 계정 생성 → JSON 키 다운로드');
      console.log('     → 파일명을 google-credentials.json 으로 저장');
      console.log('  4. Google Sheet 생성 → 서비스 계정 이메일 공유(편집자)');
      console.log('  5. sheets.config.json 의 spreadsheetId 에 시트 ID 입력');
      console.log('     (시트 URL: docs.google.com/spreadsheets/d/[ID]/edit)');
      console.log('  ─────────────────────────────────────────');
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  });
});
