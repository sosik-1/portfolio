// 가게 운영 알림을 사내 도구로 보내요
//   Slack  : 새 주문, 급한 문의, 재고 부족, 매일 아침 보고서, 재구매 안내 요약 (Incoming Webhook + Block Kit)
//   구글 시트: '주문'·'문의' 탭에 한 줄 (Apps Script 웹 앱, fixdesk·경비 검수 에이전트와 같은 시트)
//   노션   : '배송 보드'에 주문 한 장, '문의 보드'에 문의 한 장. 상태를 바꾸면 노션도 바뀜
// 받는 곳(웹훅 주소·토큰)은 비밀값으로만 넣어요. 비밀값이 없으면 보내지 않고 기록만 남겨요.
// 하나가 실패해도 주문·문의 처리는 그대로 진행되고, 결과는 처리 기록(events)에 남아요.

// ===== [시연용 가림] =====
// 이름·전화번호 가리기, 금액 표시
export const maskName = (n) => {
  const c = [...String(n || "")];
  if (c.length <= 1) return "*";
  if (c.length === 2) return c[0] + "*";
  return c[0] + "*".repeat(c.length - 2) + c[c.length - 1];
};
export const maskPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 8 ? `${d.slice(0, 3)}-****-${d.slice(-4)}` : "****";
};
export const won = (n) => `${Number(n || 0).toLocaleString("ko-KR")}원`;

// ===== [설정값] =====
// 알림 속 링크에 쓰는 사이트 주소
const siteUrl = (env) => env.SITE_URL || "https://hanjan-shop.dlalsrn08011.workers.dev";

// ===== [알림] =====
// Slack으로 보내기. 주소(비밀값)가 없으면 보내지 않고 기록만
// ───── Slack ─────
export async function sendSlack(env, message) {
  if (!env.SLACK_WEBHOOK_URL) return "주소가 없어 기록만 남김";
  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(message),
  });
  return res.ok ? "채널에 보냄" : `보내기 실패 (${res.status})`;
}

// ===== [알림 문구] =====
// 새 주문·문의·재고 부족·보고서·재구매 안내의 Slack 메시지 모양
const button = (text, url, style) => ({ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text }, url, ...(style ? { style } : {}) }] });

export function orderMessage(env, o, items) {
  const lines = items.map((i) => `• ${i.name} × ${i.qty}`).join("\n");
  const title = `☕ 새 주문 #${o.id} · ${won(o.total)}`;
  return {
    text: `${title} (${items.length}종)`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*손님*\n${maskName(o.name)} · ${maskPhone(o.phone)}` },
          { type: "mrkdwn", text: `*분쇄*\n${o.grind}` },
          { type: "mrkdwn", text: `*상품*\n${lines}`.slice(0, 1900) },
          { type: "mrkdwn", text: `*금액*\n상품 ${won(o.subtotal)} + 배송 ${won(o.shipping)}` },
        ],
      },
      ...(o.from_reorder ? [{ type: "context", elements: [{ type: "mrkdwn", text: `🔁 재구매 안내 #${o.from_reorder}을 보고 다시 주문한 손님이에요` }] }] : []),
      ...(o.memo ? [{ type: "context", elements: [{ type: "mrkdwn", text: `요청 사항: ${o.memo}`.slice(0, 500) }] }] : []),
      button("관리자 화면에서 보기", `${siteUrl(env)}/admin.html#order-${o.id}`, "primary"),
    ],
  };
}

