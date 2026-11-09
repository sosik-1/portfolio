// 질문과 관련된 조각을 찾는 부분 (AI 비용 0원)
// 1) 키워드 검색: 한글을 2글자씩 묶어(바이그램) BM25 점수로 순위 매기기
// 2) 뜻 검색(임베딩): 질문과 조각을 숫자 벡터로 바꿔 코사인 유사도로 순위 매기기
// 3) 섞기: 두 순위를 RRF(순위 역수 더하기)로 합치기

// ===== [설정값] 임베딩 모델 =====
export const EMBED_MODEL = "@cf/baai/bge-m3"; // Cloudflare Workers AI의 다국어 임베딩 모델

// ---------- 키워드 검색 ----------

// ===== [검색: 낱말 쪼개기] =====
/**
 * 글을 검색용 낱말(토큰)로 바꿔요.
 * - 한글: 단어마다 2글자씩 묶음. "연차휴가는" → 연차, 차휴, 휴가, 가는
 *   (조사가 붙어도 앞부분 묶음이 겹쳐서 찾을 수 있어요.)
 *   줄바꿈은 단어 사이로 보지 않고 이어 붙여요: PDF는 "문제⏎인지"처럼 단어 중간에서 줄이 바뀌어서요.
 *   처음엔 띄어쓰기도 무시하고 묶었는데, "제 차로" → "제차"처럼 단어 사이에 생긴 가짜 묶음이
 *   엉뚱한 조각 점수를 올려서(평가 #16) 단어 안에서만 묶도록 바꿨어요.
 * - 영문·숫자: 단어 그대로 (P1, VPN, 2580 …)
 */
export function tokenize(text) {
  const s = String(text).toLowerCase().replace(/([가-힣])[ \t]*\n\s*(?=[가-힣])/g, "$1");
  const tokens = [];
  for (const word of s.replace(/[^가-힣]+/g, " ").split(" ")) {
    if (word.length === 1) tokens.push(word);
    for (let i = 0; i + 1 < word.length; i++) tokens.push(word.slice(i, i + 2));
  }
  for (const w of s.match(/[a-z0-9]+/g) || []) tokens.push(w);
  return tokens;
}

// ===== [검색: 키워드 점수(BM25)] =====
/** BM25: 질문 낱말이 조각에 많이, 그리고 드문 낱말일수록 점수가 높음 */
export function bm25Rank(query, chunks, k1 = 1.2, b = 0.75) {
  const docs = chunks.map((c) => tokenize(searchText(c)));
  const N = docs.length;
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / Math.max(N, 1);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const qTokens = [...new Set(tokenize(query))];
  return docs
    .map((d, i) => {
      const tf = new Map();
      for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
      let score = 0;
      for (const t of qTokens) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avgLen)));
      }
      return { i, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

// ===== [검색할 글 만들기] =====
// 검색에 쓰는 글: 문서 제목 + 조항 제목 + 본문 (제목에만 있는 낱말로도 찾을 수 있게)
export const searchText = (c) => `${c.doc_title || ""}\n${c.section || ""}\n${c.text}`;

// ---------- 뜻 검색 ----------

// ===== [검색: 뜻 비슷한 정도(코사인)] =====
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ===== [검색: 뜻 순위] =====
export function vectorRank(queryVec, chunks) {
  return chunks
    .map((c, i) => ({ i, score: c.embedding ? cosine(queryVec, c.embedding) : -1 }))
    .filter((r) => r.score > -1)
    .sort((a, b) => b.score - a.score);
}

// ===== [임베딩] 글 → 숫자 (Cloudflare Workers AI) =====
// 여기가 고장 나면 문서 올리기와 뜻 검색이 같이 안 돼요
/** Workers AI로 글 여러 개를 한 번에 벡터로 바꿔요 */
export async function embed(ai, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const res = await ai.run(EMBED_MODEL, { text: texts.slice(i, i + 50) });
    out.push(...res.data);
  }
  return out;
}

// ---------- 섞기 ----------

// ===== [검색: 두 순위 섞기(RRF)] =====
/** RRF: 각 순위표에서 1/(60+순위)를 더함. 점수 단위가 다른 두 검색을 공평하게 합치는 흔한 방법 */
export function rrf(rankings, k = 60) {
  const score = new Map();
  for (const ranking of rankings) {
    ranking.forEach((r, rank) => score.set(r.i, (score.get(r.i) || 0) + 1 / (k + rank + 1)));
  }
  return [...score.entries()].map(([i, s]) => ({ i, score: s })).sort((a, b) => b.score - a.score);
}

// ===== [검색] 규정 조각 찾기 (키워드+뜻 섞어 찾기) =====
/**
 * @param mode  "keyword" | "vector" | "hybrid"
 * @returns     상위 topK 조각 (점수 포함)
 */
export async function search({ ai, query, chunks, mode = "hybrid", topK = 5 }) {
  let ranked;
  if (mode === "keyword") ranked = bm25Rank(query, chunks);
  else {
    const [qVec] = await embed(ai, [query]);
    const vec = vectorRank(qVec, chunks);
    ranked = mode === "vector" ? vec : rrf([bm25Rank(query, chunks), vec]);
  }
  return ranked.slice(0, topK).map((r) => ({ ...chunks[r.i], score: r.score }));
}
