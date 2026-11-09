// request.js / report.js 를 넣어서 n8n 워크플로 파일(site-report.workflow.json)을 만들어요
// 실행: node workflow/build.mjs  →  npx n8n import:workflow --input=workflow/site-report.workflow.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(here, f), "utf8");
const REPORTS = "C:/dev/n8n-report/reports";

// ===== [시연 예시] 가짜 단지 예시 3개 (폼 기본값·링크 실행에 씀) =====
// 시연용 예시 (가짜 단지). 예시 1은 폼 기본값, 1~3은 demo-links.html의 미리 채운 링크로 씀
export const EXAMPLES = [
  {
    label: "예시 1 · 지하주차장 (긴급 예상)",
    단지명: "햇살아파트",
    "진단 위치": "지하주차장",
    "현장 메모": "지하 2층 B구역 천장 균열 4곳에서 물이 떨어지고 있음. 그중 1곳 아래 전기 배관함 있음. 기둥 2개 모서리 콘크리트 들뜸, 손으로 누르면 부스러짐. 바닥에 물 고임 약 3m 길이. 어제 비 온 뒤부터 심해졌다고 관리소장님이 말함.",
    작성자: "현장 담당자",
  },
  {
    label: "예시 2 · 외벽 (보통 예상)",
    단지명: "푸른숲 1단지",
    "진단 위치": "외벽",
    "현장 메모": "105동 북쪽 외벽 도장 벗겨짐 여러 곳, 3~5층 사이에 가는 균열 몇 줄 보임. 창틀 주변 실링 일부 갈라짐. 세대 안 누수 민원은 아직 없음. 사다리차 없이 지상에서 육안으로만 확인함.",
    작성자: "현장 담당자",
  },
  {
    label: "예시 3 · 계단실 (낮음 예상)",
    단지명: "행복마을 3단지",
    "진단 위치": "계단실·복도",
    "현장 메모": "103동 계단실 3~4층 벽면 페인트 들뜸과 얼룩. 손으로 만지면 가루 묻어남. 습기나 물 흐른 자국은 없음. 입주민이 보기 안 좋다고 민원 넣음.",
    작성자: "현장 담당자",
  },
];
const D = EXAMPLES[0];

