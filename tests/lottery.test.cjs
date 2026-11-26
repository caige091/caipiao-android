const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = path.join(__dirname, '../app/src/main/assets/www/app.js');
const appSource = fs.readFileSync(appPath, 'utf8').replace(/\binit\(\);\s*$/, '');

function createApp(saved = {}) {
  const storage = new Map(Object.entries(saved));
  const context = vm.createContext({
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  });
  vm.runInContext(appSource, context, { filename: appPath });
  return {
    storage,
    setState(patch) {
      context.patch = patch;
      vm.runInContext('Object.assign(state, patch)', context);
    },
    call(name, ...args) {
      context.args = args;
      const result = vm.runInContext(`${name}(...args)`, context);
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
    state() {
      return JSON.parse(vm.runInContext('JSON.stringify(state)', context));
    },
  };
}

function ssqDraw(overrides = {}) {
  return {
    code: '2026136',
    date: '2026-11-26(四)',
    red: '01,02,03,04,05,06',
    blue: '07',
    prizegrades: [
      { type: '1', typemoney: '8000000' },
      { type: '2', typemoney: '150000' },
    ],
    ...overrides,
  };
}

function ssqBet(overrides = {}) {
  return {
    id: 'ssq-bet',
    game: 'ssq',
    issue: '2026136',
    reds: [1, 2, 3, 4, 5, 6],
    blue: 7,
    multiplier: 1,
    ...overrides,
  };
}

test('双色球各奖级及容易混淆的未中奖组合', async (t) => {
  const app = createApp();
  const cases = [
    { name: '6红1蓝，一等奖', reds: [1, 2, 3, 4, 5, 6], blue: 7, level: 1, unit: 8000000 },
    { name: '6红0蓝，二等奖', reds: [1, 2, 3, 4, 5, 6], blue: 8, level: 2, unit: 150000 },
    { name: '5红1蓝，三等奖', reds: [1, 2, 3, 4, 5, 10], blue: 7, level: 3, unit: 3000 },
    { name: '5红0蓝，四等奖', reds: [1, 2, 3, 4, 5, 10], blue: 8, level: 4, unit: 200 },
    { name: '4红1蓝，四等奖', reds: [1, 2, 3, 4, 10, 11], blue: 7, level: 4, unit: 200 },
    { name: '4红0蓝，五等奖', reds: [1, 2, 3, 4, 10, 11], blue: 8, level: 5, unit: 10 },
    { name: '3红1蓝，五等奖', reds: [1, 2, 3, 10, 11, 12], blue: 7, level: 5, unit: 10 },
    { name: '2红1蓝，六等奖', reds: [1, 2, 10, 11, 12, 13], blue: 7, level: 6, unit: 5 },
    { name: '1红1蓝，六等奖', reds: [1, 10, 11, 12, 13, 14], blue: 7, level: 6, unit: 5 },
    { name: '0红1蓝，六等奖', reds: [10, 11, 12, 13, 14, 15], blue: 7, level: 6, unit: 5 },
    { name: '3红0蓝，不中普通奖', reds: [1, 2, 3, 10, 11, 12], blue: 8, level: 0, unit: 0 },
    { name: '2红0蓝，未中奖', reds: [1, 2, 10, 11, 12, 13], blue: 8, level: 0, unit: 0 },
    { name: '0红0蓝，未中奖', reds: [10, 11, 12, 13, 14, 15], blue: 8, level: 0, unit: 0 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const result = app.call('checkSsq', ssqBet(scenario), ssqDraw());
      assert.equal(result.level, scenario.level);
      assert.equal(result.unit, scenario.unit);
    });
  }
});

test('双色球浮动奖金兼容数字奖级字段，缺失奖金保持待定', () => {
  const app = createApp();
  assert.equal(app.call('checkSsq', ssqBet(), ssqDraw({
    prizegrades: [{ type: 1, typemoney: '5000000' }],
  })).unit, 5000000);
  for (const prizegrades of [[], [{ type: '1', typemoney: '' }], [{ type: '1', typemoney: '--' }]]) {
    const result = app.call('checkSsq', ssqBet(), ssqDraw({ prizegrades }));
    assert.equal(result.level, 1);
    assert.equal(result.unit, null);
  }
});

test('3D单选仅顺序完全一致中奖，不能自动改为组选', () => {
  const app = createApp();
  const draw = { red: '1,2,3' };
  assert.equal(app.call('checkD3', { digits: [1, 2, 3], playMode: 'direct' }, draw).unit, 1040);
  assert.equal(app.call('checkD3', { digits: [3, 2, 1], playMode: 'direct' }, draw).unit, 0);
  assert.equal(app.call('checkD3', { digits: [1, 1, 1], playMode: 'direct' }, { red: '1,1,1' }).unit, 1040);
});

test('3D机选号码始终符合所选玩法', () => {
  const app = createApp();
  for (const mode of ['direct', 'group3', 'group6']) {
    for (let i = 0; i < 100; i++) {
      const { digits } = app.call('randomD3', mode);
      assert.equal(digits.length, 3);
      assert.ok(digits.every((digit) => Number.isInteger(digit) && digit >= 0 && digit <= 9));
      if (mode === 'group3') assert.equal(new Set(digits).size, 2);
      if (mode === 'group6') assert.equal(new Set(digits).size, 3);
    }
  }
});

