#!/usr/bin/env node
/**
 * 밸런스 시뮬레이터
 *
 * 질문: "이 게임은 몇 점에서 무너지는가?"
 *
 * 적의 압박 지표(스폰 간격·동시 최대·이동 속도)에는 전부 상한이 걸려 있는 반면
 * 플레이어 성장에는 상한이 없다. 두 곡선이 교차하는 지점을 수치로 찾는다.
 *
 * index.html에서 UPGRADES 배열을 그대로 읽어 실제 ef 함수를 재사용하므로
 * 게임의 밸런스가 바뀌면 이 시뮬레이터의 결과도 함께 바뀐다.
 *
 *   node tools/balance-sim.mjs                    # 기본 200판, 무작위 선택
 *   node tools/balance-sim.mjs --runs 1000
 *   node tools/balance-sim.mjs --strategy greedy  # DPS 최대화 플레이어
 *   node tools/balance-sim.mjs --csv > out.csv
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAME = join(HERE, '..', 'index.html');

// ── 게임에서 업그레이드 테이블 추출 ────────────────────────────
// ef는 플레이어를 직접 변형하는 함수라 그대로 가져다 쓸 수 있다.
// 일부 ef가 UI 갱신 함수 uHP()를 호출하므로 no-op을 주입한다.
function loadUpgrades() {
  const src = readFileSync(GAME, 'utf8');
  const key = 'const UPGRADES=[';
  const start = src.indexOf(key);
  if (start < 0) throw new Error('index.html에서 UPGRADES 배열을 찾지 못했다');
  const end = src.indexOf('\n];', start);
  if (end < 0) throw new Error('UPGRADES 배열의 끝을 찾지 못했다');
  const arraySrc = src.slice(start + 'const UPGRADES='.length, end + 3);
  return new Function('uHP', `return ${arraySrc}`)(() => {});
}

// ── 게임 상수 (index.html과 동일하게 유지할 것) ─────────────────
const RARITY_WEIGHT = { common: 10, rare: 4, epic: 2, legendary: 1 };

// 곱연산으로 DPS에 직접 곱해지는 축. 이 셋이 서로 곱해지면서 발산한다.
const MULT_AXES = new Set(['damage_up', 'multishot', 'fire_rate']);

// 게임에서 중첩 상한을 읽어온다 — 손으로 동기화하지 않는다
function loadStackMax() {
  const m = readFileSync(GAME, 'utf8').match(/const STACK_MAX\s*=\s*(\d+)/);
  return m ? Number(m[1]) : Infinity;
}
const GAME_STACK_MAX = loadStackMax();

// 메타 진행 — 판당 크레딧 축적량
// 적 처치 시 30% 확률로 아이템, 그중 코인이 가중치 14/24, 코인 값은 random(10~65).
const ITEM_DROP = 0.30, COIN_SHARE = 14 / 24, COIN_AVG = 37.5;
// 영구 상점 10라인의 기준가 (showShop과 동일)
const SHOP_BASE = [1200, 960, 800, 1040, 1440, 1760, 1280, 1600, 2000, 1360];
const shopCostToLevel = lv => SHOP_BASE.reduce((s, b) => s + b * (lv * (lv + 1) / 2), 0);

// 런 종료 조건 (index.html과 동일하게 유지할 것)
const RUN_SEC = 600;      // 10분 생존 = 클리어
const PURGE_SEC = 480;    // 8분에 최종 유닛 등장
const purgeHP = t => Math.floor(900 + t * 6);
const megaHP  = t => Math.floor(80 + t * 2.4);
const bossHP  = t => Math.floor(30 + t * 0.8);
const CRIT_CHANCE = 0.15;
const CRIT_MULT = 2.5;
const CRIT_AVG = 1 - CRIT_CHANCE + CRIT_CHANCE * CRIT_MULT; // 1.225

// 적 종류별 출현 확률과 점수 (Obstacle 생성자에서)
const ENEMY_MIX = [
  { typ: 'normal', p: 0.73, pts: 20, hp: d => 1 + Math.floor(d * 0.6),  spdMul: 1.0  },
  { typ: 'fast',   p: 0.12, pts: 35, hp: () => 1,                        spdMul: 2.1  },
  { typ: 'tank',   p: 0.08, pts: 60, hp: d => 6 + Math.floor(d * 1.1),  spdMul: 0.45 },
  { typ: 'bomber', p: 0.07, pts: 40, hp: () => 2,                        spdMul: 1.0  },
];

/**
 * 무기별 "1회 발사당 총 데미지" — fire()에서 그대로 옮긴 계수.
 * 빔 계열(laser/rail/chain)은 mk()를 거치지 않으므로 크리티컬이 붙지 않는다.
 */
