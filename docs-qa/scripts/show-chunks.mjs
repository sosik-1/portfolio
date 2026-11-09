// 예시 문서가 어떻게 나뉘는지 확인: node scripts/show-chunks.mjs
import { chunkPages } from "../src/chunk.js";
import { readDoc, sampleFiles } from "./files.mjs";
for (const f of sampleFiles()) {
  const d = await readDoc(f);
  const chunks = chunkPages(d.pages, d.kind);
  console.log(`\n=== ${d.title} (${d.kind}) 조각 ${chunks.length}개`);
  for (const c of chunks) console.log(`[${c.idx}] p${c.page ?? "-"} «${c.section}» ${c.text.length}자 | ${c.text.replace(/\n/g, " ⏎ ").slice(0, 90)}`);
}
