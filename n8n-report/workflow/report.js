// [n8n Code 노드] AI 답(JSON)으로 보고서 HTML과 진단 대장(CSV) 한 줄을 만들어요

// ===== [입력 받기] AI 답과 폼 내용 가져오기 =====
const res = $input.first().json;
const form = $("요청 만들기").first().json.form;

// ===== [AI 답 확인] 거절했거나 본문이 없으면 여기서 멈춤 =====
// JSON.parse 오류도 여기서 나요
if (res.stop_reason === "refusal") throw new Error("AI가 이 요청을 처리하지 않았어요. 메모를 확인해 주세요.");
const text = (res.content || []).find((b) => b.type === "text")?.text;
if (!text) throw new Error("AI 응답에 본문이 없어요");
const r = JSON.parse(text);

// ===== [글자 안전 처리] 화면에 넣을 글자 바꾸기 =====
// 화면에 넣을 글자는 항상 이스케이프 (메모에 HTML이 섞여도 실행되지 않게)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ===== [파일 이름 정하기] 한국 시간 + 단지명으로 보고서 파일 이름 =====
// 한국 시간
const now = new Date();
const kst = now.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const p = Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .formatToParts(now).map((x) => [x.type, x.value])
);
const stamp = `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
const safeName = String(form["단지명"] || "단지").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 30);
const fileName = `진단보고서_${stamp}_${safeName}.html`;

// ===== [비용 계산] 이번 보고서에 든 대략 비용(원) =====
// 대략 비용 (Opus 5.5: 입력 $4, 출력 $20 / 100만 토큰, 1달러 = 1,400원)
const u = res.usage || {};
const costKrw = (((u.input_tokens || 0) * 4 + (u.output_tokens || 0) * 20) / 1e6) * 1400;

// ===== [급한 정도 판단] 긴급·보통·낮음을 색깔 배지로 =====
const urgColor = { 긴급: "#d93025", 보통: "#c77700", 낮음: "#777" };
const badge = (v) => `<span class="badge" style="background:${urgColor[v] || "#777"}">${esc(v)}</span>`;
const list = (arr) => (arr && arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">없음</p>`);

// ===== [보고서 만들기] AI 답을 보고서 화면(HTML)으로 =====
const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>${esc(r.title)}</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; color:#111; max-width: 820px; margin: 32px auto; padding: 0 20px; line-height: 1.6; }
  h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 8px; border-bottom: 2px solid #111; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; } th, td { border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; width: 120px; } .grid th { width: auto; }
  .badge { color: #fff; border-radius: 999px; padding: 2px 10px; font-size: 13px; font-weight: 700; white-space: nowrap; }
  .muted { color: #777; } .memo { background: #f6f6f6; border-radius: 8px; padding: 12px; white-space: pre-wrap; }
  .draft { margin-top: 32px; padding: 12px; border: 1px dashed #c77700; color: #6b5a00; background: #fffbe6; border-radius: 8px; font-size: 13px; }
  @media print { .draft { border-color: #999; } }
</style></head><body>
<h1>${esc(r.title)}</h1>
<p class="muted">현장 진단 보고서 (초안)</p>

<table>
  <tr><th>단지</th><td>${esc(form["단지명"])}</td><th>진단 위치</th><td>${esc(form["진단 위치"])}</td></tr>
  <tr><th>작성자</th><td>${esc(form["작성자"] || "-")}</td><th>작성 시각</th><td>${esc(kst)}</td></tr>
  <tr><th>종합 급한 정도</th><td colspan="3">${badge(r.overall_urgency)}</td></tr>
</table>

<h2>요약</h2>
<p>${esc(r.summary)}</p>

<h2>진단 결과</h2>
<table class="grid"><tr><th>위치</th><th>하자</th><th>추정 원인</th><th>급한 정도</th></tr>
${(r.findings || []).map((x) => `<tr><td>${esc(x.location)}</td><td>${esc(x.defect)}</td><td>${esc(x.likely_cause)}</td><td>${badge(x.urgency)}</td></tr>`).join("")}
</table>

<h2>권장 조치</h2>
${list(r.recommendations)}

<h2>작업 항목 (견적 초안)</h2>
<table class="grid"><tr><th>품목</th><th>수량</th><th>단위</th><th>비고</th><th>단가</th><th>금액</th></tr>
${(r.work_items || []).map((x) => `<tr><td>${esc(x.item)}</td><td>${esc(x.quantity)}</td><td>${esc(x.unit)}</td><td>${esc(x.note)}</td><td></td><td></td></tr>`).join("")}
</table>
<p class="muted">단가·금액은 회사 단가표로 담당자가 채워요.</p>

<h2>추가로 확인할 것</h2>
${list(r.missing_info)}

<h2>현장 메모 원문</h2>
<div class="memo">${esc(form["현장 메모"])}</div>

<div class="draft">이 보고서는 AI가 현장 메모로 만든 <b>초안</b>이에요. 담당자가 내용과 수량을 확인한 뒤 확정해 주세요.
(생성 ${((u.output_tokens || 0)).toLocaleString()} 토큰 · 약 ${costKrw.toFixed(0)}원)</div>
</body></html>`;

// ===== [진단 대장(CSV)] 대장에 붙일 한 줄 만들기 =====
// 진단 대장 CSV 한 줄 (엑셀에서 열림). 칸 안의 따옴표는 두 번 써서 이스케이프
const csv = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\r?\n/g, " ")}"`;
const csvLine = [kst, form["단지명"], form["진단 위치"], r.overall_urgency, r.summary, fileName, form["작성자"] || ""].map(csv).join(",") + "\r\n";

// ===== [파일 저장 준비] 보고서·대장 글자를 파일로 넘길 모양으로 =====
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// ===== [결과 넘기기] 다음 노드(파일 저장·알림·결과 화면)가 쓸 값 =====
return [
  {
    json: { title: r.title, summary: r.summary, urgency: r.overall_urgency, fileName, costKrw: Math.round(costKrw), html },
    binary: {
      report: { data: b64(html), mimeType: "text/html", fileName, fileExtension: "html" },
      log: { data: b64(csvLine), mimeType: "text/csv", fileName: "진단대장.csv", fileExtension: "csv" },
    },
  },
];
