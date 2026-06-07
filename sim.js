/* =======================================================================
   sim.js — 세계 3차 전쟁 v2.0 밸런스 헤드리스 시뮬레이터
   -----------------------------------------------------------------------
   index.html 의 <script> 를 추출 → DOM을 더미로 모킹 → eval → window.__api 로
   여러 전략/난이도/국가를 자동 플레이하며 승률·평균턴·점수를 출력한다.
   실행:  node sim.js
   ======================================================================= */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf-8");
const scriptCode = html.split("<script>")[1].split("</script>")[0];

/* ---- 만능 더미(DOM 대용): 어떤 속성/호출도 안전하게 흡수 ---- */
const dummy = new Proxy(function () {}, {
  get: (t, p) => {
    if (p === Symbol.toPrimitive) return () => 0;
    if (p === "length") return 0;
    return dummy;
  },
  set: () => true,
  apply: () => dummy,
  construct: () => dummy,
});

/* ---- 브라우저 전역 모킹 ---- */
const realWindow = {}; // window.__api 를 받아 읽어야 하므로 진짜 객체
const document = {
  getElementById: () => dummy,
  querySelectorAll: () => [],
  querySelector: () => dummy,
  createElement: () => dummy,
  addEventListener: () => {},
};
const Image = function () { this.onload = null; this.onerror = null; let _s="";
  Object.defineProperty(this,"src",{ set(v){ _s=v; }, get(){ return _s; } }); };
const requestAnimationFrame = () => {};
function AudioContext(){ return dummy; }
const navigator = { userAgent: "node" };
realWindow.AudioContext = AudioContext;
realWindow.webkitAudioContext = AudioContext;
realWindow.requestAnimationFrame = requestAnimationFrame;
realWindow.__TURBO = true; // sleep 즉시 통과
const fetch = () => Promise.reject(new Error("no-net")); // 항상 fallback 경로

/* ---- 직접 eval (위 지역변수들이 스크립트의 bare 식별자로 보인다) ---- */
(function () {
  const window = realWindow;
  // eslint-disable-next-line no-eval
  eval(scriptCode);
})();

const api = realWindow.__api;
if (!api) { console.error("__api 노출 실패 — 스크립트 평가 오류"); process.exit(1); }

/* =====================================================================
   전략들 (true 반환 = 행동 1개 수행 / false = 더 할 게 없음 → 턴 종료)
   ===================================================================== */
function smart() {
  const g = api.game, m = api.me(), cs = api.countries, C = api.actionCosts();
  const res = g.resources;
  if ((g.crisis || g.tension > 85) && res >= C.peace) { api.peaceTalk(); return true; }
  if (m.warFatigue > 62 && res >= C.recover) { api.recover(); return true; }
  // 초반: 경제 먼저 살짝 키워 수입 기반 마련 + 외교/군사
  if (g.turn <= 4) {
    if (res >= C.economy && m.economy < 600 && g.turn <= 2) { api.upgrade("economy"); return true; }
    if (res >= C.diplomacy && m.diplomacy < 650) { api.upgrade("diplomacy"); return true; }
    if (res >= C.military && m.military < 700) { api.upgrade("military"); return true; }
  }
  // 동맹: 성공률 좋은 중립/적동맹
  let bestAlly = null, bestAR = 0;
  cs.filter(c => c.status === "neutral" || c.status === "enemyAlly").forEach(c => {
    const r = api.allianceRate(c); if (r > bestAR) { bestAR = r; bestAlly = c; }
  });
  if (bestAlly && bestAR >= 50 && res >= C.alliance) { api.attemptAlliance(bestAlly.id); return true; }
  // 점령 대상 탐색
  if (m.warFatigue < 55) {
    let bestOcc = null, bestOR = 0;
    cs.filter(c => !api.isMine(c)).forEach(c => {
      const r = api.occupationRate(c); if (r > bestOR) { bestOR = r; bestOcc = c; }
    });
    if (bestOcc && bestOR >= 52 && res >= C.occupation) { api.attemptOccupation(bestOcc.id); return true; }
    // 거의 되는데 모자라면: 첩보로 약점 파악 후 다음에 점령
    if (bestOcc && bestOR >= 38 && bestOR < 52 && !bestOcc.spied && res >= C.spy) { api.spy(bestOcc.id); return true; }
    // 강한 적이면 경제 제재로 약화
    if (bestOcc && api.isEnemy(bestOcc) && bestOR < 50 && res >= C.sanction && g.turn % 2 === 0) { api.sanction(bestOcc.id); return true; }
  }
  // 성장: 점령을 위해 군사 우선
  if (res >= C.military && m.military < 820) { api.upgrade("military"); return true; }
  if (res >= C.diplomacy && m.diplomacy < 780) { api.upgrade("diplomacy"); return true; }
  if (res >= C.economy) { api.upgrade("economy"); return true; }
  if (res >= C.recover && m.warFatigue > 15) { api.recover(); return true; }
  return false;
}

