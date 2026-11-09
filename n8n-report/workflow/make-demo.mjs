// 시연 페이지 만들기: "이렇게 넣으면 → 이렇게 나온다"
//   node workflow/make-demo.mjs --run   예시 3개를 실제로 n8n에 넣어서 보고서를 만든 뒤 페이지 생성 (약 300원)
//   node workflow/make-demo.mjs         이미 만든 결과(demo/results.json)로 페이지만 다시 생성
// n8n이 켜져 있어야 --run이 돼요 (start-n8n.ps1)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXAMPLES } from "./build.mjs";

// ===== [준비] 폴더·폼 주소·폼 칸 이름 =====
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const REPORTS = path.join(root, "reports");
const RESULTS = path.join(root, "demo", "results.json");
const FORM = "http://localhost:5678/form/5c0f3f2e-1a6b-4d0e-9a51-7d2f0c3e8b11";
const FIELDS = ["단지명", "진단 위치", "현장 메모", "작성자"];

// ===== [도우미] 글자 안전 처리·미리 채운 폼 링크·보고서 목록 =====
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const prefill = (ex) => FORM + "?" + FIELDS.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(ex[k])}`).join("&");
const listReports = () => new Set(fs.readdirSync(REPORTS).filter((f) => f.endsWith(".html")));

// ===== [예시 실행] 예시를 n8n 폼에 넣고 보고서가 생길 때까지 기다림 =====
// 예시 하나를 폼으로 제출하고, 새로 생긴 보고서 파일을 찾아요
async function runOne(ex) {
  const before = listReports();
  const fd = new FormData();
  FIELDS.forEach((k, i) => fd.append(`field-${i}`, ex[k]));
  const t0 = Date.now();
  const r = await fetch(FORM, { method: "POST", body: fd });
  const j = await r.json();
  // 결과 화면 주소를 열어서 실행을 끝까지 마무리 (안 열면 n8n 기록이 Waiting으로 남음)
  if (j.formWaitingUrl) fetch(j.formWaitingUrl, { signal: AbortSignal.timeout(120000) }).then((x) => x.text()).catch(() => {});
  while (Date.now() - t0 < 180000) {
    const added = [...listReports()].filter((f) => !before.has(f));
    if (added.length) {
      const html = fs.readFileSync(path.join(REPORTS, added[0]), "utf8");
      const urgency = (html.match(/종합 급한 정도<\/th><td colspan="3"><span[^>]*>([^<]+)</) || [])[1] || "";
      const title = (html.match(/<h1>([^<]+)<\/h1>/) || [])[1] || "";
      return { file: added[0], urgency, title, seconds: Math.round((Date.now() - t0) / 1000) };
    }
    await new Promise((s) => setTimeout(s, 1500));
  }
  throw new Error("보고서가 3분 안에 안 만들어졌어요: " + ex.label);
}

// ===== [결과 불러오기] 저장된 결과 읽기, --run이면 예시 3개를 새로 실행 =====
let results = fs.existsSync(RESULTS) ? JSON.parse(fs.readFileSync(RESULTS, "utf8")) : {};
if (process.argv.includes("--run")) {
  for (const ex of EXAMPLES) {
    process.stdout.write(`실행: ${ex.label} ... `);
    results[ex.label] = await runOne(ex);
    console.log(`${results[ex.label].urgency} (${results[ex.label].seconds}초) → ${results[ex.label].file}`);
  }
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
}

// ===== [시연 카드 만들기] 예시마다 '넣은 것 → 나온 것' 카드 =====
const color = { 긴급: "#d93025", 보통: "#c77700", 낮음: "#777" };
const cards = EXAMPLES.map((ex, i) => {
  const r = results[ex.label];
  return `<section class="card">
  <div class="num">예시 ${i + 1}</div>
  <div class="cols">
    <div class="col">
      <div class="h">넣은 것 (현장 메모)</div>
      <div class="meta">${esc(ex["단지명"])} · ${esc(ex["진단 위치"])} · ${esc(ex["작성자"])}</div>
      <div class="memo">${esc(ex["현장 메모"])}</div>
    </div>
    <div class="arrow">→</div>
    <div class="col">
      <div class="h">나온 것 (AI 보고서 초안)</div>
      ${r ? `<div class="title">${esc(r.title)}</div>
      <div><span class="badge" style="background:${color[r.urgency] || "#777"}">${esc(r.urgency)}</span> <span class="muted">약 ${r.seconds}초</span></div>
      <a class="btn" href="reports/${encodeURI(r.file)}" target="_blank">보고서 열기</a>` : `<div class="muted">아직 실행 안 함</div>`}
    </div>
  </div>
  <div class="runs">
    <button class="go" onclick="runLink(${i + 1}, this)">▶ 지금 바로 실행 (약 30초)</button>
    <a class="run" href="${esc(prefill(ex))}" target="_blank">또는 폼으로 실행 (Submit만 누르기)</a>
  </div>