/**
 * hit — 무기별 유효 명중 계수. 전역 명중률에 곱해진다.
 *
 * 확산탄을 한 방향으로 뿌리는 무기는 발사한 탄환이 전부 표적에 닿지 않는다.
 * flame은 ±0.55rad(±31°) 랜덤 확산에 탄 수명도 짧고, shotgun은 7방향으로 갈라진다.
 * 반대로 빔·유도·연쇄 계열은 표적을 직접 노리므로 손실이 거의 없다.
 * 정확한 값은 실측이 필요하지만, 전역 명중률 하나로 모든 무기를 같게 두면
 * 확산 무기의 DPS가 구조적으로 과대평가된다.
 */
const WEAPON_DPS = {
  //          발사당 데미지                                     크리    유효명중  다중타격
  pistol:   { dmg: (d, xb) => d * 0.6  * (1 + xb),        crit: true,  hit: 1.0,  multi: 1.0 },
  plasma:   { dmg: (d, xb) => d * 2.1  * (1 + xb),        crit: true,  hit: 0.95, multi: 2.0 },
  shotgun:  { dmg: (d, xb) => d * 1.75 * (7 + xb),               crit: true,  hit: 0.5,  multi: 1.0 },
  laser:    { dmg: (d)     => d * 6.9,                   crit: false, hit: 1.0,  multi: 3.0 },
  dualgun:  { dmg: (d, xb) => d * 0.86 * (2 + xb),        crit: true,  hit: 0.95, multi: 1.0 },
  sniper:   { dmg: (d)     => d * 8.4,                      crit: true,  hit: 1.0,  multi: 2.5 },
  flame:    { dmg: (d, xb) => d * 0.42 * Math.min(8 + xb * 2, 16), crit: true, hit: 0.3, multi: 1.0 },
  ricochet: { dmg: (d)     => d * 2.1,                          crit: true,  hit: 1.0,  multi: 4.0 },
  missile:  { dmg: (d, xb) => d * 1.65 * (1 + xb),           crit: true,  hit: 1.0,  multi: 2.0 },
  rail:     { dmg: (d)     => d * 5.8,                      crit: false, hit: 1.0,  multi: 4.0 },
  gatling:  { dmg: (d, xb) => d * 0.75 * (1 + xb),         crit: true,  hit: 0.85, multi: 1.0 },
  cannon:   { dmg: (d)     => d * 11,                      crit: false, hit: 1.0,  multi: 3.0 },
  chain:    { dmg: (d, xb) => d * 2.7 * (4 + xb),               crit: false, hit: 1.0,  multi: 1.0 },
};

// ── 플레이어 초기 상태 (Player 생성자, 영구 강화 0단계 기준) ────
function newPlayer() {
  return {
    spd: 2.8, mhp: 5, hp: 5, bd: 1, au: 0,
    wt: 'pistol', gc: 22, xb: 0, bsp: 10, rad: 16, mgR: 80, cm: 1,
    pr: false, hm: false, ae: false, lc: false,
    sm: 1, shB: 0, rr: 0,
    gcBase: 22,
    orbBlades: 0, coldField: false, berserker: false, phoenix: false,
    mirrorShield: false, comboBoost: false, vampire: false,
    superMagnet: false, bombDrop: false, drone: false,
  };
}

// ── 파생 지표 ─────────────────────────────────────────────────
function playerDPS(p) {
  const w = WEAPON_DPS[p.wt] ?? WEAPON_DPS.pistol;
  const perShot = w.dmg(p.bd, p.xb) * (w.crit ? CRIT_AVG : 1) * (w.hit ?? 1) * (w.multi ?? 1);
  const shotsPerSec = 60 / p.gc;
  let dps = perShot * shotsPerSec;
  // 무기와 무관한 지속 피해원
  if (p.au > 0) dps += p.au * 0.4 * (60 / 25);          // 전기 오라: 25프레임마다
  if (p.orbBlades > 0) dps += p.orbBlades * p.bd * 2;    // 공전 검 근사
  if (p.bombDrop) dps += (p.bd * 3) / 5;                 // 5초마다 폭탄
  return dps;
}

/**
 * 이 모델의 가장 큰 가정.
 * 이론 DPS 전부가 적에게 꽂히지는 않는다 — 빗나가고, 탄이 날아가는 시간이 있고,
 * 회피하느라 조준이 끊긴다. 실측 없이는 알 수 없는 값이라 파라미터로 두고
 * 민감도를 함께 본다. (--accuracy 로 조정)
 */
const DEFAULT_ACCURACY = 0.35;

