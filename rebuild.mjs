/**
 * 과거 리포트 정정 재생성
 *
 *   node rebuild.mjs            docs/ 에 있는 모든 날짜 재생성
 *   node rebuild.mjs 2026-11-12 특정 날짜만
 *
 * 초기 버전은 GitHub 크론 지연 때문에 한국 장중(09:00~15:30)에 실행돼
 * 그날의 "실시간 가격"을 종가인 것처럼 표기했다. 이 스크립트는
 * 확정 종가로 모든 수치를 다시 계산해 덮어쓴다.
 *
 * 복원 불가로 빠지는 것: 당시 해외지수·환율·뉴스, 책 기반 퀀트 포트폴리오(시점 재무 필요)
 */
import fsp from 'node:fs/promises';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = nodePath.dirname(fileURLToPath(import.meta.url));
const DOCS = nodePath.join(ROOT, 'docs');

globalThis.fs = fsp;
globalThis.path = nodePath;
globalThis.QD_ARCHIVE = ROOT;

const Q = eval(await fsp.readFile(nodePath.join(ROOT, 'core.js'), 'utf8'));
const RP = eval(await fsp.readFile(nodePath.join(ROOT, 'report.js'), 'utf8'))(Q);
const log = (...a) => console.log(...a);

/* 네비게이션 (run.mjs 와 동일) */
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

/* 대상 날짜 */
const only = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const files = (await fsp.readdir(DOCS)).filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f));
const dates = [...new Set(files.map((f) => f.slice(0, 10)))].sort().reverse();
const targets = (only.length ? only : dates).slice();
log(`재생성 대상 ${targets.length}개: ${targets.join(', ')}`);

/* 데이터는 한 번만 수집해서 모든 날짜에 재사용 */
log('\n전종목 스냅샷...');
const uni = await Q.fetchUniverse();
const pool = uni.filter((s) => s.capEok >= 300 && s.price > 0).sort((a, b) => b.capEok - a.capEok).slice(0, 2400);
const myCodes = JSON.parse(await fsp.readFile(nodePath.join(ROOT, 'watchlist.json'), 'utf8')).codes || [];
for (const c of myCodes) if (!pool.some((s) => s.code === c)) { const f = uni.find((s) => s.code === c); if (f) pool.push(f); }
log(`  ${pool.length}종목`);

log('일봉 수집 (약 5년치, 1~2분)...');
const t0 = Date.now();
const bulk = await Q.fetchBarsBulk(pool.map((s) => s.code), {
  days: 1300, concurrency: 24,
  onProgress: (d, t) => { if (d % 480 === 0) log(`  ${d}/${t} (${((Date.now() - t0) / 1000).toFixed(0)}s)`); },
});
log(`  완료 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

let ok = 0, fail = 0;
for (const d of targets) {
  const ymd = d.replace(/-/g, '');
  try {
    const R = await RP.run({ asOf: ymd, uni, bulk, log: () => {} });
    if (!R.baseDate || R.baseDate !== ymd) { log(`  ${d}  건너뜀 (거래일 아님)`); fail++; continue; }
    const html = injectNav(RP.renderHTML(R), dates, d);
    await fsp.writeFile(nodePath.join(DOCS, `${d}.html`), html, 'utf8');
    log(`  ${d}  OK  분석 ${R.analyzed}종목 · 단타 ${R.bucket.short.length}/스윙 ${R.bucket.swing.length}/장투 ${R.bucket.long.length}`);
    ok++;
  } catch (e) {
    log(`  ${d}  실패: ${e.message}`);
    fail++;
  }
}

log(`\n재생성 완료: 성공 ${ok} / 실패 ${fail}`);
log('주의: index.html(최신호)은 건드리지 않았다. 최신호는 run.mjs 가 갱신한다.');
