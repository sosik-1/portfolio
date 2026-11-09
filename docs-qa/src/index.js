// 사내 문서 Q&A 챗봇 서버 (Cloudflare Worker)
//   GET    /api/docs            예시 문서 + 내가 올린 문서 목록
//   POST   /api/docs            문서 올리기 (쪽별 글자 → 조각 → 임베딩 → 저장)
//   DELETE /api/docs/:id        내가 올린 문서 지우기
//   GET    /api/chunks/:id      조각 전체 보기 (근거 확인용)
//   POST   /api/search          검색만 (AI 비용 0원, 평가에도 씀)
//   POST   /api/ask             검색 + Claude 답 + 근거 확인

import Anthropic from "@anthropic-ai/sdk";
import { chunkPages } from "./chunk.js";
import { search, embed } from "./search.js";
import { answer } from "./answer.js";

// ===== [설정값] 한도 (문서 크기·개수·하루 올리기) =====
// 숫자를 바꾸면 한도가 바뀌어요
const LIMITS = {
  maxCharsPerDoc: 100_000, // 문서 한 개 최대 글자 수 (A4 약 50쪽)
  maxChunksPerDoc: 250,
  maxDocsPerOwner: 5,
  uploadsPerDay: 60, // 사이트 전체 하루 올리기 한도 (임베딩 무료 한도 보호)
  keepHours: 24,
};
const MODES = ["keyword", "vector", "hybrid"];

// ===== [공통 도우미] 응답 만들기·한국 날짜·방문자 확인 =====
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // 한국 날짜
const validOwner = (o) => typeof o === "string" && /^[a-z0-9-]{8,64}$/i.test(o);

// ===== [저장(DB): 사용량 세기] 하루 올리기·질문 횟수 =====
async function bump(env, col) {
  await env.DB.prepare(`INSERT INTO usage (day, ${col}) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET ${col} = ${col} + 1`)
    .bind(today())
    .run();
}
async function used(env, col) {
  const r = await env.DB.prepare(`SELECT ${col} AS n FROM usage WHERE day = ?`).bind(today()).first();
  return r?.n || 0;
}

// ===== [저장(DB): 기한 지난 문서 지우기] =====
// 기한 지난 방문자 문서 지우기 (요청 올 때마다 가볍게 실행)
async function cleanup(env) {
  const old = "SELECT id FROM docs WHERE expires_at IS NOT NULL AND expires_at < datetime('now')";
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM chunks WHERE doc_id IN (${old})`),
    env.DB.prepare(`DELETE FROM docs WHERE id IN (${old})`),
  ]);
}

// ===== [저장(DB): 볼 수 있는 조각 불러오기] =====
// 이 방문자가 볼 수 있는 조각 전부 (예시 문서 + 본인 문서). 문서가 적어서 통째로 읽고 메모리에서 검색해요.
async function visibleChunks(env, owner, docIds) {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.doc_id, c.page, c.section, c.text, c.embedding, d.title AS doc_title
       FROM chunks c JOIN docs d ON d.id = c.doc_id
      WHERE (d.is_sample = 1 OR d.owner = ?)
        AND (d.expires_at IS NULL OR d.expires_at >= datetime('now'))`
  )
    .bind(validOwner(owner) ? owner : "-")
    .all();
  const filter = Array.isArray(docIds) && docIds.length ? new Set(docIds.map(Number)) : null;
  return results
    .filter((c) => !filter || filter.has(c.doc_id))
    .map((c) => ({ ...c, embedding: c.embedding ? JSON.parse(c.embedding) : null }));
}

const publicChunk = ({ embedding, ...c }) => c;