// 적 압박 — 난이도 시계는 점수가 아니라 경과 시간(초)에 종속된다
function pressure(t) {
  const wave = 1 + Math.floor(t / 15);
  const diff = 1 + t * 0.012;
  const iv = Math.max(16, 75 - wave * 4);                     // 하한 16프레임
  const maxObs = Math.min(25 + wave * 3, 80);                 // 상한 80마리
  let spawnPerSec = 60 / iv;
  if (wave >= 3) spawnPerSec += 60 / (iv * 2 + 3);
  if (wave >= 6) spawnPerSec += 60 / (iv * 3 + 7);
  const avgHP = ENEMY_MIX.reduce((s, e) => s + e.p * e.hp(diff), 0);
  const avgPts = ENEMY_MIX.reduce((s, e) => s + e.p * e.pts, 0);
  // 적 이동 속도: (1.4~3.0) × min(diff, 4.2) — 상한이 걸려 있다
  const baseSpd = 2.2 * Math.min(diff, 4.2);                  // 기댓값
  const fastSpd = baseSpd * 2.1;
  return { wave, diff, iv, maxObs, spawnPerSec, avgHP, avgPts, baseSpd, fastSpd };
}

// ── 업그레이드 드래프트 (showUpg의 추첨 규칙과 동일) ────────────
/**
 * 성장 상한 정책
 *   none      기준선 — 상한 없음
 *   slots:N   총 획득 개수를 N개로 제한 (뱀서의 무기6+패시브6에 해당)
 *   stack:K   같은 업그레이드를 최대 K회까지만
 *   decay     중첩할수록 등장 가중치가 w/(1+획득횟수)로 감소
 */
function parseCap(str) {
  if (!str || str === 'none') return { mode: 'none', label: 'none' };
  const [mode, arg] = str.split(':');
  if (mode === 'slots') return { mode, n: Number(arg || 20), label: `slots:${arg || 20}` };
  if (mode === 'stack') return { mode, k: Number(arg || 5), label: `stack:${arg || 5}` };
  if (mode === 'decay') return { mode, label: 'decay' };
  // wfloor — 쿨다운 하한을 무기 고유 쿨다운의 40%로 둔다.
  // 전역 쿨다운 감소가 무기별 밸런스(느리고 강함 vs 빠르고 약함)를 무너뜨리는 것을 막는다.
  if (mode === 'wfloor') return { mode, ratio: Number(arg || 0.4), label: `wfloor:${arg || 0.4}` };
  if (mode === 'wfloor+stack') return { mode: 'wfloor', ratio: 0.4, stackK: Number(arg || 5), label: `wfloor+stack:${arg || 5}` };
  // mult — 곱연산 DPS 축(데미지·탄환수·연사)만 K회로 제한하는 비대칭 정책.
  // 방어·유틸 업그레이드는 그대로 두므로 선택을 분산하는 플레이어는 거의 영향받지 않고,
  // 한 축에 몰아넣는 최적화 플레이어만 걸린다.
  if (mode === 'mult') return { mode, k: Number(arg || 3), label: `mult:${arg || 3}` };
  if (mode === 'mult+wfloor') return { mode: 'mult', k: Number(arg || 3), wfloor: 0.4, label: `mult:${arg || 3}+wfloor` };
  throw new Error(`알 수 없는 상한 정책: ${str}`);
}

function draft(upgrades, takenIds, counts, rng, cap) {
  const available = upgrades.filter(u => {
    if (u.once && takenIds.has(u.id)) return false;
    if (u.req && !takenIds.has(u.req)) return false;
    if (cap.mode === 'stack' && (counts.get(u.id) || 0) >= cap.k) return false;
    if (cap.stackK && (counts.get(u.id) || 0) >= cap.stackK) return false;
    if (cap.mode === 'mult' && MULT_AXES.has(u.id) && (counts.get(u.id) || 0) >= cap.k) return false;
    return true;
  });
  const pool = available.flatMap(u => {
    let w = RARITY_WEIGHT[u.r] ?? 5;
    if (cap.mode === 'decay') w = Math.max(1, Math.round(w / (1 + (counts.get(u.id) || 0))));
    return Array(w).fill(u);
  });
  const sel = [], used = new Set();
  let tries = 0;
  while (sel.length < 3 && tries < 400) {
    tries++;
    if (!pool.length) break;
    const u = pool[Math.floor(rng() * pool.length)];
    if (!used.has(u.id)) { used.add(u.id); sel.push(u); }
  }
  return sel;
}

