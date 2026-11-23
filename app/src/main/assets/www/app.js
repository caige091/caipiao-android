/* 福彩开奖模拟器 - 前端逻辑 v2（绑定期号 + 倍投 + 账本统计） */
'use strict';

const BETS_KEY = 'lottery-bets-v2';
const LEDGER_KEY = 'lottery-ledger';

const GAME_CONF = {
  ssq: {
    name: '双色球',
    schedule: '每周二、四、日 21:15 开奖',
    redMax: 33, redNeed: 6, blueMax: 16, blueNeed: 1, price: 2,
  },
  '3d': {
    name: '福彩3D',
    schedule: '每日 21:15 开奖',
    price: 2,
  },
};

const SSQ_FIXED = { 3: 3000, 4: 200, 5: 10, 6: 5 };
const SSQ_LEVEL_NAME = { 1: '一等奖', 2: '二等奖', 3: '三等奖', 4: '四等奖', 5: '五等奖', 6: '六等奖' };
const D3_PRIZE = { direct: 1040, group3: 346, group6: 173 };

const state = {
  game: 'ssq',
  draws: {},
  fetchedAt: {},
  stale: {},
  bets: loadBets(),        // { ssq: [], '3d': [] }
  ledger: loadLedger(),    // []
  picker: {
    ssq: { reds: [], blue: null, multiplier: 1 },
    '3d': { digits: [null, null, null], multiplier: 1 },
  },
  ledgerTab: 'overview',   // overview | detail
  ledgerFilter: 'all',     // all | ssq | 3d
};

/* ================= 存储 ================= */
function loadBets() {
  try {
    const raw = localStorage.getItem(BETS_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      return { ssq: saved.ssq || [], '3d': saved['3d'] || [] };
    }
    // 旧版键名兜底：读到无期号旧格式 → 静默丢弃（v1 数据已无法关联期号）
    const legacy = localStorage.getItem('lottery-bets');
    if (legacy) {
      try { JSON.parse(legacy); } catch { /* ignore */ }
      localStorage.removeItem('lottery-bets');
    }
    return { ssq: [], '3d': [] };
  } catch {
    return { ssq: [], '3d': [] };
  }
}
function saveBets() {
  localStorage.setItem(BETS_KEY, JSON.stringify(state.bets));
}
function loadLedger() {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}
function saveLedger() {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(state.ledger));
}

/* ================= 工具 ================= */
const $ = (sel) => document.querySelector(sel);
const pad2 = (n) => String(n).padStart(2, '0');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function ballEl(n, cls = 'ball-red', size = '', hit = false) {
  const span = document.createElement('span');
  span.className = `ball ${cls} ${size} ${hit ? 'ball-hit' : ''}`.trim();
  span.textContent = pad2(n);
  return span;
}
function shuffle(n) {
  const arr = Array.from({ length: n }, (_, i) => i + 1);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function randomSsq() {
  return { reds: shuffle(33).slice(0, 6).sort((a, b) => a - b), blue: Math.ceil(Math.random() * 16) };
}
function randomD3() {
  return { digits: Array.from({ length: 3 }, () => Math.floor(Math.random() * 10)) };
}
function fmtMoney(yuan) {
  const n = Number(yuan);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿元';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万元';
  return n + ' 元';
}
function fmtYuan(n) {
  const v = Number(n) || 0;
  return (v < 0 ? '-' : '') + '¥' + Math.abs(v).toLocaleString('zh-CN');
}
function nextIssueCode(game) {
  const draw = latestDraw(game);
  if (!draw) return null;
  const code = String(draw.code);
  const next = parseInt(code) + 1;
  // 跨年守卫：如果已经跨年（2026153→2027001 这种），手动修正
  const year = code.slice(0, 4);
  const nextYear = String(new Date().getFullYear());
  if (year !== nextYear && parseInt(code.slice(4)) >= 300) {
    return nextYear + '001';
  }
  return String(next);
}

/* ================= 数据获取 ================= */
async function fetchDraw(game, { force = false } = {}) {
  try {
    const resp = await fetch(`/api/latest?game=${game}${force ? '&t=' + Date.now() : ''}`);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '请求失败');
    state.draws[game] = data;
    state.fetchedAt[game] = data.fetchedAt;
    state.stale[game] = !!data.stale;
  } catch (err) {
    throw err;
  }
}
function latestDraw(game) {
  return state.draws[game]?.result?.[0] || null;
}