export function inquiryMessage(env, q) {
  const urgent = q.urgency === "긴급" || q.needs_human;
  const icon = { 긴급: "🚨", 보통: "🟡", 낮음: "🟢" }[q.urgency] || "⚠️";
  const title = `${icon} 문의 #${q.id} · ${q.category} · ${q.urgency}`;
  return {
    text: `${q.urgency === "긴급" ? "<!here> " : ""}${title} · ${q.summary}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title.slice(0, 150) } },
      ...(q.urgency === "긴급" ? [{ type: "section", text: { type: "mrkdwn", text: "<!here> *바로 확인이 필요한 문의예요.*" } }] : []),
      { type: "section", text: { type: "mrkdwn", text: `*요약*  ${q.summary}\n*손님*  ${maskName(q.name)}${q.order_id ? ` · 주문 #${q.order_id}` : ""}` } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `AI 판단: ${q.reason}${q.cited?.length ? ` · 근거 ${q.cited.join(", ")}` : ""}${q.needs_human ? " · *사람 판단 필요*" : " · 답변 초안 준비됨"}`.slice(0, 2900) }],
      },
      button("초안 확인하고 답변하기", `${siteUrl(env)}/admin.html#inquiry-${q.id}`, urgent ? "danger" : "primary"),
    ],
  };
}

export function stockMessage(env, p, before, after) {
  const out = after <= 0;
  const title = `${out ? "⛔ 품절" : "📦 재고 부족"} · ${p.name}`;
  return {
    text: `${title} (${before} → ${after}개)`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: title } },
      { type: "section", text: { type: "mrkdwn", text: `남은 재고 *${after}개* (알림 기준 ${p.low_stock}개 이하)\n${out ? "손님 화면에서 '품절'로 보여요. 다시 볶아 채워 주세요." : "다 팔리기 전에 로스팅 일정을 잡아 주세요."}` } },
      button("재고 채우기", `${siteUrl(env)}/admin.html#products`),
    ],
  };
}

export function reportMessage(env, r) {
  const top = r.top.length ? r.top.map((t, i) => `${i + 1}. ${t.name} ${t.qty}개`).join("\n") : "없음";
  const low = r.lowStock.length ? r.lowStock.map((p) => `${p.name} ${p.stock}개`).join(", ") : "없음";
  return {
    text: `📊 ${r.day} 판매 보고서 · 주문 ${r.orders}건 · ${won(r.sales)}`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `📊 ${r.day} 판매 보고서` } },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*주문*\n${r.orders}건 (취소 ${r.cancelled}건)` },
          { type: "mrkdwn", text: `*매출*\n${won(r.sales)}` },
          { type: "mrkdwn", text: `*객단가*\n${won(r.avg)}` },
          { type: "mrkdwn", text: `*재구매 안내로 온 주문*\n${r.fromReorder}건` },
        ],
      },
      { type: "section", text: { type: "mrkdwn", text: `*많이 팔린 상품*\n${top}` } },
      { type: "section", text: { type: "mrkdwn", text: `*답변 기다리는 문의* ${r.openInquiries}건 (긴급 ${r.urgentInquiries}건)\n*재고 부족* ${low}` } },
      button("관리자 화면 열기", `${siteUrl(env)}/admin.html`),
    ],
  };
}

export function reorderSummaryMessage(env, list) {
  const lines = list.slice(0, 10).map((r) => `• ${maskName(r.name)} · ${r.products} (주문 #${r.order_id})`).join("\n");
  return {
    text: `🔁 오늘 재구매 안내 ${list.length}명`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: `🔁 오늘 재구매 안내 ${list.length}명` } },
      { type: "section", text: { type: "mrkdwn", text: `원두가 곧 떨어질 손님에게 안내를 만들었어요.\n${lines}${list.length > 10 ? `\n외 ${list.length - 10}명` : ""}` } },
      button("안내 내용 보기", `${siteUrl(env)}/admin.html#reorders`),
    ],
  };
}

// ===== [구글 시트] =====
// 주문·문의를 시트에 한 줄씩 기록 (문의는 원문 없이 요약만)
// ───── 구글 시트 (Apps Script 웹 앱: action "shop_order" → '주문' 탭, "shop_inquiry" → '문의' 탭) ─────
async function postSheet(env, action, row) {
  if (!env.SHEET_WEBHOOK_URL) return "주소가 없어 기록만 남김";
  const res = await fetch(env.SHEET_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: env.SHEET_SECRET, action, row }),
    redirect: "follow",
  });
  const text = await res.text();
  return /"ok"\s*:\s*true/.test(text) ? "한 줄 기록" : `기록 실패 (${text.slice(0, 80)})`;
}

