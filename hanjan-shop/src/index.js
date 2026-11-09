// 한잔로스터리 (가상 원두 가게) 서버 — Cloudflare Workers
// 손님: 상품 보기, 주문(가상 결제), 주문 조회·취소·다시 주문, 1:1 문의
// 관리자: 오늘 현황, 주문 상태 바꾸기, AI 답변 초안 확인·보내기, 재고, 재구매 안내, 보고서
// 화면 파일(public/)은 Cloudflare가 보내고, /api/ 로 시작하는 요청만 여기로 와요.

import Anthropic from "@anthropic-ai/sdk";
import { answerInquiry } from "./ai.js";
import { POLICY, GRINDS, FREE_SHIPPING, SHIPPING_FEE, SHOP_NAME } from "./policy.js";
import {
  sendSlack, orderMessage, inquiryMessage, stockMessage, appendSheet, addNotion, pushStatusToNotion,
  appendSheetInquiry, addNotionInquiry, pushInquiryStatusToNotion, maskName, maskPhone,
} from "./integrations.js";
import { runReorders, runReport, buildReport } from "./jobs.js";

// ===== [설정값] =====
// 주문·문의 횟수 제한, AI 하루 한도, 비밀번호 잠금 시간 같은 숫자들
const ORDER_STATUSES = ["결제 완료", "상품 준비", "배송 중", "배송 완료", "취소"];
const MAX_ORDERS_PER_HOUR = 10;   // 같은 번호로 1시간에 주문할 수 있는 수
const MAX_INQ_PER_HOUR = 5;       // 같은 번호로 1시간에 문의할 수 있는 수 (AI 비용 보호)
const MAX_AI_PER_DAY = 100;       // 하루 전체 AI 호출 수 (넘으면 AI 없이 접수만 → 하루 최대 약 2,000원)
const MAX_LOGIN_FAILS = 10;
const LOCK_MINUTES = 10;

// ===== [서버 입구·오류 처리] =====
// 모든 요청이 먼저 여기로 와요. 예상 못 한 오류는 '서버 오류' 안내로 바꿔 답하고, 아침 9시 자동 작업도 여기서 시작
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
  // 매일 한국 시간 아침 9시 (wrangler.toml [triggers]): 재구매 안내 → 어제 판매 보고서
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await runReorders(env, logEvent).catch((e) => console.error("재구매 안내 실패", e));
      await runReport(env, logEvent).catch((e) => console.error("보고서 실패", e));
    })());
  },
};