// ===== [문서 목록] 화면 왼쪽 목록에 줄 문서들 =====
async function listDocs(env, owner) {
  await cleanup(env);
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.title, d.kind, d.is_sample, d.pages, d.chars, d.created_at, d.expires_at,
            (SELECT COUNT(*) FROM chunks c WHERE c.doc_id = d.id) AS chunk_count
       FROM docs d WHERE d.is_sample = 1 OR d.owner = ? ORDER BY d.is_sample DESC, d.id`
  )
    .bind(validOwner(owner) ? owner : "-")
    .all();
  return json({ docs: results, limits: LIMITS });
}

// ===== [문서 올리기] 검사 → 조각 나누기 → 임베딩 → 저장 =====
// 올리기 한도 초과·글자 없음 같은 안내도 여기서 나가요
async function addDoc(request, env) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "잘못된 요청이에요" }, 400);
  const { title, kind, pages, owner } = body;
  // 예시 문서는 관리자 토큰이 있어야 올릴 수 있어요 (시드 스크립트용)
  const isSample = body.sample === true && env.ADMIN_TOKEN && request.headers.get("x-admin-token") === env.ADMIN_TOKEN;
  if (body.sample && !isSample) return json({ error: "권한이 없어요" }, 403);
  if (!isSample && !validOwner(owner)) return json({ error: "잘못된 요청이에요" }, 400);
  if (!title || !["pdf", "md", "txt"].includes(kind) || !Array.isArray(pages) || !pages.length)
    return json({ error: "문서 정보가 빠졌어요" }, 400);

  const chars = pages.reduce((a, p) => a + String(p.text || "").length, 0);
  if (chars < 20) return json({ error: "글자를 거의 찾지 못했어요. 스캔한 이미지 PDF는 아직 읽을 수 없어요." }, 400);
  if (chars > LIMITS.maxCharsPerDoc) return json({ error: `문서가 너무 길어요 (최대 ${LIMITS.maxCharsPerDoc.toLocaleString()}자)` }, 400);

  await cleanup(env);
  if (!isSample) {
    const mine = await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE owner = ?").bind(owner).first();
    if (mine.n >= LIMITS.maxDocsPerOwner) return json({ error: `문서는 ${LIMITS.maxDocsPerOwner}개까지 올릴 수 있어요. 하나를 지우고 올려 주세요.` }, 400);
    if ((await used(env, "uploads")) >= LIMITS.uploadsPerDay) return json({ error: "오늘 사이트 전체 올리기 한도를 다 썼어요. 내일 다시 해 주세요." }, 429);
  }

  const cleanTitle = String(title).slice(0, 80);
  const chunks = chunkPages(pages.map((p) => ({ page: kind === "pdf" ? Number(p.page) : null, text: String(p.text || "") })), kind);
  if (chunks.length > LIMITS.maxChunksPerDoc) return json({ error: "문서가 너무 길어요" }, 400);

  // ===== [임베딩] 조각을 뜻 검색용 숫자로 바꾸기 =====
  // 임베딩: 제목·조항 제목까지 같이 넣어야 "어느 규정의 어떤 내용인지" 뜻이 잘 잡혀요
  let vectors;
  try {
    vectors = await embed(env.AI, chunks.map((c) => `${cleanTitle}\n${c.section}\n${c.text}`));
  } catch (e) {
    console.error("임베딩 오류:", e?.message);
    return json({ error: "문서를 검색용으로 바꾸는 중 오류가 났어요. 잠시 뒤 다시 해 주세요." }, 502);
  }

  // ===== [저장(DB): 문서·조각 넣기] =====
  const doc = await env.DB.prepare(
    `INSERT INTO docs (title, kind, owner, is_sample, pages, chars, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ${isSample ? "NULL" : `datetime('now', '+${LIMITS.keepHours} hours')`}) RETURNING id`
  )
    .bind(cleanTitle, kind, isSample ? null : owner, isSample ? 1 : 0, kind === "pdf" ? pages.length : null, chars)
    .first();
  const stmts = chunks.map((c, i) =>
    env.DB.prepare("INSERT INTO chunks (doc_id, idx, page, section, text, embedding) VALUES (?, ?, ?, ?, ?, ?)").bind(
      doc.id, c.idx, c.page, c.section, c.text, JSON.stringify(vectors[i].map((x) => Math.round(x * 1e5) / 1e5))
    )
  );
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  if (!isSample) await bump(env, "uploads");
  return json({ id: doc.id, title: cleanTitle, chunk_count: chunks.length });
}

// ===== [문서 지우기] 내가 올린 문서만 =====
async function deleteDoc(request, env, id) {
  const owner = new URL(request.url).searchParams.get("owner");
  const doc = await env.DB.prepare("SELECT id FROM docs WHERE id = ? AND owner = ? AND is_sample = 0").bind(id, owner || "-").first();
  if (!doc) return json({ error: "지울 수 있는 문서가 아니에요" }, 404);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM chunks WHERE doc_id = ?").bind(id),
    env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id),
  ]);
  return json({ ok: true });
}

// ===== [근거 조각 보기] 근거 버튼을 누르면 조각 전체를 보여줌 =====
async function getChunk(request, env, id) {
  const owner = new URL(request.url).searchParams.get("owner");
  const c = await env.DB.prepare(
    `SELECT c.id, c.doc_id, c.idx, c.page, c.section, c.text, d.title AS doc_title
       FROM chunks c JOIN docs d ON d.id = c.doc_id WHERE c.id = ? AND (d.is_sample = 1 OR d.owner = ?)`
  )
    .bind(id, validOwner(owner) ? owner : "-")
    .first();
  return c ? json(c) : json({ error: "없는 조각이에요" }, 404);
}

// ===== [질문 받기] 질문 글 확인 (빈칸·500자 제한) =====
async function readQuery(request) {
  const body = await request.json().catch(() => null);
  const q = String(body?.q || "").trim();
  if (!q) return { error: json({ error: "질문을 입력해 주세요" }, 400) };
  if (q.length > 500) return { error: json({ error: "질문은 500자까지 쓸 수 있어요" }, 400) };
  const mode = MODES.includes(body.mode) ? body.mode : "hybrid";
  return { q, mode, owner: body.owner, docIds: body.doc_ids };
}

// ===== [검색만 하기] /api/search (AI 비용 0원) =====
async function doSearch(request, env) {
  const r = await readQuery(request);
  if (r.error) return r.error;
  const chunks = await visibleChunks(env, r.owner, r.docIds);
  const hits = await search({ ai: env.AI, query: r.q, chunks, mode: r.mode, topK: 5 });
  return json({ mode: r.mode, hits: hits.map(publicChunk) });
}

// ===== [AI 답변 만들기: 묻기 전체 흐름] /api/ask =====
// 한도 확인 → 검색 → Claude 답 → 결과 돌려주기
async function doAsk(request, env) {
  const r = await readQuery(request);
  if (r.error) return r.error;
  const max = Number(env.MAX_ASK_PER_DAY || 100);
  if ((await used(env, "asks")) >= max) return json({ error: "오늘 질문 한도를 다 썼어요. 내일 다시 써 주세요." }, 429);
  if (!env.ANTHROPIC_API_KEY) return json({ error: "서버에 AI 키가 설정되지 않았어요" }, 500);

  const t0 = Date.now();
  const chunks = await visibleChunks(env, r.owner, r.docIds);
  const hits = await search({ ai: env.AI, query: r.q, chunks, mode: r.mode, topK: 5 });
  const searchMs = Date.now() - t0;

  await bump(env, "asks");
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const result = await answer(client, r.q, hits);
  if (result.error) return json({ error: result.error }, 502);
  return json({ ...result, search_ms: searchMs, mode: r.mode, retrieved: hits.map(publicChunk) });
}

// ===== [주소 나누기] 어떤 주소로 오면 어떤 일을 할지 =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/api/docs" && request.method === "GET") return await listDocs(env, url.searchParams.get("owner"));
      if (p === "/api/docs" && request.method === "POST") return await addDoc(request, env);
      let m;
      if ((m = p.match(/^\/api\/docs\/(\d+)$/)) && request.method === "DELETE") return await deleteDoc(request, env, Number(m[1]));
      if ((m = p.match(/^\/api\/chunks\/(\d+)$/)) && request.method === "GET") return await getChunk(request, env, Number(m[1]));
      if (p === "/api/search" && request.method === "POST") return await doSearch(request, env);
      if (p === "/api/ask" && request.method === "POST") return await doAsk(request, env);
      if (p.startsWith("/api/")) return json({ error: "없는 주소예요" }, 404);
    // ===== [오류 처리] 위에서 예상 못 한 오류가 나면 '서버 오류가 났어요' =====
    } catch (e) {
      console.error("서버 오류:", e?.stack || e);
      return json({ error: "서버 오류가 났어요" }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};