export function appendSheet(env, o, items) {
  return postSheet(env, "shop_order", {
    id: o.id,
    total: o.total,
    items: items.map((i) => `${i.name}×${i.qty}`).join(", "),
    grind: o.grind,
    customer: `${maskName(o.name)} · ${maskPhone(o.phone)}`,
    status: o.status,
    reorder: o.from_reorder ? `안내 #${o.from_reorder}` : "",
    admin_url: `${siteUrl(env)}/admin.html#order-${o.id}`,
  });
}

// 문의: 손님이 쓴 원문은 보내지 않고 AI 요약만 (원문은 관리자 화면에서)
export function appendSheetInquiry(env, q) {
  return postSheet(env, "shop_inquiry", {
    id: q.id,
    category: q.category,
    urgency: q.urgency,
    summary: q.summary,
    customer: maskName(q.name),
    order_id: q.order_id || "",
    needs_human: q.needs_human ? "필요" : "",
    cited: (q.cited || []).join(", "),
    admin_url: `${siteUrl(env)}/admin.html#inquiry-${q.id}`,
  });
}

// ===== [노션 준비] =====
// 노션 칸 모양, 데이터베이스 읽기, 없는 칸 만들기
// ───── 노션: '배송 보드'(NOTION_DB_ID) · '문의 보드'(NOTION_INQ_DB_ID) ─────
const NOTION_VERSION = "2022-06-28";
const ORDER_STATUS = [
  { name: "결제 완료", color: "gray" }, { name: "상품 준비", color: "blue" }, { name: "배송 중", color: "purple" },
  { name: "배송 완료", color: "green" }, { name: "취소", color: "red" },
];
// 처음 한 번 없는 칸은 코드가 만들어요 (사용자는 빈 데이터베이스만 만들면 됨)
const ORDER_PROPS = {
  "주문 번호": { number: {} },
  상태: { select: { options: ORDER_STATUS } },
  금액: { number: { format: "won" } },
  분쇄: { select: {} },
  손님: { rich_text: {} },
  "관리자 화면": { url: {} },
};
const INQ_PROPS = {
  "문의 번호": { number: {} },
  종류: { select: {} },
  "급한 정도": { select: { options: [{ name: "긴급", color: "red" }, { name: "보통", color: "yellow" }, { name: "낮음", color: "green" }] } },
  상태: { select: { options: [{ name: "답변 대기", color: "orange" }, { name: "답변 완료", color: "green" }] } },
  "사람 판단": { checkbox: {} },
  손님: { rich_text: {} },
  "주문 번호": { number: {} },
  "관리자 화면": { url: {} },
};