// ===== [주소 나누기] =====
// 요청 주소(/api/...)를 보고 어느 기능으로 보낼지 정해요
async function route(request, env, ctx, url) {
  const p = url.pathname;
  const m = request.method;
  let hit;

  // ── 손님 ──
  if (p === "/api/products" && m === "GET") return listProducts(env);
  if (p === "/api/policy" && m === "GET") return json({ shop: SHOP_NAME, policy: POLICY, grinds: GRINDS, free_shipping: FREE_SHIPPING, shipping_fee: SHIPPING_FEE });
  if (p === "/api/orders" && m === "POST") return createOrder(request, env, ctx);
  if ((hit = p.match(/^\/api\/orders\/(\d+)$/)) && m === "GET") return getMyOrder(env, +hit[1], url.searchParams.get("secret"));
  if ((hit = p.match(/^\/api\/orders\/(\d+)\/cancel$/)) && m === "POST") return cancelMyOrder(request, env, ctx, +hit[1]);
  if (p === "/api/inquiries" && m === "POST") return createInquiry(request, env, ctx);
  if ((hit = p.match(/^\/api\/inquiries\/(\d+)$/)) && m === "GET") return getMyInquiry(env, +hit[1], url.searchParams.get("secret"));

  // ===== [관리자 로그인] =====
  // 비밀번호 확인, 여러 번 틀리면 10분 잠금, 시연용은 보기만
  // ── 관리자 (비밀번호 필요) ── 운영자(admin): 모든 기능 / 시연용(demo): 보기만, 이름·연락처·주소는 가려서
  if (p.startsWith("/api/admin/")) {
    const ipHash = await hashIp(request);
    const fails = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM login_fails WHERE ip_hash = ? AND at > datetime('now', '-${LOCK_MINUTES} minutes')`
    ).bind(ipHash).first();
    if (fails.n >= MAX_LOGIN_FAILS) return json({ error: `비밀번호를 여러 번 틀려서 ${LOCK_MINUTES}분 동안 막혔어요.` }, 429);
    const role = roleOf(request, env);
    if (!role) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO login_fails (ip_hash) VALUES (?)").bind(ipHash),
        env.DB.prepare("DELETE FROM login_fails WHERE at < datetime('now', '-1 day')"),
      ]);
      const left = MAX_LOGIN_FAILS - fails.n - 1;
      return json({ error: left > 0 ? `비밀번호가 맞지 않아요 (${left}번 더 틀리면 ${LOCK_MINUTES}분 동안 막혀요)` : `비밀번호를 여러 번 틀려서 ${LOCK_MINUTES}분 동안 막혔어요.` }, 401);
    }
    const demo = role === "demo";
    const write = m !== "GET";
    if (write && demo) return json({ error: "시연용 계정은 볼 수만 있어요" }, 403);

    if (p === "/api/admin/me") return json({ role });
    if (p === "/api/admin/dashboard") return dashboard(env);
    if (p === "/api/admin/orders" && !write) return listOrders(env, url, demo);
    if ((hit = p.match(/^\/api\/admin\/orders\/(\d+)$/))) return write ? updateOrder(request, env, ctx, +hit[1]) : orderDetail(env, +hit[1], demo);
    if (p === "/api/admin/inquiries" && !write) return listInquiries(env, url, demo);
    if ((hit = p.match(/^\/api\/admin\/inquiries\/(\d+)$/)) && !write) return inquiryDetail(env, +hit[1], demo);
    if ((hit = p.match(/^\/api\/admin\/inquiries\/(\d+)\/reply$/)) && m === "POST") return replyInquiry(request, env, ctx, +hit[1]);
    if (p === "/api/admin/products" && !write) return json((await env.DB.prepare("SELECT * FROM products ORDER BY id").all()).results);
    if ((hit = p.match(/^\/api\/admin\/products\/(\d+)$/)) && m === "PATCH") return updateProduct(request, env, +hit[1]);
    if (p === "/api/admin/reorders" && !write) return listReorders(env, demo);
    if (p === "/api/admin/report" && !write) return json(await buildReport(env, url.searchParams.get("day") || undefined));
    if (p === "/api/admin/events" && !write) return listEvents(env, url);
    if (p === "/api/admin/run/reorders" && m === "POST") return json(await runReorders(env, logEvent));
    if (p === "/api/admin/run/report" && m === "POST") {
      const b = await request.json().catch(() => ({}));
      return json(await runReport(env, logEvent, /^\d{4}-\d{2}-\d{2}$/.test(b.day || "") ? b.day : undefined));
    }
  }
  return json({ error: "없는 주소예요" }, 404);
}

// ===== [상품 목록] =====
// 손님에게 파는 상품을 보여 줘요. 재고는 숫자 대신 품절/얼마 안 남음/있음으로
// ───────────── 손님: 상품 ─────────────
async function listProducts(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, slug, name, kind, price, unit, notes, roast, description, color, stock, low_stock FROM products WHERE active = 1 ORDER BY id"
  ).all();
  // 정확한 재고 수는 손님에게 보여 주지 않아요: 품절 / 얼마 안 남음 / 넉넉함
  return json(results.map(({ stock, low_stock, ...p }) => ({ ...p, stock_state: stock <= 0 ? "품절" : stock <= low_stock ? "얼마 안 남음" : "있음" })));
}

// ===== [주문 받기·가상 결제] =====
// 주문 내용을 검사하고, 가격은 DB 값으로 다시 계산해서 주문을 저장해요 (돈은 안 나감)
// ───────────── 손님: 주문 ─────────────
const s = (v) => (typeof v === "string" ? v.trim() : "");

function validateOrder(b) {
  if (!b || typeof b !== "object") return "보낸 내용을 읽을 수 없어요";
  if (!s(b.name) || s(b.name).length > 30) return "받는 분 이름을 확인해 주세요";
  const digits = s(b.phone).replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 11) return "연락처를 확인해 주세요";
  if (!s(b.address) || s(b.address).length > 120) return "주소를 확인해 주세요";
  if (!GRINDS.includes(b.grind)) return "분쇄 굵기를 골라 주세요";
  if (s(b.memo).length > 200) return "요청 사항은 200자 안으로 써 주세요";
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 10) return "장바구니가 비어 있어요";
  for (const it of b.items) {
    if (!Number.isInteger(it?.product_id) || !Number.isInteger(it?.qty) || it.qty < 1 || it.qty > 10) return "상품 수량을 확인해 주세요 (한 상품에 10개까지)";
  }
  if (new Set(b.items.map((i) => i.product_id)).size !== b.items.length) return "같은 상품이 두 번 들어 있어요";
  return null;
}

async function createOrder(request, env, ctx) {
  const b = await request.json().catch(() => null);
  const err = validateOrder(b);
  if (err) return json({ error: err }, 400);
  const phone = b.phone.replace(/\D/g, "");

  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM orders WHERE phone = ? AND created_at > datetime('now', '-1 hour')").bind(phone).first();
  if (recent.n >= MAX_ORDERS_PER_HOUR) return json({ error: "같은 번호로 주문이 너무 많아요. 1시간 뒤 다시 시도해 주세요." }, 429);

  // 상품 확인 (가격은 손님이 보낸 값이 아니라 DB 값으로 계산)
  const ids = b.items.map((i) => i.product_id);
  const { results: prods } = await env.DB.prepare(
    `SELECT * FROM products WHERE active = 1 AND id IN (${ids.map(() => "?").join(",")})`
  ).bind(...ids).all();
  const byId = Object.fromEntries(prods.map((p) => [p.id, p]));
  for (const it of b.items) {
    const p = byId[it.product_id];
    if (!p) return json({ error: "판매하지 않는 상품이 있어요" }, 400);
    if (p.stock < it.qty) return json({ error: p.stock <= 0 ? `${p.name}은(는) 품절이에요` : `${p.name}은(는) ${p.stock}개까지 주문할 수 있어요` }, 409);
  }

  // ===== [재고 계산] =====
  // 주문한 만큼 재고를 빼요. 그 사이 다른 주문이 가져갔으면 되돌리고 실패로 답해요
  // 재고 빼기: 그 사이 다른 주문이 먼저 가져갔으면(재고 부족) 뺀 것을 되돌리고 실패로 답해요
  const dec = await env.DB.batch(b.items.map((it) =>
    env.DB.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?").bind(it.qty, it.product_id, it.qty)));
  const failed = dec.findIndex((r) => r.meta.changes === 0);
  if (failed >= 0) {
    const undo = b.items.filter((_, i) => dec[i].meta.changes > 0);
    if (undo.length) await env.DB.batch(undo.map((it) => env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").bind(it.qty, it.product_id)));
    return json({ error: `${byId[b.items[failed].product_id].name} 재고가 방금 바뀌었어요. 다시 확인해 주세요.` }, 409);
  }

  const items = b.items.map((it) => ({ product_id: it.product_id, name: byId[it.product_id].name, price: byId[it.product_id].price, qty: it.qty }));
  const subtotal = items.reduce((t, i) => t + i.price * i.qty, 0);
  const shipping = subtotal >= FREE_SHIPPING ? 0 : SHIPPING_FEE;

  // 재구매 안내 링크로 들어와 주문했는지 (안내를 받은 주문의 열쇠가 맞을 때만)
  let fromReorder = null;
  if (b.from_order && Number.isInteger(b.from_order.id)) {
    const r = await env.DB.prepare(
      "SELECT r.id FROM reorders r JOIN orders o ON o.id = r.order_id WHERE o.id = ? AND o.secret = ? AND r.converted_order_id IS NULL"
    ).bind(b.from_order.id, s(b.from_order.secret)).first();
    if (r) fromReorder = r.id;
  }

  const secret = crypto.randomUUID();
  const o = await env.DB.prepare(
    `INSERT INTO orders (secret, name, phone, address, grind, memo, subtotal, shipping, total, from_reorder)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
  ).bind(secret, s(b.name), phone, s(b.address), b.grind, s(b.memo) || null, subtotal, shipping, subtotal + shipping, fromReorder).first();
  await env.DB.batch(items.map((i) =>
    env.DB.prepare("INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?,?,?,?,?)").bind(o.id, i.product_id, i.name, i.price, i.qty)));
  if (fromReorder) await env.DB.prepare("UPDATE reorders SET converted_order_id = ? WHERE id = ?").bind(o.id, fromReorder).run();

  await logEvent(env, "order", o.id, "주문", `${items.map((i) => `${i.name}×${i.qty}`).join(", ")} · ${o.total.toLocaleString()}원 (가상 결제)`);
  if (fromReorder) await logEvent(env, "order", o.id, "재구매", `재구매 안내 #${fromReorder}을 보고 주문`);

  // 사내 도구 연동과 재고 알림은 응답을 기다리게 하지 않고 뒤에서 처리
  ctx.waitUntil(afterOrder(env, o, items, b.items.map((it) => ({ p: byId[it.product_id], before: byId[it.product_id].stock, after: byId[it.product_id].stock - it.qty }))));
  return json({ id: o.id, secret, total: o.total });
}