function choose(cards, player, strategy, rng) {
  if (cards.length === 0) return null;
  if (strategy === 'random') return cards[Math.floor(rng() * cards.length)];
  // greedy — 적용해본 뒤 DPS가 가장 높아지는 카드를 고른다
  let best = cards[0], bestDps = -1;
  for (const c of cards) {
    const probe = { ...player };
    try { c.ef(probe); } catch { continue; }
    const d = playerDPS(probe);
    if (d > bestDps) { bestDps = d; best = c; }
  }
  return best;
}

// 업그레이드 마일스톤 (gLoop과 동일)
const upgGap = score => (score < 2000 ? 200 : 200 + Math.floor((score - 2000) / 500) * 50);

// ── 한 판 시뮬레이션 ──────────────────────────────────────────
function simulate(upgrades, { strategy, rng, maxSeconds = 3600, accuracy = DEFAULT_ACCURACY, combo: comboOn = true, cap = { mode: 'none' } }) {
  const p = newPlayer();
  const taken = new Set();
  const counts = new Map();
  let score = 0, xp = 0, t = 0, combo = 0, nextUpg = upgGap(0), picks = 0, credits = 0, totalKills = 0;
  const samples = [];
  let breakPoint = null;   // 처리량 여유가 3배를 넘어선 첫 시점

  for (t = 1; t <= maxSeconds; t++) {
    const pr = pressure(t);
    const dps = playerDPS(p) * accuracy;

    // 초당 처치 수 — 스폰량을 넘어설 수는 없다
    const canKill = dps / pr.avgHP;
    const kills = Math.min(canKill, pr.spawnPerSec);
    // 처리량 여유: 1보다 크면 스폰을 전부 감당하고도 남는다
    const headroom = canKill / pr.spawnPerSec;

    // 콤보 — 2초 안에 계속 죽이면 끊기지 않는다
    if (comboOn && kills > 0.5) combo += kills; else combo = 0;
    const comboMult = comboOn ? 1 + Math.floor(combo / (p.comboBoost ? 2.5 : 5)) * 0.2 : 1;

    score += kills * pr.avgPts * comboMult;   // 표시용 — 콤보 포함
    xp    += kills * pr.avgPts;                // 성장용 — 콤보 미적용
    totalKills += kills;
    credits += kills * ITEM_DROP * COIN_SHARE * COIN_AVG;   // 콤보 배수는 붙지 않는다

    if (headroom >= 3 && breakPoint === null && t > 5) {
      breakPoint = { t, score: Math.round(score), picks, headroom };
    }

    while (xp >= nextUpg) {
      if (cap.mode === 'slots' && picks >= cap.n) { nextUpg = Infinity; break; }
      const cards = draft(upgrades, taken, counts, rng, cap);
      const pick = choose(cards, p, strategy, rng);
      if (pick) {
        const wtBefore = p.wt;
        try { pick.ef(p); } catch {}
        // 무기를 새로 집으면 그 무기의 고유 쿨다운을 기준값으로 기록한다
        if (p.wt !== wtBefore) p.gcBase = p.gc;
        const wf = cap.mode === 'wfloor' ? cap.ratio : cap.wfloor;
        if (wf) p.gc = Math.max(p.gc, Math.ceil((p.gcBase ?? 22) * wf));
        taken.add(pick.id);
        counts.set(pick.id, (counts.get(pick.id) || 0) + 1);
        picks++;
      }
      nextUpg = xp + upgGap(xp);
    }

    samples.push({ t, score, xp, dps, headroom, spd: p.spd, fastSpd: pr.fastSpd, picks, wave: pr.wave, comboMult });
  }
  // 최종 유닛 격파 가능성 — 등장 시점의 DPS로 남은 창 안에 잡을 수 있는가.
  // 잡몹도 상대해야 하므로 화력의 절반만 최종 유닛에 쓴다고 본다.
  const atPurge = samples[Math.min(PURGE_SEC, samples.length) - 1];
  let purge = null;
  if (atPurge) {
    const dpsOnPurge = atPurge.dps * 0.5;   // 잡몹도 상대하므로 화력의 절반만 최종 유닛에
    const ttk = purgeHP(PURGE_SEC) / dpsOnPurge;
    purge = { dps: atPurge.dps, ttk, killable: ttk <= RUN_SEC - PURGE_SEC,
              megaTtk: megaHP(PURGE_SEC) / dpsOnPurge, bossTtk: bossHP(PURGE_SEC) / dpsOnPurge };
  }
  return { samples, breakPoint, final: p, picks, purge, credits: Math.round(credits), kills: Math.round(totalKills) };
}