/* ================= 中奖判定 ================= */
function checkSsq(bet, draw) {
  const winReds = draw.red.split(',').map(Number);
  const winBlue = Number(draw.blue);
  const r = bet.reds.filter((n) => winReds.includes(n)).length;
  const b = bet.blue === winBlue ? 1 : 0;
  let level = 0;
  if (r === 6 && b === 1) level = 1;
  else if (r === 6) level = 2;
  else if (r === 5 && b === 1) level = 3;
  else if ((r === 5) || (r === 4 && b === 1)) level = 4;
  else if (r === 4 || (r === 3 && b === 1)) level = 5;
  else if (b === 1) level = 6;

  let unit = 0;
  if (level >= 3) unit = SSQ_FIXED[level];
  else if (level >= 1) {
    const g = draw.prizegrades?.find((p) => p.type === level);
    unit = g?.typemoney ? Number(g.typemoney) : 0;
  }
  return { level, r, b, unit, name: level ? SSQ_LEVEL_NAME[level] : '' };
}

function checkD3(bet, draw) {
  const win = draw.red.split(',').map(Number);
  const mine = bet.digits;
  const exact = mine.every((d, i) => d === win[i]);
  const sameSet = [...mine].sort().join() === [...win].sort().join();
  const distinct = new Set(win).size;

  if (exact) return { level: 'direct', name: '直选中奖', unit: D3_PRIZE.direct };
  if (sameSet && distinct === 2) return { level: 'group3', name: '组选三中奖', unit: D3_PRIZE.group3 };
  if (sameSet && distinct === 3) return { level: 'group6', name: '组选六中奖', unit: D3_PRIZE.group6 };
  return { level: 0, name: '', unit: 0 };
}

/* ================= 自动归档 ================= */
// fetchDraw 之后调用：遍历所有 bets，如果某注的 issue <= 最新开奖期号 → 结算并归档到 ledger
function autoArchive() {
  ['ssq', '3d'].forEach((game) => {
    const draw = latestDraw(game);
    if (!draw) return;
    const drawCode = String(draw.code);
    const pending = state.bets[game]; // [{id, issue, reds/blue or digits, multiplier, purchasedAt}]
    const toArchive = pending.filter((b) => b.issue <= drawCode);
    const remaining = pending.filter((b) => b.issue > drawCode);

    if (toArchive.length === 0) return;

    // 按 issue 分组，同一个期号的投注合并成一条 ledger 记录
    const grouped = {};
    toArchive.forEach((bet) => {
      if (!grouped[bet.issue]) grouped[bet.issue] = [];
      grouped[bet.issue].push(bet);
    });

    Object.keys(grouped).forEach((issue) => {
      const bets = grouped[issue];
      const targetDraw = state.draws[game]?.result?.find((d) => String(d.code) === issue) || draw;

      let totalCost = 0;
      let totalPrize = 0;
      const checked = bets.map((bet) => {
        const multiplier = bet.multiplier || 1;
        const cost = GAME_CONF[game].price * multiplier;
        totalCost += cost;
        let unit = 0, name = '', r = 0, b = 0;
        if (game === 'ssq') {
          const res = checkSsq(bet, targetDraw);
          unit = res.unit; name = res.name; r = res.r; b = res.b;
        } else {
          const res = checkD3(bet, targetDraw);
          unit = res.unit; name = res.name;
        }
        const prize = unit * multiplier;
        totalPrize += prize;
        return { bet, multiplier, cost, prize, unit, name, r, b };
      });

      state.ledger.unshift({
        id: uid(),
        game,
        issue,
        drawCode: String(targetDraw.code),
        drawDate: targetDraw.date || '',
        bets: checked,
        totalCost,
        totalPrize,
        status: totalPrize > 0 ? 'won' : 'lost',
        checkedAt: new Date().toISOString(),
      });
    });

    state.bets[game] = remaining;
  });

  saveBets();
  saveLedger();
}