// ===== [알림] =====
// 주문이 들어오면 Slack·시트·노션에 동시에 보냄. 하나가 실패해도 나머지는 감
async function afterOrder(env, o, items, stockChanges) {
  const jobs = [
    ["Slack", () => sendSlack(env, orderMessage(env, o, items))],
    ["시트", () => appendSheet(env, o, items)],
    ["노션", () => addNotion(env, o, items)],
  ];
  await Promise.all(jobs.map(async ([name, fn]) => {
    const msg = await fn().catch((e) => `실패 (${e.message})`.slice(0, 200));
    await logEvent(env, "order", o.id, "연동", `${name}: ${msg}`);
  }));
  await checkStock(env, stockChanges);
}

// ===== [재고 알림] =====
// 재고가 기준 아래로 막 내려갔을 때만 Slack으로 한 번 알려요
// 재고가 알림 기준을 '방금' 넘어 내려갔을 때만 한 번 알려요 (주문마다 계속 울리지 않게)
async function checkStock(env, changes) {
  for (const { p, before, after } of changes) {
    if (before > p.low_stock && after <= p.low_stock || before > 0 && after <= 0) {
      const msg = await sendSlack(env, stockMessage(env, p, before, after)).catch((e) => `실패 (${e.message})`);
      await logEvent(env, "product", p.id, after <= 0 ? "품절" : "재고부족", `${p.name} ${before} → ${after}개 · Slack: ${msg}`);
    }
  }
}

