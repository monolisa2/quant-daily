/**
 * quant-daily / report.js
 * core.js 를 써서 오늘자 스크리닝을 하고 단타/스윙/장투 3구간 HTML 리포트를 만든다.
 *
 *   const Q  = eval(await fs.readFile(CORE_PATH,'utf8'));
 *   const RP = eval(await fs.readFile(REPORT_PATH,'utf8'))(Q);
 *   const R  = await RP.run({ log: console.log });
 *   const html = RP.renderHTML(R);
 */
((Q) => {
  const { STRATEGIES, HORIZONS, HK, buildSeries } = Q;
  // 기본 아카이브 경로. Node/리눅스에서는 globalThis.QD_ARCHIVE 로 오버라이드한다.
  const ARCHIVE = (typeof globalThis !== 'undefined' && globalThis.QD_ARCHIVE)
    || 'C:\\Users\\y\\.aside\\u\\0\\data\\quant-daily';
  const _fs = () => (typeof fs !== 'undefined' ? fs : globalThis.fs);
  const _path = () => (typeof path !== 'undefined' ? path : globalThis.path);

  const pctS = (v, d = 1) => (v == null || !isFinite(v) ? '-' : (v > 0 ? '+' : '') + (v * 100).toFixed(d) + '%');
  const pctP = (v, d = 1) => (v == null || !isFinite(v) ? '-' : (v * 100).toFixed(d) + '%');
  const won = (v) => {
    if (!v) return '-';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + '조';
    if (v >= 1e8) return Math.round(v / 1e8).toLocaleString() + '억';
    return Math.round(v / 1e4).toLocaleString() + '만';
  };
  const capS = (eok) => (eok >= 10000 ? (eok / 10000).toFixed(1) + '조' : Math.round(eok).toLocaleString() + '억');
  const fmtD = (d) => (d ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}` : '');
  // finance.naver.com/item/main.naver 는 PC SPA(stock.naver.com)로 리다이렉트되면서
  // 클라이언트 예외가 나는 경우가 있다. 모바일 페이지는 PC·폰 모두 정상이다.
  const nlink = (c) => `https://m.stock.naver.com/domestic/stock/${c}/total`;

  async function loadJSON(p, fallback = null) {
    try { return JSON.parse(await _fs().readFile(p, 'utf8')); } catch { return fallback; }
  }

  /* ---------------------------------------------------------------- *
   * 파이프라인
   * ---------------------------------------------------------------- */
  async function run(opts = {}) {
    const {
      minCapEok = 1000, minAvgValEok = 5, valueCapEok = 300, universeLimit = 2400,
      topN = 10, log = () => {},
    } = opts;
    const P = _path();

    log('1/6 전종목 스냅샷...');
    const uni = await Q.fetchUniverse();
    const myCodes = (await loadJSON(P.join(ARCHIVE, 'watchlist.json'), { codes: [] })).codes || [];
    const pool = uni.filter((s) => s.capEok >= valueCapEok && s.price > 0).sort((a, b) => b.capEok - a.capEok).slice(0, universeLimit);
    const poolCodes = new Set(pool.map((s) => s.code));
    for (const c of myCodes) if (!poolCodes.has(c)) { const f = uni.find((s) => s.code === c); if (f) pool.push(f); }
    log(`   전체 ${uni.length} / 분석대상 ${pool.length}`);

    log('2/6 일봉 수집...');
    const bulk = await Q.fetchBarsBulk(pool.map((s) => s.code), { days: 420, onProgress: (d, t) => log(`   ${d}/${t}`) });

    log('3/6 지표 계산...');
    const allRows = [];
    for (const s of pool) {
      const C = bulk.get(s.code);
      if (!C || C.c.length < 130) continue;
      const S = buildSeries(s, C);
      if (!S) continue;
      const r = S.at(S.lastIdx);
      if (!r) continue;
      r.capEok = s.capEok; r.price = s.price;
      r.isMine = myCodes.includes(s.code);
      allRows.push(r);
    }
    // 시그널 전략용 풀 (백테스트와 동일 기준)
    const rows = allRows.filter((r) => (r.capEok >= minCapEok && r.avgVal20 >= minAvgValEok * 1e8) || r.isMine);
    const dateCount = {};
    rows.forEach((r) => { dateCount[r.date] = (dateCount[r.date] || 0) + 1; });
    const baseDate = Object.entries(dateCount).sort((a, b) => b[1] - a[1])[0]?.[0];
    log(`   유효 ${rows.length}종목 / 기준일 ${baseDate}`);

    log('4/6 전략 스크리닝...');
    const BT = await loadJSON(P.join(ARCHIVE, 'backtest.json'));
    const strat = {};
    for (const S of STRATEGIES) {
      const hit = rows.filter((r) => { try { return !!S.pick(r); } catch { return false; } });
      hit.sort((a, b) => S.score(b) - S.score(a));
      strat[S.id] = { meta: S, list: hit.slice(0, topN), total: hit.length, all: hit.map((r) => r.code) };
    }
    // 종목별 오늘 걸린 시그널
    const hitsOf = new Map();
    for (const S of STRATEGIES) for (const c of strat[S.id].all) {
      if (!hitsOf.has(c)) hitsOf.set(c, []);
      hitsOf.get(c).push(S.id);
    }

    log('5/6 재무 데이터 + 책 기반 포트폴리오...');
    let pfo = null, DEC = null;
    try {
      const fundMap = await Q.fetchFundamentalsBulk(pool, { concurrency: 30, onProgress: (d, t) => log(`   재무 ${d}/${t}`) });
      allRows.forEach((r) => { r.f = fundMap.get(r.code) || null; });
      pfo = Q.buildPortfolios(allRows, {});
      DEC = await loadJSON(P.join(ARCHIVE, 'deciles.json'));
      log(`   포트폴리오 풀 ${pfo.pool} / 소형주 ${pfo.small}`);
    } catch (e) { log('   재무 수집 실패: ' + e.message); }

    const market = await Q.fetchMarket();
    const liquid = rows.filter((r) => r.tradeVal >= 10e8);
    const gainers = [...liquid].sort((a, b) => b.ret1 - a.ret1).slice(0, topN);
    const losers = [...liquid].sort((a, b) => a.ret1 - b.ret1).slice(0, topN);
    const byValue = [...rows].sort((a, b) => b.tradeVal - a.tradeVal).slice(0, topN);

    // 구간별 최고 후보: 해당 구간 전략에 걸린 종목 중, (전략 엣지 × 종목 과거승률) 기준
    const bucket = {};
    for (const hk of HK) {
      const cands = new Map();
      for (const S of STRATEGIES.filter((x) => x.horizon === hk)) {
        const eh = BT?.strat?.[S.id]?.h?.[hk];
        const edge = eh?.edge ?? 0;
        for (const r of strat[S.id].list) {
          const ps = BT?.perStock?.[r.code]?.[S.id];
          const pw = ps?.[hk]?.win;
          const sc = (edge * 100) * (pw != null ? 0.5 + pw : 1);
          const e = cands.get(r.code) || { row: r, sigs: [], score: 0 };
          e.sigs.push({ id: S.id, name: S.name, edge, pastN: ps?.n ?? null, pastWin: pw ?? null, pastAvg: ps?.[hk]?.avg ?? null });
          e.score += sc;
          cands.set(r.code, e);
        }
      }
      bucket[hk] = [...cands.values()].sort((a, b) => b.sigs.length - a.sigs.length || b.score - a.score).slice(0, 8);
    }

    // 내 종목
    const mine = rows.filter((r) => r.isMine).map((r) => ({
      row: r, today: (hitsOf.get(r.code) || []),
      past: BT?.perStock?.[r.code] || null,
    }));

    log('6/6 뉴스...');
    const newsCodes = [...new Set([
      ...gainers.slice(0, 6).map((r) => r.code),
      ...HK.flatMap((hk) => bucket[hk].slice(0, 3).map((b) => b.row.code)),
      ...mine.map((m) => m.row.code),
    ])];
    const newsMap = {};
    await Promise.all(newsCodes.map(async (c) => { newsMap[c] = await Q.fetchNews(c, 2).catch(() => []); }));

    return {
      baseDate, generatedAt: new Date().toISOString(),
      universeCount: uni.length, analyzed: rows.length, valueAnalyzed: allRows.length,
      market, gainers, losers, byValue, strat, bucket, mine, hitsOf, newsMap, rows, allRows, BT,
      pfo, DEC, halloween: Q.halloween(),
    };
  }

  /* ---------------------------------------------------------------- *
   * 렌더링
   * ---------------------------------------------------------------- */
  function renderHTML(R) {
    const BT = R.BT;
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const cls = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'dn' : '');

    const pastCell = (code, sid, hk) => {
      const ps = BT?.perStock?.[code]?.[sid];
      if (!ps || !ps[hk]) return '<span class="mut">표본부족</span>';
      const w = ps[hk].win;
      const c = w >= 0.6 ? 'good' : w >= 0.5 ? 'ok' : 'bad';
      return `<span class="past ${c}">${ps.n}회 · 승률 ${pctP(w, 0)}</span>`;
    };

    const stockRow = (r, opts = {}) => {
      const extra = opts.extra ? opts.extra(r) : '';
      return `<tr>
        <td class="nm"><a href="${nlink(r.code)}" target="_blank">${esc(r.name)}</a><span class="cd">${r.code} · ${r.market === 'KOSPI' ? '코스피' : '코스닥'}</span></td>
        <td class="n">${r.close.toLocaleString()}</td>
        <td class="n ${cls(r.ret1)}">${pctS(r.ret1)}</td>
        <td class="n ${cls(r.ret20)}">${pctS(r.ret20)}</td>
        <td class="n">${capS(r.capEok)}</td>
        <td class="n c-opt">${won(r.tradeVal)}</td>
        <td class="n c-opt">${r.volRatio ? r.volRatio.toFixed(1) + 'x' : '-'}</td>
        ${extra}
      </tr>`;
    };
    const stockTable = (list, opts = {}) => `<div class="tw"><table>
      <thead><tr><th>종목</th><th class="n">종가</th><th class="n">1일</th><th class="n">20일</th><th class="n">시총</th><th class="n c-opt">거래대금</th><th class="n c-opt">거래량</th>${opts.head || ''}</tr></thead>
      <tbody>${list.map((r) => stockRow(r, opts)).join('')}</tbody></table></div>`;

    /* --- 전략 카드 --- */
    const btBadges = (sid, primary) => HK.map((hk) => {
      const h = BT?.strat?.[sid]?.h?.[hk];
      if (!h) return '';
      const H = HORIZONS[hk];
      const good = h.edge > 0;
      return `<div class="badge ${hk === primary ? 'pri' : ''} ${good ? 'pos' : 'neg'}">
        <b>${H.label} ${H.days}일</b>
        <span>승률 ${pctP(h.win, 0)}</span>
        <span>평균 ${pctS(h.avg)}</span>
        <span class="edge">시장대비 ${pctS(h.edge, 2)}p</span>
        <i>표본 ${h.n.toLocaleString()}</i>
      </div>`;
    }).join('');

    const stratCard = (S) => {
      const s = R.strat[S.id];
      const h = BT?.strat?.[S.id]?.h?.[S.horizon];
      const risk = h ? `<p class="risk">과거 이 시그널 후 ${HORIZONS[S.horizon].days}일 동안 <b>최대 상승 중앙값 ${pctS(h.mfe)}</b> / <b>최대 하락 중앙값 ${pctS(h.mae)}</b> → 손절선 ${pctS(h.mae * 0.8)} 부근, 1차 익절 ${pctS(h.mfe * 0.7)} 부근이 통계적 참고선</p>` : '';
      const verdict = h ? (h.edge > 0.005 ? `<span class="vd good">검증됨</span>` : h.edge > -0.002 ? `<span class="vd mid">보통</span>` : `<span class="vd bad">과거엔 손해</span>`) : '';
      const body = s.list.length
        ? stockTable(s.list, {
            head: '<th>이 종목 과거 성적</th>',
            extra: (r) => `<td>${pastCell(r.code, S.id, S.horizon)}</td>`,
          })
        : '<p class="none">오늘 조건을 만족하는 종목 없음</p>';
      return `<section class="card">
        <h3>${esc(S.name)} ${verdict}<span class="cnt">오늘 ${s.total}종목</span></h3>
        <p class="origin">${esc(S.origin)}</p>
        <div class="badges">${btBadges(S.id, S.horizon)}</div>
        <p class="why">${esc(S.why)}</p>
        <p class="caution">주의 · ${esc(S.caution)}</p>
        ${risk}
        ${body}
      </section>`;
    };

    /* --- 구간 요약 (엣지 랭킹) --- */
    const rankTable = (hk) => {
      const rows = STRATEGIES.map((S) => ({ S, h: BT?.strat?.[S.id]?.h?.[hk] })).filter((x) => x.h)
        .sort((a, b) => b.h.edge - a.h.edge);
      return `<div class="tw"><table class="rank">
        <thead><tr><th>전략</th><th class="n">승률</th><th class="n">평균수익</th><th class="n">시장대비</th><th class="n c-opt">목표달성률</th><th class="n c-opt">표본</th><th class="n">오늘</th></tr></thead>
        <tbody>${rows.map(({ S, h }) => `<tr class="${h.edge > 0 ? '' : 'dim'}">
          <td>${S.horizon === hk ? '<b>' : ''}${esc(S.name)}${S.horizon === hk ? '</b>' : ''}</td>
          <td class="n">${pctP(h.win, 0)}</td>
          <td class="n ${cls(h.avg)}">${pctS(h.avg)}</td>
          <td class="n ${cls(h.edge)}"><b>${pctS(h.edge, 2)}p</b></td>
          <td class="n c-opt">${pctP(h.hitTarget, 0)}</td>
          <td class="n mut c-opt">${h.n.toLocaleString()}</td>
          <td class="n">${R.strat[S.id].total}</td></tr>`).join('')}</tbody></table></div>`;
    };

    /* --- 구간별 TOP 픽 --- */
    const bucketPicks = (hk) => {
      const list = R.bucket[hk];
      if (!list?.length) return '<p class="none">오늘 이 구간에서 겹치는 후보 없음</p>';
      return `<div class="picks">${list.map((b) => {
        const r = b.row;
        const news = (R.newsMap[r.code] || [])[0];
        return `<div class="pick">
          <div class="ph">
            <a href="${nlink(r.code)}" target="_blank">${esc(r.name)}</a>
            <span class="cd">${r.code} · ${r.market === 'KOSPI' ? '코스피' : '코스닥'} · ${capS(r.capEok)}</span>
            <span class="pr ${cls(r.ret1)}">${r.close.toLocaleString()} <b>${pctS(r.ret1)}</b></span>
          </div>
          <div class="sigs">${b.sigs.map((g) => `<span class="chip ${g.edge > 0 ? '' : 'w'}">${esc(g.name)}${g.pastWin != null ? ` <i>과거 ${g.pastN}회 승률 ${pctP(g.pastWin, 0)}</i>` : ''}</span>`).join('')}</div>
          <div class="meta">20일 ${pctS(r.ret20)} · 60일 ${pctS(r.ret60)} · 52주고점대비 ${pctS(r.fromHigh)} · RSI ${r.rsi14 ? r.rsi14.toFixed(0) : '-'} · 거래량 ${r.volRatio ? r.volRatio.toFixed(1) + 'x' : '-'}</div>
          ${news ? `<div class="nw">${news.url ? `<a href="${news.url}" target="_blank">${esc(news.title)}</a>` : esc(news.title)} <i>${esc(news.office || '')}</i></div>` : ''}
        </div>`;
      }).join('')}</div>`;
    };

    /* --- 내 종목 --- */
    const mineBlock = !R.mine.length ? '' : `<h2>내 관심종목</h2>
      <div class="picks">${R.mine.map((m) => {
        const r = m.row;
        const news = (R.newsMap[r.code] || [])[0];
        const past = m.past ? Object.entries(m.past).sort((a, b) => b[1].n - a[1].n).slice(0, 6) : [];
        return `<div class="pick mine">
          <div class="ph">
            <a href="${nlink(r.code)}" target="_blank">${esc(r.name)}</a>
            <span class="cd">${r.code} · ${r.market === 'KOSPI' ? '코스피' : '코스닥'} · ${capS(r.capEok)}</span>
            <span class="pr ${cls(r.ret1)}">${r.close.toLocaleString()} <b>${pctS(r.ret1)}</b></span>
          </div>
          <div class="meta">20일 ${pctS(r.ret20)} · 60일 ${pctS(r.ret60)} · 240일 ${pctS(r.ret240)} · 52주고점대비 ${pctS(r.fromHigh)} · RSI ${r.rsi14 ? r.rsi14.toFixed(0) : '-'} · 20일선 ${r.aboveMa20 ? '위' : '아래'} · 120일선 ${r.aboveMa120 ? '위' : '아래'}</div>
          <div class="sigs">${m.today.length ? m.today.map((id) => `<span class="chip">오늘: ${esc(Q.STRAT_BY_ID[id].name)}</span>`).join('') : '<span class="chip w">오늘 걸린 시그널 없음</span>'}</div>
          ${past.length ? `<div class="tw"><table class="mini"><thead><tr><th>과거 시그널</th><th class="n">횟수</th><th class="n">단타3일</th><th class="n">스윙20일</th><th class="n">장투120일</th></tr></thead><tbody>
            ${past.map(([sid, v]) => `<tr><td>${esc(Q.STRAT_BY_ID[sid]?.name || sid)}</td><td class="n">${v.n}</td>
              ${HK.map((hk) => `<td class="n">${v[hk] ? `${pctP(v[hk].win, 0)} <span class="mut">${pctS(v[hk].avg)}</span>` : '-'}</td>`).join('')}</tr>`).join('')}
          </tbody></table></div>` : ''}
          ${news ? `<div class="nw">${news.url ? `<a href="${news.url}" target="_blank">${esc(news.title)}</a>` : esc(news.title)} <i>${esc(news.office || '')}</i></div>` : ''}
        </div>`;
      }).join('')}</div>`;

    const mk = R.market.map((m) => `<div class="mcard ${m.rate > 0 ? 'up' : m.rate < 0 ? 'dn' : ''}">
      <span class="ml">${esc(m.label)}</span><span class="mp">${esc(m.price)}</span>
      <span class="mr">${m.rate > 0 ? '+' : ''}${m.rate}%</span></div>`).join('');

    const bench = BT?.benchmark;
    const benchLine = bench ? `조건을 통과한 종목을 <b>아무거나</b> 샀을 때: 단타 ${pctS(bench.short.avg, 2)} (승률 ${pctP(bench.short.win, 0)}) · 스윙 ${pctS(bench.swing.avg, 2)} (${pctP(bench.swing.win, 0)}) · 장투 ${pctS(bench.long.avg, 2)} (${pctP(bench.long.win, 0)}). <b>'시장대비'</b>는 이 값을 뺀 순수 실력이다.` : '';

    /* --- 책 기반 포트폴리오 --- */
    const fmtPart = (k, v) => {
      if (v == null) return '-';
      if (typeof v !== 'number') return esc(v);
      if (/괴리율|ROE|OP\/A|수익률|변동성/.test(k)) return pctS(v * (Math.abs(v) < 5 ? 1 : 0.01));
      if (/적정주가/.test(k)) return Math.round(v).toLocaleString() + '원';
      if (/부채비율/.test(k)) return v.toFixed(0) + '%';
      return v.toFixed(2);
    };
    const pfCard = (P) => {
      const p = R.pfo?.portfolios?.[P.id];
      if (!p) return '';
      const partKeys = p.list.length ? Object.keys(p.list[0].parts) : [];
      return `<section class="card">
        <h3>${esc(P.name)}<span class="cnt">상위 ${p.list.length}종목</span></h3>
        <p class="origin">${esc(P.author)} · ${esc(P.formula)} · 리밸런싱 ${esc(P.rebalance)} · 후보군 ${p.total}종목${P.small ? ` (소형주 ${p.poolSize}종목 중)` : ''}</p>
        <p class="why">${esc(P.why)}</p>
        <p class="caution">주의 · ${esc(P.caution)}</p>
        <div class="tw"><table>
          <thead><tr><th>#</th><th>종목</th><th class="n">종가</th><th class="n">1일</th><th class="n">시총</th>${partKeys.map((k) => `<th class="n">${esc(k)}</th>`).join('')}${P.id === 'absmom_lv' ? '<th class="n">제안비중</th>' : ''}</tr></thead>
          <tbody>${p.list.map((x, i) => `<tr>
            <td class="mut">${i + 1}</td>
            <td class="nm"><a href="${nlink(x.row.code)}" target="_blank">${esc(x.row.name)}</a><span class="cd">${x.row.code} · ${x.row.market === 'KOSPI' ? '코스피' : '코스닥'}</span></td>
            <td class="n">${x.row.close.toLocaleString()}</td>
            <td class="n ${cls(x.row.ret1)}">${pctS(x.row.ret1)}</td>
            <td class="n">${capS(x.row.capEok)}</td>
            ${partKeys.map((k) => `<td class="n">${fmtPart(k, x.parts[k])}</td>`).join('')}
            ${P.id === 'absmom_lv' ? `<td class="n">${pctP(x.weight, 1)}</td>` : ''}
          </tr>`).join('')}</tbody></table></div>
      </section>`;
    };

    /* --- 팩터 구간 분석 (문병로 방식) --- */
    const decTable = (block, unitNote) => {
      if (!block) return '';
      const ds = block.deciles;
      const max = Math.max(...ds.map((d) => Math.abs(d.avgRet || 0)));
      return `<section class="card">
        <h3>${esc(block.meta.name)}<span class="cnt">${block.fwd}거래일 후</span></h3>
        <p class="origin">${esc(block.meta.note)}${unitNote ? ' · ' + esc(unitNote) : ''}</p>
        <div class="tw"><table class="rank">
          <thead><tr><th>분위</th><th class="n">구간 평균값</th><th class="n">이후 수익률</th><th class="c-opt">막대</th><th class="n">승률</th><th class="n c-opt">표본</th></tr></thead>
          <tbody>${ds.map((d) => `<tr>
            <td><b>${d.d}</b>분위</td>
            <td class="n mut">${d.avgVal == null ? '-' : (Math.abs(d.avgVal) > 1000 ? Math.round(d.avgVal).toLocaleString() : d.avgVal.toFixed(2))}</td>
            <td class="n ${cls(d.avgRet)}"><b>${pctS(d.avgRet)}</b></td>
            <td class="c-opt"><span class="bar" style="width:${max ? Math.round(Math.abs(d.avgRet || 0) / max * 100) : 0}%"></span></td>
            <td class="n">${pctP(d.win, 0)}</td>
            <td class="n mut c-opt">${d.n.toLocaleString()}</td></tr>`).join('')}</tbody></table></div>
      </section>`;
    };

    const pfTab = () => {
      if (!R.pfo) return '<div class="tab" id="tab-book"><p class="none">재무 데이터 수집에 실패해 이번 회차는 비었습니다.</p></div>';
      const hw = R.pfo.halloween;
      const pd = R.DEC?.price, vd = R.DEC?.value;
      return `<div class="tab" id="tab-book">
        <div class="lead"><h2>퀀트 포트폴리오 <small>국내 퀀트 저자들의 공식을 오늘 데이터로 돌린 결과</small></h2></div>
        <section class="card note">
          <p><b>이 탭은 앞의 3개 탭과 성격이 다릅니다.</b> 단타·스윙·장투 탭은 "오늘 이런 신호가 뗄다"는 시그널이고,
          여기는 <b>순위 상위 20~30종목을 한꺼번에 사서 분산 보유하고 정해진 주기마다 교체</b>하는 방식입니다.
          종목 하나하나가 아니라 <b>묶음 전체의 평균</b>으로 수익을 내는 구조라, 몇 종목만 골라 사면 전략이 성립하지 않습니다.</p>
          <p class="hw ${hw.on ? 'on' : 'off'}"><b>${esc(hw.label)}</b> · ${esc(hw.note)}</p>
          <p class="mutp">투자가능 풀 ${R.pfo.pool.toLocaleString()}종목 (시총 300억 이상 · 20일 평균 거래대금 3억 이상 · 부채비율 400% 이하 · 지주사·리츠·우선주·스팩 제외) ·
          소형주 = 시총 하위 20% (${capS(R.pfo.smallCut)} 이하) ${R.pfo.small.toLocaleString()}종목</p>
        </section>
        ${Q.PORTFOLIOS.map(pfCard).join('')}
        <div class="lead"><h2>팩터 구간 분석 <small>문병로 『메트릭 스튜디오』 방식</small></h2></div>
        <section class="card note">
          <p>"PBR이 낮을수록 좋다"는 말을 그대로 믿지 말고, <b>지표를 10등분해서 구간별로 실제 수익률을 직접 확인</b>한 것입니다.
          매년 같은 방향으로 움직이지 않고(비선형), 어느 구간에서만 효과가 나는 경우가 많습니다.</p>
        </section>
        ${pd ? Object.values(pd).map((b) => decTable(b)).join('') : '<p class="none">가격 팩터 분석 데이터 없음 (백테스트 갱신 필요)</p>'}
        ${vd ? Object.values(vd.result || {}).map((b) => decTable(b, `표본 ${(vd.samples || 0).toLocaleString()}건 · 연간보고서 공시 4개월 후 기준으로 재구성`)).join('') : ''}
      </div>`;
    };

    const section = (hk) => {
      const H = HORIZONS[hk];
      const ss = STRATEGIES.filter((S) => S.horizon === hk);
      return `<div class="tab" id="tab-${hk}">
        <div class="lead"><h2>${H.label} <small>${H.desc} 보유 기준</small></h2></div>
        <section class="card top"><h3>오늘의 ${H.label} 후보</h3>${bucketPicks(hk)}</section>
        ${hk === 'short' ? `<div class="cols">
          <section class="card"><h3>급등 TOP</h3>${stockTable(R.gainers)}</section>
          <section class="card"><h3>급락 TOP</h3>${stockTable(R.losers)}</section></div>
          <section class="card"><h3>거래대금 TOP <span class="cnt">돈이 몰린 곳</span></h3>${stockTable(R.byValue)}</section>` : ''}
        <section class="card"><h3>${H.label} 구간 전략 성적표 <span class="cnt">${BT ? BT.period.from.slice(0, 4) + '~' + BT.period.to.slice(0, 4) + ' 백테스트' : ''}</span></h3>
          <p class="bench">${benchLine}</p>${rankTable(hk)}</section>
        ${ss.map(stratCard).join('')}
      </div>`;
    };

    return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#15181d">
<meta name="format-detection" content="telephone=no">
<title>퀀트 브리핑 ${fmtD(R.baseDate)}</title>
<style>
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css');
:root{--up:#e5342a;--dn:#1b6ef3;--bg:#f5f6f8;--card:#fff;--line:#e6e8ee;--tx:#15181d;--mut:#79808d;--acc:#111}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.65 'Pretendard Variable',Pretendard,-apple-system,BlinkMacSystemFont,system-ui,'Malgun Gothic',sans-serif;-webkit-font-smoothing:antialiased;word-break:keep-all}
.wrap{max-width:1200px;margin:0 auto;padding:26px 16px 80px}
header h1{font-size:25px;margin:0 0 3px;letter-spacing:-.6px}
header p{margin:0;color:var(--mut);font-size:12.5px}
h2{font-size:20px;margin:30px 0 12px;letter-spacing:-.4px}
h2 small{font-size:13px;font-weight:400;color:var(--mut);margin-left:6px}
.mgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:9px;margin-bottom:6px}
.mcard{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:10px 12px;display:flex;flex-direction:column;gap:1px}
.mcard .ml{font-size:11.5px;color:var(--mut)}
.mcard .mp{font-size:18px;font-weight:700;letter-spacing:-.4px}
.mcard .mr{font-size:12.5px;font-weight:600}
.mcard.up .mr,.mcard.up .mp{color:var(--up)}.mcard.dn .mr,.mcard.dn .mp{color:var(--dn)}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:16px 16px 8px;margin-bottom:12px}
.card.top{border:2px solid var(--acc)}
.card h3{margin:0 0 4px;font-size:16.5px;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.cnt{font-size:11px;font-weight:500;color:#fff;background:var(--acc);border-radius:20px;padding:2px 9px}
.vd{font-size:11px;font-weight:700;border-radius:5px;padding:2px 7px}
.vd.good{background:#e2f6e8;color:#137a37}.vd.mid{background:#f0f1f4;color:#5c626e}.vd.bad{background:#fdeaea;color:#c22}
.origin{margin:0 0 9px;font-size:11.5px;color:var(--mut)}
.badges{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px}
.badge{border:1px solid var(--line);border-radius:9px;padding:7px 10px;font-size:11.5px;display:flex;flex-direction:column;gap:1px;min-width:132px;background:#fbfcfd}
.badge b{font-size:12px}
.badge .edge{font-weight:700}
.badge.pos .edge{color:#137a37}.badge.neg .edge{color:#c22}
.badge.pri{border-color:var(--acc);border-width:2px;background:#fff}
.badge i{color:var(--mut);font-style:normal;font-size:10.5px}
.why{margin:0 0 6px;font-size:13.5px;background:#eef3ff;border-radius:8px;padding:9px 11px}
.caution{margin:0 0 6px;font-size:12.5px;color:#8c5200;background:#fff5e3;border-radius:8px;padding:8px 11px}
.risk{margin:0 0 10px;font-size:12.5px;background:#f3f4f7;border-radius:8px;padding:8px 11px;color:#3a3f49}
.bench{margin:0 0 10px;font-size:12.5px;color:#3a3f49;background:#f3f4f7;border-radius:8px;padding:8px 11px}
.tw{overflow-x:auto;min-width:0;max-width:100%}
table{width:100%;border-collapse:collapse;font-size:13.5px;margin-bottom:8px}
th{text-align:left;font-size:11px;color:var(--mut);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 8px;border-bottom:1px solid #f2f3f6;white-space:nowrap}
tbody tr:hover{background:#fafbfd}
tr.dim{opacity:.45}
table.rank td,table.rank th{font-size:12.5px}
table.mini{font-size:12px;margin-top:8px}
.n{text-align:right}.up{color:var(--up)}.dn{color:var(--dn)}.mut{color:var(--mut);font-size:11px}
.nm a{color:inherit;text-decoration:none;font-weight:600}
.nm a:hover{text-decoration:underline}
.cd{display:block;font-size:10.5px;color:var(--mut);font-weight:400}
.past{font-size:11.5px;border-radius:5px;padding:2px 7px;white-space:nowrap}
.past.good{background:#e2f6e8;color:#137a37}.past.ok{background:#f0f1f4;color:#4b5158}.past.bad{background:#fdeaea;color:#c22}
.picks{display:grid;grid-template-columns:1fr;gap:9px;margin-bottom:8px}
@media(min-width:820px){.picks{grid-template-columns:1fr 1fr}}
.pick{border:1px solid var(--line);border-radius:11px;padding:11px 13px;background:#fcfcfd;min-width:0}
.picks>*,.cols>*{min-width:0}
.pick.mine{border-color:var(--acc)}
.ph{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.ph a{font-size:16px;font-weight:700;color:inherit;text-decoration:none}
.ph a:hover{text-decoration:underline}
.ph .cd{display:inline;font-size:11px}
.ph .pr{margin-left:auto;font-size:13.5px;font-weight:600}
.sigs{margin:7px 0 5px;display:flex;flex-wrap:wrap;gap:4px}
.chip{display:inline-block;font-size:11px;background:#e9edf5;border-radius:6px;padding:3px 8px}
.chip i{font-style:normal;color:#5b6270}
.chip.w{background:#f4f5f7;color:var(--mut)}
.meta{font-size:11.5px;color:#4b5158}
.nw{margin-top:6px;font-size:12px;white-space:normal;border-top:1px dashed var(--line);padding-top:6px}
.nw a{color:#1b4fd0;text-decoration:none}.nw a:hover{text-decoration:underline}
.nw i{color:var(--mut);font-style:normal;font-size:11px}
.none{color:var(--mut);font-size:13px;padding:4px 0 12px}
.cols{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:1100px){.cols{grid-template-columns:1fr 1fr}}
.tabs{display:flex;gap:6px;position:sticky;top:0;background:var(--bg);padding:10px 0;z-index:10;border-bottom:1px solid var(--line)}
.tabs label{flex:1;text-align:center;padding:11px 8px;border:1px solid var(--line);background:var(--card);border-radius:10px;cursor:pointer;font-weight:700;font-size:14.5px;letter-spacing:-.3px}
.tabs label small{display:block;font-weight:400;font-size:11px;color:var(--mut)}
input[name=tb]{display:none}
.tab{display:none}
#t-short:checked~.body #tab-short,#t-swing:checked~.body #tab-swing,#t-long:checked~.body #tab-long,#t-book:checked~.body #tab-book{display:block}
#t-short:checked~.tabs label[for=t-short],#t-swing:checked~.tabs label[for=t-swing],#t-long:checked~.tabs label[for=t-long],#t-book:checked~.tabs label[for=t-book]{background:var(--acc);color:#fff;border-color:var(--acc)}
#t-short:checked~.tabs label[for=t-short] small,#t-swing:checked~.tabs label[for=t-swing] small,#t-long:checked~.tabs label[for=t-long] small,#t-book:checked~.tabs label[for=t-book] small{color:#c9ced8}
.card.note p{margin:0 0 8px;font-size:13px;line-height:1.7}
.card.note{background:#fbfcfe}
.hw{border-radius:8px;padding:9px 11px;font-size:12.5px}
.hw.on{background:#e7f6ec;color:#12662f}.hw.off{background:#fdf0ec;color:#a0400f}
.mutp{color:var(--mut);font-size:11.5px}
.bar{display:inline-block;height:9px;background:#2b6cf6;border-radius:3px;min-width:2px;vertical-align:middle}
.lead h2{margin-top:26px}
footer{margin-top:36px;font-size:11.5px;color:var(--mut);line-height:1.8;border-top:1px solid var(--line);padding-top:14px}

/* ---------------- 모바일 ---------------- */
@media(max-width:680px){
  body{font-size:14px}
  .wrap{padding:14px 10px 60px}
  header h1{font-size:21px}
  header p{font-size:11px;line-height:1.55}
  h2{font-size:17px;margin:22px 0 10px}
  h2 small{display:block;margin:2px 0 0 0;font-size:11.5px}
  .c-opt{display:none}
  .mgrid{grid-template-columns:repeat(2,1fr);gap:7px}
  .mcard{padding:9px 10px;border-radius:10px}
  .mcard .mp{font-size:16px}
  .mcard .ml{font-size:11px}
  .mcard .mr{font-size:12px}
  .tabs{flex-wrap:wrap;gap:5px;padding:8px 0}
  .tabs label{flex:1 1 calc(50% - 3px);padding:8px 4px;font-size:13px;border-radius:9px}
  .tabs label small{font-size:10px;margin-top:1px}
  .card{padding:13px 12px 6px;border-radius:11px;margin-bottom:10px}
  .card h3{font-size:15.5px;gap:5px}
  .cnt{font-size:10.5px;padding:2px 7px}
  .why,.caution,.risk,.bench{font-size:12.5px;padding:8px 10px}
  .origin{font-size:11px}
  .badges{gap:5px}
  .badge{flex:1 1 calc(50% - 3px);min-width:0;padding:6px 8px;font-size:11px}
  .badge b{font-size:11.5px}
  table{font-size:12.5px}
  th{font-size:10.5px;padding:5px 5px}
  td{padding:6px 5px}
  .cd{font-size:10px}
  .nm a{font-size:13px}
  .past{font-size:10.5px;padding:2px 5px}
  .pick{padding:10px 11px}
  .ph a{font-size:15px}
  .ph .pr{margin-left:0;width:100%;font-size:13px}
  .meta{font-size:11px;line-height:1.55}
  .chip{font-size:10.5px;padding:2px 6px}
  .chip i{display:none}
  .nw{font-size:11.5px}
  .card.note p{font-size:12.5px}
  footer{font-size:11px}
}
@media(max-width:400px){
  .tabs label{font-size:12px}
  table{font-size:12px}
}
</style></head><body><div class="wrap">
<header>
  <h1>퀀트 브리핑</h1>
  <p>${fmtD(R.baseDate)} 장 마감 기준 · 분석 ${R.analyzed.toLocaleString()}종목 / 상장 ${R.universeCount.toLocaleString()}종목 · 백테스트 ${BT ? `${fmtD(BT.period.from)}~${fmtD(BT.period.to)} · ${BT.stockDays.toLocaleString()} 종목-일` : '없음'} · 생성 ${new Date(R.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</p>
</header>

<h2>시장 온도계</h2>
<div class="mgrid">${mk}</div>
${mineBlock}

<input type="radio" name="tb" id="t-short"><input type="radio" name="tb" id="t-swing" checked><input type="radio" name="tb" id="t-long"><input type="radio" name="tb" id="t-book">
<div class="tabs">
  <label for="t-short">단타<small>1~3거래일</small></label>
  <label for="t-swing">스윙<small>약 1개월</small></label>
  <label for="t-long">장투<small>약 6개월</small></label>
  <label for="t-book">퀀트 포트폴리오<small>책 기반 · 분기 리밸런싱</small></label>
</div>
<div class="body">${HK.map(section).join('')}${pfTab()}</div>

<footer>
<b>읽는 법</b> · <b>승률</b>은 보유기간 후 플러스로 끝난 비율, <b>시장대비</b>는 같은 필터를 통과한 종목을 무작위로 샀을 때보다 얼마나 더 벌었는지(이게 진짜 실력), <b>목표달성률</b>은 단타 +3% / 스윙 +8% / 장투 +20%를 넘긴 비율, <b>MFE/MAE</b>는 보유 중 최대로 올랐던 폭 / 빠졌던 폭의 중앙값이다.<br>
백테스트 조건 · 시가총액 1,000억원 이상, 20일 평균 거래대금 5억원 이상, 우선주·스팩·ETF/ETN 제외. 수수료·세금·슬리피지 미반영. 현재 상장된 종목만 대상이라 상장폐지 종목이 빠진 생존편향이 있다.<br>
데이터 출처 네이버 금융. 본 리포트는 기계적으로 계산된 통계이며 투자 권유가 아닙니다. 모든 판단과 책임은 본인에게 있습니다.
</footer>
</div></body></html>`;
  }

  /* ---------------------------------------------------------------- *
   * 시그널 아카이브
   * ---------------------------------------------------------------- */
  async function saveSnapshot(R, dir = ARCHIVE) {
    const F = _fs(), P = _path();
    await F.mkdir(P.join(dir, 'signals'), { recursive: true });
    const snap = {
      date: R.baseDate, generatedAt: R.generatedAt,
      market: R.market.map((m) => ({ label: m.label, price: m.price, rate: m.rate })),
      bucket: Object.fromEntries(HK.map((hk) => [hk, R.bucket[hk].map((b) => ({ code: b.row.code, name: b.row.name, close: b.row.close, sigs: b.sigs.map((s) => s.id) }))])),
      strat: Object.fromEntries(Object.entries(R.strat).map(([id, s]) => [id, s.list.map((r) => ({ code: r.code, name: r.name, close: r.close }))])),
      gainers: R.gainers.map((r) => ({ code: r.code, name: r.name, close: r.close, ret1: +r.ret1.toFixed(4) })),
    };
    const p = P.join(dir, 'signals', `${R.baseDate}.json`);
    await F.writeFile(p, JSON.stringify(snap), 'utf8');
    return p;
  }

  /** 어제 픽이 오늘 어떻게 됐는지 */
  async function followUp(R, dir = ARCHIVE) {
    const F = _fs(), P = _path();
    let files = [];
    try { files = (await F.readdir(P.join(dir, 'signals'))).filter((f) => f.endsWith('.json')).sort(); } catch { return null; }
    const prev = files.filter((f) => f.slice(0, 8) < R.baseDate).pop();
    if (!prev) return null;
    const snap = JSON.parse(await F.readFile(P.join(dir, 'signals', prev), 'utf8'));
    const byCode = new Map(R.rows.map((r) => [r.code, r]));
    const out = {};
    for (const hk of HK) {
      out[hk] = (snap.bucket?.[hk] || []).map((b) => {
        const now = byCode.get(b.code);
        return { code: b.code, name: b.name, then: b.close, now: now?.close ?? null, ret: now ? now.close / b.close - 1 : null };
      });
    }
    return { date: snap.date, picks: out };
  }

  return { run, renderHTML, saveSnapshot, followUp, ARCHIVE, helpers: { pctS, pctP, won, capS, fmtD, nlink } };
})