function notion(env, path, method, body) {
  return fetch(`https://api.notion.com/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${env.NOTION_TOKEN}`, "notion-version": NOTION_VERSION, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
// 링크 전체를 넣어도 돼요: ?v= 뒤(보기 id)는 버리고 32자리 id를 찾아요
function dbIdFrom(env, value) {
  if (!env.NOTION_TOKEN || !value) return null;
  return (value.split("?")[0].replace(/-/g, "").match(/[0-9a-f]{32}/gi) || []).pop() || null;
}
// 데이터베이스를 읽어 제목 칸 이름을 찾고, 없는 칸은 만들어요
async function prepareDb(env, dbId, want) {
  const db = await notion(env, `databases/${dbId}`, "GET");
  if (!db.ok) return { error: `데이터베이스를 못 읽음 (${db.status}) - 연결(Connections)에 앱을 추가했는지 확인` };
  const props = (await db.json()).properties;
  const missing = Object.fromEntries(Object.entries(want).filter(([k]) => !props[k]));
  if (Object.keys(missing).length) {
    const up = await notion(env, `databases/${dbId}`, "PATCH", { properties: missing });
    if (!up.ok) return { error: `칸 만들기 실패 (${up.status})` };
  }
  return { titleName: Object.keys(props).find((k) => props[k].type === "title") };
}
const rich = (s) => [{ text: { content: String(s).slice(0, 1900) } }];

// ===== [노션 기록] =====
// 배송 보드에 주문 한 장, 문의 보드에 문의 한 장 추가
export async function addNotion(env, o, items) {
  const dbId = dbIdFrom(env, env.NOTION_DB_ID);
  if (!dbId) return "토큰이 없어 기록만 남김";
  const { titleName, error } = await prepareDb(env, dbId, ORDER_PROPS);
  if (error) return error;
  const res = await notion(env, "pages", "POST", {
    parent: { database_id: dbId },
    icon: { type: "emoji", emoji: "☕" },
    properties: {
      [titleName]: { title: rich(items.map((i) => `${i.name}×${i.qty}`).join(", ")) },
      "주문 번호": { number: o.id },
      상태: { select: { name: o.status } },
      금액: { number: o.total },
      분쇄: { select: { name: o.grind } },
      손님: { rich_text: rich(`${maskName(o.name)} · ${maskPhone(o.phone)}`) },
      "관리자 화면": { url: `${siteUrl(env)}/admin.html#order-${o.id}` },
    },
  });
  return res.ok ? "배송 보드에 추가" : `추가 실패 (${res.status})`;
}

export async function addNotionInquiry(env, q) {
  const dbId = dbIdFrom(env, env.NOTION_INQ_DB_ID);
  if (!dbId) return "토큰이 없어 기록만 남김";
  const { titleName, error } = await prepareDb(env, dbId, INQ_PROPS);
  if (error) return error;
  const res = await notion(env, "pages", "POST", {
    parent: { database_id: dbId },
    icon: { type: "emoji", emoji: { 긴급: "🚨", 보통: "🟡", 낮음: "🟢" }[q.urgency] || "💬" },
    properties: {
      [titleName]: { title: rich(q.summary) },
      "문의 번호": { number: q.id },
      종류: { select: { name: q.category } },
      "급한 정도": { select: { name: q.urgency } },
      상태: { select: { name: "답변 대기" } },
      "사람 판단": { checkbox: !!q.needs_human },
      손님: { rich_text: rich(maskName(q.name)) },
      ...(q.order_id ? { "주문 번호": { number: q.order_id } } : {}),
      "관리자 화면": { url: `${siteUrl(env)}/admin.html#inquiry-${q.id}` },
    },
  });
  return res.ok ? "문의 보드에 추가" : `추가 실패 (${res.status})`;
}

// ===== [노션 상태 바꾸기] =====
// 주문 취소·상태 변경, 문의 답변 완료를 노션에도 반영
// 번호로 노션 페이지를 찾아 '상태'를 바꿔요 (주문: 관리자·손님 취소 / 문의: 답변 보냄)
async function setNotionStatus(env, dbValue, key, id, status) {
  const dbId = dbIdFrom(env, dbValue);
  if (!dbId) return "토큰이 없어 기록만 남김";
  const q = await notion(env, `databases/${dbId}/query`, "POST", { filter: { property: key, number: { equals: id } }, page_size: 1 });
  if (!q.ok) return `페이지 찾기 실패 (${q.status})`;
  const page = (await q.json()).results?.[0];
  if (!page) return "노션에 이 페이지가 없음";
  const up = await notion(env, `pages/${page.id}`, "PATCH", { properties: { 상태: { select: { name: status } } } });
  return up.ok ? `상태를 '${status}'로 바꿈` : `상태 바꾸기 실패 (${up.status})`;
}
export const pushStatusToNotion = (env, id, status) => setNotionStatus(env, env.NOTION_DB_ID, "주문 번호", id, status);
export const pushInquiryStatusToNotion = (env, id, status) => setNotionStatus(env, env.NOTION_INQ_DB_ID, "문의 번호", id, status);