// ===== [주문 조회·취소·상태 바꾸기] =====
// 손님 주문 조회, 손님 직접 취소, 상태 바꾸기(취소면 재고 되돌림·노션 반영)
async function getMyOrder(env, id, secret) {
  const o = await env.DB.prepare(
    "SELECT id, created_at, status, grind, subtotal, shipping, total, memo FROM orders WHERE id = ? AND secret = ?"
  ).bind(id, secret || "").first();
  if (!o) return json({ error: "주문을 찾을 수 없어요" }, 404);
  const { results: items } = await env.DB.prepare(
    "SELECT i.product_id, i.name, i.price, i.qty, p.active, p.stock > 0 AS in_stock FROM order_items i JOIN products p ON p.id = i.product_id WHERE order_id = ?"
  ).bind(id).all();
  return json({ ...o, items });
}

// 손님이 직접 취소: '결제 완료' 상태일 때만 (안내문 변경-1)
async function cancelMyOrder(request, env, ctx, id) {
  const b = await request.json().catch(() => ({}));
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND secret = ?").bind(id, s(b.secret)).first();
  if (!o) return json({ error: "주문을 찾을 수 없어요" }, 404);
  if (o.status !== "결제 완료") return json({ error: `'${o.status}' 상태라 직접 취소할 수 없어요. 1:1 문의로 알려 주세요.` }, 409);
  await setOrderStatus(env, ctx, o, "취소", "손님이 직접 취소");
  return json({ ok: true });
}

