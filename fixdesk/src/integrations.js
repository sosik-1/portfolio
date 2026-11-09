// 접수가 들어오면 사내 도구로 실시간 연동해요
//   Slack  : 담당 채널에 알림 (긴급이면 @here + 빨간 표시)
//   구글 시트: '하자 접수' 탭에 한 줄 (Apps Script 웹 앱, 경비 검수 에이전트와 같은 시트)
//   노션   : 접수 데이터베이스에 한 장
// 받는 곳(웹훅 주소·토큰)은 비밀값으로만 넣고, 접수 내용으로는 바꿀 수 없어요.
// 하나가 실패해도 접수와 다른 연동은 그대로 진행되고, 결과는 이력(events)에 남아요.

// ===== [설정값] =====
// 담당 팀 표와 급한 정도 아이콘
import { TEAM_OF } from "./classify.js";

const ICON = { 긴급: "🚨", 보통: "🟡", 낮음: "🟢" };

// ===== [개인정보 가림] =====
// 밖(Slack·시트·노션)으로 보낼 때 이름·전화번호를 가림
// 바깥으로 나가는 곳에는 고객 이름·전화번호를 가려서 보내요
export const maskName = (n) => (n.length <= 1 ? "*" : n[0] + "*".repeat(n.length - 1));
const maskPhone = (p) => p.replace(/^(\d{3})\d+(\d{4})$/, "$1-****-$2");

function adminUrl(env) {
  return `${env.SITE_URL || "https://fixdesk.dlalsrn08011.workers.dev"}/admin.html`;
}

// ===== [알림] =====
// Slack·구글 시트·노션으로 한꺼번에 보내고 결과를 처리 기록에 남김
// kind: "new"(새 접수) | "escalated"(추가 답변으로 긴급이 됨)
export async function syncTicket(env, logEvent, id, ai, t, kind = "new") {
  const row = {
    id,
    urgency: ai.needs_review ? "확인 필요" : ai.urgency,
    category: ai.category,
    team: TEAM_OF[ai.category],
    summary: ai.summary,
    reason: ai.reason,
    address: String(t.address || "").trim(),
    customer: `${maskName(String(t.name || "").trim())} · ${maskPhone(String(t.phone || "").replace(/[^0-9]/g, ""))}`,
    admin_url: adminUrl(env),
  };
  const jobs = [["Slack", () => sendSlack(env, row, kind)]];
  if (kind === "new") jobs.push(["시트", () => appendSheet(env, row)], ["노션", () => addNotion(env, row)]);
  await Promise.all(
    jobs.map(async ([name, fn]) => {
      let msg;
      try {
        msg = await fn();
      } catch (e) {
        msg = `실패 (${e.message})`.slice(0, 200);
      }
      await logEvent(env, id, "연동", `${name}: ${msg}`);
    })
  );
}

