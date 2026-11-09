// 하자 접수 도우미 서버 (Cloudflare Workers)
// - 고객: 접수하기, 내 접수 상태 보기, 더 물어본 것 답하기
// - 관리자: 접수 목록, 확인·수정, 상태 바꾸기, 통계
// 화면 파일(public/)은 Cloudflare가 알아서 보내주고, /api/ 로 시작하는 요청만 여기로 와요.

// ===== [설정값] =====
// 다른 파일을 불러오고, 접수·로그인 한도 숫자를 정해 둠
import Anthropic from "@anthropic-ai/sdk";
import { classify, TEAM_OF, CATEGORIES, URGENCIES } from "./classify.js";
import { syncTicket, pushStatusToNotion, pullFromNotion } from "./integrations.js";

const STATUSES = ["접수", "배정", "처리중", "완료"];
const MAX_PER_HOUR = 5; // 같은 전화번호로 1시간에 접수할 수 있는 수 (AI 비용 보호)
const MAX_AI_PER_DAY = 100; // 하루 전체 AI 분류 수 (넘으면 AI 없이 접수만 받음 → 하루 최대 약 2,000원)
const MAX_LOGIN_FAILS = 10; // 같은 곳에서 10분 안에 비밀번호를 이만큼 틀리면 잠시 막음
const LOCK_MINUTES = 10;

// ===== [서버 입구 · 오류 처리] =====
// 모든 요청이 처음 들어오는 곳. 예상 못 한 오류는 '서버 오류' 안내로 바꿔 보냄
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, ctx, url);
    } catch (e) {
      console.error(e);
      return json({ error: "서버 오류가 났어요. 잠시 뒤 다시 시도해 주세요." }, 500);
    }
  },
  // ===== [노션 상태 맞추기] =====
  // 1분마다 자동 실행: 노션에서 바꾼 상태를 DB로 가져옴
  // 1분마다 실행 (wrangler.toml [triggers]): 노션에서 바꾼 상태를 DB로 가져와요
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pullFromNotion(env, logEvent).then((r) => r.changed && console.log("노션 → DB", r)).catch((e) => console.error("노션 동기화 실패", e)));
  },
};