function pureDiplomacy() {
  const g = api.game, m = api.me(), cs = api.countries, C = api.actionCosts();
  const res = g.resources;
  let bestAlly = null, bestAR = 0;
  cs.filter(c => c.status === "neutral" || c.status === "enemyAlly").forEach(c => {
    const r = api.allianceRate(c); if (r > bestAR) { bestAR = r; bestAlly = c; }
  });
  if (bestAlly && res >= C.alliance) { api.attemptAlliance(bestAlly.id); return true; }
  if (res >= C.diplomacy) { api.upgrade("diplomacy"); return true; }
  return false;
}

function aggro() {
  const g = api.game, cs = api.countries, C = api.actionCosts();
  if (g.resources < C.occupation) {
    if (g.resources >= C.military) { api.upgrade("military"); return true; }
    return false;
  }
  let best = null, bo = -1;
  cs.filter(c => !api.isMine(c)).forEach(c => { const r = api.occupationRate(c); if (r > bo) { bo = r; best = c; } });
  if (best) { api.attemptOccupation(best.id); return true; }
  return false;
}

/* =====================================================================
   한 판 실행
   ===================================================================== */
async function playOne(diff, countryId, strat) {
  api.setDiff(diff); api.setCountry(countryId); api.startGame();
  let guard = 0;
  while (!api.game.over && api.game.turn <= 60 && guard < 500) {
    guard++;
    while (api.game.actionPoints > 0 && !api.game.over) { if (!strat()) break; }
    if (api.game.over) break;
    await api.endTurn();
  }
  const r = api.game._result;
  if (!r) return { victory: false, score: 0, grade: "-", turn: api.game.turn, timeout: true };
  return { ...r, timeout: false };
}

async function batch(label, diff, countryId, strat, n) {
  let wins = 0, turns = 0, score = 0, timeouts = 0, nukeWins = 0;
  const grades = {};
  for (let i = 0; i < n; i++) {
    const r = await playOne(diff, countryId, strat);
    if (r.victory) { wins++; if (r.nukesUsed > 0) nukeWins++; }
    if (r.timeout) timeouts++;
    turns += r.turn; score += r.score;
    grades[r.grade] = (grades[r.grade] || 0) + 1;
  }
  const pct = Math.round((wins / n) * 100);
  const gstr = Object.entries(grades).sort().map(([k, v]) => `${k}:${v}`).join(" ");
  console.log(
    `${label.padEnd(26)} 승률 ${String(pct).padStart(3)}%  평균턴 ${(turns / n).toFixed(1).padStart(4)}  평균점수 ${String(Math.round(score / n)).padStart(5)}  타임아웃 ${timeouts}  등급[${gstr}]`
  );
  return pct;
}

/* =====================================================================
   메인
   ===================================================================== */
(async function main() {
  const N = parseInt(process.argv[2] || "40", 10);
  console.log(`\n=== 세계 3차 전쟁 v2.0 밸런스 시뮬 (각 ${N}판) ===\n`);

  console.log("■ 똑똑한 혼합 전략 (대한민국)");
  await batch("  쉬움", "easy", "korea", smart, N);
  await batch("  보통", "normal", "korea", smart, N);
  await batch("  어려움", "hard", "korea", smart, N);

  console.log("\n■ 국가별 (보통 난이도, 똑똑한 전략)");
  for (const id of ["usa", "china", "uk", "australia", "nz", "congo", "argentina"]) {
    const name = api.byId ? "" : ""; // label은 id로 충분
    await batch("  " + id, "normal", id, smart, Math.max(20, Math.floor(N / 2)));
  }

  console.log("\n■ 극단 전략 검증 (보통, 대한민국)");
  await batch("  순수 외교만", "normal", "korea", pureDiplomacy, N);
  await batch("  무지성 공격만", "normal", "korea", aggro, N);

  console.log("\n완료.\n");
})();
