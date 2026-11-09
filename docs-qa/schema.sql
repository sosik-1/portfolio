-- 문서 Q&A 저장소 (Cloudflare D1 = SQLite)

-- 올린 문서 한 개 = 한 줄
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,              -- pdf | md | txt
  owner TEXT,                      -- 올린 방문자 표시(브라우저마다 무작위 값). 예시 문서는 NULL
  is_sample INTEGER NOT NULL DEFAULT 0,
  pages INTEGER,                   -- PDF 쪽 수
  chars INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT                  -- 방문자 문서는 24시간 뒤 삭제. 예시 문서는 NULL
);

-- 문서를 잘게 나눈 조각 = 검색 단위
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,            -- 문서 안 순서
  page INTEGER,                    -- PDF 쪽 번호 (텍스트·마크다운은 NULL)
  section TEXT,                    -- 조항·제목 (예: 제7조 (경조휴가))
  text TEXT NOT NULL,
  embedding TEXT                   -- 뜻 검색용 벡터 (숫자 1024개, JSON)
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

-- 하루 사용량 (공개 사이트 비용 한도)
CREATE TABLE IF NOT EXISTS usage (
  day TEXT PRIMARY KEY,
  asks INTEGER NOT NULL DEFAULT 0,
  uploads INTEGER NOT NULL DEFAULT 0
);
