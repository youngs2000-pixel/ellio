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

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const KEY = "ww3:leaderboard";
const MAX_KEEP = 100;   // 서버에 보관할 최대 기록 수
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
    diff: String(entry.diff || "").slice(0, 8),
    ts: Date.now(),
    id: String(entry.id || Math.random().toString(36).slice(2, 9)).slice(0, 12),
  };
}

async function getRanking() {
  const res = await redis([["ZREVRANGE", KEY, 0, TOP_N - 1, "WITHSCORES"]]);
  const flat = res && res[0] && res[0].result;
  return parseRange(flat);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // 저장소 미설정 → 프런트가 로컬 랭킹으로 폴백하도록 신호
  if (!configured()) return res.status(200).json({ ranking: null, configured: false });

  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const entry = clean(body);
      if (!entry) return res.status(200).json({ ranking: await getRanking() });
      const member = JSON.stringify(entry);
      // 추가 → 100개 초과분 정리 → 상위 목록 반환 (한 번의 파이프라인으로)
      const out = await redis([
        ["ZADD", KEY, entry.score, member],
        ["ZREMRANGEBYRANK", KEY, 0, -(MAX_KEEP + 1)],
        ["ZREVRANGE", KEY, 0, TOP_N - 1, "WITHSCORES"],
      ]);
      const flat = out && out[2] && out[2].result;
      return res.status(200).json({ ranking: parseRange(flat), configured: true });
    }
    // GET
    return res.status(200).json({ ranking: await getRanking(), configured: true });
  } catch (e) {
    // 오류가 나도 게임이 멈추지 않도록 null 반환(프런트 로컬 폴백)
    return res.status(200).json({ ranking: null, configured: true, error: true });
  }
}