test('设备时间早于已有开奖时刻时不生成新投注期号', () => {
  const app = createApp();
  app.setState({ draws: { ssq: { result: [ssqDraw()] } } });
  assert.equal(app.call('nextIssueCode', 'ssq', new Date('2026-11-25T12:00:00Z')), null);
});

test('3D组选三按数字与重复次数匹配，无论顺序均仅支付组选奖金', () => {
  const app = createApp();
  const draw = { red: '1,1,2' };
  assert.equal(app.call('checkD3', { digits: [1, 1, 2], playMode: 'group3' }, draw).unit, 346);
  assert.equal(app.call('checkD3', { digits: [2, 1, 1], playMode: 'group3' }, draw).unit, 346);
  assert.equal(app.call('checkD3', { digits: [1, 2, 2], playMode: 'group3' }, draw).unit, 0);
  assert.equal(app.call('checkD3', { digits: [1, 1, 1], playMode: 'group3' }, { red: '1,1,1' }).unit, 0);
  assert.equal(app.call('checkD3', { digits: [1, 2, 3], playMode: 'group3' }, { red: '1,2,3' }).unit, 0);
});

test('3D组选六必须三个不同数字，顺序相同也只支付组选六奖金', () => {
  const app = createApp();
  const draw = { red: '1,2,3' };
  assert.equal(app.call('checkD3', { digits: [1, 2, 3], playMode: 'group6' }, draw).unit, 173);
  assert.equal(app.call('checkD3', { digits: [3, 1, 2], playMode: 'group6' }, draw).unit, 173);
  assert.equal(app.call('checkD3', { digits: [1, 2, 4], playMode: 'group6' }, draw).unit, 0);
  assert.equal(app.call('checkD3', { digits: [1, 1, 2], playMode: 'group6' }, { red: '1,1,2' }).unit, 0);
});

test('旧版无玩法字段的3D投注保留原有自动判奖语义', () => {
  const app = createApp();
  assert.equal(app.call('checkD3', { digits: [1, 2, 3] }, { red: '1,2,3' }).unit, 1040);
  assert.equal(app.call('checkD3', { digits: [3, 2, 1] }, { red: '1,2,3' }).unit, 173);
  assert.equal(app.call('checkD3', { digits: [2, 1, 1] }, { red: '1,1,2' }).unit, 346);
});

test('双色球跨年由下次开奖日决定，3D每日跨年重置为001', () => {
  const app = createApp();
  app.setState({ draws: {
    ssq: { result: [ssqDraw({ code: '2026153', date: '2026-12-31(四)' })] },
    '3d': { result: [{ code: '2026351', date: '2026-12-31' }] },
  } });
  const now = new Date('2026-12-31T22:00:00+08:00');
  assert.equal(app.call('nextIssueCode', 'ssq', now), '2027001');
  assert.equal(app.call('nextIssueCode', '3d', now), '2027001');
  assert.equal(app.call('nextIssueCode', 'ssq', new Date('2027-01-01T12:00:00+08:00')), '2027001');
});

test('同年期号递增并保留三位序号，双色球跳过无开奖的周五周六', () => {
  const app = createApp();
  app.setState({ draws: {
    ssq: { result: [ssqDraw({ code: '2027001', date: '2027-01-03' })] },
    '3d': { result: [{ code: '2027001', date: '2027-01-01' }] },
  } });
  assert.equal(app.call('nextIssueCode', 'ssq', new Date('2027-01-04T12:00:00+08:00')), '2027002');
  assert.equal(app.call('nextIssueCode', '3d', new Date('2027-01-02T12:00:00+08:00')), '2027002');
  app.setState({ draws: { ssq: { result: [ssqDraw()] } } });
  assert.equal(app.call('nextIssueCode', 'ssq', new Date('2026-11-28T22:00:00+08:00')), '2026137');
});

test('北京时间下一开奖时刻到达后阻止绑定可能已开奖的旧期号', () => {
  const app = createApp();
  app.setState({ draws: { ssq: { result: [ssqDraw({ code: '2026135', date: '2026-11-24' })] } } });
  assert.equal(app.call('nextIssueCode', 'ssq', new Date('2026-11-26T13:14:59.999Z')), '2026136');
  assert.equal(app.call('nextIssueCode', 'ssq', new Date('2026-11-26T13:15:00Z')), null);
  assert.equal(app.call('nextIssueCode', 'ssq', new Date('2027-01-01T12:00:00+08:00')), null);
  app.setState({ draws: { '3d': { result: [{ code: '2026300', date: '2026-11-24' }] } } });
  assert.equal(app.call('nextIssueCode', '3d', new Date('2026-11-25T21:15:00+08:00')), null);
});

