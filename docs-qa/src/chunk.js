// 문서를 검색하기 좋은 크기의 '조각'으로 나누는 부분
// 서버(src/index.js)와 평가·시드 스크립트가 같이 써요.

// ===== [설정값] 조각 길이 =====
const TARGET = 500; // 조각 하나의 목표 길이(글자). 규정 1~2개 조항 정도
const MAX = 800; // 이보다 길어지면 무조건 자름

// ===== [제목 줄 찾기] =====
// 제목 줄인지 판단: 마크다운 제목(#), "제3조 (연차휴가)", "3. 장애 등급" 같은 짧은 번호 제목
// 마크다운은 # 제목만 믿어요 (마크다운의 "1. ..."은 대부분 목록이라서)
export function isHeading(line, markdown = false) {
  const s = line.trim();
  if (/^#{1,6}\s+\S/.test(s)) return true;
  if (markdown) return false;
  if (/^제\s*\d+\s*조/.test(s) && s.length <= 40) return true;
  if (/^\d+\.\s+\S/.test(s) && s.length <= 30 && !/[다요]\.?$/.test(s) && !/,/.test(s)) return true;
  return false;
}

const cleanHeading = (s) => s.trim().replace(/^#{1,6}\s+/, "");

// ===== [조항 단위로 자르기] =====
/**
 * @param pages  [{ page: 쪽 번호(PDF) 또는 null(텍스트·마크다운), text }]
 * @param kind   "pdf" | "md" | "txt"
 * @returns      [{ idx, page, section, text }]
 * 규칙: 제목이 나오면 새 조각을 시작하고, 길면 TARGET 근처의 줄 끝에서 자르며
 *       앞 조각의 마지막 줄을 다음 조각 앞에 겹쳐 넣어요(문맥이 끊기지 않게).
 *       PDF는 조각이 쪽을 넘지 않게 해서 "몇 쪽"을 정확히 보여줘요.
 */
export function chunkPages(pages, kind = "txt") {
  const md = kind === "md";
  const chunks = [];
  let section = "";
  for (const { page, text } of pages) {
    const lines = String(text || "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim() && !/^\|?[\s:|-]+\|?$/.test(l)); // 빈 줄, 표 구분선(|---|) 제외
    let buf = [];
    let len = 0;
    // ===== [조각 하나 마무리] =====
    const flush = (overlap) => {
      const body = buf.join("\n").trim();
      if (body.replace(/\s/g, "").length >= 15) chunks.push({ idx: chunks.length, page, section, text: body });
      buf = overlap && buf.length > 1 ? [buf[buf.length - 1]] : [];
      len = buf.reduce((a, l) => a + l.length, 0);
    };
    // ===== [줄마다 읽으며 자르기] =====
    for (const line of lines) {
      if (isHeading(line, md)) {
        if (buf.length) flush(false);
        section = cleanHeading(line);
        buf.push(line.trim());
        len += line.length;
        continue;
      }
      if (len + line.length > MAX || (len >= TARGET && buf.length > 1)) flush(true);
      buf.push(line);
      len += line.length;
    }
    if (buf.length) flush(false);
  }
  // ===== [제목만 있는 조각 합치기] =====
  // 제목 한 줄만 있는 조각(바로 다음 제목이 나온 경우)은 다음 조각과 합쳐요
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.text.split("\n").length === 1 && isHeading(c.text, md) && chunks[i + 1] && chunks[i + 1].page === c.page) {
      chunks[i + 1].text = c.text + "\n" + chunks[i + 1].text;
      continue;
    }
    out.push({ ...c, idx: out.length });
  }
  return out;
}
