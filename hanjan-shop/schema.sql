-- 한잔로스터리(가상 원두 가게) 저장 구조 (Cloudflare D1 = SQLite)
-- 시각은 모두 UTC로 저장하고, 화면·보고서에서 한국 시간(+9시간)으로 바꿔 보여 줘요.

-- 상품
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,              -- 원두 / 드립백 / 도구
  price         INTEGER NOT NULL,
  unit          TEXT NOT NULL,              -- 200g, 10개입, 1개 ...
  notes         TEXT,                       -- 맛 표현 (예: 자몽 · 꿀 · 홍차)
  roast         TEXT,                       -- 약배전 / 중배전 / 강배전 (도구는 비움)
  description   TEXT,
  color         TEXT,                       -- 화면 그림 색
  days_per_unit INTEGER,                    -- 1개를 다 먹는 데 걸리는 날 (재구매 안내 계산용, 도구는 비움)
  stock         INTEGER NOT NULL DEFAULT 0,
  low_stock     INTEGER NOT NULL DEFAULT 5, -- 이 개수 이하로 내려가면 재고 알림
  active        INTEGER NOT NULL DEFAULT 1
);

-- 주문
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  secret     TEXT NOT NULL,                 -- 손님만 아는 조회용 열쇠
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  address    TEXT NOT NULL,
  grind      TEXT NOT NULL,                 -- 분쇄 굵기 (원두에만 적용)
  memo       TEXT,
  subtotal   INTEGER NOT NULL,
  shipping   INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT '결제 완료', -- 결제 완료 → 상품 준비 → 배송 중 → 배송 완료 / 취소
  from_reorder INTEGER,                     -- 재구매 안내를 보고 한 주문이면 그 안내 번호
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  order_id   INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  name       TEXT NOT NULL,                 -- 주문할 때의 이름·가격을 그대로 남겨요
  price      INTEGER NOT NULL,
  qty        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- 1:1 문의 (AI가 분류하고 답변 초안을 써요. 보내는 건 사람)
CREATE TABLE IF NOT EXISTS inquiries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  secret       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  order_id     INTEGER,                     -- 주문 번호를 적었고 전화번호가 맞을 때만 연결
  message      TEXT NOT NULL,
  category     TEXT,
  urgency      TEXT,
  summary      TEXT,
  reason       TEXT,
  cited        TEXT,                        -- JSON 배열: 답변 근거로 쓴 안내문 번호
  draft        TEXT,                        -- AI 답변 초안
  needs_human  INTEGER NOT NULL DEFAULT 0,  -- 안내문으로 답할 수 없어 사람이 판단해야 함
  ai_ms        INTEGER,
  ai_cost_krw  REAL,
  status       TEXT NOT NULL DEFAULT '답변 대기', -- 답변 대기 → 답변 완료
  reply        TEXT,                        -- 실제로 보낸 답변
  reply_edited INTEGER,                     -- 1이면 사람이 초안을 고쳐서 보냄 (초안 그대로 쓴 비율 계산)
  answered_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_inq_phone ON inquiries(phone, created_at);

-- 재구매 안내 (원두가 떨어질 때쯤인 손님에게 보낼 안내)
CREATE TABLE IF NOT EXISTS reorders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL UNIQUE,     -- 주문 하나에 안내 한 번만
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  due_date     TEXT NOT NULL,               -- 다 떨어질 것으로 계산한 날
  message      TEXT NOT NULL,
  converted_order_id INTEGER                -- 안내를 보고 다시 주문하면 그 주문 번호
);

-- 처리 기록 (주문·문의·상품·시스템에서 일어난 일)
CREATE TABLE IF NOT EXISTS events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL DEFAULT (datetime('now')),
  ref_type TEXT NOT NULL,                   -- order / inquiry / product / system
  ref_id   INTEGER,
  kind     TEXT NOT NULL,
  detail   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_ref ON events(ref_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind, at);

-- 관리자 비밀번호를 틀린 기록 (무차별 대입 막기). IP는 해시로만
CREATE TABLE IF NOT EXISTS login_fails (
  ip_hash TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_fails ON login_fails(ip_hash, at);
