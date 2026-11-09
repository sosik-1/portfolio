-- 경비 검수 에이전트 저장소 (docs-qa와 같은 D1 DB를 같이 써요)

-- 회계 시스템에 이미 승인된 과거 청구 (실제 회사라면 회계 시스템에서 가져올 내용. 여기서는 시연용 가짜 데이터)
-- 에이전트는 "같은 거래처를 이번 달에 몇 번 접대했나", "같은 물품을 이번 달에 몇 번 샀나"를 SQL로 확인해요.
CREATE TABLE IF NOT EXISTS past_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee TEXT NOT NULL,
  team TEXT NOT NULL,
  category TEXT NOT NULL,      -- 교통비 | 식대 | 회식비 | 출장비 | 접대비 | 교육비 | 구매 | 기타
  vendor TEXT NOT NULL,        -- 가맹점·거래처·업체 이름
  item TEXT,                   -- 구매 물품 (구매일 때)
  amount INTEGER NOT NULL,     -- 원
  spent_on TEXT NOT NULL       -- YYYY-MM-DD
);

-- 에이전트가 검수한 기록 (구글 시트에도 같은 내용을 한 줄씩 남겨요)
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL,        -- web(화면에서) | eval(평가 스크립트)
  doc_type TEXT NOT NULL,      -- 경비 청구 | 견적서
  employee TEXT,
  team TEXT,
  category TEXT,
  vendor TEXT,
  amount INTEGER,
  verdict TEXT NOT NULL,       -- 승인 가능 | 보완 필요 | 규정 위반
  summary TEXT NOT NULL,
  issues TEXT NOT NULL,        -- 문제 목록 (JSON)
  notified INTEGER NOT NULL DEFAULT 0,  -- 담당자에게 메일 보냈나
  sheet_ok INTEGER NOT NULL DEFAULT 0,  -- 구글 시트에 기록됐나
  tool_calls INTEGER NOT NULL DEFAULT 0,
  seconds REAL,
  cost_krw REAL,
  steps TEXT,                  -- 에이전트가 한 일 (JSON, 상세 화면용)
  message TEXT,                -- 청구자에게 보여준 결과
  mail TEXT                    -- 담당자에게 보낸 메일 (JSON)
);
CREATE INDEX IF NOT EXISTS idx_checks_created ON checks(created_at);
CREATE INDEX IF NOT EXISTS idx_past_vendor ON past_claims(vendor, spent_on);

-- 시연용 과거 승인 내역 (다시 실행해도 중복되지 않게 비우고 넣어요)
DELETE FROM past_claims;
INSERT INTO past_claims (employee, team, category, vendor, item, amount, spent_on) VALUES
  ('정하늘', '영업1팀', '접대비', '가람물산', NULL, 180000, '2026-10-06'),
  ('정하늘', '영업1팀', '접대비', '가람물산', NULL, 210000, '2026-10-15'),
  ('최도윤', '영업1팀', '접대비', '가람물산', NULL, 95000, '2026-10-22'),
  ('정하늘', '영업1팀', '접대비', '누리테크', NULL, 120000, '2026-10-08'),
  ('한지우', '개발팀', '구매', '오름전자', '무선 마우스', 480000, '2026-10-07'),
  ('한지우', '개발팀', '구매', '오름전자', '무선 마우스', 450000, '2026-10-20'),
  ('송예린', '디자인팀', '구매', '오름전자', '모니터 받침대', 160000, '2026-10-13'),
  ('윤서준', '개발팀', '회식비', '숲속한식당', NULL, 250000, '2026-10-16'),
  ('강민재', '영업2팀', '교통비', '서울개인택시', NULL, 21400, '2026-10-19'),
  ('오유나', '인사팀', '교육비', '배움아카데미', NULL, 300000, '2026-09-25');