/* ================= 渲染：最新开奖 ================= */
function renderDraw() {
  const game = state.game;
  const draw = latestDraw(game);
  const conf = GAME_CONF[game];
  const ballsEl = $('#drawBalls');
  ballsEl.innerHTML = '';

  if (!draw) {
    $('#drawIssue').textContent = '暂无数据';
    $('#drawDate').textContent = '';
    ballsEl.innerHTML = '<span class="tip">开奖数据获取失败，请点击"刷新"重试。</span>';
    $('#drawStats').innerHTML = '';
    $('#prizeTable').innerHTML = '';
    return;
  }

  $('#drawIssue').textContent = `第 ${draw.code} 期`;
  $('#drawDate').textContent = draw.date;
  const nums = draw.red.split(',').map(Number);
  nums.forEach((n) => ballsEl.appendChild(ballEl(n, 'ball-red')));
  if (game === 'ssq') {
    const plus = document.createElement('span');
    plus.className = 'plus';
    plus.textContent = '+';
    ballsEl.appendChild(plus);
    ballsEl.appendChild(ballEl(Number(draw.blue), 'ball-blue'));
  }

  const stats = $('#drawStats');
  stats.innerHTML = '';
  const statItems =
    game === 'ssq'
      ? [['奖池滚存', fmtMoney(draw.poolmoney)], ['当期销量', fmtMoney(draw.sales)]]
      : [['当期销量', fmtMoney(draw.sales)]];
  statItems.forEach(([label, val]) => {
    const div = document.createElement('div');
    div.innerHTML = `${label}：<b>${val}</b>`;
    stats.appendChild(div);
  });

  renderPrizeTable(draw);
  $('#scheduleTip').textContent = conf.schedule;
}

function renderPrizeTable(draw) {
  const tbl = $('#prizeTable');
  tbl.innerHTML = '';
  if (state.game === 'ssq') {
    const thead = document.createElement('tr');
    ['奖级', '中奖注数', '单注奖金'].forEach((t) => {
      const th = document.createElement('th'); th.textContent = t; thead.appendChild(th);
    });
    tbl.appendChild(thead);
    draw.prizegrades?.filter((p) => p.type <= 6).forEach((p) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="pname">${SSQ_LEVEL_NAME[p.type]}</td>` +
        `<td>${p.typenum ? Number(p.typenum).toLocaleString('zh-CN') + ' 注' : '--'}</td>` +
        `<td>${p.typemoney ? fmtYuan(p.typemoney) : '--'}</td>`;
      tbl.appendChild(tr);
    });
  } else {
    const thead = document.createElement('tr');
    ['玩法', '中奖条件', '单注奖金'].forEach((t) => {
      const th = document.createElement('th'); th.textContent = t; thead.appendChild(th);
    });
    tbl.appendChild(thead);
    [
      ['直选', '号码与开奖号码完全相同且顺序一致', fmtYuan(D3_PRIZE.direct)],
      ['组选三', '3 个号码中有 2 个相同，不要求顺序', fmtYuan(D3_PRIZE.group3)],
      ['组选六', '3 个号码各不相同，不要求顺序', fmtYuan(D3_PRIZE.group6)],
    ].forEach(([a, b, c]) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td class="pname">${a}</td><td style="white-space:normal;text-align:left">${b}</td><td>${c}</td>`;
      tbl.appendChild(tr);
    });
  }
}

/* ================= 渲染：历史 ================= */
function renderHistory() {
  const game = state.game;
  const list = $('#historyList');
  list.innerHTML = '';
  const results = state.draws[game]?.result || [];
  results.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const issue = document.createElement('span');
    issue.className = 'history-issue';
    issue.textContent = `${d.code} 期 · ${d.date}`;
    row.appendChild(issue);

    const balls = document.createElement('span');
    balls.className = 'history-balls';
    d.red.split(',').map(Number).forEach((n) => balls.appendChild(ballEl(n, 'ball-red', 'ball-sm')));
    if (game === 'ssq' && d.blue) {
      const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '+';
      balls.appendChild(plus);
      balls.appendChild(ballEl(Number(d.blue), 'ball-blue', 'ball-sm'));
    }
    row.appendChild(balls);
    list.appendChild(row);
  });
}

