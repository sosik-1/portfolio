// AI 분류 정확도 평가
// 실행: node eval/run.mjs            (전체)
//       node eval/run.mjs 1 2 33     (고른 번호만)
// 결과: 화면에 요약, eval/results/ 에 자세한 기록(JSON)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { classify, MODEL } from "../src/classify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let cases = JSON.parse(fs.readFileSync(path.join(here, "cases.json"), "utf8"));
const pick = process.argv.slice(2).map(Number).filter(Boolean);
if (pick.length) cases = cases.filter((c) => pick.includes(c.id));

const client = new Anthropic();
const CONCURRENCY = 4; // 동시에 4개씩

const results = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const ai = await classify(client, { description: c.text });
    const catOk = ai.category === c.category || (c.category_alt || []).includes(ai.category);
    const urgOk = ai.urgency === c.urgency || (c.urgency_alt || []).includes(ai.urgency);
    results.push({ ...c, ai, catOk, urgOk, strict: ai.category === c.category && ai.urgency === c.urgency });
    process.stdout.write(catOk && urgOk ? "." : "x");
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
results.sort((a, b) => a.id - b.id);
console.log("\n");

const n = results.length;
const pct = (k) => `${results.filter(k).length}/${n} (${Math.round((results.filter(k).length / n) * 100)}%)`;
// 가장 위험한 실수: 진짜 긴급인데 긴급이 아니라고 한 것
const urgent = results.filter((r) => r.urgency === "긴급");
const urgentMissed = urgent.filter((r) => r.ai.urgency !== "긴급");
const falseUrgent = results.filter((r) => r.ai.urgency === "긴급" && r.urgency !== "긴급" && !(r.urgency_alt || []).includes("긴급"));

console.log(`모델: ${MODEL}  /  문제 ${n}개`);
console.log(`종류 정확도        ${pct((r) => r.catOk)}`);
console.log(`급한 정도 정확도   ${pct((r) => r.urgOk)}`);
console.log(`둘 다 맞음         ${pct((r) => r.catOk && r.urgOk)}`);
console.log(`(엄격: 첫 정답만)  ${pct((r) => r.strict)}`);
console.log(`긴급 놓침          ${urgentMissed.length}/${urgent.length}  ← 0이어야 함`);
console.log(`괜히 긴급          ${falseUrgent.length}`);
// 되묻기: 정보가 모자란 건은 "물어보거나, 안전하게 긴급으로 올려서 바로 출동"해야 하고,
//         나머지는 되도록 묻지 않아야 고객이 편함
const mustAsk = results.filter((r) => r.should_ask);
const handled = (r) => r.ai.questions.length > 0 || r.ai.urgency === "긴급";
console.log(`되묻기 나온 문제   ${results.filter((r) => r.ai.questions.length).length}/${n}  ← 적을수록 고객이 편함`);
console.log(`정보 부족 건 처리  ${mustAsk.filter(handled).length}/${mustAsk.length}  ← 물었거나 긴급으로 올렸으면 통과, 다 통과해야 함`);
console.log(`AI 실패(기본값)    ${results.filter((r) => r.ai.needs_review).length}개`);
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
