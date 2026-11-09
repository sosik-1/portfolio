// 정해진 시간에 도는 일 (wrangler.toml [triggers]: 매일 한국 시간 아침 9시)
//   1) 재구매 안내: 원두가 곧 떨어질 손님을 골라 안내 문구를 만들어요
//   2) 판매 보고서: 어제 주문·매출·많이 팔린 상품·답변 대기 문의·재고 부족을 Slack으로
// 관리자 화면의 '지금 실행' 버튼으로도 돌릴 수 있어요 (시연용).
// AI를 쓰지 않아서 비용이 들지 않아요.

import { sendSlack, reportMessage, reorderSummaryMessage, won } from "./integrations.js";
import { SHOP_NAME } from "./policy.js";

// ===== [설정값] =====
// 재구매 안내를 언제 보낼지 정하는 날짜 수
const DAY = 24 * 60 * 60 * 1000;
const REMIND_BEFORE_DAYS = 3; // 다 떨어지기 3일 전에 안내
const LATE_LIMIT_DAYS = 14;   // 다 떨어진 지 2주가 넘은 주문은 안내하지 않음 (너무 늦은 안내는 스팸)

// ===== [날짜 계산 도우미] =====
// DB 시간 읽기, 한국 날짜로 바꾸기
const toUtc = (s) => new Date(s.replace(" ", "T") + "Z");
const kstDate = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

// ===== [재구매 안내] =====
// 원두가 곧 떨어질 손님을 골라 다시 주문 안내 문구를 만들어요
export async function runReorders(env, logEvent) {
  const { results: orders } = await env.DB.prepare(
    `SELECT o.id, o.secret, o.created_at, o.name, o.phone, o.grind
       FROM orders o LEFT JOIN reorders r ON r.order_id = o.id
      WHERE r.id IS NULL AND o.status != '취소'
        AND o.created_at > datetime('now', '-90 days') AND o.created_at < datetime('now', '-3 days')
      ORDER BY o.id`
  ).all();

  const now = Date.now();
  const made = [];
  for (const o of orders) {
    // 원두·드립백만 계산 (도구는 다시 살 일이 드물어요)
    const { results: items } = await env.DB.prepare(
      `SELECT i.name, i.qty, p.days_per_unit FROM order_items i JOIN products p ON p.id = i.product_id
        WHERE i.order_id = ? AND p.days_per_unit IS NOT NULL`
    ).bind(o.id).all();
    if (!items.length) continue;
    const days = items.reduce((s, i) => s + i.days_per_unit * i.qty, 0);
    const runsOut = toUtc(o.created_at).getTime() + days * DAY;
    if (now < runsOut - REMIND_BEFORE_DAYS * DAY || now > runsOut + LATE_LIMIT_DAYS * DAY) continue;

    // 그 사이에 이미 다시 주문한 손님은 건너뛰어요
    const again = await env.DB.prepare(
      "SELECT id FROM orders WHERE phone = ? AND id > ? AND status != '취소' LIMIT 1"
    ).bind(o.phone, o.id).first();
    if (again) continue;

    const products = items.map((i) => i.name).join(", ");
    const link = `${env.SITE_URL || "https://hanjan-shop.dlalsrn08011.workers.dev"}/#/order/${o.id}/${o.secret}`;
    const message =
      `[${SHOP_NAME}] 고객님, ${kstDate(toUtc(o.created_at)).slice(5).replace("-", "월 ")}일에 주문하신 ${products}이(가) 곧 떨어질 때예요. ` +
      `지난번과 같은 ${o.grind}(으)로 다시 받으시려면 아래 링크에서 한 번에 주문할 수 있어요.\n${link}`;
    const r = await env.DB.prepare(
      "INSERT INTO reorders (order_id, due_date, message) VALUES (?,?,?) ON CONFLICT(order_id) DO NOTHING RETURNING id"
    ).bind(o.id, kstDate(new Date(runsOut)), message).first();
    if (!r) continue;
    await logEvent(env, "order", o.id, "재구매안내", `안내 #${r.id} 만듦 (다 떨어지는 날 ${kstDate(new Date(runsOut))})`);
    made.push({ id: r.id, order_id: o.id, name: o.name, products });
  }

  // ===== [알림] =====
  // 만든 재구매 안내를 Slack으로 요약해서 알려요
  let slack = "보낼 안내 없음";
  if (made.length) slack = await sendSlack(env, reorderSummaryMessage(env, made)).catch((e) => `실패 (${e.message})`);
  await logEvent(env, "system", null, "재구매안내", `${made.length}명 · Slack: ${slack}`);
  return { made: made.length, slack };
}

// ===== [매일 9시 보고서] =====
// 어제 주문·매출·많이 팔린 상품·답변 대기 문의·재고 부족 숫자 모으기
// day: 한국 날짜 "YYYY-MM-DD" (없으면 어제)
export async function buildReport(env, day) {
  day = day || kstDate(new Date(Date.now() - DAY));
  const one = (sql, ...a) => env.DB.prepare(sql).bind(...a).first();
  const sum = await one(
    `SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales, SUM(from_reorder IS NOT NULL) AS from_reorder
       FROM orders WHERE date(created_at, '+9 hours') = ? AND status != '취소'`, day);
  const cancelled = await one(`SELECT COUNT(*) AS n FROM orders WHERE date(created_at, '+9 hours') = ? AND status = '취소'`, day);
  const { results: top } = await env.DB.prepare(
    `SELECT i.name, SUM(i.qty) AS qty FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE date(o.created_at, '+9 hours') = ? AND o.status != '취소' GROUP BY i.name ORDER BY qty DESC LIMIT 3`
  ).bind(day).all();
  const inq = await one(`SELECT COUNT(*) AS open, SUM(urgency = '긴급') AS urgent FROM inquiries WHERE status = '답변 대기'`);
  const { results: lowStock } = await env.DB.prepare(
    "SELECT name, stock FROM products WHERE active = 1 AND stock <= low_stock ORDER BY stock"
  ).all();
  return {
    day,
    orders: sum.orders,
    sales: sum.sales,
    avg: sum.orders ? Math.round(sum.sales / sum.orders) : 0,
    fromReorder: sum.from_reorder || 0,
    cancelled: cancelled.n,
    top,
    openInquiries: inq.open || 0,
    urgentInquiries: inq.urgent || 0,
    lowStock,
  };
}

// ===== [매일 9시 보고서] =====
// 모은 숫자를 Slack으로 보내고 기록 남기기
export async function runReport(env, logEvent, day) {
  const r = await buildReport(env, day);
  const slack = await sendSlack(env, reportMessage(env, r)).catch((e) => `실패 (${e.message})`);
  await logEvent(env, "system", null, "보고서", `${r.day} · 주문 ${r.orders}건 · ${won(r.sales)} · Slack: ${slack}`);
  return { ...r, slack };
}
