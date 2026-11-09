-- 하자 접수 저장 구조 (Cloudflare D1 = SQLite)

CREATE TABLE IF NOT EXISTS tickets (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  secret         TEXT NOT NULL,              -- 고객만 아는 조회용 열쇠 (접수번호만으로 남의 접수를 못 보게)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  address        TEXT NOT NULL,
  description    TEXT NOT NULL,
  photo          TEXT,                       -- 줄인 사진 (data URL)

  -- AI가 판단한 값
  category       TEXT,
  urgency        TEXT,
  team           TEXT,                       -- 종류 → 팀 표로 코드가 정함
  summary        TEXT,
  reason         TEXT,
  questions      TEXT,                       -- JSON 배열: 고객에게 더 물어볼 것
  customer_guide TEXT,
  needs_review   INTEGER NOT NULL DEFAULT 0, -- AI가 판단 못 함 → 사람이 꼭 봐야 함
  ai_ms          INTEGER,
  ai_cost_krw    REAL,

  -- 사람이 확인·수정한 값 (AI 정확도 계산에 씀)
  checked_category TEXT,
  checked_urgency  TEXT,

  status         TEXT NOT NULL DEFAULT '접수',   -- 접수 → 배정 → 처리중 → 완료
  done_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_phone ON tickets(phone, created_at);

-- 처리 기록 (언제 무슨 일이 있었는지)
CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  kind      TEXT NOT NULL,   -- 접수 / AI분류 / 추가답변 / 알림 / 상태변경 / 확인
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ticket ON events(ticket_id);

-- 관리자 비밀번호를 틀린 기록 (무차별 대입 막기용). IP는 해시로만 저장
CREATE TABLE IF NOT EXISTS login_fails (
  ip_hash TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_login_fails ON login_fails(ip_hash, at);
