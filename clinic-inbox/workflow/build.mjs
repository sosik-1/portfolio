// core.js를 넣어서 n8n 워크플로 파일(clinic-inbox.workflow.json)을 만들어요
// 실행: node workflow/build.mjs  →  .\setup-n8n.ps1 (불러오기·켜기)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const CORE = fs.readFileSync(path.join(here, "..", "core.js"), "utf8");
const ROSTER = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "roster.json"), "utf8"));
const RECORDS = "C:/dev/clinic-inbox/records";

// ===== [1] 접수번호 붙이고 가리기 =====
const intakeCode = `${CORE}

// ===== 여기부터 이 노드에서 하는 일 =====
// 채널 연결(카카오톡·인스타·톡톡·홈페이지)이 보내는 모양: { channel, name, phone, text }
// 여러 건이면 { inquiries: [ ... ] }. 이름·연락처는 다른 칸으로 받고, AI에는 내용 칸만 가려서 보내요.
// 병원 명단: 실제 운영에선 예약 명단 시트에서 읽어요. 시안에선 data/roster.json (지어낸 이름)
const ROSTER = ${JSON.stringify(ROSTER)};
const body = $input.first().json.body || {};
const list = (Array.isArray(body.inquiries) ? body.inquiries : [body]).filter((x) => x && String(x.text || "").trim());
// 접수번호: n8n 실행 번호로 만들어요. 실행 번호는 데이터베이스가 겹치지 않게 하나씩 매기고(지운 번호도 다시 안 씀),
// 동시에 여러 문의가 들어와도 겹치지 않아요. (예전처럼 "다음 번호"를 기억해 두면 동시에 온 문의가 같은 번호를 받았어요)
const base = 1000 + Number($execution.id);
const now = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
const items = list.map((x, i) => {
  const id = list.length > 1 ? "R-" + base + "-" + (i + 1) : "R-" + base;
  const name = String(x.name || "").trim();
  const raw = String(x.text).slice(0, 2000);
  const m = mask(raw, name ? [name] : [], ROSTER);
  // 병원 안(상담 대장·상담실장 화면)에 남길 원문. 주민번호만은 병원 안에서도 가려 둬요 (문의로 받지 않는 정보라서)
  let original = raw;
  for (const e of m.map) if (e.kind === "주민번호") original = original.split(e.value).join("[주민번호]");
  return { id, channel: String(x.channel || "기타"), name, phone: String(x.phone || ""), at: now, masked: m.masked, map: m.map, original };
});
return [{ json: { items, body: items.length ? buildRequest(items) : null } }];`;

// ===== [2] 접수번호로 결과 붙이기 =====
const attachCode = `${CORE}

// ===== 여기부터 이 노드에서 하는 일 =====
// AI 답을 접수번호로 붙이고, 상담 대장 줄·긴급 알림·응답을 만들어요.
const { items } = $("접수번호 붙이고 가리기").first().json;
const api = $input.first().json;
const { records, costKrw, unknownIds, duplicateIds } = parseResponse(items, api);
const byId = Object.fromEntries(items.map((x) => [x.id, x]));
const csv = (v) => '"' + String(v ?? "").replace(/"/g, '""').replace(/\\r?\\n/g, " ") + '"';
const lines = records.map((r) => {
  const x = byId[r.id];
  const notes = [r.safety_net ? "안전망 규칙으로 긴급" : "", r.pii_warning, r.failed ? r.reason : ""].filter(Boolean).join(" / ");
  return [r.id, x.at, x.channel, x.name, x.phone, r.procedure, r.types.join(", "), r.urgency, r.department,
    r.ad_risk === "없음" ? "" : "주의: " + r.ad_risk, r.missing.join(", "), r.summary, x.masked, r.draft, "검토 전", notes,
    // 병원 안에서만 보는 원문과, AI로 보낼 때 무엇을 무엇으로 바꿨는지(대조표). AI로는 가린 글만 나가요
    x.original, JSON.stringify(x.map.filter((e) => e.kind !== "주민번호").map((e) => [e.tag, e.value]))].map(csv).join(",");
}).join("\\r\\n") + "\\r\\n";
// 간호팀 알림에는 이름·연락처를 넣지 않고 접수번호만 보내요
const urgent = records.filter((r) => r.urgency === "긴급").map((r) => "[긴급] " + r.id + " · " + r.procedure + " · " + r.types[0] + " · " + byId[r.id].channel + " · 상담 화면에서 확인해 주세요");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
return [{
  json: {
    urgent,
    alertText: urgent.join("\\n"),
    response: {
      received: records.length,
      costKrw: Math.round(costKrw),
      unknownIds, duplicateIds,
      results: records.map((r) => ({ id: r.id, procedure: r.procedure, types: r.types, urgency: r.urgency, department: r.department,
        ad_risk: r.ad_risk, missing: r.missing, summary: r.summary, safety_net: r.safety_net, failed: r.failed })),
    },
  },
  binary: { ledger: { data: b64(lines), mimeType: "text/csv", fileName: "상담대장.csv", fileExtension: "csv" } },
}];`;