/* ================= 渲染：选号器 ================= */
function renderPicker() {
  const game = state.game;
  const conf = GAME_CONF[game];
  $('#pickerTitle').textContent = `${conf.name} · 选号`;
  $('#pickerIssue').textContent = nextIssueCode(game)
    ? `当前购买：第 ${nextIssueCode(game)} 期`
    : '开奖数据未获取，暂无法确定期号';

  const area = $('#pickerArea');
  area.innerHTML = '';

  if (game === 'ssq') {
    const { reds, blue, multiplier } = state.picker.ssq;

    // 倍数选择器
    area.appendChild(buildMultiplierRow('ssq', multiplier));

    const redGroup = document.createElement('div');
    redGroup.className = 'picker-group';
    redGroup.innerHTML = `<div class="picker-group-label">红球（1-33，至少选 <b>6</b> 个，已选 <b>${reds.length}</b> 个）</div>`;
    const grid = document.createElement('div');
    grid.className = 'ball-grid';
    for (let n = 1; n <= 33; n++) {
      const b = document.createElement('button');
      b.className = 'ball-pick' + (reds.includes(n) ? ' sel-red' : '');
      b.textContent = pad2(n);
      b.onclick = () => toggleRed(n);
      grid.appendChild(b);
    }
    redGroup.appendChild(grid);
    area.appendChild(redGroup);

    const blueGroup = document.createElement('div');
    blueGroup.className = 'picker-group';
    blueGroup.innerHTML = `<div class="picker-group-label">蓝球（1-16，选 <b>1</b> 个${blue ? '，已选 <b>' + pad2(blue) + '</b>' : ''}）</div>`;
    const bgrid = document.createElement('div');
    bgrid.className = 'ball-grid';
    for (let n = 1; n <= 16; n++) {
      const b = document.createElement('button');
      b.className = 'ball-pick' + (blue === n ? ' sel-blue' : '');
      b.textContent = pad2(n);
      b.onclick = () => {
        state.picker.ssq.blue = state.picker.ssq.blue === n ? null : n;
        renderPicker();
      };
      bgrid.appendChild(b);
    }
    blueGroup.appendChild(bgrid);
    area.appendChild(blueGroup);

    const done = reds.length === 6 && blue;
    const cost = done ? conf.price * multiplier : 0;
    $('#pickerTip').textContent = done
      ? `已选满，本注 × ${multiplier} 倍 = ${fmtYuan(cost)}，加入投注吧`
      : '请选 6 个红球 + 1 个蓝球';
    $('#btnAddBet').disabled = !done;
  } else {
    const { digits, multiplier } = state.picker['3d'];

    area.appendChild(buildMultiplierRow('3d', multiplier));

    const group = document.createElement('div');
    group.className = 'picker-group';
    group.innerHTML = `<div class="picker-group-label">选择一个 3 位号码（每位 0-9），对奖时自动判定直选 / 组选</div>`;
    const row = document.createElement('div');
    row.className = 'digit-row';
    ['百位', '十位', '个位'].forEach((label, idx) => {
      const col = document.createElement('div');
      col.className = 'digit-col';
      col.innerHTML = `<div class="digit-col-label">${label}</div>`;
      const grid = document.createElement('div');
      grid.className = 'digit-grid';
      for (let n = 0; n <= 9; n++) {
        const c = document.createElement('button');
        c.className = 'digit-cell' + (digits[idx] === n ? ' sel' : '');
        c.textContent = n;
        c.onclick = () => {
          state.picker['3d'].digits[idx] = state.picker['3d'].digits[idx] === n ? null : n;
          renderPicker();
        };
        grid.appendChild(c);
      }
      col.appendChild(grid);
      row.appendChild(col);
    });
    group.appendChild(row);
    area.appendChild(group);

    const done = digits.every((d) => d !== null);
    const cost = done ? conf.price * multiplier : 0;
    $('#pickerTip').textContent = done
      ? `号码已选好，本注 × ${multiplier} 倍 = ${fmtYuan(cost)}，加入投注吧`
      : '请把百、十、个三位都选上';
    $('#btnAddBet').disabled = !done;
  }
}

function buildMultiplierRow(game, currentMultiplier) {
  const conf = GAME_CONF[game];
  const wrap = document.createElement('div');
  wrap.className = 'multiplier-row';
  wrap.innerHTML = `<span class="multiplier-label">倍数：</span>`;
  for (let m = 1; m <= 10; m++) {
    const btn = document.createElement('button');
    btn.className = 'multiplier-btn' + (m === currentMultiplier ? ' active' : '');
    btn.textContent = m;
    btn.onclick = () => {
      state.picker[game].multiplier = m;
      renderPicker();
    };
    wrap.appendChild(btn);
  }
  const preview = document.createElement('span');
  preview.className = 'multiplier-preview';
  preview.textContent = `单注 ${conf.price} 元，× ${currentMultiplier} = ${fmtYuan(conf.price * currentMultiplier)}`;
  wrap.appendChild(preview);
  return wrap;
}