// ── 실행 ──────────────────────────────────────────────────────
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const RUNS = Number(flag('runs', 200));
const STRATEGY = flag('strategy', 'random');
const SECONDS = Number(flag('seconds', RUN_SEC));
const ACCURACY = Number(flag('accuracy', DEFAULT_ACCURACY));
const COMBO_ON = !args.includes('--no-combo');
const AS_CSV = args.includes('--csv');
const SWEEP = args.includes('--sweep');
const CAP = parseCap(flag('cap', `stack:${GAME_STACK_MAX}`));   // 기본값은 게임의 실제 설정

const upgrades = loadUpgrades();

// ── 진단: 무기별 고유 DPS 편차 ──
if (args.includes('--weapons')) {
  const BASE_GC = { pistol:22, plasma:20, shotgun:32, laser:44, dualgun:20, sniper:55,
                    flame:4, ricochet:22, missile:26, rail:50, gatling:5, cannon:45, chain:22 };
  const bd = Number(flag('bd', 5)), xb = Number(flag('xb', 2));
  console.log(`\n  무기별 고유 DPS — 데미지 bd=${bd}, 추가탄환 xb=${xb}, 각 무기 고유 쿨다운, 연사 업그레이드 없음\n`);
  console.log('  무기        쿨다운   초당발사   발사당(유효)      DPS   기준 대비');
  console.log('  ' + '─'.repeat(64));
  const rows = Object.keys(BASE_GC).map(wt => {
    const w = WEAPON_DPS[wt], gc = BASE_GC[wt];
    const per = w.dmg(bd, xb) * (w.crit ? CRIT_AVG : 1) * (w.hit ?? 1) * (w.multi ?? 1);
    return { wt, gc, rate: 60 / gc, per, dps: per * (60 / gc) };
  }).sort((a, b) => b.dps - a.dps);
  const lo = rows[rows.length - 1].dps;
  for (const r of rows)
    console.log(`  ${r.wt.padEnd(10)} ${String(r.gc).padStart(5)}f ${r.rate.toFixed(1).padStart(9)} ` +
      `${r.per.toFixed(1).padStart(14)} ${r.dps.toFixed(0).padStart(8)} ${(r.dps / lo).toFixed(1).padStart(9)}x`);
  console.log(`\n  최고/최저 = ${(rows[0].dps / lo).toFixed(1)}배 (${rows[0].wt} / ${rows[rows.length-1].wt})`);
  const mid = rows[Math.floor(rows.length/2)].dps;
  console.log(`  중앙값 ${mid.toFixed(0)} DPS 대비 최고 ${(rows[0].dps/mid).toFixed(1)}배\n`);
  process.exit(0);
}

// ── 진단: greedy가 실제로 무엇을 쌓는지 ──
if (args.includes('--inspect')) {
  const med = a => { const x=[...a].sort((m,n)=>m-n); return x[Math.floor(x.length/2)]; };
  for (const capStr of ['none','slots:16','stack:3','decay']) {
    const rs=[];
    for (let i=0;i<RUNS;i++)
      rs.push(simulate(upgrades,{strategy:'greedy',rng:mulberry32(i*7919+13),maxSeconds:RUN_SEC,accuracy:0.35,combo:true,cap:parseCap(capStr)}));
    const f = rs.map(r=>r.final);
    const wc={}; f.forEach(x=>wc[x.wt]=(wc[x.wt]||0)+1);
    const topW = Object.entries(wc).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([w,n])=>`${w} ${Math.round(n/RUNS*100)}%`).join(', ');
    console.log(`\n  [${capStr}]  최종 빌드 중앙값`);
    console.log(`    데미지 bd=${med(f.map(x=>x.bd))}  추가탄환 xb=${med(f.map(x=>x.xb))}  쿨다운 gc=${med(f.map(x=>x.gc))}프레임 (초당 ${(60/med(f.map(x=>x.gc))).toFixed(1)}발)`);
    console.log(`    주 무기: ${topW}`);
    const p0 = f[0];
    console.log(`    예시 DPS 분해: ${p0.wt} → 발사당 ${WEAPON_DPS[p0.wt] ? WEAPON_DPS[p0.wt].dmg(p0.bd,p0.xb).toFixed(0) : '?'} × 초당 ${(60/p0.gc).toFixed(1)}발`);
  }
  process.exit(0);
}