// ===== [3] 상담실장 화면 =====
// 디자인은 시안 화면(design/template.html)의 CSS를 그대로 가져와요
const tpl = fs.readFileSync(path.join(here, "..", "design", "template.html"), "utf8");
const CSS = tpl.slice(tpl.indexOf("<style>") + 7, tpl.indexOf("</style>"));
if (CSS.includes("`") || CSS.includes("\\") || CSS.includes("${")) throw new Error("CSS에 백틱·역슬래시·${ 가 있으면 화면 코드가 깨져요");
const boardCode = fs.readFileSync(path.join(here, "board.js"), "utf8").replace("__CSS__", CSS);

const nodes = [
  { id: "c1000000-0000-4000-8000-000000000001", name: "문의 받기", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 300],
    webhookId: "3f6b2a10-7c4d-4e2a-9b1f-0c5d8e7a6b21",
    parameters: { httpMethod: "POST", path: "clinic-inquiry", responseMode: "responseNode", options: {} } },
  { id: "c1000000-0000-4000-8000-000000000002", name: "접수번호 붙이고 가리기", type: "n8n-nodes-base.code", typeVersion: 2, position: [240, 300],
    parameters: { jsCode: intakeCode } },
  { id: "c1000000-0000-4000-8000-000000000003", name: "AI에게 분류 요청", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [480, 300],
    onError: "continueRegularOutput",
    parameters: {
      method: "POST", url: "https://api.anthropic.com/v1/messages",
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: "x-api-key", value: "={{ $env.ANTHROPIC_API_KEY }}" },
        { name: "anthropic-version", value: "2023-06-01" },
        { name: "anthropic-beta", value: "server-side-fallback-2026-07-01" },
      ] },
      sendBody: true, specifyBody: "json", jsonBody: "={{ JSON.stringify($json.body) }}",
      options: { timeout: 180000 },
    } },
  { id: "c1000000-0000-4000-8000-000000000004", name: "접수번호로 결과 붙이기", type: "n8n-nodes-base.code", typeVersion: 2, position: [720, 300],
    parameters: { jsCode: attachCode } },
  { id: "c1000000-0000-4000-8000-000000000005", name: "상담 대장에 기록", type: "n8n-nodes-base.readWriteFile", typeVersion: 1.1, position: [960, 300],
    parameters: { operation: "write", fileName: `${RECORDS}/상담대장.csv`, dataPropertyName: "ledger", options: { append: true } } },
  { id: "c1000000-0000-4000-8000-000000000006", name: "긴급 알림 보낼까?", type: "n8n-nodes-base.if", typeVersion: 2.2, position: [1200, 300],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [{ id: "u1", leftValue: "={{ $('접수번호로 결과 붙이기').first().json.urgent.length > 0 && !!$env.ALERT_WEBHOOK_URL }}",
          rightValue: true, operator: { type: "boolean", operation: "true", singleValue: true } }],
        combinator: "and",
      },
      options: {},
    } },
  { id: "c1000000-0000-4000-8000-000000000007", name: "간호팀 알림 (Slack)", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [1440, 200],
    onError: "continueRegularOutput",
    notes: "ALERT_WEBHOOK_URL 환경변수(Slack 웹훅 주소)가 있을 때만 보내요. 이름·연락처 없이 접수번호만 보내요.",
    parameters: { method: "POST", url: "={{ $env.ALERT_WEBHOOK_URL }}", sendBody: true, specifyBody: "json",
      jsonBody: "={{ JSON.stringify({ text: '🚨 샘플성형외과(예시) 긴급 문의\\n' + $('접수번호로 결과 붙이기').first().json.alertText }) }}", options: {} } },
  { id: "c1000000-0000-4000-8000-000000000008", name: "결과 돌려주기", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [1680, 300],
    parameters: { respondWith: "json", responseBody: "={{ JSON.stringify($('접수번호로 결과 붙이기').first().json.response) }}", options: {} } },

  // 상담실장 화면: /webhook/clinic-board 를 브라우저로 열면 상담 대장을 보여 줘요
  { id: "c1000000-0000-4000-8000-000000000011", name: "상담실장 화면 열기", type: "n8n-nodes-base.webhook", typeVersion: 2, position: [0, 640],
    webhookId: "7a2e9c44-1b3d-4f5a-8c6e-2d4f6a8b0c13",
    parameters: { httpMethod: "GET", path: "clinic-board", responseMode: "responseNode", options: {} } },
  { id: "c1000000-0000-4000-8000-000000000012", name: "상담 대장 읽기", type: "n8n-nodes-base.readWriteFile", typeVersion: 1.1, position: [240, 640],
    parameters: { operation: "read", fileSelector: `${RECORDS}/상담대장.csv`, options: {} } },
  { id: "c1000000-0000-4000-8000-000000000013", name: "화면 만들기", type: "n8n-nodes-base.code", typeVersion: 2, position: [480, 640],
    parameters: { jsCode: boardCode } },
  { id: "c1000000-0000-4000-8000-000000000014", name: "화면 보여주기", type: "n8n-nodes-base.respondToWebhook", typeVersion: 1.1, position: [720, 640],
    parameters: { respondWith: "text", responseBody: "={{ $json.html }}",
      options: { responseHeaders: { entries: [{ name: "content-type", value: "text/html; charset=utf-8" }] } } } },
];

