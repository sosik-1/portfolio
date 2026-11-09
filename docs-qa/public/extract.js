// 파일 → 쪽별 글자 [{ page, text }]
// 브라우저(화면)와 Node(시드·평가 스크립트)가 같은 코드를 써서, 어디서 올려도 조각이 똑같이 나와요.

// ===== [PDF 글자 뽑기] =====
/** PDF: pdf.js로 쪽마다 글자를 뽑아요. pdfjs = pdf.js 모듈 */
export async function pdfToPages(pdfjs, data) {
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    const text = content.items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("");
    pages.push({ page: i, text });
  }
  return pages;
}

// ===== [텍스트·마크다운 글자 뽑기] =====
/** 텍스트·마크다운: 쪽 개념이 없어서 한 덩어리 */
export function textToPages(text) {
  return [{ page: null, text: String(text).replace(/^\uFEFF/, "") }];
}

// ===== [파일 종류 알아내기] =====
export function kindOf(name) {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") return "pdf";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt") return "txt";
  return null;
}

// ===== [문서 제목 만들기] =====
export const titleOf = (name) => name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