// 주문 상태 바꾸기 (손님 취소·관리자 공통): 취소면 재고를 되돌리고, 노션 배송 보드에도 반영
async function setOrderStatus(env, ctx, o, status, who) {
  await env.DB.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, o.id).run();
  if (status === "취소" && o.status !== "취소") {
    const { results: items } = await env.DB.prepare("SELECT product_id, qty FROM order_items WHERE order_id = ?").bind(o.id).all();
    if (items.length) await env.DB.batch(items.map((i) => env.DB.prepare("UPDATE products SET stock = stock + ? WHERE id = ?").bind(i.qty, i.product_id)));
  }
  await logEvent(env, "order", o.id, "상태변경", `${o.status} → ${status} (${who})${status === "취소" ? " · 재고 되돌림" : ""}`);
  ctx.waitUntil(pushStatusToNotion(env, o.id, status).catch((e) => `실패 (${e.message})`).then((msg) => logEvent(env, "order", o.id, "연동", `노션: ${msg}`)));
}

// ===== [문의 받기] =====
// 손님 문의를 검사·저장하고 Slack·시트·노션으로 알려요
// ───────────── 손님: 1:1 문의 ─────────────
async function createInquiry(request, env, ctx) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object") return json({ error: "보낸 내용을 읽을 수 없어요" }, 400);
  const phone = s(b.phone).replace(/\D/g, "");
  if (!s(b.name) || s(b.name).length > 30) return json({ error: "이름을 확인해 주세요" }, 400);
  if (phone.length < 9 || phone.length > 11) return json({ error: "연락처를 확인해 주세요" }, 400);
  if (s(b.message).length < 5) return json({ error: "문의 내용을 조금만 더 자세히 써 주세요" }, 400);
  if (s(b.message).length > 1000) return json({ error: "문의는 1000자 안으로 써 주세요" }, 400);

  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM inquiries WHERE phone = ? AND created_at > datetime('now', '-1 hour')").bind(phone).first();
  if (recent.n >= MAX_INQ_PER_HOUR) return json({ error: "같은 번호로 문의가 너무 많아요. 1시간 뒤 다시 시도해 주세요." }, 429);

  // 주문 번호를 적었으면, 같은 전화번호로 한 주문일 때만 연결 (남의 주문 정보를 AI에 넣지 않게)
  let order = null;
  const orderId = parseInt(String(b.order_id || "").replace(/\D/g, ""), 10);
  if (orderId) {
    const o = await env.DB.prepare("SELECT id, created_at, status, grind FROM orders WHERE id = ? AND phone = ?").bind(orderId, phone).first();
    if (o) {
      const { results: items } = await env.DB.prepare("SELECT name, qty FROM order_items WHERE order_id = ?").bind(o.id).all();
      order = { ...o, items: items.map((i) => `${i.name}×${i.qty}`).join(", ") };
    }
  }

  const ai = await answerWithLimit(env, s(b.message), order);
  const secret = crypto.randomUUID();
  const q = await env.DB.prepare(
    `INSERT INTO inquiries (secret, name, phone, order_id, message, category, urgency, summary, reason, cited, draft, needs_human, ai_ms, ai_cost_krw)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
  ).bind(secret, s(b.name), phone, order?.id || null, s(b.message), ai.category, ai.urgency, ai.summary, ai.reason,
    JSON.stringify(ai.cited), ai.draft, ai.needs_human ? 1 : 0, ai.ms, ai.costKrw).first();

  await logEvent(env, "inquiry", q.id, "문의", order ? `주문 #${order.id} (${order.status})과 연결` : orderId ? `주문 #${orderId}은 전화번호가 달라 연결 안 함` : "주문 연결 없음");
  await logEvent(env, "inquiry", q.id, "AI분류", `${ai.category} · ${ai.urgency}${ai.needs_human ? " · 사람 판단 필요" : ""} · 근거 ${ai.cited.join(", ") || "없음"} (${ai.ms}ms, 약 ${ai.costKrw.toFixed(1)}원)`);

  const info = { id: q.id, name: s(b.name), order_id: order?.id, ...ai };
  // 주문과 같은 방식: Slack·시트·노션 세 곳에 따로, 응답은 기다리지 않음
  ctx.waitUntil(Promise.all([
    ["Slack", () => sendSlack(env, inquiryMessage(env, info))],
    ["시트", () => appendSheetInquiry(env, info)],
    ["노션", () => addNotionInquiry(env, info)],
  ].map(async ([name, fn]) => {
    const msg = await fn().catch((e) => `실패 (${e.message})`.slice(0, 200));
    await logEvent(env, "inquiry", q.id, "연동", `${name}: ${msg}`);
  })));
  return json({ id: q.id, secret, category: ai.category, urgent: ai.urgency === "긴급" });
}