function toggleRed(n) {
  const reds = state.picker.ssq.reds;
  const i = reds.indexOf(n);
  if (i >= 0) reds.splice(i, 1);
  else {
    if (reds.length >= 6) reds.shift();
    reds.push(n);
    reds.sort((a, b) => a - b);
  }
  renderPicker();
}

/* ================= 渲染：待开奖投注 ================= */
function renderBets() {
  const game = state.game;
  const bets = state.bets[game];
  const issue = nextIssueCode(game);
  const draw = latestDraw(game);
  const listEl = $('#betList');
  listEl.innerHTML = '';

  $('#betIssueTag').textContent = issue ? `待开奖：第 ${issue} 期` : '待开奖';
  $('#betCount').textContent = bets.length === 0
    ? '共 0 注'
    : `共 ${bets.length} 注 · ${bets.reduce((s, b) => s + GAME_CONF[game].price * (b.multiplier || 1), 0)} 元`;
  $('#emptyTip').hidden = bets.length > 0;

  bets.forEach((bet, idx) => {
    const item = document.createElement('div');
    item.className = 'bet-item';
    const main = document.createElement('div');
    main.className = 'bet-main';

    const no = document.createElement('span');
    no.className = 'bet-no';
    no.textContent = `${idx + 1}#`;
    main.appendChild(no);

    if (game === 'ssq') {
      bet.reds.forEach((n) => main.appendChild(ballEl(n, 'ball-red', 'ball-sm')));
      const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '+';
      main.appendChild(plus);
      main.appendChild(ballEl(bet.blue, 'ball-blue', 'ball-sm'));
    } else {
      bet.digits.forEach((d) => main.appendChild(ballEl(d, 'ball-red', 'ball-sm')));
    }

    const multi = document.createElement('span');
    multi.className = 'bet-multi';
    multi.textContent = `× ${bet.multiplier || 1}`;
    main.appendChild(multi);

    const cost = GAME_CONF[game].price * (bet.multiplier || 1);
    const costEl = document.createElement('span');
    costEl.className = 'bet-cost';
    costEl.textContent = fmtYuan(cost);
    main.appendChild(costEl);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:8px';

    const del = document.createElement('button');
    del.className = 'bet-del'; del.textContent = '✕'; del.title = '删除此注';
    del.onclick = () => {
      state.bets[game].splice(idx, 1);
      saveBets();
      renderBets();
    };
    right.appendChild(del);

    item.appendChild(main);
    item.appendChild(right);
    listEl.appendChild(item);
  });
}

