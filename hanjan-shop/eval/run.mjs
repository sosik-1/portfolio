// AI 문의 분류 정확도 평가 (한잔로스터리)
// 실행: .\eval.ps1            (전체 25문제, 1회 약 750원)
//       .\eval.ps1 1 2 13     (고른 번호만)
// 결과: 화면에 요약, eval/results/ 에 자세한 기록(JSON)
// 서버를 띄우지 않고 src/ai.js를 바로 불러요 (운영 서버와 같은 프롬프트·같은 모델)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { answerInquiry, MODEL } from "../src/ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let cases = JSON.parse(fs.readFileSync(path.join(here, process.env.CASES || "cases.json"), "utf8"));
const pick = process.argv.slice(2).map(Number).filter(Boolean);
if (pick.length) cases = cases.filter((c) => pick.includes(c.id));

// 운영 서버가 AI에 주는 것과 같은 '판매 중인 상품' 목록 (seed.sql과 같은 값)
const PRODUCTS = [
  ["에티오피아 예가체프", "원두", "200g", 16000, "약배전", "자몽 · 자스민 · 홍차"],
  ["케냐 AA", "원두", "200g", 17000, "약배전", "블랙커런트 · 토마토 · 와인"],
  ["콜롬비아 수프리모", "원두", "200g", 14000, "중배전", "캐러멜 · 견과 · 밀크초콜릿"],
  ["브라질 산토스 500g", "원두", "500g", 26000, "중강배전", "고소함 · 다크초콜릿"],
  ["한잔 하우스 블렌드", "원두", "200g", 13000, "중배전", "흑설탕 · 구운 견과"],
  ["디카페인 콜롬비아", "원두", "200g", 16000, "중배전", "코코아 · 부드러움"],
  ["콜드브루용 블렌드", "원두", "500g", 24000, "강배전", "초콜릿 · 묵직함"],
  ["드립백 10개입", "드립백", "10개입", 12000, "중배전", "하우스 블렌드"],
  ["세라믹 드리퍼 1~2인용", "도구", "1개", 18000, "", ""],
  ["종이 필터 100매", "도구", "100매", 5000, "", ""],
].map(([name, kind, unit, price, roast, notes]) => ({ name, kind, unit, price, roast, notes, sold_out: 0 }));

const client = new Anthropic();
const CONCURRENCY = 4;
const results = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const order = c.order ? { id: 900 + c.id, created_at: "2026-11-07 01:00:00", ...c.order } : null;
    const ai = await answerInquiry(client, c.text, order, PRODUCTS);
    const catOk = ai.category === c.category || (c.category_alt || []).includes(ai.category);
    const urgOk = ai.urgency === c.urgency || (c.urgency_alt || []).includes(ai.urgency);
    results.push({ ...c, ai, catOk, urgOk });
    process.stdout.write(catOk && urgOk ? "." : "x");
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
results.sort((a, b) => a.id - b.id);
console.log("\n");

const n = results.length;
const cnt = (f) => results.filter(f).length;
const pct = (f) => `${cnt(f)}/${n} (${Math.round((cnt(f) / n) * 100)}%)`;
// 가장 위험한 실수: 진짜 긴급(먹으면 안 될 수 있음, 오배송, 돈 문제)을 긴급이 아니라고 한 것
const urgent = results.filter((r) => r.urgency === "긴급");
const urgentMissed = urgent.filter((r) => r.ai.urgency !== "긴급");

console.log(`모델: ${MODEL}  /  문제 ${n}개`);
console.log(`종류 정확도        ${pct((r) => r.catOk)}`);
console.log(`급한 정도 정확도   ${pct((r) => r.urgOk)}`);
console.log(`둘 다 맞음         ${pct((r) => r.catOk && r.urgOk)}`);
console.log(`긴급 놓침          ${urgentMissed.length}/${urgent.length}  ← 0이어야 함`);
console.log(`근거 안내문 붙음   ${pct((r) => r.ai.cited.length > 0)}`);
console.log(`사람 판단 필요     ${cnt((r) => r.ai.needs_human)}건`);
console.log(`AI 실패(기본값)    ${cnt((r) => r.ai.failed)}개`);
const cost = results.reduce((s, r) => s + (r.ai.costKrw || 0), 0);
const ms = results.reduce((s, r) => s + (r.ai.ms || 0), 0);
console.log(`비용               합계 약 ${cost.toFixed(0)}원 / 1건 약 ${(cost / n).toFixed(1)}원`);
console.log(`속도               1건 평균 ${(ms / n / 1000).toFixed(1)}초`);

const wrong = results.filter((r) => !(r.catOk && r.urgOk));
if (wrong.length) {
  console.log("\n틀린 문제:");
  for (const r of wrong) {
    console.log(`  #${r.id} ${r.text}`);
    console.log(`     정답 ${r.category}·${r.urgency}  /  AI ${r.ai.category}·${r.ai.urgency}  — ${r.ai.reason}`);
  }
}

const outDir = path.join(here, "results");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(results, null, 2));
console.log(`\n자세한 기록: eval/results/${stamp}.json`);
