-- 상세 보기용 칸 추가 (2026-11-06). 이미 만든 checks 표에 한 번만 실행
ALTER TABLE checks ADD COLUMN steps TEXT;
ALTER TABLE checks ADD COLUMN message TEXT;
ALTER TABLE checks ADD COLUMN mail TEXT;
