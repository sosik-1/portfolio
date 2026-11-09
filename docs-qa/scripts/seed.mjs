// 예시 문서(sample-docs)를 서버에 올려요. 이미 있는 제목은 건너뛰어요.
//   로컬:  node scripts/seed.mjs                       (ADMIN_TOKEN은 .dev.vars에서 읽음)
//   배포:  $env:ADMIN_TOKEN="..."; node scripts/seed.mjs https://docs-qa.<계정>.workers.dev
import fs from "node:fs";
import { readDoc, sampleFiles } from "./files.mjs";

const BASE = process.argv[2] || "http://localhost:8788";
let token = process.env.ADMIN_TOKEN;
if (!token && fs.existsSync(".dev.vars")) token = /ADMIN_TOKEN=(\S+)/.exec(fs.readFileSync(".dev.vars", "utf8"))?.[1];
if (!token) throw new Error("ADMIN_TOKEN이 없어요");

const { docs } = await fetch(`${BASE}/api/docs`).then((r) => r.json());
const have = new Set(docs.filter((d) => d.is_sample).map((d) => d.title));
for (const f of sampleFiles()) {
  const doc = await readDoc(f);
  if (have.has(doc.title)) { console.log("건너뜀:", doc.title); continue; }
  const r = await fetch(`${BASE}/api/docs`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": token },
    body: JSON.stringify({ ...doc, sample: true }),
  }).then((r) => r.json());
  console.log(r.error ? `실패: ${doc.title} - ${r.error}` : `올림: ${r.title} (조각 ${r.chunk_count}개)`);
}
