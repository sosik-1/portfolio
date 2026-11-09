// n8n 전체 흐름 시험: 4개 채널 예시 문의 20건을 실제로 n8n에 보내고 결과를 확인해요 (약 170원)
// 실행: node eval/n8n-test.mjs   (n8n이 켜져 있어야 함)
//   - 10건은 하나씩 차례로, 10건은 동시에 보내요
//   - 확인: 대장에 20건이 서로 다른 접수번호로 들어갔나 / 긴급은 전부 긴급인가 /
//           AI로 보낸 글(대장의 '가린 문의 내용')에 이름·번호가 남았나 / n8n 실행 기록이 0건인가
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const URL = "http://127.0.0.1:5680/webhook/clinic-inquiry";
const LEDGER = path.join(root, "records", "상담대장.csv");
const run = Date.now().toString(36).slice(-4); // 이번 시험 표시 (문의 끝에 붙여 이번 것만 찾음)

// u: 긴급이어야 하는 문의
const CASES = [
  { channel: "카카오톡", name: "윤재희", phone: "010-3390-6612", text: "코 수술 3일째인데 콧속에서 피가 계속 나요. 거즈를 갈아도 멈추지 않아요.", u: true },
  { channel: "홈페이지", name: "최민재", phone: "010-7712-0459", text: "지방흡입 받은 지 4일째인데 열이 38.5도까지 올라요. 최민재 010-7712-0459 주민번호 920314-1234567", u: true },
  { channel: "인스타 DM", name: "강유리", phone: "", text: "어제 필러 맞았는데 맞은 자리가 하얗게 변하고 점점 아파요. 강유리 01066241180", u: true },
  { channel: "네이버 톡톡", name: "배수아", phone: "", text: "어제 쌍꺼풀 수술했는데 한쪽 눈이 흐릿하게 보여요. 배수아 010 9081 2273", u: true },
  { channel: "카카오톡", name: "편도현", phone: "010-5560-3312", text: "코 수술하고 집에 왔는데 숨쉬기가 너무 힘들고 가슴이 답답해요.", u: true },
  { channel: "홈페이지", name: "국하율", phone: "010-4402-1987", text: "지방흡입 2일째인데 일어나면 너무 어지럽고 쓰러질 것 같아요. 연락은 010-4402-1987", u: true },
  { channel: "카카오톡", name: "김서연", phone: "010-2847-3391", text: "안녕하세요 김서연입니다. 쌍꺼풀 수술 가격이 궁금해요. 010-2847-3391로 주세요." },
  { channel: "인스타 DM", name: "박지훈", phone: "", text: "코 수술 전후 사진 더 보내주실 수 있나요? 인스타 @jihoon.p 로 주세요." },
  { channel: "네이버 톡톡", name: "이하은", phone: "", text: "다음주 화요일 오후 2시에 리프팅 예약 잡고 싶어요. 이하은 010 5521 8840 입니다." },
  { channel: "인스타 DM", name: "오세린", phone: "", text: "피부 레이저 이벤트 가격 아직 하나요? 친구랑 같이 가면 더 할인돼요?" },
  { channel: "네이버 톡톡", name: "한도윤", phone: "", text: "11월 15일 상담 예약 취소하고 싶어요. 한도윤입니다." },
  { channel: "카카오톡", name: "정유나", phone: "010-1234-5678", text: "보톡스 맞으면 붓기 빠지는 데 얼마나 걸려요? 유나예요. 이번 주말에 결혼식이 있어서요." },
  { channel: "홈페이지", name: "장민서", phone: "", text: "가슴 지방이식 비용이랑 회복 기간 알려주세요. 답장은 minseo.j@example.com 으로 부탁드려요. 장민서" },
  { channel: "네이버 톡톡", name: "서지호", phone: "", text: "쌍꺼풀 재수술도 하시나요? 다른 병원에서 했는데 라인이 짝짝이에요." },
  { channel: "카카오톡", name: "문하준", phone: "010-6624-1180", text: "리프팅 가격표 받아볼 수 있을까요?" },
  { channel: "홈페이지", name: "어수진", phone: "02-345-6789", text: "지방흡입 하면 압박복은 언제까지 입어야 하나요? 집 전화 02-345-6789" },
  { channel: "인스타 DM", name: "도준서", phone: "", text: "남자도 쌍꺼풀 수술 많이 하나요? 티 안 나게 하고 싶어요." },
  { channel: "카카오톡", name: "모은채", phone: "010-7781-2290", text: "이마 보톡스 맞고 다음 날 헬스 해도 되나요?" },
  { channel: "네이버 톡톡", name: "남궁윤", phone: "", text: "코 수술 생각 중인데 수술하면 피가 많이 나나요? 아직 상담 전이에요." },
  { channel: "홈페이지", name: "추현우", phone: "010-8823-4471", text: "다음 달 3일 지방흡입 상담 예약했는데 4일로 바꿀 수 있을까요? 추현우 010-8823-4471" },
].map((c, i) => ({ ...c, text: `${c.text} (시험${run}-${String(i + 1).padStart(2, "0")})` }));