// ── 상한 정책 비교: 무제한 성장을 어떤 방식으로 막을지 데이터로 고른다 ──
if (args.includes('--compare-caps')) {
  const CAPS = args.includes('--caps') ? flag('caps','').split(',') : ['none', 'slots:20', 'stack:3', 'decay', 'mult:1', 'mult:2', 'mult:3', 'mult+wfloor:2', 'mult+wfloor:3'];
  const med = a => { const x = [...a].sort((m, n) => m - n); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
  const run = (cap, strat, acc) => {
    const rs = [];
    for (let i = 0; i < RUNS; i++)
      rs.push(simulate(upgrades, { strategy: strat, rng: mulberry32(i * 7919 + 13), maxSeconds: RUN_SEC, accuracy: acc, combo: true, cap: parseCap(cap) }));
    const at600 = rs.map(r => r.samples[RUN_SEC - 1]).filter(Boolean);
    const pg = rs.map(r => r.purge).filter(Boolean);
    return {
      dps: med(at600.map(s => s.dps)),
      head: med(at600.map(s => s.headroom)),
      picks: med(at600.map(s => s.picks)),
      purge: pg.filter(x => x.killable).length / pg.length * 100,
    };
  };
  console.log(`\n  성장 상한 정책 비교 — 정책 ${CAPS.length}종 × ${RUNS}판, 명중률 35%, 10분\n`);
  console.log('  정책        │ random DPS  여유  격파 │ greedy DPS   여유  격파 │ greedy/random  판정');
  console.log('  ' + '─'.repeat(92));
  const rows = [];
  for (const cap of CAPS) {
    const r = run(cap, 'random', 0.35), g = run(cap, 'greedy', 0.35);
    const ratio = g.dps / r.dps;
    // 판정 기준: random이 놀 만한 구간(여유 0.3~1.5)에 있고, greedy가 그 5배 안쪽
    const ok = r.head >= 0.3 && r.head <= 1.5 && ratio <= 5;
    rows.push({ cap, rDps: +r.dps.toFixed(1), rHead: +r.head.toFixed(2), rPurge: Math.round(r.purge),
                gDps: +g.dps.toFixed(1), gHead: +g.head.toFixed(2), gPurge: Math.round(g.purge),
                ratio: +ratio.toFixed(1), picks: g.picks });
    console.log(`  ${cap.padEnd(11)} │ ${r.dps.toFixed(1).padStart(10)} ${r.head.toFixed(2).padStart(5)} ${(Math.round(r.purge)+'%').padStart(5)} │` +
      ` ${g.dps.toFixed(1).padStart(10)} ${g.head.toFixed(2).padStart(6)} ${(Math.round(g.purge)+'%').padStart(5)} │` +
      ` ${(ratio.toFixed(1)+'x').padStart(13)}  ${ok ? '✅' : '❌'}`);
  }
  const header = 'cap_policy,random_dps,random_headroom,random_purge_pct,greedy_dps,greedy_headroom,greedy_purge_pct,greedy_over_random,greedy_picks';
  const csv = [header, ...rows.map(r => Object.values(r).join(','))].join('\n');
  mkdirSync(join(HERE, '..', 'docs'), { recursive: true });
  writeFileSync(join(HERE, '..', 'docs', 'cap-policy-data.csv'), csv + '\n');
  console.log(`\n  판정 기준: random 처리량 여유 0.3~1.5 (놀 만한 구간) + greedy/random 배율 5배 이하`);
  console.log(`  데이터셋 저장: docs/cap-policy-data.csv\n`);
  process.exit(0);
}

// ── 캠페인: 명중률 × 선택전략 전 조합을 돌려 데이터셋을 남긴다 ──
if (args.includes('--campaign')) {
  const ACCS = [0.15, 0.25, 0.35, 0.5, 0.75, 1.0];
  const STRATS = ['random', 'greedy'];
  const med = a => { const x = [...a].sort((m, n) => m - n); return x.length ? x[Math.floor(x.length / 2)] : NaN; };
  const rows = [];
  console.log(`\n  밸런스 캠페인 — ${ACCS.length * STRATS.length}개 조합 × ${RUNS}판 × ${RUN_SEC}초\n`);
  console.log('  전략     명중률  업글@600  DPS@600  여유@180  여유@600  최종유닛격파  메가TTK  일반TTK');
  console.log('  ' + '─'.repeat(88));
  for (const strat of STRATS) {
    for (const acc of ACCS) {
      const rs = [];
      for (let i = 0; i < RUNS; i++)
        rs.push(simulate(upgrades, { strategy: strat, rng: mulberry32(i * 7919 + 13), maxSeconds: RUN_SEC, accuracy: acc, combo: true, cap: CAP }));
      const at = k => rs.map(r => r.samples[k - 1]).filter(Boolean);
      const pg = rs.map(r => r.purge).filter(Boolean);
      const row = {
        strategy: strat, accuracy: acc,
        picks600: med(at(600).map(s => s.picks)),
        dps600: +med(at(600).map(s => s.dps)).toFixed(1),
        head180: +med(at(180).map(s => s.headroom)).toFixed(2),
        head600: +med(at(600).map(s => s.headroom)).toFixed(2),
        purgeKillRate: +(pg.filter(x => x.killable).length / pg.length * 100).toFixed(0),
        megaTtk: Math.round(med(pg.map(x => x.megaTtk))),
        bossTtk: Math.round(med(pg.map(x => x.bossTtk))),
      };
      rows.push(row);
      const warn = row.megaTtk > 180 || row.bossTtk > 60 ? '  ← 보스 누적' : '';
      console.log(`  ${strat.padEnd(8)} ${(acc * 100).toFixed(0).padStart(5)}% ${String(row.picks600).padStart(9)} ` +
        `${String(row.dps600).padStart(8)} ${String(row.head180).padStart(9)} ${String(row.head600).padStart(9)} ` +
        `${String(row.purgeKillRate + '%').padStart(13)} ${String(row.megaTtk).padStart(8)} ${String(row.bossTtk).padStart(8)}${warn}`);
    }
    console.log('');
  }
  const header = 'strategy,accuracy,picks_at_600s,dps_at_600s,headroom_at_180s,headroom_at_600s,purge_kill_rate_pct,mega_ttk_sec,boss_ttk_sec';
  const csv = [header, ...rows.map(r => Object.values(r).join(','))].join('\n');
  const out = join(HERE, '..', 'docs', 'balance-data.csv');
  try {
    mkdirSync(join(HERE, '..', 'docs'), { recursive: true });
    writeFileSync(out, csv + '\n');
    console.log(`  데이터셋 저장: docs/balance-data.csv (${rows.length}행, 조합당 ${RUNS}판)\n`);
  } catch (e) { console.log('  CSV 저장 실패:', e.message); }
  process.exit(0);
}

if (SWEEP) {
  console.log(`\n  명중률 민감도 스윕 — ${RUNS}판씩, 판당 ${Math.floor(SECONDS / 60)}분, 전략 ${STRATEGY}\n`);
  console.log('  명중률  콤보   5분 점수(중앙값)   최종 처리량여유   붕괴한 판');
  console.log('  ' + '─'.repeat(64));
  for (const combo of [true, false]) {
    for (const acc of [0.15, 0.25, 0.35, 0.5, 0.75, 1.0]) {
      const rs = [];
      for (let i = 0; i < RUNS; i++)
        rs.push(simulate(upgrades, { strategy: STRATEGY, rng: mulberry32(i * 7919 + 13), maxSeconds: SECONDS, accuracy: acc, combo, cap: CAP }));
      const at300 = rs.map(r => r.samples[Math.min(299, SECONDS - 1)]).filter(Boolean);
      const med = a => { const s2 = [...a].sort((x, y) => x - y); return s2[Math.floor(s2.length / 2)]; };
      const broke = rs.filter(r => r.breakPoint).length;
      console.log(
        `  ${(acc * 100).toFixed(0).padStart(5)}%  ${(combo ? '켬' : '끔').padEnd(4)} ` +
        `${String(Math.round(med(at300.map(s => s.score)))).padStart(16)} ` +
        `${med(at300.map(s => s.headroom)).toFixed(2).padStart(15)}x ` +
        `${String(broke).padStart(9)}/${RUNS}`);
    }
    console.log('');
  }
  process.exit(0);
}

const runs = [];
for (let i = 0; i < RUNS; i++) {
  runs.push(simulate(upgrades, { strategy: STRATEGY, rng: mulberry32(i * 7919 + 13), maxSeconds: SECONDS, accuracy: ACCURACY, combo: COMBO_ON, cap: CAP }));
}

const median = arr => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};