async function getMyInquiry(env, id, secret) {
  const q = await env.DB.prepare(
    "SELECT id, created_at, message, category, status, reply, answered_at FROM inquiries WHERE id = ? AND secret = ?"
  ).bind(id, secret || "").first();
  if (!q) return json({ error: "문의를 찾을 수 없어요" }, 404);
  return json(q);
}

// ===== [AI 문의 분류·답변 초안] =====
// 하루 AI 한도를 넘었으면 AI 없이 접수만, 아니면 ai.js의 AI를 불러요
async function answerWithLimit(env, message, order) {
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'AI분류' AND at > datetime('now', '-1 day')").first();
  if (used.n >= MAX_AI_PER_DAY) {
    return { category: "기타", urgency: "보통", summary: "오늘 AI 한도 초과 - 사람 확인 필요", reason: `하루 AI 한도(${MAX_AI_PER_DAY}건)를 넘어서 AI를 부르지 않았어요`, cited: [], needs_human: true, draft: "", ms: 0, costKrw: 0 };
  }
  const { results: products } = await env.DB.prepare(
    "SELECT name, kind, unit, price, roast, notes, stock <= 0 AS sold_out FROM products WHERE active = 1 ORDER BY id"
  ).all();
  return answerInquiry(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), message, order, products);
}

// ===== [관리자 화면] =====
// 오늘 현황(주문·매출·문의·재고 부족·주간 그래프) 숫자 모으기
// ───────────── 관리자 ─────────────
async function dashboard(env) {
  const one = (sql) => env.DB.prepare(sql).first();
  const today = await one(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS sales FROM orders
    WHERE date(created_at,'+9 hours') = date('now','+9 hours') AND status != '취소'`);
  const todo = await one(`SELECT SUM(status='결제 완료') AS to_prepare, SUM(status='상품 준비') AS to_ship FROM orders`);
  const inq = await one(`SELECT SUM(status='답변 대기') AS open, SUM(status='답변 대기' AND urgency='긴급') AS urgent,
      SUM(status='답변 완료') AS answered, SUM(status='답변 완료' AND reply_edited=0) AS as_is,
      ROUND(AVG(CASE WHEN ai_cost_krw > 0 THEN ai_cost_krw END),1) AS avg_cost,
      ROUND(AVG(CASE WHEN ai_cost_krw > 0 THEN ai_ms END)) AS avg_ms,
      ROUND(AVG(CASE WHEN answered_at IS NOT NULL THEN (julianday(answered_at)-julianday(created_at))*24*60 END)) AS avg_answer_min
    FROM inquiries`);
  const re = await one(`SELECT COUNT(*) AS made, SUM(converted_order_id IS NOT NULL) AS converted FROM reorders`);
  const { results: lowStock } = await env.DB.prepare("SELECT id, name, stock, low_stock FROM products WHERE active=1 AND stock <= low_stock ORDER BY stock").all();
  const { results: week } = await env.DB.prepare(`SELECT date(created_at,'+9 hours') AS day, COUNT(*) AS orders, SUM(total) AS sales
    FROM orders WHERE status != '취소' AND created_at > datetime('now','-7 days') GROUP BY 1 ORDER BY 1`).all();
  const { results: byCategory } = await env.DB.prepare("SELECT category, COUNT(*) AS n FROM inquiries GROUP BY 1 ORDER BY n DESC").all();
  return json({ today, todo, inq, reorders: re, lowStock, week, byCategory });
}

// ===== [시연용 가림] =====
// 시연용 계정에는 이름·연락처·주소를 가려서 보여 줘요
function maskOrder(o) {
  return { ...o, name: maskName(o.name), phone: maskPhone(o.phone), address: o.address ? o.address.split(" ").slice(0, 2).join(" ") + " ***" : o.address };
}

// ===== [관리자: 주문 관리] =====
// 주문 목록·상세 보기, 주문 상태 바꾸기
async function listOrders(env, url, demo) {
  const st = url.searchParams.get("status");
  const where = ORDER_STATUSES.includes(st) ? "WHERE o.status = ?" : st === "할 일" ? "WHERE o.status IN ('결제 완료','상품 준비')" : "";
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.created_at, o.name, o.phone, o.status, o.total, o.grind, o.from_reorder,
       (SELECT group_concat(name || '×' || qty, ', ') FROM order_items WHERE order_id = o.id) AS items
     FROM orders o ${where} ORDER BY o.id DESC LIMIT 200`
  ).bind(...(ORDER_STATUSES.includes(st) ? [st] : [])).all();
  return json(demo ? results.map(maskOrder) : results);
}

