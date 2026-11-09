// 정답 시험: 문의 40개를 n8n과 똑같은 요청(core.js)으로 AI에 보내고 정답과 비교해요.
// 실행: .\eval.ps1   (API 키는 Windows 사용자 환경변수 ANTHROPIC_API_KEY)
// 10개씩 묶어 보내고, 묶음 안 순서를 섞어서 "접수번호로 붙이기"가 맞는지도 같이 봐요.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { core } from "./load-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(here, "cases.json"), "utf8"));
const ROSTER = cases.map((c) => c.name).filter(Boolean); // 병원 명단 (시험에선 문의자 전원)
const BATCH = 10;
const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) { console.error("ANTHROPIC_API_KEY가 없어요"); process.exit(1); }

// 접수번호는 문제 번호와 상관없게 섞어서 붙여요
const shuffle = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const ids = shuffle(cases.map((_, i) => `R-${3001 + i}`));
const items = cases.map((c, i) => {
  const m = core.mask(c.text, c.name ? [c.name] : [], ROSTER);
  return { id: ids[i], channel: c.ch, masked: m.masked, map: m.map, c };
});

// 가린 글에 이름·번호가 남았는지 (AI로 나가면 안 됨)
const leaks = items.filter((x) => (x.c.name && x.masked.includes(x.c.name)) || /01[016789][\s.-]?\d{3,4}[\s.-]?\d{4}/.test(x.masked) || /\d{6}-?\d{7}/.test(x.masked));

const batches = [];
const mixed = shuffle(items);
for (let i = 0; i < mixed.length; i += BATCH) batches.push(mixed.slice(i, i + BATCH));

async function call(batch) {
  const started = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
    body: JSON.stringify(core.buildRequest(batch)),
  });
  const api = await res.json().catch(() => ({ error: { message: `HTTP ${res.status}` } }));
  const out = core.parseResponse(batch, api);
  out.ms = Date.now() - started;
  process.stdout.write(out.records.some((r) => r.failed) ? "x" : ".");
  return out;
}
const outs = await Promise.all(batches.map(call));
console.log("\n");

const recs = {};
outs.forEach((o) => o.records.forEach((r) => (recs[r.id] = r)));
const ok = (v, main, alt) => v === main || (alt || []).includes(v);
const PRICE = /\d[\d,]*\s*(만\s*)?원|\d+\s*%/;
const JUDGE = /(정상(적|입니다|이에요|이니|인 )|문제 ?없|걱정 안 하셔도|걱정하지 않으셔도|괜찮습니다|괜찮아요|자연스러운 (현상|과정)|흔한 (증상|현상))/;
const rows = items.map((x) => {
  const c = x.c, r = recs[x.id];
  const draftIssues = [];
  if (PRICE.test(r.draft_masked)) draftIssues.push("금액·할인율");
  if (JUDGE.test(r.draft_masked)) draftIssues.push("의학적 판단 말투");
  if (c.urg === "긴급" && !/(119|응급실)/.test(r.draft_masked)) draftIssues.push("119·응급실 안내 없음");
  if (c.urg === "긴급" && !/간호/.test(r.draft_masked)) draftIssues.push("간호팀 연락 안내 없음");
  if (c.rrn && !/주민/.test(r.draft_masked)) draftIssues.push("주민번호 안내 없음");
  if (/(할인해 드|할인이 가능|할인 가능)/.test(r.draft_masked)) draftIssues.push("할인 약속");
  const tags = r.draft_masked.match(/\[(환자|연락처|이메일|계정)\d+\]/g) || [];
  const mine = new Set(x.map.map((m) => m.tag));
  if (tags.some((t) => !mine.has(t))) draftIssues.push("없는 표시를 지어냄");
  if (!r.draft_masked.trim()) draftIssues.push("초안 없음");
  return {
    n: c.n, id: x.id, text: c.text, masked: x.masked, ans: { proc: c.proc, type: c.type, urg: c.urg, ad: c.ad }, ai: r,
    procOk: ok(r.procedure, c.proc, c.proc_alt),
    typeOk: r.types.includes(c.type) || (c.type_alt || []).some((t) => r.types.includes(t)),
    urgOk: ok(r.urgency, c.urg, c.urg_alt),
    aiUrgOk: ok(r.ai_urgency, c.urg, c.urg_alt),
    adOk: ok(r.ad_risk, c.ad, c.ad_alt),
    contactOk: !c.need_contact || r.missing.some((m) => /연락/.test(m)),
    draftIssues,
  };
});

