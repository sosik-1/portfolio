// 정확도 평가
//   node eval/run.mjs --search-only        검색 점수만 (AI 비용 0원)
//   node eval/run.mjs                      검색 점수 + 답 점수 (질문당 약 40원)
//   node eval/run.mjs --ids 10,32          특정 문제만
//   node eval/run.mjs --base https://...   배포된 사이트로 평가
//   node eval/run.mjs --mode keyword       답할 때 쓸 검색 방식 (기본 hybrid)
import fs from "node:fs";
import path from "node:path";
import { norm } from "../src/answer.js";

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const BASE = opt("--base", "http://localhost:8788");
const ANSWER_MODE = opt("--mode", "hybrid");
const SEARCH_ONLY = args.includes("--search-only");
const ids = opt("--ids", null)?.split(",").map(Number);

const all = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "cases.json"), "utf8"));
const cases = ids ? all.filter((c) => ids.includes(c.id)) : all;

const post = (p, body) =>
  fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

// 정답 조각을 찾았나: 정답 문장(evidence)이 조각 안에 있으면 맞음 (띄어쓰기·줄바꿈 무시)
const hasEvidence = (chunkText, ev) => norm(chunkText).includes(norm(ev));
// 답에 꼭 들어가야 할 말: "a|b"는 둘 중 하나만 있어도 됨
const mustOk = (answer, must) => must.every((m) => m.split("|").some((alt) => norm(answer).includes(norm(alt))));

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const MODES = ["keyword", "vector", "hybrid"];
console.log(`평가 ${cases.length}문제 · 서버 ${BASE}${SEARCH_ONLY ? " · 검색만" : ` · 답 검색 방식 ${ANSWER_MODE}`}\n`);

const rows = await pool(cases, 4, async (c) => {
  const row = { id: c.id, q: c.q, answerable: c.answerable, search: {} };
  if (c.answerable) {
    for (const mode of MODES) {
      const r = await post("/api/search", { q: c.q, mode });
      if (r.error) throw new Error(`${c.id} 검색 오류: ${r.error}`);
      const rank = r.hits.findIndex((h) => hasEvidence(h.text, c.evidence));
      row.search[mode] = rank === -1 ? null : rank + 1; // 몇 번째에 찾았나 (못 찾으면 null)
    }
  }
  if (SEARCH_ONLY) return row;
  const a = await post("/api/ask", { q: c.q, mode: ANSWER_MODE });
  if (a.error) { row.error = a.error; return row; }
  row.found = a.found;
  row.answer = a.answer;
  row.note = a.note;
  row.citations = a.citations;
  row.dropped = a.dropped;
  row.ms = a.ms;
  row.costKrw = a.costKrw;
  if (c.answerable) {
    row.answerOk = a.found && mustOk(a.answer, c.must);
    const byId = new Map(a.retrieved.map((h) => [h.id, h]));
    row.citeOk = a.citations.some((ct) => byId.has(ct.chunk_id) && hasEvidence(byId.get(ct.chunk_id).text, c.evidence));
  } else {
    row.answerOk = a.found === false; // 없는 걸 없다고 했나
  }
  const mark = row.answerOk ? "O" : "X";
  console.log(`${mark} #${c.id} ${c.q}\n   → ${a.found ? "" : "[없음] "}${a.answer.replace(/\n/g, " ").slice(0, 120)}`);
  return row;
});

// ---------- 점수 ----------
const ans = rows.filter((r) => r.answerable);
const un = rows.filter((r) => !r.answerable);
const pct = (n, d) => (d ? `${n}/${d} (${Math.round((100 * n) / d)}%)` : "-");

console.log("\n## 검색: 정답 조각을 상위 5개 안에 찾았나 (답이 있는 문제 " + ans.length + "개)\n");
console.log("| 검색 방식 | 1위로 찾음 | 5위 안에 찾음 | MRR |");
console.log("|---|---|---|---|");
for (const m of MODES) {
  const r1 = ans.filter((r) => r.search[m] === 1).length;
  const r5 = ans.filter((r) => r.search[m] !== null).length;
  const mrr = ans.reduce((a, r) => a + (r.search[m] ? 1 / r.search[m] : 0), 0) / Math.max(ans.length, 1);
  console.log(`| ${{ keyword: "키워드만 (BM25)", vector: "뜻만 (임베딩)", hybrid: "섞기 (RRF)" }[m]} | ${pct(r1, ans.length)} | ${pct(r5, ans.length)} | ${mrr.toFixed(2)} |`);
}
const missed = ans.filter((r) => MODES.some((m) => r.search[m] === null));
if (missed.length) {
  console.log("\n못 찾은 문제:");
  for (const r of missed) console.log(`  #${r.id} ${r.q} → ${MODES.map((m) => `${m}:${r.search[m] ?? "X"}`).join(" ")}`);
}

if (!SEARCH_ONLY) {
  const errors = rows.filter((r) => r.error);
  const cost = rows.reduce((a, r) => a + (r.costKrw || 0), 0);
  const avgMs = rows.filter((r) => r.ms).reduce((a, r) => a + r.ms, 0) / Math.max(rows.filter((r) => r.ms).length, 1);
  console.log(`\n## 답 (검색 방식: ${ANSWER_MODE})\n`);
  console.log("| 항목 | 결과 |");
  console.log("|---|---|");
  console.log(`| 답이 맞음 (답 있는 문제) | ${pct(ans.filter((r) => r.answerOk).length, ans.length)} |`);
  console.log(`| 근거가 정답 조각을 가리킴 | ${pct(ans.filter((r) => r.citeOk).length, ans.length)} |`);
  console.log(`| 없는 걸 없다고 함 (답 없는 문제) | ${pct(un.filter((r) => r.answerOk).length, un.length)} |`);
  console.log(`| 지어낸 답 (답 없는 문제에 답함) | ${un.filter((r) => r.found).length}건 |`);
  console.log(`| 원문과 안 맞아 버린 근거 | ${rows.reduce((a, r) => a + (r.dropped || 0), 0)}개 |`);
  console.log(`| 평균 답 시간 | ${(avgMs / 1000).toFixed(1)}초 |`);
  console.log(`| 비용 | 약 ${Math.round(cost)}원 (질문당 약 ${Math.round(cost / Math.max(rows.length - errors.length, 1))}원) |`);
  if (errors.length) console.log(`\n오류 ${errors.length}건: ${errors.map((r) => `#${r.id} ${r.error}`).join(", ")}`);
  const wrong = rows.filter((r) => !r.error && !r.answerOk);
  if (wrong.length) {
    console.log("\n틀린 문제:");
    for (const r of wrong) console.log(`  #${r.id} ${r.q}\n     답: ${r.answer}${r.note ? ` / ${r.note}` : ""}`);
  }
}

const dir = path.join(import.meta.dirname, "results");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}${SEARCH_ONLY ? "-search" : ""}.json`);
fs.writeFileSync(file, JSON.stringify(rows, null, 2));
console.log(`\n저장: ${path.relative(process.cwd(), file)}`);