async function orderDetail(env, id, demo) {
  let o = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!o) return json({ error: "없는 주문이에요" }, 404);
  delete o.secret;
  const { results: items } = await env.DB.prepare("SELECT * FROM order_items WHERE order_id = ?").bind(id).all();
  const { results: events } = await env.DB.prepare("SELECT at, kind, detail FROM events WHERE ref_type='order' AND ref_id = ? ORDER BY id").bind(id).all();
  const { results: inquiries } = await env.DB.prepare("SELECT id, created_at, summary, status FROM inquiries WHERE order_id = ? ORDER BY id").bind(id).all();
  const reorder = await env.DB.prepare("SELECT * FROM reorders WHERE order_id = ?").bind(id).first();
  if (demo) o = maskOrder(o);
  return json({ ...o, items, events, inquiries, reorder });
}

async function updateOrder(request, env, ctx, id) {
  const b = await request.json().catch(() => ({}));
  const o = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!o) return json({ error: "없는 주문이에요" }, 404);
  if (!ORDER_STATUSES.includes(b.status)) return json({ error: "상태 값이 이상해요" }, 400);
  if (o.status === "취소") return json({ error: "취소된 주문은 바꿀 수 없어요" }, 409);
  if (b.status !== o.status) await setOrderStatus(env, ctx, o, b.status, "관리자");
  return orderDetail(env, id, false);
}