// ===== [입력 받기] 현장 진단 입력 폼 노드 =====
// 폼 칸 이름·기본값이 여기 있어요
const nodes = [
  {
    id: "a1000000-0000-4000-8000-000000000001",
    name: "현장 진단 입력",
    type: "n8n-nodes-base.formTrigger",
    typeVersion: 2.3,
    position: [0, 300],
    webhookId: "5c0f3f2e-1a6b-4d0e-9a51-7d2f0c3e8b11",
    parameters: {
      path: "site-report",
      formTitle: "현장 진단 메모 → 보고서 초안",
      formDescription: "현장에서 본 것을 짧게 적으면 AI가 진단 보고서와 작업 항목(견적) 초안을 만들어요.",
      formFields: {
        values: [
          { fieldLabel: "단지명", placeholder: "예) 행복마을 3단지", defaultValue: D["단지명"], requiredField: true },
          {
            fieldLabel: "진단 위치",
            fieldType: "dropdown",
            fieldOptions: { values: ["옥상", "외벽", "지하주차장", "계단실·복도", "세대 내부", "기타"].map((o) => ({ option: o })) },
            defaultValue: D["진단 위치"],
            requiredField: true,
          },
          {
            fieldLabel: "현장 메모",
            fieldType: "textarea",
            placeholder: "예) 102동 옥상 우레탄 방수층 들뜸 3곳, 배수구 주변 물 고임. 최상층 1502호 천장 얼룩 있다고 함",
            defaultValue: D["현장 메모"],
            requiredField: true,
          },
          { fieldLabel: "작성자", placeholder: "이름 (선택)", defaultValue: D["작성자"] },
        ],
      },
      responseMode: "lastNode",
      options: {},
    },
  },
  // ===== [링크 입구] 링크만 열면 예시로 실행되는 입구 + 예시 고르기 =====
  // 링크 입구: /webhook/site-report-demo?example=1 을 열기만 하면 예시로 실행돼요
  {
    id: "a1000000-0000-4000-8000-000000000010",
    name: "링크로 실행 (예시)",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [0, 560],
    webhookId: "9a7c2b41-6d3e-4f8a-a1b2-5c6d7e8f9012",
    parameters: { httpMethod: "GET", path: "site-report-demo", responseMode: "responseNode", options: {} },
  },
  {
    id: "a1000000-0000-4000-8000-000000000011",
    name: "예시 고르기",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [0, 760],
    parameters: {
      jsCode: `// 링크의 ?example=1~${EXAMPLES.length} 로 예시를 골라서, 폼으로 들어온 것과 같은 모양으로 넘겨요
const EXAMPLES = ${JSON.stringify(EXAMPLES.map(({ label, ...rest }) => rest), null, 2)};
const n = Number($input.first().json.query?.example) || 1;
const ex = EXAMPLES[Math.min(Math.max(n, 1), EXAMPLES.length) - 1];
return [{ json: { ...ex, source: "link" } }];`,
    },
  },
  // ===== [요청 만들기] request.js 내용을 그대로 넣는 노드 =====
  {
    id: "a1000000-0000-4000-8000-000000000002",
    name: "요청 만들기",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [240, 300],
    parameters: { jsCode: read("request.js") },
  },
  // ===== [AI 호출] Claude에게 보고서를 부탁하는 노드 =====
  // API 키·주소·기다리는 시간(3분)이 여기 있어요
  {
    id: "a1000000-0000-4000-8000-000000000003",
    name: "AI에게 보고서 요청",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [480, 300],
    parameters: {
      method: "POST",
      url: "https://api.anthropic.com/v1/messages",
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: "x-api-key", value: "={{ $env.ANTHROPIC_API_KEY }}" },
          { name: "anthropic-version", value: "2023-06-01" },
          { name: "anthropic-beta", value: "server-side-fallback-2026-07-01" },
        ],
      },
      sendBody: true,
      specifyBody: "json",
      jsonBody: "={{ JSON.stringify($json.body) }}",
      options: { timeout: 180000 },
    },
  },
  // ===== [보고서 만들기] report.js 내용을 그대로 넣는 노드 =====
  {
    id: "a1000000-0000-4000-8000-000000000004",
    name: "보고서 만들기",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [720, 300],
    parameters: { jsCode: read("report.js") },
  },
  // ===== [파일 저장] 보고서 HTML을 reports 폴더에 저장 =====
  {
    id: "a1000000-0000-4000-8000-000000000005",
    name: "보고서 파일 저장",
    type: "n8n-nodes-base.readWriteFile",
    typeVersion: 1.1,
    position: [960, 180],
    parameters: {
      operation: "write",
      fileName: `=${REPORTS}/{{ $json.fileName }}`,
      dataPropertyName: "report",
      options: {},
    },
  },
  // ===== [진단 대장(CSV)] 진단대장.csv에 한 줄 덧붙이기 =====
  {
    id: "a1000000-0000-4000-8000-000000000006",
    name: "진단 대장에 기록",
    type: "n8n-nodes-base.readWriteFile",
    typeVersion: 1.1,
    position: [960, 420],
    parameters: {
      operation: "write",
      fileName: `${REPORTS}/진단대장.csv`,
      dataPropertyName: "log",
      options: { append: true },
    },
  },
  // ===== [알림 분기] 긴급이면 디스코드 알림 (알림 노드는 꺼져 있음) =====
  {
    id: "a1000000-0000-4000-8000-000000000007",
    name: "긴급인가?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [1200, 420],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "strict" },
        conditions: [
          {
            id: "c1",
            leftValue: "={{ $('보고서 만들기').item.json.urgency }}",
            rightValue: "긴급",
            operator: { type: "string", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    id: "a1000000-0000-4000-8000-000000000008",
    name: "담당자 알림 (디스코드)",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: [1440, 320],
    disabled: true, // 디스코드 웹훅 주소를 DISCORD_WEBHOOK_URL 환경변수에 넣고 켜면 알림이 가요
    notes: "꺼져 있어요. DISCORD_WEBHOOK_URL을 넣고 켜면 긴급 보고서가 나올 때 알림이 가요.",
    parameters: {
      method: "POST",
      url: "={{ $env.DISCORD_WEBHOOK_URL }}",
      sendBody: true,
      specifyBody: "json",
      jsonBody:
        "={{ JSON.stringify({ content: '🚨 긴급 진단 보고서: ' + $('보고서 만들기').item.json.title + '\\n' + $('보고서 만들기').item.json.summary }) }}",
      options: {},
    },
  },
  // ===== [결과 돌려주기] 링크로 왔으면 링크 화면에, 폼이면 폼 화면에 보고서 =====
  {
    id: "a1000000-0000-4000-8000-000000000012",
    name: "링크로 왔나?",
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position: [1680, 560],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose" },
        conditions: [
          {
            id: "c2",
            leftValue: "={{ $('요청 만들기').item.json.form.source }}",
            rightValue: "link",
            operator: { type: "string", operation: "equals" },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
  },
  {
    id: "a1000000-0000-4000-8000-000000000013",
    name: "링크에 보고서 돌려주기",
    type: "n8n-nodes-base.respondToWebhook",
    typeVersion: 1.1,
    position: [1920, 680],
    parameters: {
      respondWith: "text",
      responseBody: "={{ $('보고서 만들기').item.json.html }}",
      options: {
        responseHeaders: {
          entries: [
            { name: "content-type", value: "text/html; charset=utf-8" },
            { name: "access-control-allow-origin", value: "*" },
          ],
        },
      },
    },
  },
  {
    id: "a1000000-0000-4000-8000-000000000009",
    name: "보고서 보여주기",
    type: "n8n-nodes-base.form",
    typeVersion: 2.3,
    position: [1920, 420],
    webhookId: "8e3d1c55-2b7a-4f6e-b0c4-3a9d6e1f2c22",
    parameters: {
      operation: "completion",
      respondWith: "showText",
      responseText: "={{ $('보고서 만들기').item.json.html }}",
    },
  },
];

// 화면에서 보이는 설명 메모
const sticky = (id, content, position, width, height, color) => ({
  id, name: `메모 ${id.slice(-1)}`, type: "n8n-nodes-base.stickyNote", typeVersion: 1, position,
  parameters: { content, width, height, color },
});
nodes.push(
  sticky("b1000000-0000-4000-8000-000000000001",
    "## ① 입력\n현장 담당자가 폼에 단지·위치·메모를 적어요", [-60, 120], 260, 150, 7),
  sticky("b1000000-0000-4000-8000-000000000002",
    "## ② AI 정리\n메모 → 정해진 형식(JSON)의 보고서 내용\n- 메모에 없는 수치는 '현장 실측 필요'\n- 단가는 비움 (담당자가 채움)", [200, 80], 500, 190, 5),
  sticky("b1000000-0000-4000-8000-000000000003",
    "## ③ 기록\n보고서 HTML 저장 + 진단 대장(CSV)에 한 줄 추가", [680, 60], 460, 100, 4),
  sticky("b1000000-0000-4000-8000-000000000004",
    "## ④ 알림·결과\n긴급이면 담당자 알림 → 폼이면 폼 화면에, 링크면 링크 화면에 보고서를 돌려줌", [1180, 200], 880, 100, 3),
  sticky("b1000000-0000-4000-8000-000000000005",
    "## 링크 입구 (시연용)\n/webhook/site-report-demo?example=1~3\n열기만 하면 예시로 실행돼요", [-60, 880], 260, 140, 6),
);

// ===== [노드 연결] 어느 노드 다음에 어느 노드가 도는지 =====
const at = (name, i = 0) => ({ node: name, type: "main", index: i });
const connections = {
  "현장 진단 입력": { main: [[at("요청 만들기")]] },
  "링크로 실행 (예시)": { main: [[at("예시 고르기")]] },
  "예시 고르기": { main: [[at("요청 만들기")]] },
  "요청 만들기": { main: [[at("AI에게 보고서 요청")]] },
  "AI에게 보고서 요청": { main: [[at("보고서 만들기")]] },
  "보고서 만들기": { main: [[at("보고서 파일 저장"), at("진단 대장에 기록")]] },
  "진단 대장에 기록": { main: [[at("긴급인가?")]] },
  "긴급인가?": { main: [[at("담당자 알림 (디스코드)")], [at("링크로 왔나?")]] },
  "담당자 알림 (디스코드)": { main: [[at("링크로 왔나?")]] },
  "링크로 왔나?": { main: [[at("링크에 보고서 돌려주기")], [at("보고서 보여주기")]] },
};

// ===== [워크플로 조립] 다 합쳐서 site-report.workflow.json 파일로 쓰기 =====
const workflow = {
  id: "SiteReport0000001",
  name: "현장 진단 메모 → AI 보고서 초안",
  nodes,
  connections,
  settings: { executionOrder: "v1", timezone: "Asia/Seoul" },
  active: false,
  pinData: {},
};

// 직접 실행했을 때만 파일을 써요 (make-demo.mjs가 EXAMPLES만 가져갈 때는 쓰지 않음)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.join(here, "site-report.workflow.json");
  fs.writeFileSync(out, JSON.stringify(workflow, null, 2));
  console.log("written:", out, nodes.length, "nodes");
}

// 시연 페이지(demo.html)는 make-demo.mjs가 만들어요 (예시를 미리 돌려서 결과까지 붙임)
