/* =======================================================================
   /api/score  —  Vercel 서버리스 함수 (온라인 공유 랭킹)
   -----------------------------------------------------------------------
   · 저장소: Upstash Redis (REST). 의존성(npm 패키지) 없이 fetch 로 직접 호출.
   · 환경변수(둘 중 아무 이름이나 인식):
       KV_REST_API_URL  / KV_REST_API_TOKEN        (Vercel 의 KV·Upstash 연동)
       UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash 직접)
   · 환경변수가 없으면 ranking:null 을 돌려준다 → 프런트가 자동으로
     localStorage(이 기기) 랭킹으로 폴백한다. (게임은 절대 안 멈춤)
   · GET  /api/score        → { ranking:[...] }  상위 기록
     POST /api/score {entry} → 저장 후 { ranking:[...] }
   ======================================================================= */

/* 환경변수 이름은 연동 방식마다 다르다. 표준 이름 + Vercel Upstash Integration이
   자동 생성하는 접두어(UPSTASH_REDIS_REST_*) 이름을 모두 순서대로 지원한다.
   ※ REST API용(https://..upstash.io) URL/TOKEN만 사용. redis:// 형태(_KV_URL,
     _REDIS_URL)는 이 코드(REST 호출)에선 쓰지 않는다. */
const pickEnv = (...names) => {
  for (const n of names) { const v = process.env[n]; if (v) return v; }
  return "";
};
const URL = pickEnv(
  "KV_REST_API_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_KV_REST_API_URL"
).replace(/\/+$/, ""); // 끝 슬래시 제거(`${URL}/pipeline` 중복 방지)
const TOKEN = pickEnv(
  "KV_REST_API_TOKEN",
  "UPSTASH_REDIS_REST_TOKEN",
  "UPSTASH_REDIS_REST_KV_REST_API_TOKEN"
);
/* 랭킹은 난이도(easy/normal/hard)별로 따로 보관한다.
   (낮은 난이도가 점수 올리기 쉬워 같은 표에서 비교하면 불공정) */
const DIFFS = ["easy", "normal", "hard"];
const normDiff = (d) => (DIFFS.includes(d) ? d : "normal");
const keyFor = (d) => "ww3:leaderboard:" + normDiff(d);
const MAX_KEEP = 100;   // 난이도별 보관할 최대 기록 수
const TOP_N = 30;       // 돌려줄 상위 기록 수

const configured = () => URL && TOKEN;

/* Upstash REST 파이프라인 호출: commands = [["ZADD",...],["ZREVRANGE",...]] */
async function redis(commands, pipeline = true) {
  const endpoint = pipeline ? `${URL}/pipeline` : URL;
  const body = pipeline ? JSON.stringify(commands) : JSON.stringify(commands[0]);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json(); // pipeline → [{result},...]  /  단일 → {result}
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ZREVRANGE ... WITHSCORES 결과(평탄 배열 [member,score,member,score,...]) → 객체 배열 */
function parseRange(flat) {
  const out = [];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i < flat.length; i += 2) {
    try {
      const e = JSON.parse(flat[i]);
      e.score = Number(flat[i + 1]);
      out.push(e);
    } catch (_) { /* 깨진 항목은 건너뜀 */ }
  }
  return out;
}

/* 입력 정제 — 이름/등급/숫자 범위 검증 */
function clean(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = String(entry.name || "").replace(/[<>&"'\\\r\n\t]/g, "").trim().slice(0, 12);
  const score = Math.round(Number(entry.score));
  if (!name) return null;
  if (!Number.isFinite(score) || score < 0 || score > 1000000) return null;
  const grade = ["S", "A", "B", "C", "D"].includes(entry.grade) ? entry.grade : "D";
  const emoji = String(entry.emoji || "").slice(0, 4);
  const country = String(entry.country || "").replace(/[<>&"']/g, "").slice(0, 16);
  return {
    name, score, grade, emoji, country,
    turn: Math.max(0, Math.min(999, Math.round(Number(entry.turn) || 0))),
    nukesUsed: Math.max(0, Math.min(99, Math.round(Number(entry.nukesUsed) || 0))),
    victory: !!entry.victory,
    diffKey: normDiff(entry.diffKey),                 // 난이도(어느 표에 넣을지)
    diff: String(entry.diff || "").slice(0, 8),        // 표시용 라벨
    ts: Date.now(),
    id: String(entry.id || Math.random().toString(36).slice(2, 9)).slice(0, 12),
  };
}

async function getRanking(diff) {
  const res = await redis([["ZREVRANGE", keyFor(diff), 0, TOP_N - 1, "WITHSCORES"]]);
  const flat = res && res[0] && res[0].result;
  return parseRange(flat);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 저장소 미설정 → 프런트가 로컬 랭킹으로 폴백하도록 신호
  if (!configured())
    return res.status(200).json({
      configured: false,
      ranking: null,
      message: "온라인 랭킹 서버가 아직 연결되지 않았습니다.",
    });

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const entry = clean(body);
      const diff = entry ? entry.diffKey : "normal";
      if (!entry) return res.status(200).json({ ranking: await getRanking(diff), diff, configured: true });
      const member = JSON.stringify(entry);
      const key = keyFor(diff);
      // 추가 → 100개 초과분 정리 → 상위 목록 반환 (한 번의 파이프라인으로, 난이도별 키)
      const out = await redis([
        ["ZADD", key, entry.score, member],
        ["ZREMRANGEBYRANK", key, 0, -(MAX_KEEP + 1)],
        ["ZREVRANGE", key, 0, TOP_N - 1, "WITHSCORES"],
      ]);
      const flat = out && out[2] && out[2].result;
      return res.status(200).json({ ranking: parseRange(flat), diff, configured: true });
    }
    // GET  (?diff=easy|normal|hard)
    const diff = normDiff(req.query && req.query.diff);
    return res.status(200).json({ ranking: await getRanking(diff), diff, configured: true });
  } catch (e) {
    // 오류가 나도 게임이 멈추지 않도록 null 반환(프런트 로컬 폴백)
    return res.status(200).json({ ranking: null, configured: true, error: true });
  }
}
