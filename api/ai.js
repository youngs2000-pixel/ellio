/* =======================================================================
   /api/ai  —  Vercel 서버리스 함수 (Google Gemini 내러티브 생성)
   -----------------------------------------------------------------------
   원칙(기획서 25~41, 40번 핵심):
     · 게임의 수치/승패/밸런스는 절대 건드리지 않는다. 여기서는 "문구"만 만든다.
     · API 키(GEMINI_API_KEY)는 이 서버 함수 안에서만 쓴다. 브라우저로 안 나간다.
     · 무슨 일이 있어도(키 없음/네트워크 오류/이상한 응답) 200 + fallback 문구로 응답해서
       게임이 멈추지 않게 한다.
   호출 형식: POST /api/ai   body = { type, payload }
     type: "news" | "diplomacy" | "strategy" | "ending"
   ======================================================================= */

const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const API_KEY = process.env.GEMINI_API_KEY || "";

/* 초등학생도 즐길 수 있도록 톤을 제한하는 공통 시스템 지시문 */
const SYSTEM_PROMPT = `너는 초등학생도 즐길 수 있는 턴제 세계 전략 게임 "세계 3차 전쟁"의 내러티브 AI다.
규칙:
- 실제 전쟁의 잔혹한 묘사(학살, 민간인 피해, 대량살상 등)는 절대 하지 않는다.
- 특정 국가나 민족을 비하하지 않는다.
- 핵무기는 실제 파괴 묘사 대신 "위기", "억제력", "전략적 압박"으로 표현한다.
- 게임 수치를 직접 바꾸지 않는다. 너는 상황을 설명하는 해설자다.
- 답은 짧고 쉽게, 한국어로, 2~3문장 이내로 작성한다.
- 과장된 폭력 대신 전략·외교·긴장감 중심으로 표현한다.`;

/* 타입별 사용자 프롬프트 만들기 */
function buildPrompt(type, p = {}) {
  const j = JSON.stringify(p, null, 0);
  switch (type) {
    case "news":
      return `현재 게임 상태를 바탕으로 "세계 뉴스" 문구를 2문장 이내로 만들어라. 전략·외교·긴장감 중심으로, 중립적인 뉴스 앵커 말투로.\n상태: ${j}`;
    case "diplomacy":
      return `다음 외교/행동 결과에 대한 상대 국가의 반응 메시지를 2문장 이내로 만들어라. 결과(성공/실패)에 어울리게.\n상황: ${j}`;
    case "strategy":
      return `플레이어의 현재 전략을 코치처럼 2~3문장으로 짧게 분석해라. 정답을 직접 알려주지 말고 힌트 수준으로. 부드럽게.\n상태: ${j}`;
    case "ending":
      return `게임이 끝났다. 최종 결과를 바탕으로 엔딩 내레이션을 2~3문장으로 만들어라. 승리/패배와 핵무기 사용 여부에 어울리는 여운 있는 마무리로.\n결과: ${j}`;
    default:
      return `현재 상황을 한 문장으로 중립적으로 묘사해라.\n정보: ${j}`;
  }
}

/* 타입별 오프라인 fallback (LLM 없이도 게임이 자연스럽게 굴러가도록) */
function fallbackMessage(type, p = {}) {
  switch (type) {
    case "news":
      return "세계 정세가 조용히, 그러나 빠르게 변하고 있습니다. 각국은 다음 수를 신중히 고르는 중입니다.";
    case "diplomacy":
      return p && p.success
        ? "상대국은 이번 제안을 긍정적으로 받아들였습니다."
        : "상대국은 신중한 입장을 보이며 답을 미뤘습니다.";
    case "strategy":
      return "지금은 균형이 중요한 시점입니다. 무리한 확장보다 다음 몇 턴의 안정을 살펴보세요.";
    case "ending":
      return "길었던 세계 정세가 한 장의 막을 내렸습니다. 당신의 선택이 새로운 질서를 만들었습니다.";
    default:
      return "세계 정세가 흔들리고 있습니다.";
  }
}

/* 응답 검증 — 부적절/과한 표현 차단 + 길이 제한 */
function sanitize(message, type, p) {
  if (!message || typeof message !== "string") return fallbackMessage(type, p);
  const banned = ["학살", "민간인 피해", "대량살상", "몰살", "처형"];
  if (banned.some((w) => message.includes(w))) return fallbackMessage(type, p);
  return message.trim().slice(0, 200);
}

/* Gemini 호출 (Node 18+ 의 전역 fetch 사용) */
async function callGemini(type, payload) {
  if (!API_KEY) return null; // 키가 없으면 fallback 으로
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: "user", parts: [{ text: buildPrompt(type, payload) }] }],
    generationConfig: { temperature: 0.95, maxOutputTokens: 256, topP: 0.95 },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts
      ?.map((x) => x.text)
      .join("")
      .trim();
    return text || null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  // 단순 CORS (혹시 다른 출처에서 부를 경우 대비)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  let type = "news";
  let payload = {};
  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    type = body.type || "news";
    payload = body.payload || {};
  } catch (e) {
    /* 파싱 실패해도 아래에서 fallback */
  }

  try {
    const raw = await callGemini(type, payload);
    const message = sanitize(raw, type, payload);
    return res.status(200).json({ message, fallback: raw === null });
  } catch (e) {
    // 절대 게임을 멈추지 않는다 — 항상 200 + fallback
    return res.status(200).json({ message: fallbackMessage(type, payload), fallback: true });
  }
}