/* ================= 渲染：账本 ================= */
function renderLedger() {
  const ledger = state.ledger;
  const filtered = state.ledgerFilter === 'all'
    ? ledger
    : ledger.filter((l) => l.game === state.ledgerFilter);

  // 统计
  let totalCost = 0, totalPrize = 0, wonCount = 0;
  filtered.forEach((l) => {
    totalCost += l.totalCost;
    totalPrize += l.totalPrize;
    if (l.status === 'won') wonCount++;
  });
  const net = totalPrize - totalCost;
  const hitRate = filtered.length > 0 ? (wonCount / filtered.length * 100).toFixed(1) + '%' : '--';

  const overview = $('#ledgerOverview');
  overview.innerHTML = '';
  const cards = [
    { label: '累计投入', value: fmtYuan(totalCost), cls: 'cost' },
    { label: '累计收益', value: fmtYuan(totalPrize), cls: 'prize' },
    { label: '净利润', value: (net < 0 ? '-' : '') + fmtYuan(Math.abs(net)), cls: net >= 0 ? 'profit' : 'loss' },
    { label: '已开奖', value: `${filtered.length} 期`, cls: '' },
    { label: '中奖期数', value: `${wonCount} 期`, cls: '' },
    { label: '中奖率', value: hitRate, cls: '' },
  ];
  cards.forEach((c) => {
    const el = document.createElement('div');
    el.className = `stat-card ${c.cls}`;
    el.innerHTML = `<div class="stat-label">${c.label}</div><div class="stat-value">${c.value}</div>`;
    overview.appendChild(el);
  });

  // 筛选按钮
  const filterWrap = $('#ledgerFilter');
  if (filterWrap) {
    filterWrap.innerHTML = '';
    [
      { v: 'all', t: '全部' },
      { v: 'ssq', t: '双色球' },
      { v: '3d', t: '福彩3D' },
    ].forEach((f) => {
      const btn = document.createElement('button');
      btn.className = 'filter-btn' + (state.ledgerFilter === f.v ? ' active' : '');
      btn.textContent = f.t;
      btn.onclick = () => { state.ledgerFilter = f.v; renderLedger(); };
      filterWrap.appendChild(btn);
    });
  }

  // 明细列表
  const detail = $('#ledgerDetail');
  detail.innerHTML = '';
  if (filtered.length === 0) {
    detail.innerHTML = '<div class="empty-tip">还没有开奖记录。投注后等待开奖，结果会自动计入这里。</div>';
  } else {
    filtered.forEach((rec) => {
      const row = document.createElement('div');
      row.className = `ledger-row ${rec.status === 'won' ? 'won' : ''}`;

      const head = document.createElement('div');
      head.className = 'ledger-row-head';
      head.innerHTML = `
        <span class="ledger-game tag-${rec.game}">${GAME_CONF[rec.game].name}</span>
        <span class="ledger-issue">第 ${rec.issue} 期 · ${rec.drawDate}</span>
        <span class="ledger-status ${rec.status}">${rec.status === 'won' ? '🎉 中奖' : '未中'}</span>
      `;
      row.appendChild(head);

      const betsWrap = document.createElement('div');
      betsWrap.className = 'ledger-bets';
      rec.bets.forEach((entry, i) => {
        const betLine = document.createElement('div');
        betLine.className = 'ledger-bet';
        const main = document.createElement('span');
        main.className = 'ledger-bet-main';
        if (rec.game === 'ssq') {
          entry.bet.reds.forEach((n) => main.appendChild(ballEl(n, 'ball-red', 'ball-sm')));
          const plus = document.createElement('span'); plus.className = 'plus'; plus.textContent = '+';
          main.appendChild(plus);
          main.appendChild(ballEl(entry.bet.blue, 'ball-blue', 'ball-sm'));
        } else {
          entry.bet.digits.forEach((d) => main.appendChild(ballEl(d, 'ball-red', 'ball-sm')));
        }
        const multi = document.createElement('span'); multi.className = 'bet-multi';
        multi.textContent = `× ${entry.multiplier}`;
        main.appendChild(multi);

        const money = document.createElement('span');
        money.className = 'ledger-bet-money';
        if (entry.prize > 0) {
          money.innerHTML = `<b class="prize">${fmtYuan(entry.prize)}</b><small> (投入 ${fmtYuan(entry.cost)})</small>`;
        } else {
          money.innerHTML = `<span class="noprize">投入 ${fmtYuan(entry.cost)}</span>`;
        }

        betLine.appendChild(main);
        betLine.appendChild(money);
        betsWrap.appendChild(betLine);
      });
      row.appendChild(betsWrap);

      const foot = document.createElement('div');
      foot.className = 'ledger-row-foot';
      const netLine = rec.totalPrize - rec.totalCost;
      foot.innerHTML = `
        <span>共 ${rec.bets.length} 注，投入 <b>${fmtYuan(rec.totalCost)}</b>，收益 <b>${fmtYuan(rec.totalPrize)}</b>
        ，<b class="${netLine >= 0 ? 'prize' : 'noprize'}">${netLine >= 0 ? '盈余 ' : '亏损 '}${fmtYuan(Math.abs(netLine))}</b></span>
        <button class="bet-del" title="删除此条记录">✕</button>
      `;
      foot.querySelector('.bet-del').onclick = () => {
        if (confirm('确定删除这条账本记录吗？')) {
          const idx = state.ledger.findIndex((l) => l.id === rec.id);
          if (idx >= 0) state.ledger.splice(idx, 1);
          saveLedger();
          renderLedger();
        }
      };
      row.appendChild(foot);

      detail.appendChild(row);
    });
  }
}