// ===== [알림 · Slack] =====
// 담당 채널에 알림 (긴급이면 @here)
// ───── Slack (Incoming Webhook + Block Kit) ─────
export function slackMessage(r, kind) {
  const urgent = r.urgency === "긴급" || r.urgency === "확인 필요";
  const title = `${ICON[r.urgency] || "⚠️"} ${r.urgency} · 하자 접수 #${r.id}${kind === "escalated" ? " (추가 답변 후 긴급)" : ""}`;
  return {
    text: `${urgent ? "<!here> " : ""}${title} · ${r.category} → ${r.team}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
      ...(urgent ? [{ type: "section", text: { type: "mrkdwn", text: "<!here> *바로 확인이 필요한 접수예요.*" } }] : []),
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*종류*\n${r.category}` },
          { type: "mrkdwn", text: `*담당 팀*\n${r.team}` },
          { type: "mrkdwn", text: `*주소*\n${r.address}` },
          { type: "mrkdwn", text: `*고객*\n${r.customer}` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*요약*\n${r.summary}`.slice(0, 2900) } },
      { type: "context", elements: [{ type: "mrkdwn", text: `AI 판단 이유: ${r.reason}`.slice(0, 2900) }] },
      {
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "관리자 화면에서 보기" }, url: r.admin_url, style: urgent ? "danger" : "primary" }],
      },
    ],
  };
}

async function sendSlack(env, r, kind) {
  if (!env.SLACK_WEBHOOK_URL) return "주소가 없어 기록만 남김";
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(slackMessage(r, kind)),
  });
  return res.ok ? "채널에 보냄" : `보내기 실패 (${res.status})`;
}

// ===== [알림 · 구글 시트] =====
// '하자 접수' 탭에 한 줄 추가
// ───── 구글 시트 (Apps Script 웹 앱) ─────
async function appendSheet(env, r) {
  if (!env.SHEET_WEBHOOK_URL) return "주소가 없어 기록만 남김";
  const res = await fetch(env.SHEET_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.SHEET_SECRET, action: "fixdesk", row: r }),
    redirect: "follow",
  });
  const text = await res.text();
  return /"ok"\s*:\s*true/.test(text) ? "한 줄 기록" : `기록 실패 (${text.slice(0, 80)})`;
}

// ===== [알림 · 노션] =====
// 노션 접수 데이터베이스에 페이지 한 장 추가 (없는 칸은 만듦)
// ───── 노션 (Notion API) ─────
const NOTION_VERSION = "2022-06-28";
// 접수 데이터베이스에 필요한 칸. 처음 한 번 없으면 코드가 만들어요 (사용자는 빈 데이터베이스만 만들면 됨)
const NOTION_PROPS = {
  "접수 번호": { number: {} },
  "급한 정도": { select: { options: [{ name: "긴급", color: "red" }, { name: "확인 필요", color: "orange" }, { name: "보통", color: "yellow" }, { name: "낮음", color: "green" }] } },
  종류: { select: {} },
  "담당 팀": { select: {} },
  주소: { rich_text: {} },
  고객: { rich_text: {} },
  "판단 이유": { rich_text: {} },
  상태: { select: { options: [{ name: "접수", color: "gray" }, { name: "배정", color: "blue" }, { name: "처리중", color: "purple" }, { name: "완료", color: "green" }] } },
  "관리자 화면": { url: {} },
};

function notion(env, path, method, body) {
  return fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function addNotion(env, r) {
  if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) return "토큰이 없어 기록만 남김";
  // 링크 전체를 넣어도 돼요: ?v= 뒤(보기 id)는 버리고, 32자리 id를 찾아요
  const dbId = (env.NOTION_DB_ID.split("?")[0].replace(/-/g, "").match(/[0-9a-f]{32}/gi) || []).pop();
  if (!dbId) return "데이터베이스 링크에서 id를 못 찾음";
  // 데이터베이스의 칸 확인: 제목 칸 이름을 찾고, 없는 칸은 만들어요
  const db = await notion(env, `databases/${dbId}`, "GET");
  if (!db.ok) return `데이터베이스를 못 읽음 (${db.status}) - 연결(Connections)에 앱을 추가했는지 확인`;
  const props = (await db.json()).properties;
  const titleName = Object.keys(props).find((k) => props[k].type === "title");
  const missing = Object.fromEntries(Object.entries(NOTION_PROPS).filter(([k]) => !props[k]));
  if (Object.keys(missing).length) {
    const up = await notion(env, `databases/${dbId}`, "PATCH", { properties: missing });
    if (!up.ok) return `칸 만들기 실패 (${up.status})`;
  }
  const text = (s) => [{ text: { content: String(s).slice(0, 1900) } }];
  const res = await notion(env, "pages", "POST", {
    parent: { database_id: dbId },
    icon: { type: "emoji", emoji: ICON[r.urgency] || "⚠️" },
    properties: {
      [titleName]: { title: text(r.summary) },
      "접수 번호": { number: r.id },
      "급한 정도": { select: { name: r.urgency } },
      종류: { select: { name: r.category } },
      "담당 팀": { select: { name: r.team } },
      주소: { rich_text: text(r.address) },
      고객: { rich_text: text(r.customer) },
      "판단 이유": { rich_text: text(r.reason) },
      상태: { select: { name: "접수" } },
      "관리자 화면": { url: r.admin_url },
    },
  });
  return res.ok ? "페이지 추가" : `추가 실패 (${res.status})`;
}

// ===== [노션 상태 맞추기] =====
// 노션과 fixdesk의 처리 상태를 양쪽으로 맞춤
// ───── 노션 ↔ fixdesk 상태 맞추기 (양방향) ─────
// 원본은 fixdesk DB. 노션에서 '상태'를 바꾸면 1분마다 도는 예약 작업이 읽어서 DB에 반영하고,
// 관리자 화면에서 바꾸면 바로 노션 페이지에 반영해요. 두 쪽 값이 같으면 아무것도 안 해서 서로 계속 고치는 일은 없어요.
const STATUSES = ["접수", "배정", "처리중", "완료"];

function notionDbId(env) {
  if (!env.NOTION_TOKEN || !env.NOTION_DB_ID) return null;
  return (env.NOTION_DB_ID.split("?")[0].replace(/-/g, "").match(/[0-9a-f]{32}/gi) || []).pop() || null;
}

// ===== [노션 상태 맞추기 · 관리자 → 노션] =====
// 관리자 화면에서 바꾼 상태를 노션 페이지에 반영
// 관리자 화면에서 상태를 바꿨을 때: 접수 번호로 노션 페이지를 찾아 '상태' 칸을 바꿔요
export async function pushStatusToNotion(env, id, status) {
  const dbId = notionDbId(env);
  if (!dbId) return "토큰이 없어 기록만 남김";
  const q = await notion(env, `databases/${dbId}/query`, "POST", { filter: { property: "접수 번호", number: { equals: id } }, page_size: 1 });
  if (!q.ok) return `페이지 찾기 실패 (${q.status})`;
  const page = (await q.json()).results?.[0];
  if (!page) return "노션에 이 접수 페이지가 없음";
  const up = await notion(env, `pages/${page.id}`, "PATCH", { properties: { 상태: { select: { name: status } } } });
  return up.ok ? `상태를 '${status}'로 바꿈` : `상태 바꾸기 실패 (${up.status})`;
}

// ===== [노션 상태 맞추기 · 노션 → DB] =====
// 1분마다: 노션에서 바꾼 상태를 DB에 반영
// 예약 작업(1분마다): 최근 15분 안에 고친 노션 페이지의 '상태'를 DB와 비교해 다르면 DB를 바꿔요
export async function pullFromNotion(env, logEvent) {
  const dbId = notionDbId(env);
  if (!dbId) return { skipped: "토큰 없음" };
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const q = await notion(env, `databases/${dbId}/query`, "POST", {
    filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: since } },
    page_size: 100,
  });
  if (!q.ok) return { error: `노션 읽기 실패 (${q.status})` };
  let changed = 0;
  for (const page of (await q.json()).results || []) {
    const id = page.properties?.["접수 번호"]?.number;
    const status = page.properties?.["상태"]?.select?.name;
    if (!Number.isInteger(id) || !STATUSES.includes(status)) continue;
    const t = await env.DB.prepare("SELECT status FROM tickets WHERE id = ?").bind(id).first();
    if (!t || t.status === status) continue;
    await env.DB.prepare("UPDATE tickets SET status=?, done_at = CASE WHEN ?='완료' THEN datetime('now') ELSE NULL END WHERE id=?")
      .bind(status, status, id).run();
    await logEvent(env, id, "상태변경", `노션에서 바꿈: ${t.status} → ${status}`);
    changed++;
  }
  return { changed };
}
