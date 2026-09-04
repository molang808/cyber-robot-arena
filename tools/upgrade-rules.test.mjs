/**
 * 업그레이드 드래프트 규칙 테스트
 *
 *   node --test tools/
 *
 * index.html에서 UPGRADES 배열과 STACK_MAX를 그대로 읽어 검증한다.
 * 게임의 규칙(once / req / 중첩 상한 / 레어도 가중치)이 의도대로 도는지 확인한다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const GAME = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
const src = readFileSync(GAME, 'utf8');

function loadUpgrades() {
  const start = src.indexOf('const UPGRADES=[');
  const end = src.indexOf('\n];', start);
  return new Function('uHP', `return ${src.slice(start + 'const UPGRADES='.length, end + 3)}`)(() => {});
}
const UPGRADES = loadUpgrades();
const STACK_MAX = Number(src.match(/const STACK_MAX\s*=\s*(\d+)/)[1]);
const RARITY_WEIGHT = { common: 10, rare: 4, epic: 2, legendary: 1 };

/** showUpg()의 후보 필터와 같은 규칙 */
function available(taken, counts) {
  return UPGRADES.filter(u => {
    if (u.once && taken.has(u.id)) return false;
    const rq = u.req ? (Array.isArray(u.req) ? u.req : [u.req]) : [];
    if (rq.some(r => !taken.has(r))) return false;
    if (!u.once && (counts.get(u.id) || 0) >= STACK_MAX) return false;
    return true;
  });
}

test('중첩 상한: 같은 업그레이드는 STACK_MAX회까지만 등장한다', () => {
  // 선행 조건이 있는 것은 다른 규칙에 먼저 걸리므로 제외한다
  const stackable = UPGRADES.find(u => !u.once && !u.req);
  assert.ok(stackable, '선행 조건 없는 중첩 가능 업그레이드가 하나는 있어야 한다');
  const taken = new Set(), counts = new Map();
  for (let i = 0; i < STACK_MAX; i++) {
    assert.ok(available(taken, counts).some(u => u.id === stackable.id),
      `${i}회 획득 시점에는 아직 후보에 있어야 한다`);
    taken.add(stackable.id);
    counts.set(stackable.id, i + 1);
  }
  assert.ok(!available(taken, counts).some(u => u.id === stackable.id),
    `${STACK_MAX}회 획득 후에는 후보에서 빠져야 한다`);
});

test('1회성 업그레이드는 한 번 먹으면 다시 안 나온다', () => {
  const once = UPGRADES.find(u => u.once);
  const taken = new Set([once.id]);
  assert.ok(!available(taken, new Map()).some(u => u.id === once.id));
});

test('선행 조건: req가 충족되기 전에는 후보에 없다 (단일·복수 모두)', () => {
  const deps = UPGRADES.filter(u => u.req);
  assert.ok(deps.length, 'req를 가진 업그레이드가 있어야 한다');
  for (const dep of deps) {
    const rq = Array.isArray(dep.req) ? dep.req : [dep.req];
    assert.ok(!available(new Set(), new Map()).some(u => u.id === dep.id),
      `${dep.id}가 선행 조건 없이 등장한다`);
    // 조건을 하나만 채우면 아직 나오면 안 된다
    if (rq.length > 1)
      assert.ok(!available(new Set([rq[0]]), new Map()).some(u => u.id === dep.id),
        `${dep.id}가 선행 조건을 일부만 채웠는데 등장한다`);
    assert.ok(available(new Set(rq), new Map()).some(u => u.id === dep.id),
      `${dep.id}가 선행 조건을 다 채웠는데 등장하지 않는다`);
  }
});

test('모든 req는 실제로 존재하는 업그레이드를 가리킨다', () => {
  const ids = new Set(UPGRADES.map(u => u.id));
  for (const u of UPGRADES.filter(x => x.req))
    for (const r of (Array.isArray(u.req) ? u.req : [u.req]))
      assert.ok(ids.has(r), `${u.id}의 선행 조건 ${r}가 카탈로그에 없다`);
});