const sticky = (n, content, position, width, height, color) => ({
  id: `d1000000-0000-4000-8000-00000000000${n}`, name: `메모 ${n}`, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position,
  parameters: { content, width, height, color },
});
nodes.push(
  sticky(1, "## ① 받기 · 가리기\n채널 연결이 {channel, name, phone, text}로 보내요\n접수번호(R-1001…)를 붙이고 내용 칸의 이름·연락처·주민번호를 [환자1] 등으로 바꿔요", [-60, 60], 500, 200, 7),
  sticky(2, "## ② AI 분류\n가린 글만 Claude로. 시술·문의 종류·급한 정도·광고 주의·빠진 정보·답변 초안\n결과는 줄 순서가 아니라 **접수번호로** 붙여요", [460, 60], 480, 200, 5),
  sticky(3, "## ③ 기록 · 알림\n상담 대장(CSV)에 한 줄씩. 긴급이면 간호팀 알림(접수번호만)\n실행 기록 저장은 꺼 둠", [960, 60], 500, 200, 4),
  sticky(4, "## 상담실장 화면\n/webhook/clinic-board", [-60, 820], 300, 100, 6),
);

const at = (name, i = 0) => ({ node: name, type: "main", index: i });
const connections = {
  "문의 받기": { main: [[at("접수번호 붙이고 가리기")]] },
  "접수번호 붙이고 가리기": { main: [[at("AI에게 분류 요청")]] },
  "AI에게 분류 요청": { main: [[at("접수번호로 결과 붙이기")]] },
  "접수번호로 결과 붙이기": { main: [[at("상담 대장에 기록")]] },
  "상담 대장에 기록": { main: [[at("긴급 알림 보낼까?")]] },
  "긴급 알림 보낼까?": { main: [[at("간호팀 알림 (Slack)")], [at("결과 돌려주기")]] },
  "간호팀 알림 (Slack)": { main: [[at("결과 돌려주기")]] },
  "상담실장 화면 열기": { main: [[at("상담 대장 읽기")]] },
  "상담 대장 읽기": { main: [[at("화면 만들기")]] },
  "화면 만들기": { main: [[at("화면 보여주기")]] },
};

const workflow = {
  id: "ClinicInbox000001",
  name: "병원 상담 문의 모으기 · 분류",
  nodes,
  connections,
  // 실행 기록에 문의 원문이 쌓이지 않게 저장을 꺼요
  settings: { executionOrder: "v1", timezone: "Asia/Seoul", saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveManualExecutions: false, saveExecutionProgress: false },
  active: false,
  pinData: {},
};
const out = path.join(here, "clinic-inbox.workflow.json");
fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
console.log("written:", out, nodes.length, "nodes");