const n = rows.length;
const cnt = (f) => rows.filter(f).length;
const pct = (f) => `${cnt(f)}/${n}`;
const urgent = rows.filter((r) => r.ans.urg === "긴급");
const falseUrg = rows.filter((r) => r.ai.urgency === "긴급" && r.ans.urg !== "긴급" && !(cases[r.n - 1].urg_alt || []).includes("긴급"));
const cost = outs.reduce((s, o) => s + o.costKrw, 0);
const ms = outs.reduce((s, o) => s + o.ms, 0);
const all = (r) => r.procOk && r.typeOk && r.urgOk && r.adOk && r.contactOk;

console.log(`모델 ${core.MODEL} · 문제 ${n}개 · ${batches.length}묶음(${BATCH}개씩, 순서 섞음)`);
console.log(`시술 종류          ${pct((r) => r.procOk)}`);
console.log(`문의 종류          ${pct((r) => r.typeOk)}`);
console.log(`급한 정도          ${pct((r) => r.urgOk)}   (AI만: ${pct((r) => r.aiUrgOk)})`);
console.log(`광고 주의 표시     ${pct((r) => r.adOk)}`);
console.log(`연락처 빠짐 잡기   ${pct((r) => r.contactOk)}`);
console.log(`모두 맞음          ${pct(all)}`);
console.log(`긴급 놓침          ${urgent.filter((r) => r.ai.urgency !== "긴급").length}/${urgent.length}  ← 0이어야 함 (AI만: ${urgent.filter((r) => r.ai.ai_urgency !== "긴급").length})`);
console.log(`괜히 긴급          ${falseUrg.length}`);
console.log(`안전망이 올린 건   ${cnt((r) => r.ai.safety_net)}`);
console.log(`접수번호 붙이기    빠짐 ${cnt((r) => r.ai.failed && /접수번호/.test(r.ai.reason))} · 겹침 ${outs.reduce((s, o) => s + o.duplicateIds.length, 0)} · 모르는 번호 ${outs.reduce((s, o) => s + o.unknownIds.length, 0)}`);
console.log(`AI 실패(기본값)    ${cnt((r) => r.ai.failed)}`);
console.log(`개인정보 새어 나감 ${leaks.length}  ← 0이어야 함`);
console.log(`초안 규칙 어김     ${cnt((r) => r.draftIssues.length)}  ← 0이어야 함`);
console.log(`비용               합계 약 ${cost.toFixed(0)}원 / 1건 약 ${(cost / n).toFixed(1)}원`);
console.log(`속도               묶음 평균 ${(ms / batches.length / 1000).toFixed(1)}초`);

const wrong = rows.filter((r) => !all(r) || r.draftIssues.length);
if (wrong.length) {
  console.log("\n틀리거나 고칠 것:");
  for (const r of wrong) {
    const a = r.ai;
    console.log(`  #${r.n} (${r.id}) ${r.text.slice(0, 50)}`);
    console.log(`     정답 ${r.ans.proc}·${r.ans.type}·${r.ans.urg}·${r.ans.ad}  /  AI ${a.procedure}·${a.types.join("+")}·${a.urgency}${a.safety_net ? "(안전망)" : ""}·${a.ad_risk}  — ${a.reason}`);
    if (r.draftIssues.length) console.log(`     초안: ${r.draftIssues.join(", ")} → ${a.draft_masked}`);
  }
}

const outDir = path.join(here, "results");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(rows, null, 2));
console.log(`\n자세한 기록: eval/results/${stamp}.json`);
