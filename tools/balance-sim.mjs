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
const WEAPON_DPS = {
  //            발사당 데미지                        크리 적용 여부
  pistol:   { dmg: (d, xb) => d * 0.6  * (1 + xb),        crit: true  },
  plasma:   { dmg: (d, xb) => d * 2.5  * (1 + xb),        crit: true  },
  shotgun:  { dmg: (d, xb) => d * (7 + xb),               crit: true  },
  laser:    { dmg: (d)     => d * 5,                      crit: false },
  dualgun:  { dmg: (d, xb) => d * 0.8  * (2 + xb),        crit: true  },
  sniper:   { dmg: (d)     => d * 4,                      crit: true  },
  flame:    { dmg: (d, xb) => d * 1.4 * Math.min(8 + xb * 2, 16), crit: true },
  ricochet: { dmg: (d)     => d,                          crit: true  },
  missile:  { dmg: (d, xb) => d * 7 * (1 + xb),           crit: true  },
  rail:     { dmg: (d)     => d * 9,                      crit: false },
  gatling:  { dmg: (d, xb) => d * 0.7 * (1 + xb),         crit: true  },
  cannon:   { dmg: (d)     => d * 5,                      crit: false },
  chain:    { dmg: (d, xb) => d * (4 + xb),               crit: false },
};

// ── 플레이어 초기 상태 (Player 생성자, 영구 강화 0단계 기준) ────
function newPlayer() {
  return {
    spd: 2.8, mhp: 5, hp: 5, bd: 1, au: 0,
    wt: 'pistol', gc: 22, xb: 0, bsp: 10, rad: 16, mgR: 80, cm: 1,
    pr: false, hm: false, ae: false, lc: false,
    sm: 1, shB: 0, rr: 0,
    orbBlades: 0, coldField: false, berserker: false, phoenix: false,
    mirrorShield: false, comboBoost: false, vampire: false,
    superMagnet: false, bombDrop: false, drone: false,
  };
}

// ── 파생 지표 ─────────────────────────────────────────────────
function playerDPS(p) {
  const w = WEAPON_DPS[p.wt] ?? WEAPON_DPS.pistol;
  const perShot = w.dmg(p.bd, p.xb) * (w.crit ? CRIT_AVG : 1);
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
function draft(upgrades, takenIds, rng) {
  const available = upgrades.filter(u => {
    if (u.once && takenIds.has(u.id)) return false;
    if (u.req && !takenIds.has(u.req)) return false;
    return true;
  });
  const pool = available.flatMap(u => Array(RARITY_WEIGHT[u.r] ?? 5).fill(u));
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
function simulate(upgrades, { strategy, rng, maxSeconds = 3600, accuracy = DEFAULT_ACCURACY, combo: comboOn = true }) {
  const p = newPlayer();
  const taken = new Set();
  let score = 0, xp = 0, t = 0, combo = 0, nextUpg = upgGap(0), picks = 0;
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

    if (headroom >= 3 && breakPoint === null && t > 5) {
      breakPoint = { t, score: Math.round(score), picks, headroom };
    }

    while (xp >= nextUpg) {
      const cards = draft(upgrades, taken, rng);
      const pick = choose(cards, p, strategy, rng);
      if (pick) { try { pick.ef(p); } catch {} taken.add(pick.id); picks++; }
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
  return { samples, breakPoint, final: p, picks, purge };
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

const upgrades = loadUpgrades();

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
        rs.push(simulate(upgrades, { strategy: strat, rng: mulberry32(i * 7919 + 13), maxSeconds: RUN_SEC, accuracy: acc, combo: true }));
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
        rs.push(simulate(upgrades, { strategy: STRATEGY, rng: mulberry32(i * 7919 + 13), maxSeconds: SECONDS, accuracy: acc, combo }));
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
  runs.push(simulate(upgrades, { strategy: STRATEGY, rng: mulberry32(i * 7919 + 13), maxSeconds: SECONDS, accuracy: ACCURACY, combo: COMBO_ON }));
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
