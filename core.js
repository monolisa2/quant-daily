/**
 * quant-daily / core.js
 * 데이터 수집 + 지표 시계열 계산 + 전략 정의 + 백테스트
 * REPL에서 eval(src) 하면 객체 반환. 외부 의존성 없음.
 */
(() => {
  const UA = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
  };
  const M = 'https://m.stock.naver.com';
  const API = 'https://api.stock.naver.com';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const num = (v) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,%+\s]/g, '')) || 0);

  async function getJSON(url, referer = M + '/', tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, { headers: { ...UA, Referer: referer } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } catch (e) { if (i === tries - 1) return null; await sleep(250 * (i + 1)); }
    }
    return null;
  }
  async function getText(url, referer = 'https://finance.naver.com/', tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(url, { headers: { ...UA, Referer: referer } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
      } catch (e) { if (i === tries - 1) return null; await sleep(250 * (i + 1)); }
    }
    return null;
  }

  /* ================================================================ *
   * 1. 수집
   * ================================================================ */
  const EXCLUDE_NAME = /(스팩|제\d+호|리츠)/;
  // 우선주: 끝이 '우', '우B/C', '2우(전환)', '3우B' 등
  const PREF = /(\d?우[A-C]?(\(전환\))?)$/;

  async function fetchUniverse() {
    const out = [];
    for (const sosok of [0, 1]) {
      const r = await getJSON(`${M}/api/json/sise/siseListJson.nhn?menu=market_sum&sosok=${sosok}&pageSize=2500&page=1`);
      for (const x of (r?.result?.itemList || [])) {
        if (x.etf || x.etn) continue;
        if (EXCLUDE_NAME.test(x.nm) || PREF.test(x.nm)) continue;
        out.push({
          code: x.cd, name: x.nm, market: sosok === 0 ? 'KOSPI' : 'KOSDAQ',
          price: num(x.nv), prevClose: num(x.pcv), chgPct: num(x.cr),
          capEok: num(x.mks), volume: num(x.aq), tradeVal: num(x.aq) * num(x.nv),
        });
      }
    }
    return out;
  }

  const BAR_RE = /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*(\d+),\s*([\d.-]+)\]/g;

  /** 컬럼형 일봉: {d:[], o:[], h:[], l:[], c:[], v:[], f:[]} */
  async function fetchBars(code, days = 400) {
    const end = new Date();
    const start = new Date(end.getTime() - days * 86400000 * 1.5);
    const f = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const t = await getText(`https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${f(start)}&endTime=${f(end)}&timeframe=day`);
    const C = { d: [], o: [], h: [], l: [], c: [], v: [], f: [] };
    if (!t) return C;
    let m; BAR_RE.lastIndex = 0;
    while ((m = BAR_RE.exec(t))) {
      C.d.push(m[1]); C.o.push(+m[2]); C.h.push(+m[3]); C.l.push(+m[4]);
      C.c.push(+m[5]); C.v.push(+m[6]); C.f.push(+m[7]);
    }
    return C;
  }

  async function fetchBarsBulk(codes, { concurrency = 24, days = 400, onProgress } = {}) {
    const res = new Map();
    let done = 0;
    for (let i = 0; i < codes.length; i += concurrency) {
      const chunk = codes.slice(i, i + concurrency);
      const got = await Promise.all(chunk.map((c) => fetchBars(c, days).catch(() => ({ d: [] }))));
      chunk.forEach((c, k) => res.set(c, got[k]));
      done += chunk.length;
      if (onProgress && done % (concurrency * 10) === 0) onProgress(done, codes.length);
    }
    return res;
  }

  /* ================================================================ *
   * 2. 롤링 지표 (배열 단위)
   * ================================================================ */
  function rollMean(a, n) {
    const out = new Array(a.length).fill(null);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      s += a[i];
      if (i >= n) s -= a[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  function rollExtreme(a, n, isMax) {
    const out = new Array(a.length).fill(null);
    const dq = [];
    for (let i = 0; i < a.length; i++) {
      while (dq.length && (isMax ? a[dq[dq.length - 1]] <= a[i] : a[dq[dq.length - 1]] >= a[i])) dq.pop();
      dq.push(i);
      while (dq[0] <= i - n) dq.shift();
      if (i >= n - 1) out[i] = a[dq[0]];
    }
    return out;
  }
  const rollMax = (a, n) => rollExtreme(a, n, true);
  const rollMin = (a, n) => rollExtreme(a, n, false);

  /** RSI(n) — 단순 평균 방식 */
  function rsiArr(c, n = 14) {
    const g = new Array(c.length).fill(0), l = new Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g[i] = d > 0 ? d : 0; l[i] = d < 0 ? -d : 0;
    }
    const mg = rollMean(g, n), ml = rollMean(l, n);
    return c.map((_, i) => {
      if (mg[i] == null) return null;
      if (ml[i] === 0) return 100;
      return 100 - 100 / (1 + mg[i] / ml[i]);
    });
  }

  /** 연율 변동성 (n일 일간수익률 표준편차 × √252) */
  function volaArr(c, n = 20) {
    const r = new Array(c.length).fill(0);
    for (let i = 1; i < c.length; i++) r[i] = c[i] / c[i - 1] - 1;
    const m = rollMean(r, n);
    const sq = r.map((x) => x * x);
    const m2 = rollMean(sq, n);
    return c.map((_, i) => (m[i] == null ? null : Math.sqrt(Math.max(0, m2[i] - m[i] * m[i])) * Math.sqrt(252)));
  }

  /**
   * 종목 1개의 전체 지표 시계열.
   * @returns { cols, n, at(i) -> row }
   */
  function buildSeries(stock, C) {
    const { c, h, l, v, o, d, f } = C;
    const n = c.length;
    if (n < 30) return null;

    const ma5 = rollMean(c, 5), ma20 = rollMean(c, 20), ma60 = rollMean(c, 60), ma120 = rollMean(c, 120);
    const hi250 = rollMax(h, 250), lo250 = rollMin(l, 250);
    const cHi250 = rollMax(c, 250), cLo250 = rollMin(c, 250);
    const vMean20 = rollMean(v, 20);
    const val = c.map((x, i) => x * v[i]);
    const valMean20 = rollMean(val, 20);
    const rsi = rsiArr(c, 14);
    const vola = volaArr(c, 20);
    const volaMin = rollMin(vola.map((x) => (x == null ? 9e9 : x)), 60);
    const lastClose = c[n - 1];
    const capToday = stock.capEok || 0;

    const retAt = (i, k) => (i - k >= 0 && c[i - k] > 0 ? c[i] / c[i - k] - 1 : null);

    function at(i) {
      if (i < 1 || i >= n) return null;
      const rng = h[i] - l[i];
      return {
        code: stock.code, name: stock.name, market: stock.market,
        idx: i, date: d[i], close: c[i], open: o[i], high: h[i], low: l[i], volume: v[i],
        ret1: retAt(i, 1), ret2: retAt(i, 2), ret3: retAt(i, 3), ret5: retAt(i, 5),
        ret10: retAt(i, 10), ret20: retAt(i, 20), ret60: retAt(i, 60),
        ret120: retAt(i, 120), ret240: retAt(i, 240),
        mom12_1: i >= 241 && c[i - 241] > 0 ? c[i - 21] / c[i - 241] - 1 : null,
        ma5: ma5[i], ma20: ma20[i], ma60: ma60[i], ma120: ma120[i],
        aboveMa20: ma20[i] != null ? c[i] > ma20[i] : null,
        aboveMa60: ma60[i] != null ? c[i] > ma60[i] : null,
        aboveMa120: ma120[i] != null ? c[i] > ma120[i] : null,
        goldenCross: ma20[i] != null && ma60[i] != null && ma20[i - 1] != null && ma60[i - 1] != null
          ? ma20[i - 1] <= ma60[i - 1] && ma20[i] > ma60[i] : false,
        deadCross: ma20[i] != null && ma60[i] != null && ma20[i - 1] != null && ma60[i - 1] != null
          ? ma20[i - 1] >= ma60[i - 1] && ma20[i] < ma60[i] : false,
        w52h: hi250[i], w52l: lo250[i],
        fromHigh: hi250[i] ? c[i] / hi250[i] - 1 : null,
        fromLow: lo250[i] ? c[i] / lo250[i] - 1 : null,
        newHigh: cHi250[i - 1] != null ? c[i] >= cHi250[i - 1] : false,
        newLow: cLo250[i - 1] != null ? c[i] <= cLo250[i - 1] : false,
        nearHigh: hi250[i] ? c[i] >= hi250[i] * 0.97 : false,
        rsi14: rsi[i], rsiPrev: rsi[i - 1],
        volRatio: vMean20[i - 1] > 0 ? v[i] / vMean20[i - 1] : null,
        avgVal20: valMean20[i] || 0,
        tradeVal: val[i],
        vola20: vola[i],
        volaSqueeze: vola[i] != null && volaMin[i] < 9e8 ? vola[i] <= volaMin[i] * 1.15 : false,
        closeStrength: rng > 0 ? (c[i] - l[i]) / rng : 0.5,
        frgnRatio: f[i], frgnChg5: i >= 5 ? f[i] - f[i - 5] : null,
        frgnChg20: i >= 20 ? f[i] - f[i - 20] : null,
        capEok: lastClose > 0 ? capToday * (c[i] / lastClose) : capToday,
      };
    }
    return { cols: C, n, at, lastIdx: n - 1 };
  }

  /* ================================================================ *
   * 3. 전략 정의 — 단타(short) / 스윙(swing) / 장투(long)
   * ================================================================ */
  const HORIZONS = {
    short: { key: 'short', days: 3, label: '단타', desc: '1~3거래일', target: 0.03 },
    swing: { key: 'swing', days: 20, label: '스윙', desc: '약 1개월', target: 0.08 },
    long: { key: 'long', days: 120, label: '장투', desc: '약 6개월', target: 0.20 },
  };

  const STRATEGIES = [
    /* ---------------- 단타 ---------------- */
    {
      id: 'volspike', horizon: 'short', name: '거래량 폭증 + 상승',
      origin: '이벤트 드리븐 (뉴스·실적·수주 선반영)',
      why: '거래량이 평소 3배 이상 터지며 오르면 새로운 정보가 들어온 것. 왜 터졌는지 찾아볼 가치가 있다.',
      caution: '테마성 1일 급등이면 다음 날 거래량이 죽는다. 뉴스 확인 필수.',
      pick: (r) => r.volRatio > 3 && r.ret1 > 0.05,
      score: (r) => r.volRatio * 10 + r.ret1 * 100,
    },
    {
      id: 'surge_strong', horizon: 'short', name: '급등 + 종가 강세',
      origin: '단기 모멘텀 / 시가 갭 추종',
      why: '8% 이상 오르면서 종가가 당일 고가 근처에서 끝난 종목. 장 막판까지 매수세가 살아있었다는 뜻이라 다음 날로 이어지는 경우가 많다.',
      caution: '이미 오른 자리에서 들어가는 것. 다음 날 시가에 갭으로 뜨면 오히려 손해 구간.',
      pick: (r) => r.ret1 >= 0.08 && r.ret1 < 0.25 && r.volRatio > 2 && r.closeStrength >= 0.75,
      score: (r) => r.closeStrength * 50 + r.volRatio * 5,
    },
    {
      id: 'limitup', horizon: 'short', name: '상한가 근접',
      origin: '상한가 따라잡기 (한국 시장 고유)',
      why: '가격제한폭(+30%) 근처까지 간 종목. 다음 날 시초가 갭과 추가 상승 가능성을 본다.',
      caution: '가장 변동성 큰 자리. 다음 날 하한가도 가능. 절대 큰 금액 넣지 말 것.',
      pick: (r) => r.ret1 >= 0.22,
      score: (r) => r.ret1 * 100 + (r.volRatio || 0),
    },
    {
      id: 'oversold', horizon: 'short', name: '과매도 반등 (RSI)',
      origin: '웰스 와일더 RSI / 평균회귀',
      why: '단기 과매도(RSI 32 이하)에서 벗어나는 구간. 장기 추세가 살아있는 종목일수록 반등 확률이 높다.',
      caution: '하락 추세 한복판이면 떨어지는 칼날. 120일선 필터를 꼭 같이 본다.',
      pick: (r) => r.rsiPrev != null && r.rsiPrev < 32 && r.rsi14 > r.rsiPrev && r.ma120 && r.close > r.ma120 * 0.85,
      score: (r) => -(r.rsi14 || 50),
    },
    /* ---------------- 스윙 ---------------- */
    {
      id: 'newhigh', horizon: 'swing', name: '52주 신고가 돌파',
      origin: '윌리엄 오닐 CAN SLIM / 마크 미너비니',
      why: '1년 중 최고 종가를 넘었다는 건 물려 있는 사람이 없다는 뜻. 위로 막는 매물이 없어 추세가 이어지기 쉽다.',
      caution: '꼭지에 물리면 낙폭이 크다. 손절선을 반드시 정하고 들어간다.',
      pick: (r) => r.newHigh && r.volRatio > 1.0 && r.ret20 > 0,
      score: (r) => (r.ret60 || 0) * 100 + (r.volRatio || 0) * 5,
    },
    {
      id: 'golden', horizon: 'swing', name: '골든크로스 (20일선 > 60일선)',
      origin: '고전 추세 전환 시그널',
      why: '단기 평균단가가 중기 평균단가를 위로 뚫음. 수급 주도권이 매수 쪽으로 넘어갔다고 본다.',
      caution: '후행 지표라 늦다. 횡보장에서는 속임수(휩쏘)가 잦다.',
      pick: (r) => r.goldenCross && r.avgVal20 > 0,
      score: (r) => (r.volRatio || 0) * 10 + (r.ret20 || 0) * 100,
    },
    {
      id: 'pullback', horizon: 'swing', name: '상승추세 눌림목',
      origin: '추세추종 진입 타이밍의 정석',
      why: '장기추세(120일선 위)는 살아있는데 단기적으로 20일선까지 밀린 자리. 좋은 종목을 덜 비싸게 사는 접근.',
      caution: '눌림이 아니라 추세 붕괴의 시작일 수 있다. 20일선 회복 못 하면 손절.',
      pick: (r) => r.ma20 && r.ma120 && r.close > r.ma120 && r.ret240 > 0.15 &&
                   r.close >= r.ma20 * 0.96 && r.close <= r.ma20 * 1.03 && r.ret5 < 0,
      score: (r) => (r.ret240 || 0) * 100,
    },
    {
      id: 'squeeze', horizon: 'swing', name: '변동성 수축 후 돌파',
      origin: '볼린저 스퀴즈 / 마크 미너비니 VCP',
      why: '오랫동안 조용히 횡보하며 변동성이 바닥까지 줄어든 뒤 거래량 터지며 위로 뚫는 자리. 에너지 응축 후 분출 패턴.',
      caution: '아래로 뚫는 경우도 절반이다. 반드시 위로 뚫은 걸 확인하고 들어간다.',
      pick: (r) => r.volaSqueeze && r.ret1 > 0.03 && r.volRatio > 2 && r.ma60 && r.close > r.ma60,
      score: (r) => (r.volRatio || 0) * 10,
    },
    {
      id: 'deepvalue', horizon: 'swing', name: '낙폭과대 턴어라운드',
      origin: '컨트래리안 / 평균회귀',
      why: '52주 고점 대비 -40% 이상 빠진 뒤 바닥 다지고 20일선을 회복하기 시작한 종목.',
      caution: '가장 위험한 전략. 진짜 망해가는 회사일 수 있으니 재무·악재 뉴스 필수 확인.',
      pick: (r) => r.fromHigh != null && r.fromHigh < -0.4 && r.ret20 > 0.08 && r.ret5 > 0 &&
                   r.ma20 && r.close > r.ma20 && r.ma60 && r.ma20 > r.ma60 * 0.98 && r.capEok > 3000,
      score: (r) => (r.ret20 || 0) * 100,
    },
    /* ---------------- 장투 ---------------- */
    {
      id: 'momentum', horizon: 'long', name: '12-1 모멘텀',
      origin: 'Jegadeesh & Titman (1993) / 게리 안토나치 듀얼모멘텀',
      why: '최근 1개월을 뺀 1년 수익률이 높은 종목이 이후에도 잘 가는 경향. 가장 오래 검증된 팩터.',
      caution: '시장이 꺾이는 전환기에 가장 크게 깨진다.',
      pick: (r) => r.mom12_1 != null && r.mom12_1 > 0.3 && r.ma120 && r.close > r.ma120,
      score: (r) => (r.mom12_1 || 0) * 100,
    },
    {
      id: 'steady', horizon: 'long', name: '꾸준한 우상향',
      origin: '추세 지속성 + 저변동 결합',
      why: '1년·6개월·3개월 수익률이 모두 플러스이면서 변동성이 과하지 않은 종목. 마음 편하게 들고 가기 좋은 유형.',
      caution: '이미 비싸 보일 수 있다. 분할 매수로 접근하는 게 안전.',
      pick: (r) => r.ret240 > 0.15 && r.ret120 > 0.05 && r.ret60 > 0 && r.vola20 != null && r.vola20 < 0.45 &&
                   r.ma120 && r.close > r.ma120 && r.capEok > 3000,
      score: (r) => (r.ret240 || 0) / Math.max(0.1, r.vola20),
    },
    {
      id: 'lowvol', horizon: 'long', name: '저변동 우량',
      origin: '저변동성 이상현상 (Low-Volatility Anomaly)',
      why: '변동성이 낮은 종목이 오히려 위험 대비 수익이 좋다는, 교과서를 뒤집은 유명한 팩터. 연기금이 쓴다.',
      caution: '느리다. 짧게 먹고 나오려는 사람에겐 지루하다.',
      pick: (r) => r.vola20 != null && r.vola20 < 0.25 && r.ret120 > 0.05 && r.capEok > 5000,
      score: (r) => (r.ret120 || 0) / Math.max(0.05, r.vola20),
    },
    {
      id: 'frgn', horizon: 'long', name: '외국인 지분율 급증',
      origin: '스마트머니 추종',
      why: '최근 5거래일 외국인 보유 비중이 뚜렷하게 늘어난 종목. 외국인·기관은 정보와 자금력이 개인보다 앞선다고 본다.',
      caution: '지수 편입, 블록딜 같은 기계적 이유로도 움직인다.',
      pick: (r) => r.frgnChg5 != null && r.frgnChg5 >= 0.4 && r.ma60 && r.close > r.ma60 && r.capEok > 2000,
      score: (r) => r.frgnChg5 || 0,
    },
  ];
  const STRAT_BY_ID = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

  /* ================================================================ *
   * 4. 백테스트
   * ================================================================ */
  function statsOf(arr) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    return {
      n: arr.length,
      avg,
      med: q(0.5),
      win: arr.filter((x) => x > 0).length / arr.length,
      p25: q(0.25),
      p75: q(0.75),
      worst: s[0],
      best: s[s.length - 1],
    };
  }

  const HK = ['short', 'swing', 'long'];

  /** 미래 구간 최고가/최저가 사전계산: fwdMax[i] = max(h[i+1..i+hd]) */
  function fwdExtremes(a, hd, isMax) {
    const rev = a.slice().reverse();
    const rolled = rollExtreme(rev, hd, isMax); // rolled[j] = extreme of rev[j-hd+1..j]
    const out = new Array(a.length).fill(null);
    for (let i = 0; i < a.length; i++) {
      const j = a.length - 1 - (i + 1);          // rev index of a[i+1]
      const jj = j;                              // 창: rev[jj-hd+1..jj] == a[i+1..i+hd]
      out[i] = jj >= hd - 1 ? rolled[jj] : null;
    }
    return out;
  }

  /** 누적기 생성 (청크 단위로 feed 가능) */
  function createAcc() {
    const acc = { strat: {}, base: { short: [], swing: [], long: [] }, per: {},
                  usedStocks: 0, signalDays: 0, firstDate: '99999999', lastDate: '0' };
    for (const S of STRATEGIES) {
      acc.strat[S.id] = {};
      for (const k of HK) acc.strat[S.id][k] = { ret: [], mfe: [], mae: [], tgt: 0 };
    }
    return acc;
  }

  /** 청크 투입 */
  function feedAcc(acc, stocks, bulk, opts = {}) {
    const { minAvgValEok = 5, warmup = 250 } = opts;
    const HD = HK.map((k) => HORIZONS[k].days);
    const maxH = Math.max(...HD);

    for (const st of stocks) {
      const C = bulk.get(st.code);
      if (!C || !C.c || C.c.length < warmup + maxH + 10) continue;
      const S = buildSeries(st, C);
      if (!S) continue;
      acc.usedStocks++;
      const { c, h, l } = C;
      const n = c.length;
      const end = n - maxH - 1;
      const fMax = HD.map((hd) => fwdExtremes(h, hd, true));
      const fMin = HD.map((hd) => fwdExtremes(l, hd, false));

      for (let i = warmup; i <= end; i++) {
        const r = S.at(i);
        if (!r || !r.avgVal20 || r.avgVal20 < minAvgValEok * 1e8) continue;
        if (r.capEok < 500) continue;
        acc.signalDays++;
        if (r.date < acc.firstDate) acc.firstDate = r.date;
        if (r.date > acc.lastDate) acc.lastDate = r.date;
        const base0 = c[i];
        for (let k = 0; k < 3; k++) {
          const fwd = c[i + HD[k]] / base0 - 1;
          if (isFinite(fwd)) acc.base[HK[k]].push(fwd);
        }
        for (const ST of STRATEGIES) {
          let hit = false;
          try { hit = !!ST.pick(r); } catch { hit = false; }
          if (!hit) continue;
          for (let k = 0; k < 3; k++) {
            const hk = HK[k], hd = HD[k];
            const fwd = c[i + hd] / base0 - 1;
            if (!isFinite(fwd)) continue;
            const A = acc.strat[ST.id][hk];
            A.ret.push(fwd);
            if (fMax[k][i] != null) A.mfe.push(fMax[k][i] / base0 - 1);
            if (fMin[k][i] != null) A.mae.push(fMin[k][i] / base0 - 1);
            if (fwd >= HORIZONS[hk].target) A.tgt++;
            const P = (acc.per[st.code] = acc.per[st.code] || {});
            const PS = (P[ST.id] = P[ST.id] || { short: [], swing: [], long: [] });
            PS[hk].push(fwd);
          }
        }
      }
    }
    return acc;
  }

  /** 누적기 -> 최종 리포트 */
  function finalizeAcc(acc) {
    const benchmark = {};
    for (const hk of HK) benchmark[hk] = statsOf(acc.base[hk]);

    const strat = {};
    for (const ST of STRATEGIES) {
      strat[ST.id] = { id: ST.id, name: ST.name, horizon: ST.horizon, h: {} };
      for (const hk of HK) {
        const A = acc.strat[ST.id][hk];
        const s = statsOf(A.ret);
        if (!s) { strat[ST.id].h[hk] = null; continue; }
        strat[ST.id].h[hk] = {
          n: s.n, avg: s.avg, med: s.med, win: s.win, p25: s.p25, p75: s.p75, worst: s.worst, best: s.best,
          hitTarget: A.ret.length ? A.tgt / A.ret.length : null,
          mfe: statsOf(A.mfe)?.med ?? null,
          mae: statsOf(A.mae)?.med ?? null,
          edge: s.avg - (benchmark[hk]?.avg ?? 0),
          winEdge: s.win - (benchmark[hk]?.win ?? 0),
        };
      }
    }

    const perStock = {};
    for (const [code, m] of Object.entries(acc.per)) {
      const o = {};
      for (const [sid, hs] of Object.entries(m)) {
        if (hs.short.length < 3) continue;
        const c3 = {};
        for (const hk of HK) {
          const s = statsOf(hs[hk]);
          if (s) c3[hk] = { avg: +s.avg.toFixed(4), win: +s.win.toFixed(3) };
        }
        o[sid] = { n: hs.short.length, ...c3 };
      }
      if (Object.keys(o).length) perStock[code] = o;
    }

    return {
      generatedAt: new Date().toISOString(),
      period: { from: acc.firstDate, to: acc.lastDate },
      stocks: acc.usedStocks, stockDays: acc.signalDays,
      horizons: HORIZONS, strat, benchmark, perStock,
    };
  }

  /** 한 번에 실행 (소규모용) */
  function backtest(stocks, bulk, opts = {}) {
    const acc = createAcc();
    feedAcc(acc, stocks, bulk, opts);
    return finalizeAcc(acc);
  }

  /* ---------------------------------------------------------------- *
   * 팩터 구간(10분위) 분석 — 문병로 『메트릭 스튜디오』 방법론
   * "PER이 낮을수록 좋다"가 아니라 "구간별로 이렇게 비선형이다"를 본다.
   * ---------------------------------------------------------------- */
  const PRICE_FACTORS = [
    { id: 'cap', name: '시가총액', get: (r) => r.capEok, asc: true, fmt: 'cap',
      note: '1분위 = 가장 작은 회사. 소형주 효과 확인용' },
    { id: 'mom', name: '12-1 모멘텀', get: (r) => r.mom12_1, asc: true, fmt: 'pct',
      note: '1분위 = 가장 많이 하락. 10분위 = 가장 많이 상승' },
    { id: 'vola', name: '변동성(20일)', get: (r) => r.vola20, asc: true, fmt: 'pct',
      note: '1분위 = 가장 안 흔들림' },
    { id: 'fromHigh', name: '52주 고점 대비', get: (r) => r.fromHigh, asc: true, fmt: 'pct',
      note: '1분위 = 고점에서 가장 많이 빠짐' },
    { id: 'rsi', name: 'RSI(14)', get: (r) => r.rsi14, asc: true, fmt: 'num',
      note: '1분위 = 가장 과매도' },
  ];

  /** 패널 샘플링(20거래일마다). 청크로 나눠 모을 수 있도록 분리. */
  function pricePanel(stocks, bulk, opts = {}) {
    const { minAvgValEok = 5, warmup = 250, step = 20, fwd = 120 } = opts;
    const panel = [];
    for (const st of stocks) {
      const C = bulk.get(st.code);
      if (!C || !C.c || C.c.length < warmup + fwd + 10) continue;
      const S = buildSeries(st, C);
      if (!S) continue;
      const c = C.c, n = c.length, end = n - fwd - 1;
      for (let i = warmup; i <= end; i += step) {
        const r = S.at(i);
        if (!r || !r.avgVal20 || r.avgVal20 < minAvgValEok * 1e8) continue;
        const ret = c[i + fwd] / c[i] - 1;
        if (!isFinite(ret)) continue;
        const rec = { d: r.date, ret };
        for (const F of PRICE_FACTORS) rec[F.id] = F.get(r);
        panel.push(rec);
      }
    }
    return panel;
  }
  function priceDeciles(stocks, bulk, opts = {}) {
    return decileFrom(pricePanel(stocks, bulk, opts), PRICE_FACTORS, opts.fwd ?? 120);
  }

  function decileFrom(panel, factors, fwd) {
    const byDate = new Map();
    for (const p of panel) {
      if (!byDate.has(p.d)) byDate.set(p.d, []);
      byDate.get(p.d).push(p);
    }
    const res = {};
    for (const F of factors) {
      const buckets = Array.from({ length: 10 }, () => []);
      for (const [, arr] of byDate) {
        const v = arr.filter((x) => x[F.id] != null && isFinite(x[F.id]));
        if (v.length < 30) continue;
        v.sort((a, b) => (F.asc ? a[F.id] - b[F.id] : b[F.id] - a[F.id]));
        const per = v.length / 10;
        v.forEach((x, k) => { buckets[Math.min(9, Math.floor(k / per))].push(x); });
      }
      res[F.id] = {
        meta: F, fwd,
        deciles: buckets.map((b, i) => ({
          d: i + 1, n: b.length,
          avgRet: b.length ? b.reduce((a, x) => a + x.ret, 0) / b.length : null,
          win: b.length ? b.filter((x) => x.ret > 0).length / b.length : null,
          avgVal: b.length ? b.reduce((a, x) => a + x[F.id], 0) / b.length : null,
        })),
      };
    }
    return res;
  }

  /**
   * 밸류 팩터(PBR/PER) 구간 분석
   * 연간 BPS/EPS 를 사업연도 종료 4개월 뒤부터 사용 가능하다고 보고
   * 그 시점의 주가로 PBR = P / BPS, PER = P / EPS 를 재구성한다.
   * (주당지표라 주식수 변동은 상쇄된다)
   */
  const VALUE_FACTORS = [
    { id: 'pbr', name: 'PBR', asc: true, fmt: 'num', note: '1분위 = 가장 싸다(저PBR)' },
    { id: 'per', name: 'PER', asc: true, fmt: 'num', note: '1분위 = 가장 싸다(저PER). 적자 기업 제외' },
  ];
  function valuePanel(stocks, bulk, fundMap, opts = {}) {
    const { fwd = 240, lagMonths = 4 } = opts;
    const panel = [];
    for (const st of stocks) {
      const C = bulk.get(st.code);
      const f = fundMap.get(st.code);
      if (!C || !C.c || !f?.annual?.keys?.length) continue;
      const { keys, bps, eps } = f.annual;
      for (let k = 0; k < keys.length; k++) {
        const fy = keys[k];                       // '202312'
        const y = +fy.slice(0, 4), m = +fy.slice(4, 6);
        const dt = new Date(Date.UTC(y, m - 1 + lagMonths, 1));
        const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '');
        let i = C.d.findIndex((d) => d >= ymd);
        if (i < 0 || i + fwd >= C.c.length) continue;
        const p = C.c[i];
        const ret = C.c[i + fwd] / p - 1;
        if (!isFinite(ret)) continue;
        panel.push({
          d: ymd, ret,
          pbr: bps[k] > 0 ? p / bps[k] : null,
          per: eps[k] > 0 ? p / eps[k] : null,
        });
      }
    }
    return panel;
  }
  function valueDeciles(stocks, bulk, fundMap, opts = {}) {
    const panel = valuePanel(stocks, bulk, fundMap, opts);
    return { result: decileFrom(panel, VALUE_FACTORS, opts.fwd ?? 240), samples: panel.length };
  }

  /* ================================================================ *
   * 4.5 재무 데이터 (밸류·퀄리티 팩터용)
   * ------------------------------------------------------------------
   * 네이버 모바일 재무 API. 단위는 억원.
   * 매출원가·영업현금흐름은 무료로 못 받아서
   *   GP/A -> OP/A(영업이익/자산, Fama-French RMW 계열)
   *   PCR  -> POR(시총/영업이익)
   * 로 대체한다.
   * ================================================================ */
  const rowMap = (rowList) => Object.fromEntries((rowList || []).map((r) => [r.title, r.columns || {}]));

  async function fetchFundamental(stock) {
    const code = stock.code;
    const [fq, fa, ig] = await Promise.all([
      getJSON(`${M}/api/stock/${code}/finance/quarter`),
      getJSON(`${M}/api/stock/${code}/finance/annual`),
      getJSON(`${M}/api/stock/${code}/integration`),
    ]);
    if (!fq?.financeInfo && !fa?.financeInfo) return null;

    const pick = (fi) => {
      if (!fi) return null;
      const cols = (fi.trTitleList || []).filter((t) => t.isConsensus !== 'Y').map((t) => t.key);
      return { cols, rows: rowMap(fi.rowList) };
    };
    const Qd = pick(fq?.financeInfo);
    const Ad = pick(fa?.financeInfo);

    const sum = (d, title, n) => {
      if (!d) return null;
      const ks = d.cols.slice(-n);
      if (ks.length < n) return null;
      let s = 0;
      for (const k of ks) {
        const v = d.rows[title]?.[k]?.value;
        if (v == null || v === '') return null;
        s += num(v);
      }
      return s;
    };
    const last = (d, title) => {
      if (!d) return null;
      for (let i = d.cols.length - 1; i >= 0; i--) {
        const v = d.rows[title]?.[d.cols[i]]?.value;
        if (v != null && v !== '') return num(v);
      }
      return null;
    };
    const series = (d, title, n) => {
      if (!d) return [];
      return d.cols.slice(-n).map((k) => {
        const v = d.rows[title]?.[k]?.value;
        return v == null || v === '' ? null : num(v);
      }).filter((x) => x != null);
    };

    // TTM (최근 4분기). 분기가 모자라면 연간 최근치로 대체
    const ttmSales = sum(Qd, '매출액', 4) ?? last(Ad, '매출액');
    const ttmOp = sum(Qd, '영업이익', 4) ?? last(Ad, '영업이익');
    const ttmNi = sum(Qd, '지배주주순이익', 4) ?? sum(Qd, '당기순이익', 4)
                  ?? last(Ad, '지배주주순이익') ?? last(Ad, '당기순이익');
    const bps = last(Qd, 'BPS') ?? last(Ad, 'BPS');
    const debtRatio = last(Qd, '부채비율') ?? last(Ad, '부채비율');
    const roeHist = series(Ad, 'ROE', 3);
    // 연도별 주당지표 (과거 PBR/PER 재구성용). 주당값이라 주식수 변동과 무관하다.
    const annual = Ad ? {
      keys: Ad.cols.slice(),
      bps: Ad.cols.map((k) => { const v = Ad.rows['BPS']?.[k]?.value; return v ? num(v) : null; }),
      eps: Ad.cols.map((k) => { const v = Ad.rows['EPS']?.[k]?.value; return v ? num(v) : null; }),
    } : null;

    const info = {};
    for (const t of (ig?.totalInfos || [])) info[t.code] = t.value;
    const per = num(info.per) || null;
    const pbr = num(info.pbr) || null;
    const divYield = num(info.dividendYieldRatio) || 0;

    const price = stock.price || 0;
    const capEok = stock.capEok || 0;
    const shares = price > 0 ? (capEok * 1e8) / price : null;          // 주식수
    const equity = shares && bps ? (bps * shares) / 1e8 : null;        // 자기자본(억원)
    const assets = equity && debtRatio != null ? equity * (1 + debtRatio / 100) : null;

    const pbrCalc = equity > 0 ? capEok / equity : null;
    const perCalc = ttmNi > 0 ? capEok / ttmNi : null;
    const psr = ttmSales > 0 ? capEok / ttmSales : null;
    const por = ttmOp > 0 ? capEok / ttmOp : null;
    const opa = assets > 0 && ttmOp != null ? ttmOp / assets : null;   // GP/A 대용
    const roeTtm = equity > 0 && ttmNi != null ? ttmNi / equity : null;
    const roa = assets > 0 && ttmNi != null ? ttmNi / assets : null;

    return {
      code, per: per ?? perCalc, pbr: pbr ?? pbrCalc, perCalc, pbrCalc,
      psr, por, opa, roeTtm, roa, divYield,
      bps, eps: num(info.eps) || null, debtRatio,
      ttmSales, ttmOp, ttmNi, shares, equity, assets, roeHist, annual,
      profitable: ttmNi > 0, opProfitable: ttmOp > 0,
    };
  }

  async function fetchFundamentalsBulk(stocks, { concurrency = 30, onProgress } = {}) {
    const res = new Map();
    let done = 0;
    for (let i = 0; i < stocks.length; i += concurrency) {
      const chunk = stocks.slice(i, i + concurrency);
      const got = await Promise.all(chunk.map((s) => fetchFundamental(s).catch(() => null)));
      chunk.forEach((s, k) => { if (got[k]) res.set(s.code, got[k]); });
      done += chunk.length;
      if (onProgress && done % (concurrency * 10) === 0) onProgress(done, stocks.length);
    }
    return res;
  }

  /* ---------------------------------------------------------------- *
   * 순위·백분위 유틸
   * ---------------------------------------------------------------- */
  /** 값이 작을수록 좋은 지표 -> 0(최고)~1(최저) 백분위. null 은 null */
  function pctRank(list, getter, asc = true) {
    const vals = list.map((x, i) => ({ i, v: getter(x) })).filter((o) => o.v != null && isFinite(o.v));
    vals.sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
    const out = new Array(list.length).fill(null);
    vals.forEach((o, k) => { out[o.i] = vals.length > 1 ? k / (vals.length - 1) : 0; });
    return out;
  }

  /* ================================================================ *
   * 4.7 책 기반 포트폴리오 전략 (국내 퀀트 저자 계열)
   * ------------------------------------------------------------------
   * 시그널형 STRATEGIES 와 달리 "순위 상위 N종목을 분산 보유하고
   * 주기적으로 리밸런싱" 하는 포트폴리오 전략이다.
   * ================================================================ */
  const HOLDING = /(홀딩스|지주$)/;

  function investable(r, { minCapEok = 300, minAvgValEok = 3, maxDebt = 400 } = {}) {
    if (!r.f) return false;
    if (r.capEok < minCapEok) return false;
    if (!r.avgVal20 || r.avgVal20 < minAvgValEok * 1e8) return false;
    if (r.f.debtRatio == null || r.f.debtRatio > maxDebt) return false;
    if (HOLDING.test(r.name)) return false;
    if (r.f.equity != null && r.f.equity <= 0) return false;   // 자본잠식
    return true;
  }

  const PORTFOLIOS = [
    {
      id: 'newmagic1', name: '신마법공식 1.0', author: '강환국 『할 수 있다! 퀀트투자』',
      formula: '저PBR 순위 + 고 OP/A 순위 합산',
      rebalance: '분기~반기 1회', hold: 30, small: false,
      why: '그린블랫의 마법공식(ROC+EV/EBIT)이 한국에서 잘 안 먹혀서, 밸류 지표 1개 + 퀄리티 지표 1개로 단순화한 버전. 싼 가격(저PBR)과 돈 잘 버는 능력(고 수익성)을 동시에 본다.',
      caution: '원전략은 GP/A(매출총이익/자산)이다. 무료 데이터로 매출원가를 못 받아 영업이익/자산(OP/A)으로 대체했다. 저자 백테스트와 수치가 다를 수 있다.',
    },
    {
      id: 'newmagic2', name: '신마법공식 2.0 (소형주)', author: '강환국 『할 수 있다! 퀀트투자』',
      formula: '시총 하위 20% 중 저PBR + 고 OP/A 순위 합산',
      rebalance: '분기~반기 1회', hold: 30, small: true,
      why: '같은 공식을 소형주에만 적용. 책의 백테스트에서 소형주 제한을 걸었을 때 연복리가 크게 올라갔다. 기관·외국인이 못 건드리는 구간이라 비효율이 남아있다는 해석.',
      caution: '소형주는 거래량이 적어 사고 팔 때 불리하다(슬리피지). 상장폐지·관리종목 위험도 높으니 반드시 분산하고 공시를 확인해야 한다.',
    },
    {
      id: 'supervalue', name: '슈퍼가치 전략', author: '강환국 『할 수 있다! 퀀트투자』',
      formula: '시총 하위 20% 중 PER·PBR·PSR·POR 4지표 순위 합산',
      rebalance: '연 1회 (7월)', hold: 30, small: true,
      why: '밸류 지표는 시기마다 잘 듣는 게 다르니 하나만 보지 말고 여러 개를 섞으라는 아이디어. 한 지표가 망가져도 나머지가 받쳐준다.',
      caution: '원전략은 PCR(시총/영업현금흐름)을 쓴다. 현금흐름표를 못 받아 POR(시총/영업이익)로 대체했다.',
    },
    {
      id: 'smallpbr', name: '소형주 저PBR', author: '강환국 『할 수 있다! 퀀트투자』',
      formula: '시총 하위 20% 중 PBR 낮은 순 (하위 2% 제외)',
      rebalance: '반기~연 1회', hold: 30, small: true,
      why: '가장 오래된 밸류 팩터. 자산 대비 싼 주식을 사는 가장 단순한 방법이고, 한국 소형주에서 효과가 가장 세게 나타났다.',
      caution: 'PBR 극하위 2%는 일부러 불다. 그 정도로 싸면 장부에 안 보이는 중대한 문제가 있을 가능성이 높다는 게 책의 지적이다.',
    },
    {
      id: 'fscore', name: '신 F-스코어 + 저PBR', author: '강환국 (피오트로스키 F-Score 한국형 축소)',
      formula: '재무 건전성 3개 중 2개 이상 통과 + 저PBR',
      rebalance: '분기 1회', hold: 25, small: false,
      why: '피오트로스키의 9개 지표 중 한국에서 유의미했던 것만 추린 버전. "싸기만 한 게 아니라 망하지는 않는 회사"를 걸러내는 게 목적이다.',
      caution: '원전략 3지표는 신규주식 발행 없음·순이익 흑자·영업현금흐름 흑자다. 현금흐름과 신주발행 데이터가 없어 영업이익 흑자·부채비율 200% 미만으로 대체했다.',
    },
    {
      id: 'srim', name: 'S-RIM 저평가', author: '사경인 『재무제표 모르면 주식투자 절대로 하지 마라』',
      formula: '적정주가 = 자기자본 + 초과이익의 현재가치 → 괴리율 상위',
      rebalance: '분기 1회', hold: 25, small: false,
      why: 'ROE가 요구수익률보다 높은 만큼이 "초과이익"이고, 그걸 자기자본에 더해 적정가를 구한다. 회계사가 만들어 국내 스크리닝 도구에 가장 널리 들어간 적정주가 모델.',
      caution: '요구수익률(기본 8%)과 초과이익 지속계수(기본 0.8)에 결과가 크게 좌우된다. ROE가 틀리면 적정가도 틀린다. 일회성 이익으로 ROE가 튀어오른 회사를 조심할 것.',
    },
    {
      id: 'absmom_lv', name: '절대모멘텀 + 변동성 역가중', author: 'systrader79 계열',
      formula: '1년 수익률 플러스 + 120일선 위 → 변동성 낮은 순',
      rebalance: '월 1회', hold: 20, small: false,
      why: '먼저 오르는 종목만 남기고(절대모멘텀), 그 안에서 덜 흔들리는 걸 더 많이 담는다(변동성 역가중). 수익률보다 떨어질 때 덜 아프려는 접근이다.',
      caution: '강세장에서는 변동성 큰 종목이 더 오르기 때문에 뒤처진다. 하락장 방어용에 가깝다.',
    },
  ];
  const PF_BY_ID = Object.fromEntries(PORTFOLIOS.map((p) => [p.id, p]));

  function halloween(date = new Date()) {
    const m = date.getMonth() + 1;
    const on = m >= 11 || m <= 4;
    return { on, month: m,
      label: on ? '할러윈 구간 (11~4월)' : '비수기 (5~10월)',
      note: on
        ? '과거 통계상 11~4월 수익률이 5~10월보다 뚰렵하게 높았던 구간. 강환국이 한국 데이터로도 검증했다.'
        : '과거 통계상 수익률이 낮았던 구간. Sell in May 격언의 근거. 비중을 줄이거나 보수적으로 보는 것도 방법.' };
  }

  function buildPortfolios(rows, opts = {}) {
    const { srimR = 0.08, srimW = 0.8, smallPct = 0.2 } = opts;
    const pool = rows.filter((r) => investable(r, opts));
    const byCapAsc = [...pool].sort((a, b) => a.capEok - b.capEok);
    const smallCut = byCapAsc[Math.max(0, Math.floor(byCapAsc.length * smallPct) - 1)]?.capEok ?? 0;
    const small = pool.filter((r) => r.capEok <= smallCut);

    const out = {};
    const mk = (id, list) => {
      const P = PF_BY_ID[id];
      out[id] = { meta: P, poolSize: (P.small ? small : pool).length, smallCut, list: list.slice(0, P.hold), total: list.length };
    };

    const magic = (base) => {
      const cand = base.filter((r) => r.f.pbr > 0.2 && r.f.opa != null && r.f.opProfitable && r.f.profitable);
      const rp = pctRank(cand, (r) => r.f.pbr, true);
      const ro = pctRank(cand, (r) => r.f.opa, false);
      return cand.map((r, i) => ({ row: r, score: (rp[i] ?? 1) + (ro[i] ?? 1), parts: { PBR: r.f.pbr, 'OP/A': r.f.opa } }))
        .filter((x) => isFinite(x.score)).sort((a, b) => a.score - b.score);
    };
    mk('newmagic1', magic(pool));
    mk('newmagic2', magic(small));

    const sv = small.filter((r) => r.f.per > 0 && r.f.pbr > 0 && r.f.psr > 0 && r.f.por > 0);
    const r1 = pctRank(sv, (r) => r.f.per, true), r2 = pctRank(sv, (r) => r.f.pbr, true);
    const r3 = pctRank(sv, (r) => r.f.psr, true), r4 = pctRank(sv, (r) => r.f.por, true);
    mk('supervalue', sv.map((r, i) => ({ row: r, score: (r1[i] ?? 1) + (r2[i] ?? 1) + (r3[i] ?? 1) + (r4[i] ?? 1),
      parts: { PER: r.f.per, PBR: r.f.pbr, PSR: r.f.psr, POR: r.f.por } })).sort((a, b) => a.score - b.score));

    const sp = small.filter((r) => r.f.pbr > 0).sort((a, b) => a.f.pbr - b.f.pbr);
    const cut2 = Math.floor(sp.length * 0.02);
    mk('smallpbr', sp.slice(cut2).map((r) => ({ row: r, score: r.f.pbr,
      parts: { PBR: r.f.pbr, ROE: r.f.roeTtm, '부채비율': r.f.debtRatio } })));

    const fsc = (r) => (r.f.profitable ? 1 : 0) + (r.f.opProfitable ? 1 : 0) + (r.f.debtRatio < 200 ? 1 : 0);
    const fsl = pool.filter((r) => r.f.pbr > 0.2 && fsc(r) >= 2).sort((a, b) => a.f.pbr - b.f.pbr);
    mk('fscore', fsl.map((r) => ({ row: r, score: r.f.pbr,
      parts: { 'F점수': fsc(r) + '/3', PBR: r.f.pbr, '부채비율': r.f.debtRatio } })));

    const srimL = [];
    for (const r of pool) {
      const h = r.f.roeHist;
      if (!h || h.length < 2 || !r.f.equity || !r.f.shares) continue;
      // 이상치 제거: 일회성·자본잠식으로 ROE가 튀는 경우를 걸러낸다
      const clean = h.filter((v) => v != null && isFinite(v) && Math.abs(v) < 80);
      if (clean.length < 2) continue;
      const wts = clean.length >= 3 ? [1, 2, 3] : [1, 2];
      const hh = clean.slice(-wts.length);
      const roe = hh.reduce((a, v, i) => a + v * wts[i], 0) / wts.reduce((a, b) => a + b, 0) / 100;
      if (!isFinite(roe) || roe <= srimR || roe > 0.5 || !r.f.profitable) continue;
      if (!(r.f.equity > 0)) continue;
      const value = r.f.equity + r.f.equity * (roe - srimR) * srimW / (1 + srimR - srimW);
      const fair = (value * 1e8) / r.f.shares;
      if (!isFinite(fair) || fair <= 0) continue;
      const gap = fair / r.close - 1;
      if (gap <= 0 || gap > 3) continue;   // 괴리율 300% 초과는 데이터 오류 가능성
      srimL.push({ row: r, score: -gap, parts: { '적정주가': Math.round(fair), '괴리율': gap, 'ROE(가중)': roe, PBR: r.f.pbr } });
    }
    mk('srim', srimL.sort((a, b) => a.score - b.score));

    const am = pool.filter((r) => r.ret240 > 0 && r.ma120 && r.close > r.ma120 && r.vola20 > 0);
    mk('absmom_lv', am.map((r) => ({ row: r, score: r.vola20,
      parts: { '1년수익률': r.ret240, '변동성': r.vola20 } })).sort((a, b) => a.score - b.score));
    const amL = out.absmom_lv.list;
    const tw = amL.reduce((a, x) => a + 1 / x.row.vola20, 0);
    amL.forEach((x) => { x.weight = (1 / x.row.vola20) / tw; });

    return { pool: pool.length, small: small.length, smallCut, halloween: halloween(), portfolios: out };
  }

  /* ================================================================ *
   * 5. 시장지표 / 뉴스
   * ================================================================ */
  async function fetchMarket() {
    const idx = async (code, label) => {
      const d = await getJSON(`${API}/index/${encodeURIComponent(code)}/basic`, M + '/');
      if (!d || !d.closePrice) return null;
      return { label, code, price: d.closePrice, rate: num(d.fluctuationsRatio) };
    };
    const dom = async (code, label) => {
      const d = await getJSON(`${M}/api/index/${code}/basic`);
      if (!d || !d.closePrice) return null;
      return { label, code, price: d.closePrice, rate: num(d.fluctuationsRatio) };
    };
    const fx = async (code, label) => {
      const d = await getJSON(`${API}/marketindex/exchange/${code}`, M + '/');
      const e = d?.exchangeInfo || d;
      if (!e?.closePrice) return null;
      return { label, code, price: e.closePrice, rate: num(e.fluctuationsRatio) };
    };
    const out = await Promise.all([
      dom('KOSPI', '코스피'), dom('KOSDAQ', '코스닥'),
      idx('.IXIC', '나스닥'), idx('.INX', 'S&P500'), idx('.SOX', '필라델피아 반도체'),
      idx('.N225', '닛케이225'), fx('FX_USDKRW', '원/달러'),
    ]);
    return out.filter(Boolean);
  }

  async function fetchNews(code, size = 2) {
    const d = await getJSON(`${API}/news/stock/${code}?pageSize=${size}&page=1`, M + '/');
    const items = Array.isArray(d) ? d : d?.items || [];
    const out = [];
    for (const g of items) {
      for (const it of (g.items || [g])) {
        if (!it.title) continue;
        out.push({
          title: String(it.title).replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').trim(),
          office: it.officeName, date: it.datetime,
          url: it.officeId && it.articleId ? `https://n.news.naver.com/mnews/article/${it.officeId}/${it.articleId}` : null,
        });
        if (out.length >= size) return out;
      }
    }
    return out;
  }

  return {
    UA, getJSON, getText, sleep, num,
    fetchUniverse, fetchBars, fetchBarsBulk,
    rollMean, rollMax, rollMin, rsiArr, volaArr, buildSeries,
    fetchFundamental, fetchFundamentalsBulk, pctRank,
    PORTFOLIOS, PF_BY_ID, buildPortfolios, investable, halloween,
    STRATEGIES, STRAT_BY_ID, HORIZONS, HK,
    statsOf, backtest, createAcc, feedAcc, finalizeAcc, fwdExtremes,
    PRICE_FACTORS, VALUE_FACTORS, pricePanel, valuePanel, priceDeciles, valueDeciles, decileFrom,
    fetchMarket, fetchNews,
  };
})()
