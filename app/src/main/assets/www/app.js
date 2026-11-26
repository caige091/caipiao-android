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
const D3_MODE_NAME = { direct: '单选（直选）', group3: '组选三', group6: '组选六', legacy: '旧版自动判奖' };

const state = {
  game: 'ssq',
  draws: {},
  fetchedAt: {},
  stale: {},
  bets: loadBets(),        // { ssq: [], '3d': [] }
  ledger: loadLedger(),    // []
  picker: {
    ssq: { reds: [], blue: null, multiplier: 1 },
    '3d': { digits: [null, null, null], multiplier: 1, playMode: 'direct' },
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
function randomD3(playMode = 'direct') {
  if (playMode === 'group3') {
    const repeated = Math.floor(Math.random() * 10);
    const other = (repeated + 1 + Math.floor(Math.random() * 9)) % 10;
    const digits = [repeated, repeated, other];
    const singlePosition = Math.floor(Math.random() * 3);
    [digits[2], digits[singlePosition]] = [digits[singlePosition], digits[2]];
    return { digits };
  }
  if (playMode === 'group6') return { digits: shuffle(10).slice(0, 3).map((n) => n - 1) };
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
function nextIssueCode(game, now = new Date()) {
  const draw = latestDraw(game);
  if (!draw || state.stale[game]) return null;
  const code = String(draw.code);
  const datePart = String(draw.date || '').match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (!/^\d{4}\d{3}$/.test(code) || !datePart || Number(code.slice(4)) === 0) return null;
  // 用 UTC 表达日历日期，避免设备时区影响跨年和星期判断。
  const nextDate = new Date(datePart + 'T00:00:00Z');
  if (!Number.isFinite(nextDate.getTime()) || nextDate.toISOString().slice(0, 10) !== datePart
      || String(nextDate.getUTCFullYear()) !== code.slice(0, 4)) return null;
  const drawTimeOffset = (21 * 60 + 15 - 8 * 60) * 60_000;
  if (now.getTime() < nextDate.getTime() + drawTimeOffset) return null;
  do {
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  } while (game === 'ssq' && ![0, 2, 4].includes(nextDate.getUTCDay()));
  // 正常开奖日 21:15（北京时间）后仍无新数据时，不再绑定可能已开奖的旧期。
  // 休市或临时调整不能仅凭日历判断，等待官网更新后再确认期号。
  if (!Number.isFinite(now.getTime()) || now.getTime() >= nextDate.getTime() + drawTimeOffset) return null;
  const nextYear = String(nextDate.getUTCFullYear());
  const sequence = nextYear === code.slice(0, 4) ? Number(code.slice(4)) + 1 : 1;
  if (sequence > 999) return null;
  return nextYear + String(sequence).padStart(3, '0');
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
    const g = draw.prizegrades?.find((p) => Number(p.type) === level);
    const amount = Number(String(g?.typemoney ?? '').replace(/,/g, ''));
    unit = Number.isFinite(amount) && amount > 0 ? amount : null;
  }
  return { level, r, b, unit, name: level ? SSQ_LEVEL_NAME[level] : '' };
}

function checkD3(bet, draw) {
  const win = draw.red.split(',').map(Number);
  const mine = bet.digits;
  const exact = mine.every((d, i) => d === win[i]);
  const sameSet = [...mine].sort().join() === [...win].sort().join();
  const distinct = new Set(win).size;
  const mode = bet.playMode || 'legacy';

  // 无玩法字段的旧投注沿用旧版模拟判奖，避免静默改变已有投注含义。
  if ((mode === 'direct' || mode === 'legacy') && exact) return { level: 'direct', name: '直选中奖', unit: D3_PRIZE.direct };
  if ((mode === 'group3' || mode === 'legacy') && sameSet && distinct === 2) return { level: 'group3', name: '组选三中奖', unit: D3_PRIZE.group3 };
  if ((mode === 'group6' || mode === 'legacy') && sameSet && distinct === 3) return { level: 'group6', name: '组选六中奖', unit: D3_PRIZE.group6 };
  return { level: 0, name: '', unit: 0 };
}

/* ================= 自动归档 ================= */
// 仅使用投注对应期的完整开奖结果结算；缺少历史或浮动奖金时继续等待。
function autoArchive() {
  ['ssq', '3d'].forEach((game) => {
    const draw = latestDraw(game);
    if (!draw) return;
    const pending = state.bets[game]; // [{id, issue, reds/blue or digits, multiplier, purchasedAt}]
    const toArchive = pending.filter((b) => String(b.issue) <= String(draw.code)
      && state.draws[game].result.some((d) => String(d.code) === String(b.issue)));
    const settled = new Set();

    if (toArchive.length === 0) return;

    // 按 issue 分组，同一个期号的投注合并成一条 ledger 记录
    const grouped = {};
    toArchive.forEach((bet) => {
      if (!grouped[bet.issue]) grouped[bet.issue] = [];
      grouped[bet.issue].push(bet);
    });

    Object.keys(grouped).forEach((issue) => {
      const bets = grouped[issue];
      const targetDraw = state.draws[game].result.find((d) => String(d.code) === issue);

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
      if (checked.some((entry) => entry.unit === null)) return;

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
      bets.forEach((bet) => settled.add(bet.id));
    });

    state.bets[game] = pending.filter((bet) => !settled.has(bet.id));
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
  document.body.dataset.game = game;
  $('#drawGameName').textContent = conf.name;
  $('#scheduleTip').textContent = conf.schedule;
  ballsEl.innerHTML = '';

  if (!draw) {
    $('#drawIssue').textContent = '暂无数据';
    $('#drawDate').textContent = '';
    ballsEl.innerHTML = '<div class="draw-empty"><strong>等待同步开奖号码</strong><p>点击上方刷新，获取最新一期数据。</p></div>';
    $('#drawStats').innerHTML = '';
    $('#prizeTable').innerHTML = '<tr><td class="table-empty">同步开奖后显示本期奖金</td></tr>';
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
    const caption = document.createElement('span');
    caption.textContent = label;
    const amount = document.createElement('b');
    amount.textContent = val;
    div.append(caption, amount);
    stats.appendChild(div);
  });

  renderPrizeTable(draw);
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

/* ================= 渲染：中奖规则（无网络时仍可阅读） ================= */
function renderRules() {
  const ssq = state.game === 'ssq';
  $('#rulesTitle').textContent = `${GAME_CONF[state.game].name} · 中奖规则`;
  $('#rulesIntro').textContent = ssq
    ? '每注 2 元，选择 6 个红球和 1 个蓝球。红球顺序不限，蓝球须相同。下表按命中的最高奖级列出，不重复计奖。'
    : '每注 2 元，先选玩法，再选 3 位数字（每位 0–9）。只按投注时选择的玩法对奖，单选未中不会自动改为组选。';
  const rows = ssq ? [
    ['一等奖', '6 红 + 1 蓝', '浮动奖金，以当期公告为准'],
    ['二等奖', '6 红 + 0 蓝', '浮动奖金，以当期公告为准'],
    ['三等奖', '5 红 + 1 蓝', fmtYuan(SSQ_FIXED[3])],
    ['四等奖', '5 红 + 0 蓝，或 4 红 + 1 蓝', fmtYuan(SSQ_FIXED[4])],
    ['五等奖', '4 红 + 0 蓝，或 3 红 + 1 蓝', fmtYuan(SSQ_FIXED[5])],
    ['六等奖', '0–2 红 + 1 蓝', fmtYuan(SSQ_FIXED[6])],
    ['福运奖（有条件）', '特别规定期间，3 红 + 0 蓝', '¥5'],
  ] : [
    ['单选（直选）', '数字与位置全部一致。如选 123，只有开 123 才中。', fmtYuan(D3_PRIZE.direct)],
    ['组选三', '恰有两位相同，数字相同且顺序不限。如选 112，开 112、121、211 均中。', fmtYuan(D3_PRIZE.group3)],
    ['组选六', '三位各不相同，数字相同且顺序不限。如选 123，其 6 种排列均中。', fmtYuan(D3_PRIZE.group6)],
  ];
  const table = $('#rulesTable');
  table.innerHTML = '<thead><tr><th scope="col">奖级 / 玩法</th><th scope="col">中奖条件</th><th scope="col">单注基础奖金</th></tr></thead>';
  const body = document.createElement('tbody');
  rows.forEach((cells) => {
    const row = document.createElement('tr');
    cells.forEach((text, index) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (index === 0) cell.className = 'pname';
      row.appendChild(cell);
    });
    body.appendChild(row);
  });
  table.appendChild(body);
  $('#rulesNotes').innerHTML = (ssq
    ? '<p><strong>福运奖说明：</strong>2026 年规则规定，奖池达到 15 亿元触发特别规定，启动后持续至某期开奖后奖池低于 3 亿元时停止，具体启停以官方公告为准。3 红 + 1 蓝已中五等奖，不再叠加福运奖。</p>'
      + '<p><strong>模拟结算范围：</strong>当前仅计算一至六等奖基础奖金；福运奖、活动特别奖及翻番等奖金未自动计入。一、二等奖使用该期公告金额，未公布奖金时保留待结算。</p>'
    : '<p>组选三必须恰有两位相同，组选六必须三位各不相同；三位全同只能选择单选。旧版未标注玩法的投注保留原模拟判奖方式，并显示“旧版自动判奖”。当前只提供上述三种玩法，不含 1D、2D 等其他玩法及活动派奖。</p>')
    + '<p>倍数同时作用于投入和基础奖金。投注期号按正常开奖日推算；休市、临时调整以官方为准。数据过期或期号待确认时请先刷新。仅在应用打开并取得对应期开奖数据后自动结算；近 10 期未包含的旧期继续保留，不会用其他期代替。</p>';
  $('#rulesSource').innerHTML = ssq
    ? '规则核对：2026-11-26（现行规则自 2026014 期起执行）。依据：<a href="https://www.scflcp.com.cn/tzgg/823144831.jhtml">四川福彩规则公告</a>、<a href="https://www.gdfc.org.cn/datas/content/content_281592.html">广东福彩福运奖说明</a>。'
    : '规则核对：2026-11-26。依据：<a href="https://www.swlc.net.cn/games/3d.html">上海福彩 3D 游戏规则</a>。';
}

/* ================= 渲染：历史 ================= */
function renderHistory() {
  const game = state.game;
  const list = $('#historyList');
  list.innerHTML = '';
  const results = state.draws[game]?.result || [];
  if (!results.length) {
    list.innerHTML = '<div class="empty-tip"><strong>暂无开奖记录</strong><p>同步后显示最近 10 期号码。</p></div>';
    return;
  }
  results.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const issue = document.createElement('span');
    issue.className = 'history-issue';
    issue.textContent = `${d.code} 期`;
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = d.date;
    const top = document.createElement('div');
    top.className = 'history-top';
    top.append(issue, date);
    row.appendChild(top);

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
  const issue = nextIssueCode(game);
  $('#pickerIssue').textContent = issue ? `模拟投注：第 ${issue} 期` : '期号待确认，请刷新开奖数据';

  const area = $('#pickerArea');
  area.innerHTML = '';

  if (game === 'ssq') {
    const { reds, blue, multiplier } = state.picker.ssq;

    const redGroup = document.createElement('div');
    redGroup.className = 'picker-group';
    redGroup.innerHTML = `<div class="picker-group-label">红球（1-33，选 <b>6</b> 个，已选 <b>${reds.length}</b> 个）</div>`;
    const grid = document.createElement('div');
    grid.className = 'ball-grid';
    for (let n = 1; n <= 33; n++) {
      const b = document.createElement('button');
      b.className = 'ball-pick' + (reds.includes(n) ? ' sel-red' : '');
      b.textContent = pad2(n);
      b.setAttribute('aria-label', `红球 ${pad2(n)}`);
      b.setAttribute('aria-pressed', String(reds.includes(n)));
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
      b.setAttribute('aria-label', `蓝球 ${pad2(n)}`);
      b.setAttribute('aria-pressed', String(blue === n));
      b.onclick = () => {
        state.picker.ssq.blue = state.picker.ssq.blue === n ? null : n;
        renderPicker();
      };
      bgrid.appendChild(b);
    }
    blueGroup.appendChild(bgrid);
    area.appendChild(blueGroup);
    area.appendChild(buildMultiplierRow('ssq', multiplier));

    const done = reds.length === 6 && blue;
    const cost = done ? conf.price * multiplier : 0;
    $('#pickerTip').textContent = done
      ? `已选满，本注 × ${multiplier} 倍 = ${fmtYuan(cost)}，加入投注吧`
      : '请选 6 个红球 + 1 个蓝球';
    $('#btnAddBet').disabled = !done || !issue;
  } else {
    const { digits, multiplier, playMode } = state.picker['3d'];

    const modes = document.createElement('div');
    modes.className = 'play-mode-row';
    modes.innerHTML = '<span class="play-mode-label">选择玩法</span>';
    ['direct', 'group3', 'group6'].forEach((mode) => {
      const button = document.createElement('button');
      button.className = 'filter-btn' + (playMode === mode ? ' active' : '');
      button.textContent = D3_MODE_NAME[mode];
      button.setAttribute('aria-pressed', String(playMode === mode));
      button.onclick = () => { state.picker['3d'].playMode = mode; renderPicker(); };
      modes.appendChild(button);
    });
    area.appendChild(modes);

    const group = document.createElement('div');
    group.className = 'picker-group';
    group.innerHTML = '<div class="picker-group-label">选择一个 3 位号码（每位 0-9），按已选玩法对奖</div>';
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
        c.setAttribute('aria-label', `${label} ${n}`);
        c.setAttribute('aria-pressed', String(digits[idx] === n));
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
    area.appendChild(buildMultiplierRow('3d', multiplier));

    const complete = digits.every((d) => d !== null);
    const validMode = playMode === 'direct' || new Set(digits).size === (playMode === 'group3' ? 2 : 3);
    const done = complete && validMode;
    const cost = done ? conf.price * multiplier : 0;
    $('#pickerTip').textContent = done
      ? `${D3_MODE_NAME[playMode]}，本注 × ${multiplier} 倍 = ${fmtYuan(cost)}，加入投注吧`
      : !complete ? '请把百、十、个三位都选上'
        : playMode === 'group3' ? '组选三必须恰有两位数字相同' : '组选六必须三位数字各不相同';
    $('#btnAddBet').disabled = !done || !issue;
  }
}

function buildMultiplierRow(game, currentMultiplier) {
  const conf = GAME_CONF[game];
  const wrap = document.createElement('div');
  wrap.className = 'multiplier-row';
  wrap.innerHTML = '<span class="multiplier-label">投注倍数</span>';
  for (let m = 1; m <= 10; m++) {
    const btn = document.createElement('button');
    btn.className = 'multiplier-btn' + (m === currentMultiplier ? ' active' : '');
    btn.textContent = m;
    btn.setAttribute('aria-label', `${m} 倍`);
    btn.setAttribute('aria-pressed', String(m === currentMultiplier));
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

  $('#betIssueTag').textContent = issue ? `下一期：${issue}` : '期号待确认';
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

    const issueEl = document.createElement('span');
    issueEl.className = 'bet-issue';
    const overdue = draw && String(bet.issue) <= String(draw.code);
    issueEl.classList.toggle('pending', !!overdue);
    issueEl.textContent = `第 ${bet.issue} 期${game === '3d' ? ' · ' + D3_MODE_NAME[bet.playMode || 'legacy'] : ''}`
      + (overdue ? ' · 缺少该期完整开奖数据，暂未结算' : ' · 等待开奖');
    main.appendChild(issueEl);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;align-items:center;gap:8px';

    const del = document.createElement('button');
    del.className = 'bet-del'; del.textContent = '✕'; del.title = '删除此注';
    del.setAttribute('aria-label', `删除第 ${idx + 1} 注投注`);
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
    { label: '已结算净盈亏', value: (net < 0 ? '-' : '') + fmtYuan(Math.abs(net)), cls: `primary ${net >= 0 ? 'profit' : 'loss'}` },
    { label: '累计投入', value: fmtYuan(totalCost), cls: 'cost' },
    { label: '累计收益', value: fmtYuan(totalPrize), cls: 'prize' },
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
      btn.setAttribute('aria-pressed', String(state.ledgerFilter === f.v));
      btn.onclick = () => { state.ledgerFilter = f.v; renderLedger(); };
      filterWrap.appendChild(btn);
    });
  }

  // 明细列表
  const detail = $('#ledgerDetail');
  detail.innerHTML = '';
  if (filtered.length === 0) {
    detail.innerHTML = '<div class="empty-tip"><span class="empty-symbol" aria-hidden="true">≡</span><strong>还没有结算记录</strong><p>添加投注后，开奖结果会自动归档到这里。</p></div>';
  } else {
    filtered.forEach((rec) => {
      const row = document.createElement('div');
      row.className = `ledger-row ${rec.status === 'won' ? 'won' : ''}`;

      const head = document.createElement('div');
      head.className = 'ledger-row-head';
      head.innerHTML = `
        <span class="ledger-game tag-${rec.game}">${GAME_CONF[rec.game].name}</span>
        <span class="ledger-issue">第 ${rec.issue} 期 · ${rec.drawDate}</span>
        <span class="ledger-status ${rec.status}">${rec.status === 'won' ? '已中奖' : '未中'}</span>
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
        const result = document.createElement('span');
        result.className = 'bet-issue';
        result.textContent = (rec.game === '3d' ? D3_MODE_NAME[entry.bet.playMode || 'legacy'] + ' · ' : '')
          + (entry.name || '未中基础奖');
        main.appendChild(result);

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
        <button class="bet-del" title="删除此条记录" aria-label="删除第 ${rec.issue} 期账本记录">✕</button>
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
  if (!issue) return alert('期号待确认，请先刷新开奖数据后再投注');

  let betData;
  if (game === 'ssq') {
    const { reds, blue, multiplier } = state.picker.ssq;
    if (reds.length !== 6 || blue === null) return;
    betData = { id: uid(), game, issue, reds: [...reds], blue, multiplier, purchasedAt: new Date().toISOString() };
    state.bets.ssq.push(betData);
    state.picker.ssq = { reds: [], blue: null, multiplier: 1 };
  } else {
    const { digits, multiplier, playMode } = state.picker['3d'];
    if (digits.some((d) => d === null)) return;
    if (!['direct', 'group3', 'group6'].includes(playMode)) return;
    if (playMode === 'group3' && new Set(digits).size !== 2) return;
    if (playMode === 'group6' && new Set(digits).size !== 3) return;
    betData = { id: uid(), game, issue, digits: [...digits], multiplier, playMode, purchasedAt: new Date().toISOString() };
    state.bets['3d'].push(betData);
    state.picker['3d'] = { digits: [null, null, null], multiplier: 1, playMode };
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
    const { multiplier, playMode } = state.picker['3d'];
    state.picker['3d'] = { ...randomD3(playMode), multiplier, playMode };
  }
  renderPicker();
}
function clearPicker() {
  if (state.game === 'ssq') state.picker.ssq = { reds: [], blue: null, multiplier: state.picker.ssq.multiplier };
  else state.picker['3d'] = { ...state.picker['3d'], digits: [null, null, null] };
  renderPicker();
}

function renderHeaderStatus(err) {
  const el = $('#headerStatus');
  const t = state.fetchedAt[state.game] ? new Date(state.fetchedAt[state.game]).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
  if (err) {
    el.classList.add('err');
    el.textContent = latestDraw(state.game) ? '更新失败，正在显示上次数据' : '暂未获取开奖，请刷新重试';
  } else {
    el.classList.remove('err');
    const draw = latestDraw(state.game);
    el.textContent = draw ? (state.stale[state.game] ? '使用缓存，建议稍后刷新' : `${t} 已同步最新开奖`) : '正在同步开奖数据';
  }
}

function renderAll(err) {
  renderDraw();
  renderHistory();
  renderPicker();
  renderBets();
  renderLedger();
  renderRules();
  renderHeaderStatus(err);
}

async function switchGame(game) {
  state.game = game;
  document.querySelectorAll('.game-tab').forEach((t) => {
    const selected = t.dataset.game === game;
    t.classList.toggle('active', selected);
    t.setAttribute('aria-selected', String(selected));
  });
  if (!state.draws[game]) {
    try { await fetchDraw(game); } catch { /* ignore */ }
  }
  // 切换彩种后，如果有新开奖要先自动归档再渲染
  autoArchive();
  renderAll(!state.draws[game]);
  window.scrollTo(0, 0);
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

  // 底部导航切换；保留选号状态，返回页面顶部。
  document.querySelectorAll('.page-tab').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.page-tab').forEach((t) => {
        const selected = t.dataset.page === tab.dataset.page;
        t.classList.toggle('active', selected);
        if (selected) t.setAttribute('aria-current', 'page');
        else t.removeAttribute('aria-current');
      });
      document.querySelectorAll('.page-section').forEach((s) => s.hidden = s.dataset.page !== tab.dataset.page);
      window.scrollTo(0, 0);
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