// ===== [관리자: 문의 답변] =====
// 문의 목록·상세, 답변 보내기 (AI 초안을 그대로 썼는지도 기록)
async function listInquiries(env, url, demo) {
  const st = url.searchParams.get("status");
  const where = ["답변 대기", "답변 완료"].includes(st) ? "WHERE status = ?" : "";
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, name, order_id, category, urgency, summary, needs_human, status, reply_edited
       FROM inquiries ${where}
      ORDER BY (status = '답변 대기' AND urgency = '긴급') DESC, (status = '답변 대기') DESC, id DESC LIMIT 200`
  ).bind(...(where ? [st] : [])).all();
  if (demo) for (const r of results) r.name = maskName(r.name);
  return json(results);
}

async function inquiryDetail(env, id, demo) {
  const q = await env.DB.prepare("SELECT * FROM inquiries WHERE id = ?").bind(id).first();
  if (!q) return json({ error: "없는 문의예요" }, 404);
  delete q.secret;
  q.cited = JSON.parse(q.cited || "[]");
  const sources = POLICY.filter((p) => q.cited.includes(p.id)); // 초안의 근거 원문을 같이 보여 줘요
  const { results: events } = await env.DB.prepare("SELECT at, kind, detail FROM events WHERE ref_type='inquiry' AND ref_id = ? ORDER BY id").bind(id).all();
  const order = q.order_id ? await env.DB.prepare("SELECT id, created_at, status, grind, total FROM orders WHERE id = ?").bind(q.order_id).first() : null;
  if (demo) { q.name = maskName(q.name); q.phone = maskPhone(q.phone); }
  return json({ ...q, sources, events, order });
}

async function replyInquiry(request, env, ctx, id) {
  const b = await request.json().catch(() => ({}));
  const reply = s(b.reply);
  if (reply.length < 5 || reply.length > 2000) return json({ error: "답변 내용을 확인해 주세요" }, 400);
  const q = await env.DB.prepare("SELECT * FROM inquiries WHERE id = ?").bind(id).first();
  if (!q) return json({ error: "없는 문의예요" }, 404);
  if (q.status === "답변 완료") return json({ error: "이미 답변한 문의예요" }, 409);
  // 초안을 그대로 보냈는지 기록 (공백 차이는 같은 것으로 봐요) → 'AI 초안 그대로 쓴 비율'
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();
  const edited = q.draft && norm(q.draft) === norm(reply) ? 0 : 1;
  await env.DB.prepare("UPDATE inquiries SET reply = ?, reply_edited = ?, status = '답변 완료', answered_at = datetime('now') WHERE id = ?")
    .bind(reply, edited, id).run();
  await logEvent(env, "inquiry", id, "답변", edited ? "초안을 고쳐서 보냄" : "AI 초안 그대로 보냄");
  ctx.waitUntil(pushInquiryStatusToNotion(env, id, "답변 완료").catch((e) => `실패 (${e.message})`).then((msg) => logEvent(env, "inquiry", id, "연동", `노션: ${msg}`)));
  return inquiryDetail(env, id, false);
}

// ===== [관리자: 재고·재구매·처리 기록] =====
// 재고 숫자 고치기, 재구매 안내 목록, 처리 기록 목록
async function updateProduct(request, env, id) {
  const b = await request.json().catch(() => ({}));
  const p = await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first();
  if (!p) return json({ error: "없는 상품이에요" }, 404);
  const stock = Number.isInteger(b.stock) && b.stock >= 0 && b.stock <= 9999 ? b.stock : p.stock;
  const low = Number.isInteger(b.low_stock) && b.low_stock >= 0 && b.low_stock <= 999 ? b.low_stock : p.low_stock;
  await env.DB.prepare("UPDATE products SET stock = ?, low_stock = ? WHERE id = ?").bind(stock, low, id).run();
  if (stock !== p.stock) await logEvent(env, "product", id, "재고", `${p.name} ${p.stock} → ${stock}개 (관리자)`);
  return json(await env.DB.prepare("SELECT * FROM products WHERE id = ?").bind(id).first());
}

async function listReorders(env, demo) {
  const { results } = await env.DB.prepare(
    `SELECT r.*, o.name, o.created_at AS ordered_at,
       (SELECT group_concat(name || '×' || qty, ', ') FROM order_items WHERE order_id = r.order_id) AS items
       FROM reorders r JOIN orders o ON o.id = r.order_id ORDER BY r.id DESC LIMIT 200`
  ).all();
  return json(results.map((r) => ({
    ...r,
    name: demo ? maskName(r.name) : r.name,
    // 안내 문구 속 주문 조회 링크(열쇠 포함)는 시연용에게 가려요
    message: demo ? r.message.replace(/#\/order\/\d+\/[0-9a-f-]+/, "#/order/…") : r.message,
  })));
}

async function listEvents(env, url) {
  const type = url.searchParams.get("type");
  const ok = ["order", "inquiry", "product", "system"].includes(type);
  const { results } = await env.DB.prepare(
    `SELECT * FROM events ${ok ? "WHERE ref_type = ?" : ""} ORDER BY id DESC LIMIT 100`
  ).bind(...(ok ? [type] : [])).all();
  return json(results);
}

// ===== [관리자 로그인] =====
// 접속 주소 지문 만들기, 비밀번호 비교 (시간으로 추측 못 하게)
// ───────────── 작은 도우미들 ─────────────
async function hashIp(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hanjan:" + ip));
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function roleOf(request, env) {
  const given = request.headers.get("x-admin-key") || "";
  if (same(given, env.ADMIN_PASSWORD)) return "admin";
  if (same(given, env.DEMO_PASSWORD)) return "demo";
  return null;
}

function same(given, real) {
  if (!real || given.length !== real.length) return false;
  let diff = 0; // 끝까지 다 비교 (비교 시간으로 비밀번호를 추측하지 못하게)
  for (let i = 0; i < real.length; i++) diff |= given.charCodeAt(i) ^ real.charCodeAt(i);
  return diff === 0;
}

// ===== [처리 기록·응답 만들기] =====
// 처리 기록(events)에 한 줄 남기기, 화면에 보낼 답 만들기
function logEvent(env, refType, refId, kind, detail) {
  return env.DB.prepare("INSERT INTO events (ref_type, ref_id, kind, detail) VALUES (?,?,?,?)").bind(refType, refId ?? null, kind, detail ?? null).run();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