if (AS_CSV) {
  console.log('t,score,dps,headroom,player_spd,fast_enemy_spd,picks,wave');
  for (const s of runs[0].samples) {
    console.log([s.t, Math.round(s.score), s.dps.toFixed(1), s.headroom.toFixed(2),
      s.spd.toFixed(2), s.fastSpd.toFixed(2), s.picks, s.wave].join(','));
  }
  process.exit(0);
}

console.log(`\n  CYBER ROBOT: ARENA — 밸런스 시뮬레이션`);
console.log(`  업그레이드 ${upgrades.length}종 · ${RUNS}판 · 판당 ${Math.floor(SECONDS / 60)}분 · 선택 전략: ${STRATEGY}`);
console.log(`  가정: 명중률 ${(ACCURACY * 100).toFixed(0)}% · 콤보 ${COMBO_ON ? '켬' : '끔'}\n`);

// 시간대별 중앙값
console.log('  경과   점수      웨이브  업글  플레이어DPS  요구DPS  처리량여유  플레이어속도  적속도(fast)');
console.log('  ' + '─'.repeat(94));
for (const t of [30, 60, 120, 180, 300, 450, 600, 900].filter(x => x <= SECONDS)) {
  const at = runs.map(r => r.samples[t - 1]).filter(Boolean);
  if (!at.length) continue;
  const sc = median(at.map(s => s.score));
  const pr = pressure(t);
  const dps = median(at.map(s => s.dps));
  const hr = median(at.map(s => s.headroom));
  const spd = median(at.map(s => s.spd));
  const mark = hr >= 3 ? '  ← 붕괴' : hr >= 1.5 ? '  ← 우세' : '';
  console.log(
    `  ${String(t).padStart(4)}s ${String(Math.round(sc)).padStart(8)} ` +
    `${String(pr.wave).padStart(6)} ${String(median(at.map(s => s.picks))).padStart(5)} ` +
    `${dps.toFixed(1).padStart(11)} ${(pr.spawnPerSec * pr.avgHP).toFixed(1).padStart(8)} ` +
    `${hr.toFixed(2).padStart(10)}x ${spd.toFixed(2).padStart(12)} ${pr.fastSpd.toFixed(2).padStart(12)}${mark}`
  );
}