const send = async (c) => {
  const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: c.channel, name: c.name, phone: c.phone, text: c.text }) });
  const body = await res.text();
  try { return JSON.parse(body); } catch { return { error: `${res.status} ${body.slice(0, 80)}` }; }
};

const started = Date.now();
const replies = [];
// 1) 하나씩 10건 (교대로 섞어서: 짝수 번호)
const seq = CASES.filter((_, i) => i % 2 === 0), par = CASES.filter((_, i) => i % 2 === 1);
for (const c of seq) { replies.push(await send(c)); process.stdout.write("."); }
// 2) 동시에 10건
replies.push(...(await Promise.all(par.map(send))));
console.log(`\n보낸 시간 ${((Date.now() - started) / 1000).toFixed(0)}초 · 오류 응답 ${replies.filter((r) => r.error || !r.results).length}건`);

// 대장 읽기 (따옴표 CSV)
function parseCsv(s) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}
const [head, ...body] = parseCsv(fs.readFileSync(LEDGER, "utf8").replace(/^﻿/, ""));
const all = body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ""])));
const mine = all.filter((r) => r["가린 문의 내용"].includes(`시험${run}-`));
const caseOf = (r) => CASES[Number(r["가린 문의 내용"].match(new RegExp(`시험${run}-(\\d+)`))[1]) - 1];

const ids = mine.map((r) => r["접수번호"]);
const dupIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
const dupAll = all.map((r) => r["접수번호"]).filter((id, i, a) => a.indexOf(id) !== i);
const urgentCases = CASES.filter((c) => c.u);
const urgentMiss = mine.filter((r) => caseOf(r).u && r["급한 정도"] !== "긴급");
const urgentFound = mine.filter((r) => caseOf(r).u).length;
// AI로 보낸 글에 남으면 안 되는 것: 그 문의의 이름(성 뺀 이름 포함)·전화·주민번호·이메일·계정
const leaks = mine.flatMap((r) => {
  const c = caseOf(r), t = r["가린 문의 내용"];
  const bad = [c.name, c.name.length === 3 ? c.name.slice(1) : null].filter(Boolean).filter((n) => t.includes(n));
  if (/01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}|0\d{1,2}-\d{3,4}-\d{4}|\d{6}-?[1-8]\d{6}|[\w.]+@[\w-]+\.|@[A-Za-z0-9._]{3,}/.test(t)) bad.push("번호·이메일·계정");
  return bad.length ? [`${r["접수번호"]}: ${bad.join(", ")} → ${t}`] : [];
});
// 같은 문의가 다른 사람 결과와 섞였는지: 대장의 이름 칸이 보낸 이름과 같아야 함
const mixed = mine.filter((r) => r["이름"] !== caseOf(r).name);
// n8n 실행 기록 수
const execCount = execFileSync("python", ["-c", "import sqlite3;c=sqlite3.connect('file:.n8n/database.sqlite?mode=ro',uri=True);print(c.execute('select count(*) from execution_entity').fetchone()[0], c.execute('select count(*) from execution_data').fetchone()[0])"], { cwd: root }).toString().trim().split(" ").map(Number);

const ok = (b) => (b ? "통과" : "실패");
const checks = [
  [`대장에 들어온 건수`, `${mine.length}/20`, mine.length === 20],
  [`서로 다른 접수번호`, `${new Set(ids).size}/20 · 겹친 번호 ${dupIds.join(", ") || "없음"} · 대장 전체 겹침 ${dupAll.length}`, mine.length === 20 && !dupIds.length && !dupAll.length],
  [`이름이 다른 사람과 섞임`, `${mixed.length}건`, mixed.length === 0],
  [`긴급 문의 → 긴급`, `${urgentFound - urgentMiss.length}/${urgentCases.length}${urgentMiss.length ? " · 놓침 " + urgentMiss.map((r) => r["접수번호"]).join(", ") : ""}`, urgentFound === urgentCases.length && !urgentMiss.length],
  [`AI로 보낸 글에 이름·번호`, `${leaks.length}건`, leaks.length === 0],
  [`n8n 실행 기록`, `${execCount[0]}건 · 실행 데이터 ${execCount[1]}건`, execCount[0] === 0 && execCount[1] === 0],
];
console.log(`\n이번 시험 표시: 시험${run}`);
for (const [k, v, pass] of checks) console.log(`${ok(pass)}  ${k.padEnd(18)} ${v}`);
if (leaks.length) console.log("\n새어 나간 것:\n  " + leaks.join("\n  "));
const cost = replies.reduce((s, r) => s + (r.costKrw || 0), 0);
console.log(`\n비용 약 ${cost}원 · 접수번호 ${ids.slice().sort().join(" ")}`);
const allOk = checks.every((c) => c[2]);
console.log(allOk ? "\n모두 통과" : "\n실패한 항목이 있어요");
process.exit(allOk ? 0 : 1);