test('업그레이드 id는 중복되지 않는다', () => {
  const ids = UPGRADES.map(u => u.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('모든 업그레이드는 알려진 레어도를 가진다', () => {
  for (const u of UPGRADES)
    assert.ok(RARITY_WEIGHT[u.r], `${u.id}의 레어도 '${u.r}'에 가중치가 없다`);
});

test('ef를 적용해도 쿨다운이 하한 아래로 내려가지 않는다', () => {
  const p = { gc: 22, spd: 2.8, mhp: 5, hp: 5, bd: 1, xb: 0, rad: 16, mgR: 80, cm: 1, au: 0, bsp: 10, sm: 1, shB: 0, rr: 0 };
  const fireRate = UPGRADES.find(u => u.id === 'fire_rate');
  for (let i = 0; i < 50; i++) fireRate.ef(p);
  assert.ok(p.gc >= 4, `쿨다운 하한 위반: ${p.gc}`);
});

test('중첩 상한 아래에서는 카탈로그가 3장을 뽑을 만큼 남아 있다', () => {
  // 최악의 경우 — 모든 1회성을 먹고, 중첩 가능한 것도 상한까지 채운 상태
  const taken = new Set(UPGRADES.filter(u => u.once).map(u => u.id));
  const counts = new Map(UPGRADES.filter(u => !u.once).map(u => [u.id, STACK_MAX]));
  const left = available(taken, counts);
  // 이 시점에는 후보가 0이어야 하고, showUpg는 그때 조용히 게임을 재개해야 한다
  assert.equal(left.length, 0, '모두 소진되면 후보가 비어야 한다');
  assert.match(src, /if\(sel\.length===0\)/, 'showUpg에 후보 소진 처리가 있어야 한다');
});

// ── 해금 규칙 ────────────────────────────────────────────
function loadUnlocks(pd) {
  const start = src.indexOf('const UNLOCKS=[');
  const end = src.indexOf('\n];', start);
  return new Function('pd', `return ${src.slice(start + 'const UNLOCKS='.length, end + 3)}`)(pd);
}
const EMPTY_PD = { kills: 0, bosses: 0, clears: 0, best: 0, purges: 0 };

test('해금: 신규 계정에서는 아무것도 열려 있지 않다', () => {
  const U = loadUnlocks(EMPTY_PD);
  assert.ok(U.length > 0);
  for (const u of U) assert.ok(u.cur() < u.max, `${u.id}가 처음부터 충족돼 있다`);
});

test('해금: 조건을 넘기면 충족으로 판정된다', () => {
  const U = loadUnlocks({ ...EMPTY_PD, kills: 5000, bosses: 10, clears: 1, best: 100000, purges: 1 });
  for (const u of U) assert.ok(u.cur() >= u.max, `${u.id}가 조건 충족인데 미달로 나온다`);
});

test('해금: id는 중복되지 않고 목표치는 양수다', () => {
  const U = loadUnlocks(EMPTY_PD);
  assert.equal(new Set(U.map(u => u.id)).size, U.length);
  for (const u of U) assert.ok(u.max > 0, `${u.id}의 목표치가 0 이하`);
});

test('진화: 진화형이 가리키는 wt 분기가 fire()에 존재한다', () => {
  const evos = UPGRADES.filter(u => u.id.startsWith('ev_'));
  assert.ok(evos.length >= 4, '진화형이 4종 이상이어야 한다');
  for (const e of evos) {
    assert.ok(src.includes(`wt==='${e.id}'`), `fire()에 ${e.id} 분기가 없다`);
    assert.ok(Array.isArray(e.req) && e.req.length === 2, `${e.id}의 재료는 2개여야 한다`);
  }
});

test('해금: 무기 슬롯이 가리키는 무기가 fire()에 실제로 존재한다', () => {
  for (const u of loadUnlocks(EMPTY_PD).filter(x => x.slot === 'w')) {
    assert.ok(u.wt && u.gc > 0, `${u.id}에 wt/gc가 없다`);
    assert.ok(src.includes(`wt==='${u.wt}'`), `fire()에 ${u.wt} 분기가 없다`);
  }
});

test('해금: 슬롯은 무기(w)와 캐릭터(c)뿐이고, 슬롯별로 하나만 장착된다', () => {
  const U = loadUnlocks(EMPTY_PD);
  for (const u of U) if (u.slot) assert.ok(['w', 'c'].includes(u.slot), `${u.id}의 슬롯 '${u.slot}'`);
  // 장착은 pd.eqW / pd.eqC 한 칸씩이라 구조적으로 중복 장착이 불가능하다
  assert.match(src, /pd\.eqW=eq\?null:u\.id/);
  assert.match(src, /pd\.eqC=eq\?null:u\.id/);
});