/* ================= 交互 ================= */
function addBet() {
  const game = state.game;
  const issue = nextIssueCode(game);
  if (!issue) return alert('开奖数据尚未获取，暂无法确定期号');

  let betData;
  if (game === 'ssq') {
    const { reds, blue, multiplier } = state.picker.ssq;
    if (reds.length !== 6 || blue === null) return;
    betData = { id: uid(), game, issue, reds: [...reds], blue, multiplier, purchasedAt: new Date().toISOString() };
    state.bets.ssq.push(betData);
    state.picker.ssq = { reds: [], blue: null, multiplier: 1 };
  } else {
    const { digits, multiplier } = state.picker['3d'];
    if (digits.some((d) => d === null)) return;
    betData = { id: uid(), game, issue, digits: [...digits], multiplier, purchasedAt: new Date().toISOString() };
    state.bets['3d'].push(betData);
    state.picker['3d'] = { digits: [null, null, null], multiplier: 1 };
  }
  saveBets();
  renderPicker();
  renderBets();
}

function randomFillPicker() {
  if (state.game === 'ssq') {
    const m = state.picker.ssq.multiplier;
    state.picker.ssq = { ...randomSsq(), multiplier: m };
  } else {
    const m = state.picker['3d'].multiplier;
    state.picker['3d'] = { ...randomD3(), multiplier: m };
  }
  renderPicker();
}
function clearPicker() {
  if (state.game === 'ssq') state.picker.ssq = { reds: [], blue: null, multiplier: state.picker.ssq.multiplier };
  else state.picker['3d'] = { digits: [null, null, null], multiplier: state.picker['3d'].multiplier };
  renderPicker();
}

function renderHeaderStatus(err) {
  const el = $('#headerStatus');
  const t = state.fetchedAt[state.game] ? new Date(state.fetchedAt[state.game]).toLocaleTimeString('zh-CN') : '';
  if (err) {
    el.classList.add('err');
    el.textContent = '开奖数据获取失败，点击"刷新"重试';
  } else {
    el.classList.remove('err');
    const draw = latestDraw(state.game);
    el.textContent = draw ? `已更新至第 ${draw.code} 期 · ${t}${state.stale[state.game] ? '（缓存）' : ''}` : '加载中…';
  }
}

function renderAll(err) {
  renderDraw();
  renderHistory();
  renderPicker();
  renderBets();
  renderLedger();
  renderHeaderStatus(err);
}

async function switchGame(game) {
  state.game = game;
  document.querySelectorAll('.game-tab').forEach((t) => t.classList.toggle('active', t.dataset.game === game));
  if (!state.draws[game]) {
    try { await fetchDraw(game); } catch { /* ignore */ }
  }
  // 切换彩种后，如果有新开奖要先自动归档再渲染
  autoArchive();
  renderAll(!state.draws[game]);
}

/* ================= 启动 ================= */
function bindEvents() {
  document.querySelectorAll('.game-tab').forEach((tab) => {
    tab.onclick = () => switchGame(tab.dataset.game);
  });
  $('#btnRefresh').onclick = async () => {
    $('#btnRefresh').disabled = true;
    try {
      await fetchDraw(state.game, { force: true });
      autoArchive();
      renderAll(false);
    } catch (err) {
      renderAll(true);
    } finally {
      $('#btnRefresh').disabled = false;
    }
  };
  $('#btnRandom').onclick = randomFillPicker;
  $('#btnClearPicker').onclick = clearPicker;
  $('#btnAddBet').onclick = addBet;

  // Tab 切换（开奖 / 投注 / 账本）
  document.querySelectorAll('.page-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.page-tab').forEach((t) => t.classList.toggle('active', t.dataset.page === tab.dataset.page));
      document.querySelectorAll('.page-section').forEach((s) => s.hidden = s.dataset.page !== tab.dataset.page);
    };
  });
}

async function init() {
  bindEvents();
  try { await fetchDraw('ssq'); } catch { /* ignore */ }
  autoArchive();
  renderAll(!state.draws.ssq);
  fetchDraw('3d').then(() => { autoArchive(); renderAll(false); }).catch(() => {});

  setInterval(async () => {
    try {
      await fetchDraw(state.game);
      autoArchive();
      renderAll(false);
    } catch {
      renderAll(true);
    }
  }, 5 * 60 * 1000);
}

init();
