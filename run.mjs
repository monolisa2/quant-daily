/**
 * 데일리 퀀트 브리핑 — GitHub Actions 실행 엔트리
 *
 *   node run.mjs              오늘자 리포트 생성 → docs/
 *   node run.mjs --backtest   백테스트 강제 재계산
 *
 * core.js / report.js 는 Aside REPL 과 완전히 같은 파일을 그대로 쓴다.
 * (브라우저 REPL 과 Node 양쪽에서 돌도록 eval 로드 방식)
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = nodePath.dirname(fileURLToPath(import.meta.url));
const DOCS = nodePath.join(ROOT, 'docs');

// report.js 가 참조하는 전역
globalThis.fs = fsp;
globalThis.path = nodePath;
globalThis.QD_ARCHIVE = ROOT;

const Q = eval(await fsp.readFile(nodePath.join(ROOT, 'core.js'), 'utf8'));
const RP = eval(await fsp.readFile(nodePath.join(ROOT, 'report.js'), 'utf8'))(Q);

const log = (...a) => console.log(...a);
const BACKTEST_MAX_AGE_DAYS = 30;

/* ------------------------------------------------------------------ *
 * 백테스트 (없거나 30일 이상 오래됐으면 재계산)
 * ------------------------------------------------------------------ */
async function ensureBacktest(force = false) {
  const p = nodePath.join(ROOT, 'backtest.json');
  if (!force) {
    try {
      const bt = JSON.parse(await fsp.readFile(p, 'utf8'));
      const age = (Date.now() - new Date(bt.generatedAt).getTime()) / 86400000;
      if (age < BACKTEST_MAX_AGE_DAYS) {
        log(`백테스트 최신 (${age.toFixed(0)}일 전 · 표본 ${bt.stockDays.toLocaleString()} 종목-일)`);
        return;
      }
      log(`백테스트 ${age.toFixed(0)}일 경과 → 재계산`);
    } catch {
      log('백테스트 없음 → 신규 계산');
    }
  } else {
    log('백테스트 강제 재계산');
  }

  const uni = await Q.fetchUniverse();
  const U = uni.filter((s) => s.capEok >= 1000 && s.price > 0).sort((a, b) => b.capEok - a.capEok);
  log(`  대상 ${U.length}종목`);
  const acc = Q.createAcc();
  const t0 = Date.now();
  for (let i = 0; i < U.length; i += 220) {
    const part = U.slice(i, i + 220);
    const bulk = await Q.fetchBarsBulk(part.map((s) => s.code), { days: 1300 });
    Q.feedAcc(acc, part, bulk);
    bulk.clear();
    log(`  ${Math.min(i + 220, U.length)}/${U.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const BT = Q.finalizeAcc(acc);
  await fsp.writeFile(p, JSON.stringify(BT), 'utf8');
  log(`  완료: ${BT.period.from}~${BT.period.to} · ${BT.stockDays.toLocaleString()} 종목-일`);
}

/* ------------------------------------------------------------------ *
 * 아카이브 네비게이션 주입
 * ------------------------------------------------------------------ */
function injectNav(html, dates, current) {
  const opts = dates.map((d) => `<option value="${d}.html"${d === current ? ' selected' : ''}>${d}</option>`).join('');
  const nav = `<div id="qdnav">
  <b>퀀트 브리핑</b>
  <select onchange="if(this.value)location.href=this.value">${opts}</select>
  <a href="./">최신</a>
</div>
<style>
#qdnav{position:sticky;top:0;z-index:60;display:flex;align-items:center;gap:10px;
  background:#15181d;color:#fff;padding:9px 16px;
  font:600 13.5px 'Pretendard Variable',Pretendard,-apple-system,sans-serif}
#qdnav b{letter-spacing:-.3px}
#qdnav select{margin-left:auto;background:#262b33;color:#fff;border:1px solid #39404b;
  border-radius:7px;padding:5px 9px;font:inherit;font-weight:500;max-width:150px}
#qdnav a{color:#9fb4ff;text-decoration:none;font-weight:600}
#qdnav a:hover{text-decoration:underline}
.tabs{top:41px !important}
</style>`;
  return html.replace('<div class="wrap">', nav + '<div class="wrap">');
}
const stripNav = (h) => h.replace(/<div id="qdnav">[\s\S]*?<\/style>\n?/, '');

/* ------------------------------------------------------------------ *
 * 메인
 * ------------------------------------------------------------------ */
const force = process.argv.includes('--backtest');
await ensureBacktest(force);

log('리포트 생성...');
const R = await RP.run({ log });
const dash = `${R.baseDate.slice(0, 4)}-${R.baseDate.slice(4, 6)}-${R.baseDate.slice(6, 8)}`;

// 어제 픽 추적 (Actions 로그에 남김)
try {
  const prev = await RP.followUp(R, ROOT);
  if (prev) {
    for (const hk of Q.HK) {
      const arr = (prev.picks[hk] || []).filter((x) => x.ret != null);
      if (!arr.length) continue;
      const avg = arr.reduce((a, b) => a + b.ret, 0) / arr.length;
      const best = arr.slice().sort((a, b) => b.ret - a.ret)[0];
      log(`  [추적] ${prev.date} ${Q.HORIZONS[hk].label} 픽 ${arr.length}종목 평균 ${(avg * 100).toFixed(2)}% (최고 ${best.name} ${(best.ret * 100).toFixed(1)}%)`);
    }
  }
} catch (e) { log('  추적 건너뜀:', e.message); }

await RP.saveSnapshot(R, ROOT);

await fsp.mkdir(DOCS, { recursive: true });
const existing = (await fsp.readdir(DOCS).catch(() => []))
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).map((f) => f.slice(0, 10));
const dates = [...new Set([...existing, dash])].sort().reverse();

const raw = RP.renderHTML(R);
await fsp.writeFile(nodePath.join(DOCS, `${dash}.html`), injectNav(raw, dates, dash), 'utf8');
await fsp.writeFile(nodePath.join(DOCS, 'index.html'), injectNav(raw, dates, dash), 'utf8');
await fsp.writeFile(nodePath.join(DOCS, '.nojekyll'), '', 'utf8');

// 지난 리포트 네비도 최신 목록으로 갱신
for (const d of dates) {
  if (d === dash) continue;
  const f = nodePath.join(DOCS, `${d}.html`);
  try { await fsp.writeFile(f, injectNav(stripNav(await fsp.readFile(f, 'utf8')), dates, d), 'utf8'); } catch {}
}

await fsp.writeFile(nodePath.join(DOCS, 'archive.json'),
  JSON.stringify({ updated: new Date().toISOString(), latest: dash, dates }, null, 2), 'utf8');

log(`\n완료: ${dash} · 분석 ${R.analyzed}종목 · 아카이브 ${dates.length}호`);
log(`후보 — 단타 ${R.bucket.short.length} / 스윙 ${R.bucket.swing.length} / 장투 ${R.bucket.long.length}`);