// 최종 유닛 격파 가능성
const pgs = runs.map(r => r.purge).filter(Boolean);
if (pgs.length) {
  const killable = pgs.filter(x => x.killable).length;
  console.log(`\n  최종 유닛 (${PURGE_SEC}초 등장, HP ${purgeHP(PURGE_SEC).toLocaleString()}, 격파 창 ${RUN_SEC - PURGE_SEC}초)`);
  console.log(`    격파 가능한 판: ${killable}/${pgs.length} (${(killable / pgs.length * 100).toFixed(0)}%)`);
  console.log(`    처치 소요 시간 중앙값: ${median(pgs.map(x => x.ttk)).toFixed(0)}초`);
  console.log(`    같은 시점 참고 — 메가 보스 ${median(pgs.map(x => x.megaTtk)).toFixed(0)}초 / 일반 보스 ${median(pgs.map(x => x.bossTtk)).toFixed(0)}초`);
}

// 메타 진행 — 판당 크레딧과 상점 만렙까지 걸리는 판 수
const creds = runs.map(r => r.credits);
const medCred = median(creds);
console.log(`\n  메타 진행 (판당 10분 완주 기준)`);
console.log(`    판당 크레딧 중앙값: ${medCred.toLocaleString()}  (처치 ${Math.round(median(runs.map(r => r.kills))).toLocaleString()}마리)`);
for (const lv of [1, 3, 5]) {
  const cost = shopCostToLevel(lv);
  console.log(`    10라인 전부 Lv.${lv} 달성 비용 ${cost.toLocaleString()} → ${(cost / medCred).toFixed(1)}판`);
}

const bps = runs.map(r => r.breakPoint).filter(Boolean);
console.log('');
if (bps.length) {
  console.log(`  처리량 여유가 3배를 넘은 판: ${bps.length}/${RUNS} (${(bps.length / RUNS * 100).toFixed(0)}%)`);
  console.log(`  붕괴 시점 중앙값: ${median(bps.map(b => b.t))}초 / ${median(bps.map(b => b.score))}점 / 업그레이드 ${median(bps.map(b => b.picks))}개`);
} else {
  console.log(`  처리량 여유가 3배를 넘은 판 없음 — 이 전략에서는 붕괴하지 않는다.`);
}

// 최종 무기 분포
const wcount = {};
for (const r of runs) wcount[r.final.wt] = (wcount[r.final.wt] || 0) + 1;
console.log('\n  최종 무기 분포');
Object.entries(wcount).sort((a, b) => b[1] - a[1]).forEach(([w, n]) =>
  console.log(`    ${w.padEnd(10)} ${String(n).padStart(4)}판  ${(n / RUNS * 100).toFixed(1)}%`));

// 속도 역전 시점
const spdFlip = runs.map(r => r.samples.find(s => s.spd > s.fastSpd)).filter(Boolean);
console.log('');
if (spdFlip.length) {
  console.log(`  플레이어 속도가 fast 적을 앞지른 판: ${spdFlip.length}/${RUNS} (${(spdFlip.length / RUNS * 100).toFixed(0)}%)`);
  console.log(`  역전 시점 중앙값: ${median(spdFlip.map(s => s.t))}초 / ${median(spdFlip.map(s => Math.round(s.score)))}점`);
} else {
  console.log(`  플레이어 속도가 fast 적을 앞지른 판 없음.`);
}
console.log('');