</section>`;
}).join("\n");

// ===== [시연 페이지 만들기] 카드를 모아 demo.html 화면으로 =====
const page = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>현장 진단 메모 → AI 보고서 시연</title>
<style>
body{font-family:-apple-system,"Segoe UI","Malgun Gothic",sans-serif;max-width:1000px;margin:36px auto;padding:0 20px;color:#111;background:#fafafa}
h1{font-size:24px;margin:0 0 6px}.lead{color:#555;margin:0 0 20px;line-height:1.6}
.card{background:#fff;border:1px solid #e3e3e3;border-radius:14px;padding:18px 20px;margin:16px 0}
.num{font-size:13px;font-weight:700;color:#777;margin-bottom:8px}
.cols{display:grid;grid-template-columns:1fr 40px 1fr;gap:12px;align-items:start}
@media(max-width:760px){.cols{grid-template-columns:1fr}.arrow{display:none}}
.arrow{font-size:28px;color:#999;text-align:center;padding-top:40px}
.h{font-weight:700;margin-bottom:6px}.meta{color:#666;font-size:13px;margin-bottom:6px}
.memo{background:#f4f4f4;border-radius:10px;padding:12px;line-height:1.6;font-size:14px}
.title{font-weight:700;margin-bottom:8px;line-height:1.4}
.badge{color:#fff;border-radius:999px;padding:2px 10px;font-size:13px;font-weight:700}
.btn{display:inline-block;margin-top:12px;background:#111;color:#fff;text-decoration:none;padding:9px 14px;border-radius:9px;font-weight:700}
.runs{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:14px}
.go{font:inherit;font-weight:700;border:1px solid #111;background:#fff;color:#111;border-radius:9px;padding:8px 14px;cursor:pointer}
.go:disabled{opacity:.6;cursor:default}
.run{font-size:13px;color:#555}
.muted{color:#777;font-size:13px}.flow{background:#fff;border:1px solid #e3e3e3;border-radius:14px;padding:14px 18px;font-size:14px;line-height:1.7}
</style></head><body>
<h1>현장 진단 메모 → AI 보고서 초안 (n8n 자동화)</h1>
<p class="lead">현장 담당자가 짧은 메모만 남기면, n8n 워크플로가 AI로 <b>진단 결과·추정 원인·급한 정도·권장 조치·작업 항목(견적)</b>을 정리해 보고서 파일로 저장하고 진단 대장에 기록합니다. 아래는 미리 돌려 둔 예시예요.</p>
<div class="flow"><b>흐름</b> 폼 입력 → 요청 만들기 → AI 호출 → 보고서 만들기 → 파일 저장 + 진단 대장 기록 → 긴급인가? → 담당자 알림 → 결과 화면<br>
<span class="muted">규칙: 메모에 없는 수치는 "현장 실측 필요" · 원인은 "추정" · 단가는 비움(담당자가 채움)</span></div>
${cards}
<p class="muted">진단 대장: <a href="reports/진단대장.csv">reports/진단대장.csv</a> (엑셀로 열림) · n8n 편집 화면: <a href="http://localhost:5678" target="_blank">http://localhost:5678</a></p>
<script>
// "지금 바로 실행": n8n 링크 입구(웹훅)를 불러서, 새 창에 진행 화면 → 보고서를 띄워요
const LINK = "http://localhost:5678/webhook/site-report-demo?example=";
async function runLink(n, btn) {
  const w = window.open("", "_blank");
  w.document.write('<meta charset="utf-8"><title>보고서 만드는 중</title><body style="font-family:Malgun Gothic,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh;color:#333"><div style="text-align:center"><div style="font-size:20px;font-weight:700">AI가 진단 보고서를 쓰는 중이에요…</div><div id="t" style="margin-top:10px;color:#777">0초</div></div></body>');
  const t0 = Date.now(), timer = setInterval(() => { const el = w.document.getElementById("t"); if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + "초"; }, 500);
  btn.disabled = true; const old = btn.textContent; btn.textContent = "실행 중…";
  try {
    const res = await fetch(LINK + n);
    const html = await res.text();
    clearInterval(timer); w.document.open(); w.document.write(html); w.document.close();
  } catch (e) {
    clearInterval(timer);
    w.document.body.innerHTML = '<div style="padding:40px;font-size:18px">n8n에 연결하지 못했어요. start-n8n.ps1로 n8n을 먼저 켜 주세요.</div>';
  } finally { btn.disabled = false; btn.textContent = old; }
}
</script>
</body></html>`;
// ===== [파일 저장] demo.html로 저장 =====
fs.writeFileSync(path.join(root, "demo.html"), page);
console.log("written: demo.html");