// ===== [요청 나누기] =====
// 주소(/api/...)를 보고 알맞은 기능으로 보냄
async function route(request, env, ctx, url) {
  const p = url.pathname;
  const m = request.method;

  // ── 고객 ──
  if (p === "/api/tickets" && m === "POST") return createTicket(request, env, ctx);
  let hit = p.match(/^\/api\/tickets\/(\d+)$/);
  if (hit && m === "GET") return getMyTicket(env, +hit[1], url.searchParams.get("secret"));
  hit = p.match(/^\/api\/tickets\/(\d+)\/more$/);
  if (hit && m === "POST") return addMore(request, env, ctx, +hit[1]);

  // ── 관리자 (비밀번호 필요) ──
  // 운영자(admin): 모든 기능 / 시연용(demo): 보기만, 이름·전화번호는 가려서
  // ===== [관리자 로그인] =====
  // 비밀번호 확인. 여러 번 틀리면 10분 막음. 시연용은 보기만
  if (p.startsWith("/api/admin/")) {
    // 비밀번호를 여러 번 틀린 곳이면 확인도 하지 않고 막아요 (무차별 대입 공격 방지)
    const ipHash = await hashIp(request);
    const fails = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM login_fails WHERE ip_hash = ? AND at > datetime('now', '-${LOCK_MINUTES} minutes')`
    ).bind(ipHash).first();
    if (fails.n >= MAX_LOGIN_FAILS) {
      return json({ error: `비밀번호를 여러 번 틀려서 ${LOCK_MINUTES}분 동안 막혔어요. 잠시 뒤 다시 시도해 주세요.` }, 429);
    }
    const role = roleOf(request, env);
    if (!role) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO login_fails (ip_hash) VALUES (?)").bind(ipHash),
        env.DB.prepare("DELETE FROM login_fails WHERE at < datetime('now', '-1 day')"), // 오래된 기록 정리
      ]);
      const left = MAX_LOGIN_FAILS - fails.n - 1;
      return json({ error: left > 0 ? `비밀번호가 맞지 않아요 (${left}번 더 틀리면 ${LOCK_MINUTES}분 동안 막혀요)` : `비밀번호를 여러 번 틀려서 ${LOCK_MINUTES}분 동안 막혔어요.` }, 401);
    }
    if (p === "/api/admin/me" && m === "GET") return json({ role });
    if (p === "/api/admin/tickets" && m === "GET") return listTickets(env, url, role);
    if (p === "/api/admin/stats" && m === "GET") return stats(env);
    hit = p.match(/^\/api\/admin\/tickets\/(\d+)$/);
    if (hit && m === "GET") return ticketDetail(env, +hit[1], role);
    if (hit && m === "PATCH") {
      if (role !== "admin") return json({ error: "시연용 계정은 볼 수만 있어요" }, 403);
      return updateTicket(request, env, +hit[1]);
    }
  }
  return json({ error: "없는 주소예요" }, 404);
}

// ───────────── 고객: 접수하기 ─────────────
// ===== [접수 받기] =====
// 고객 접수: 입력 검사 → 1시간 한도 → AI 분류 → 저장 → 알림
async function createTicket(request, env, ctx) {
  const body = await request.json().catch(() => null);
  const err = validate(body);
  if (err) return json({ error: err }, 400);

  const phone = body.phone.replace(/[^0-9]/g, "");
  // 같은 번호로 너무 많이 접수하면 막기 (장난 접수로 AI 비용이 새는 것 방지)
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tickets WHERE phone = ? AND created_at > datetime('now', '-1 hour')"
  ).bind(phone).first();
  if (recent.n >= MAX_PER_HOUR) {
    return json({ error: "같은 번호로 접수가 너무 많아요. 1시간 뒤 다시 시도하거나 전화로 문의해 주세요." }, 429);
  }

  // ===== [AI 분류] =====
  // 접수 내용을 AI에게 보내 종류·급한 정도를 받음 (하루 한도 확인 포함)
  const ai = await classifyWithLimit(env, { description: body.description, photo: body.photo });
  const secret = crypto.randomUUID();

  // ===== [저장(DB)] =====
  // 접수를 DB에 저장하고 처리 기록을 남김
  const row = await env.DB.prepare(
    `INSERT INTO tickets (secret, name, phone, address, description, photo,
       category, urgency, team, summary, reason, questions, customer_guide, needs_review, ai_ms, ai_cost_krw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
  ).bind(
    secret, body.name.trim(), phone, body.address.trim(), body.description.trim(), body.photo || null,
    ai.category, ai.urgency, TEAM_OF[ai.category], ai.summary, ai.reason,
    JSON.stringify(ai.questions), ai.customer_guide, ai.needs_review ? 1 : 0, ai.ms, ai.costKrw
  ).first();
  const id = row.id;

  await logEvent(env, id, "접수", `${body.name.trim()} / ${body.address.trim()}`);
  await logEvent(env, id, "AI분류", `${ai.category} · ${ai.urgency} → ${TEAM_OF[ai.category]} (${ai.ms}ms, 약 ${ai.costKrw.toFixed(1)}원)`);

  // ===== [알림] =====
  // Slack·구글 시트·노션으로 보내기 시작. 실패해도 접수는 저장됨
  // 사내 도구로 실시간 연동: Slack 알림(긴급이면 @here) + 구글 시트 + 노션 (응답은 기다리지 않고 먼저 보냄)
  ctx.waitUntil(syncTicket(env, logEvent, id, ai, body, "new"));

  return json({
    id, secret,
    category: ai.category, urgency: ai.urgency, team: TEAM_OF[ai.category],
    customer_guide: ai.customer_guide, questions: ai.questions,
  });
}

// ===== [접수 받기 · 입력 검사] =====
// 이름·연락처·주소·설명·사진이 올바른지 확인
function validate(b) {
  if (!b || typeof b !== "object") return "보낸 내용을 읽을 수 없어요";
  const s = (v) => (typeof v === "string" ? v.trim() : "");
  if (!s(b.name) || s(b.name).length > 30) return "이름을 확인해 주세요";
  const digits = s(b.phone).replace(/[^0-9]/g, "");
  if (digits.length < 9 || digits.length > 11) return "연락처를 확인해 주세요";
  if (!s(b.address) || s(b.address).length > 100) return "주소(동·호수)를 확인해 주세요";
  if (s(b.description).length < 5) return "어떤 문제인지 조금만 더 자세히 써 주세요";
  if (s(b.description).length > 1000) return "설명은 1000자 안으로 써 주세요";
  if (b.photo != null) {
    if (typeof b.photo !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(b.photo)) return "사진 형식을 읽을 수 없어요";
    if (b.photo.length > 1_500_000) return "사진이 너무 커요";
  }
  return null;
}

// ───────────── 고객: 내 접수 보기 / 추가 답변 ─────────────
// ===== [내 접수 보기 · 추가 답변] =====
// 고객이 자기 접수 상태를 보고, AI가 물어본 것에 답하면 다시 분류
async function getMyTicket(env, id, secret) {
  const t = await env.DB.prepare(
    "SELECT id, created_at, category, urgency, team, status, customer_guide, questions FROM tickets WHERE id = ? AND secret = ?"
  ).bind(id, secret || "").first();
  if (!t) return json({ error: "접수를 찾을 수 없어요" }, 404);
  t.questions = JSON.parse(t.questions || "[]");
  return json(t);
}

async function addMore(request, env, ctx, id) {
  const body = await request.json().catch(() => ({}));
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (answer.length < 1 || answer.length > 500) return json({ error: "답변을 확인해 주세요" }, 400);

  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ? AND secret = ?").bind(id, body.secret || "").first();
  if (!t) return json({ error: "접수를 찾을 수 없어요" }, 404);

  // 답변을 설명 뒤에 붙여서 다시 분류 (정보가 늘었으니 판단이 바뀔 수 있음)
  const description = `${t.description}\n\n[고객 추가 답변] ${answer}`;
  const ai = await classifyWithLimit(env, { description, photo: t.photo });
  await env.DB.prepare(
    `UPDATE tickets SET description=?, category=?, urgency=?, team=?, summary=?, reason=?, questions='[]',
       customer_guide=?, needs_review=?, ai_cost_krw = ai_cost_krw + ? WHERE id=?`
  ).bind(description, ai.category, ai.urgency, TEAM_OF[ai.category], ai.summary, ai.reason,
    ai.customer_guide, ai.needs_review ? 1 : 0, ai.costKrw, id).run();

  await logEvent(env, id, "추가답변", answer);
  const changed = ai.category !== t.category || ai.urgency !== t.urgency;
  await logEvent(env, id, "AI분류", `${changed ? "다시 판단: " : "그대로: "}${ai.category} · ${ai.urgency}`);
  if (ai.urgency === "긴급" && t.urgency !== "긴급") {
    ctx.waitUntil(syncTicket(env, logEvent, id, ai, t, "escalated"));
  }
  return json({ id, category: ai.category, urgency: ai.urgency, team: TEAM_OF[ai.category], customer_guide: ai.customer_guide });
}

// ───────────── 관리자 ─────────────
// ===== [관리자 로그인] =====
// 접속 위치 지문 만들기, 비밀번호 비교
// 접속한 곳(IP)을 알아볼 수 없는 값으로 바꿔요. 같은 IP면 같은 값이 나오지만, 값에서 IP를 되돌릴 수는 없어요
async function hashIp(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("fixdesk:" + ip));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 비밀번호로 권한 확인: "admin"(운영자) / "demo"(시연용) / null(틀림)
function roleOf(request, env) {
  const given = request.headers.get("x-admin-key") || "";
  if (same(given, env.ADMIN_PASSWORD)) return "admin";
  if (same(given, env.DEMO_PASSWORD)) return "demo";
  return null;
}

function same(given, real) {
  if (!real || given.length !== real.length) return false;
  // 글자를 끝까지 다 비교 (비교 시간으로 비밀번호를 추측하지 못하게)
  let diff = 0;
  for (let i = 0; i < real.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
  return diff === 0;
}

// ===== [시연용 가림] =====
// 시연용 계정에는 이름·전화번호를 가려서 보여줌
// 시연용에게는 개인정보를 가려서 보여줘요: 홍길동 → 홍*동, 01012345678 → 010-****-5678
function maskName(s) {
  const c = [...(s || "")];
  if (c.length <= 1) return "*";
  if (c.length === 2) return c[0] + "*";
  return c[0] + "*".repeat(c.length - 2) + c[c.length - 1];
}
function maskPhone(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : "****";
}

// ===== [관리자 화면 목록] =====
// 접수 목록 (긴급이 맨 위, 그다음 최신순)
async function listTickets(env, url, role) {
  const where = [], args = [];
  const status = url.searchParams.get("status");
  const urgency = url.searchParams.get("urgency");
  if (status === "진행중") where.push("status != '완료'");
  else if (STATUSES.includes(status)) { where.push("status = ?"); args.push(status); }
  if (URGENCIES.includes(urgency)) { where.push("COALESCE(checked_urgency, urgency) = ?"); args.push(urgency); }

  // 끝나지 않은 긴급 건이 맨 위, 그다음 최신순
  const sql = `SELECT id, created_at, name, address, summary, status, needs_review,
      COALESCE(checked_category, category) AS category,
      COALESCE(checked_urgency, urgency) AS urgency, team,
      checked_category IS NOT NULL AS checked
    FROM tickets ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY (status != '완료' AND COALESCE(checked_urgency, urgency) = '긴급') DESC, id DESC
    LIMIT 200`;
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  if (role === "demo") for (const r of results) r.name = maskName(r.name);
  return json(results);
}

// ===== [관리자 화면 상세] =====
// 접수 하나의 자세한 내용과 처리 기록
async function ticketDetail(env, id, role = "admin") {
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
  if (!t) return json({ error: "없는 접수예요" }, 404);
  let { results: events } = await env.DB.prepare("SELECT at, kind, detail FROM events WHERE ticket_id = ? ORDER BY id").bind(id).all();
  t.questions = JSON.parse(t.questions || "[]");
  delete t.secret;
  if (role === "demo") {
    t.name = maskName(t.name);
    t.phone = maskPhone(t.phone);
    // 처리 기록의 '접수' 줄에도 이름이 들어 있어서 같이 가려요
    events = events.map((e) => (e.kind === "접수" ? { ...e, detail: e.detail.replace(/^[^/]+/, (n) => maskName(n.trim()) + " ") } : e));
  }
  return json({ ...t, events, role });
}

// ===== [관리자 수정] =====
// AI 판단 확인·수정, 처리 상태 바꾸기 (노션에도 바로 반영)
async function updateTicket(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
  if (!t) return json({ error: "없는 접수예요" }, 404);

  // 사람이 확인한 종류·급한 정도 → 담당 팀도 다시 계산
  if (b.checked_category !== undefined || b.checked_urgency !== undefined) {
    const cat = CATEGORIES.includes(b.checked_category) ? b.checked_category : t.category;
    const urg = URGENCIES.includes(b.checked_urgency) ? b.checked_urgency : t.urgency;
    await env.DB.prepare("UPDATE tickets SET checked_category=?, checked_urgency=?, team=?, needs_review=0 WHERE id=?")
      .bind(cat, urg, TEAM_OF[cat], id).run();
    const same = cat === t.category && urg === t.urgency;
    await logEvent(env, id, "확인", same ? `AI 판단 그대로 (${cat} · ${urg})` : `수정: ${t.category}·${t.urgency} → ${cat}·${urg}`);
  }
  if (b.status !== undefined && b.status !== t.status) {
    if (!STATUSES.includes(b.status)) return json({ error: "상태 값이 이상해요" }, 400);
    await env.DB.prepare("UPDATE tickets SET status=?, done_at = CASE WHEN ?='완료' THEN datetime('now') ELSE NULL END WHERE id=?")
      .bind(b.status, b.status, id).run();
    await logEvent(env, id, "상태변경", `${t.status} → ${b.status}`);
    // 노션 업무 보드에도 바로 반영 (실패해도 상태 변경은 그대로)
    const msg = await pushStatusToNotion(env, id, b.status).catch((e) => `실패 (${e.message})`);
    await logEvent(env, id, "연동", `노션: ${msg}`);
  }
  return ticketDetail(env, id);
}

// ===== [통계] =====
// 관리자 화면 위쪽 숫자들 (오늘 접수, 정확도, 비용 등)
async function stats(env) {
  const one = (sql) => env.DB.prepare(sql).first();
  const all = async (sql) => (await env.DB.prepare(sql).all()).results;

  const total = await one(`SELECT COUNT(*) AS n,
      SUM(created_at > datetime('now','-1 day')) AS today,
      SUM(status != '완료') AS open,
      SUM(status != '완료' AND COALESCE(checked_urgency, urgency) = '긴급') AS urgent_open,
      SUM(needs_review = 1) AS review,
      -- 비용·속도 평균은 AI를 실제로 부른 건만 (AI 실패·한도 초과는 0원이라 평균을 낮춰버림)
      ROUND(AVG(CASE WHEN ai_cost_krw > 0 THEN ai_ms END)) AS avg_ms,
      ROUND(AVG(CASE WHEN ai_cost_krw > 0 THEN ai_cost_krw END), 1) AS avg_cost
    FROM tickets`);
  // AI 정확도: 사람이 확인한 접수 중에서 AI 판단과 같았던 비율
  const acc = await one(`SELECT COUNT(*) AS checked,
      SUM(checked_category = category) AS cat_ok,
      SUM(checked_urgency = urgency) AS urg_ok
    FROM tickets WHERE checked_category IS NOT NULL`);
  const byCategory = await all(`SELECT COALESCE(checked_category, category) AS category, COUNT(*) AS n
    FROM tickets GROUP BY 1 ORDER BY n DESC`);
  // 접수부터 완료까지 평균 걸린 시간(시간 단위)
  const done = await one(`SELECT ROUND(AVG((julianday(done_at) - julianday(created_at)) * 24), 1) AS avg_hours
    FROM tickets WHERE done_at IS NOT NULL`);
  return json({ ...total, ...acc, byCategory, avg_done_hours: done.avg_hours });
}

// ===== [하루 한도] =====
// 하루 AI 분류 100건을 넘으면 AI 없이 '사람 확인 필요'로 접수
// 하루 AI 분류 한도를 넘었으면 AI를 부르지 않고 "사람 확인 필요"로 둬요
async function classifyWithLimit(env, input) {
  const used = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events WHERE kind = 'AI분류' AND at > datetime('now', '-1 day')"
  ).first();
  if (used.n >= MAX_AI_PER_DAY) {
    return {
      category: "기타", urgency: "보통", summary: "오늘 AI 분류 한도 초과 - 사람 확인 필요",
      reason: `하루 AI 분류 한도(${MAX_AI_PER_DAY}건)를 넘어서 AI를 부르지 않았어요`,
      questions: [], needs_review: true, ms: 0, costKrw: 0,
      customer_guide: "접수됐어요. 담당자가 내용을 확인한 뒤 연락드릴게요. 위험한 상황이면 119에 먼저 연락하세요.",
    };
  }
  return classify(client(env), input);
}

// ───────────── 작은 도우미들 ─────────────
// ===== [도우미] =====
// AI 연결 만들기, 처리 기록 남기기, 응답 만들기
function client(env) {
  // Workers에서는 키가 env 안에 있어서 직접 넘겨줘요
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

function logEvent(env, id, kind, detail) {
  return env.DB.prepare("INSERT INTO events (ticket_id, kind, detail) VALUES (?,?,?)").bind(id, kind, detail ?? null).run();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