test('缺少或无效开奖数据、过期缓存不产生可投注期号', () => {
  const app = createApp();
  const now = new Date('2026-11-26T12:00:00+08:00');
  assert.equal(app.call('nextIssueCode', 'ssq', now), null);
  for (const draw of [
    ssqDraw({ code: 'not-an-issue' }),
    ssqDraw({ date: '' }),
    ssqDraw({ date: 'not-a-date' }),
    ssqDraw({ date: '2026-13-40' }),
  ]) {
    app.setState({ draws: { ssq: { result: [draw] } } });
    assert.equal(app.call('nextIssueCode', 'ssq', now), null);
  }
  app.setState({ draws: { ssq: { result: [ssqDraw()] } }, stale: { ssq: true } });
  assert.equal(app.call('nextIssueCode', 'ssq', now), null);
});

test('缺失历史期保留待结算，有精确历史结果才归档，未来投注不受影响', () => {
  const app = createApp();
  app.setState({
    draws: { ssq: { result: [ssqDraw(), ssqDraw({ code: '2026135', blue: '08' })] } },
    bets: { ssq: [
      ssqBet({ id: 'missing-history', issue: '2026001' }),
      ssqBet({ id: 'historical', issue: '2026135' }),
      ssqBet({ id: 'future', issue: '2026137' }),
    ], '3d': [] },
  });
  app.call('autoArchive');
  const { bets, ledger } = app.state();
  assert.deepEqual(bets.ssq.map((bet) => bet.id), ['missing-history', 'future']);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].issue, '2026135');
  assert.equal(ledger[0].drawCode, '2026135');
  assert.equal(ledger[0].totalPrize, 150000);
  assert.equal(ledger[0].bets[0].bet.id, 'historical');
});

test('同一期多注按倍数结算，持久化且反复刷新不会重复归档', () => {
  const app = createApp();
  app.setState({
    draws: { ssq: { result: [ssqDraw()] } },
    bets: { ssq: [
      ssqBet({ id: 'third', reds: [1, 2, 3, 4, 5, 10], multiplier: 3 }),
      ssqBet({ id: 'sixth', reds: [10, 11, 12, 13, 14, 15], multiplier: 2 }),
    ], '3d': [] },
  });
  app.call('autoArchive');
  app.call('autoArchive');
  const { bets, ledger } = app.state();
  assert.equal(bets.ssq.length, 0);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].totalCost, 10);
  assert.equal(ledger[0].totalPrize, 9010);
  assert.equal(ledger[0].status, 'won');
  assert.deepEqual(ledger[0].bets.map((entry) => entry.prize), [9000, 10]);
  assert.equal(JSON.parse(app.storage.get('lottery-ledger')).length, 1);
  assert.deepEqual(JSON.parse(app.storage.get('lottery-bets-v2')).ssq, []);
});

test('浮动奖金尚未公布时整期保留，公布后只结算一次', () => {
  const app = createApp();
  app.setState({
    draws: { ssq: { result: [ssqDraw({ prizegrades: [] })] } },
    bets: { ssq: [ssqBet(), ssqBet({ id: 'fixed', reds: [1, 2, 3, 4, 5, 10] })], '3d': [] },
  });
  app.call('autoArchive');
  assert.equal(app.state().ledger.length, 0);
  assert.equal(app.state().bets.ssq.length, 2);
  app.setState({ draws: { ssq: { result: [ssqDraw()] } } });
  app.call('autoArchive');
  app.call('autoArchive');
  assert.equal(app.state().ledger.length, 1);
  assert.equal(app.state().ledger[0].totalPrize, 8003000);
  assert.equal(app.state().bets.ssq.length, 0);
});

test('3D明确玩法的多倍奖金可正确归档', () => {
  const app = createApp();
  app.setState({
    draws: { '3d': { result: [{ code: '2026300', date: '2026-11-24', red: '1,2,3' }] } },
    bets: { ssq: [], '3d': [
      { id: 'group', issue: '2026300', digits: [1, 2, 3], playMode: 'group6', multiplier: 2 },
      { id: 'direct-miss', issue: '2026300', digits: [3, 2, 1], playMode: 'direct', multiplier: 1 },
    ] },
  });
  app.call('autoArchive');
  const record = app.state().ledger[0];
  assert.equal(record.totalCost, 6);
  assert.equal(record.totalPrize, 346);
  assert.deepEqual(record.bets.map((entry) => entry.prize), [346, 0]);
});

test('升级保留现有v2投注和账本，不回写或重算旧账本', () => {
  const previousBet = { id: 'old-3d', issue: '2026200', digits: [3, 2, 1], multiplier: 2 };
  const previousLedger = { id: 'old-ledger', game: 'ssq', issue: '2026100', totalCost: 2, totalPrize: 5, bets: [] };
  const app = createApp({
    'lottery-bets-v2': JSON.stringify({ ssq: [], '3d': [previousBet] }),
    'lottery-ledger': JSON.stringify([previousLedger]),
  });
  app.call('autoArchive');
  assert.deepEqual(app.state().bets['3d'], [previousBet]);
  assert.deepEqual(app.state().ledger, [previousLedger]);
});
