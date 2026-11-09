"""경비 검수 에이전트 서버 (Cloudflare Python Worker)
  화면(/)과 예시 문서(/samples.json)는 public 폴더에서 Cloudflare가 바로 보내요
  POST /api/check        검수하기 (에이전트 실행)
  GET  /api/checks       최근 검수 기록
  GET  /api/report       SQL 집계 (판정별·종류별·자주 걸리는 규정)
"""

import datetime as dt
import json
import re
from urllib.parse import parse_qs, urlparse

import httpx
from workers import Response, WorkerEntrypoint

from agent import check_document
from tools import Toolbox

try:  # D1에 None을 넘기면 undefined가 되어 거절돼요. JS null로 바꿔서 넘겨요.
    from pyodide.ffi import jsnull
except ImportError:  # 오래된 런타임
    from js import JSON as _JSON
    jsnull = _JSON.parse("null")

# ===== [설정값] 하루 검수 한도 =====
MAX_CHECKS_PER_DAY = 50  # 공개 사이트 하루 검수 한도 (한 건에 약 100원 안팎)


# ===== [저장(DB)] D1 쓰기 도우미 =====
class DB:
    """D1(SQLite)을 파이썬에서 쓰기 편하게 감싼 것"""

    def __init__(self, d1):
        self.d1 = d1

    def _stmt(self, sql, params):
        return self.d1.prepare(sql).bind(*[jsnull if p is None else p for p in params])

    async def all(self, sql, params=()):
        res = await self._stmt(sql, params).all()
        rows = res.results
        if hasattr(rows, "to_py"):  # 런타임에 따라 JS 배열 또는 이미 파이썬 목록으로 와요
            rows = rows.to_py()
        return [dict(r) for r in rows]

    async def first(self, sql, params=()):
        rows = await self.all(sql, params)
        return rows[0] if rows else None

    async def run(self, sql, params=()):
        await self._stmt(sql, params).run()


# ===== [비밀값 읽기] API 키·웹훅 주소 =====
def secret(env, name):
    """비밀값 읽기. 붙여 넣을 때 섞인 앞뒤 공백·BOM(눈에 안 보이는 U+FEFF 글자)을 떼요."""
    v = getattr(env, name, None)
    return str(v).strip().lstrip("\ufeff").strip() if v is not None else None


# ===== [오류 처리: 로그에서 키 가리기] =====
def redact(text: str) -> str:
    """로그에 API 키 같은 비밀값이 찍히지 않게 가려요"""
    return re.sub(r"sk-ant-[A-Za-z0-9_\-]+", "sk-ant-***", text)[:500]


# ===== [응답 만들기] =====
def json_response(data, status=200):
    return Response(json.dumps(data, ensure_ascii=False), status=status, headers={"content-type": "application/json; charset=utf-8"})


# ===== [주소 나누기] 어떤 주소로 오면 어떤 일을 할지 =====
class Default(WorkerEntrypoint):
    async def fetch(self, request):
        path = urlparse(request.url).path
        try:
            db = DB(self.env.DB)
            if path == "/api/check" and request.method == "POST":
                return await self.check(request, db)
            # ===== [검수 기록 한 건 보기] /api/checks/번호 =====
            m = re.fullmatch(r"/api/checks/(\d+)", path)
            if m:  # 검수 한 건 상세 (시트의 '상세 보기' 링크가 여는 화면)
                row = await db.first(
                    "SELECT id, created_at, doc_type, employee, team, category, vendor, amount, verdict, summary, issues, notified, sheet_ok, "
                    "tool_calls, seconds, cost_krw, steps, message, mail FROM checks WHERE id = ? AND source = 'web'",
                    [int(m.group(1))],
                )
                if not row:
                    return json_response({"error": "없는 기록이에요"}, 404)
                for k in ("issues", "steps", "mail"):
                    row[k] = json.loads(row[k]) if row.get(k) else ([] if k != "mail" else None)
                return json_response(row)
            # ===== [최근 검수 기록] /api/checks =====
            if path == "/api/checks":
                rows = await db.all(
                    "SELECT id, created_at, doc_type, employee, team, category, vendor, amount, verdict, summary, notified, sheet_ok, tool_calls, seconds, cost_krw "
                    "FROM checks WHERE source = 'web' ORDER BY id DESC LIMIT 30"
                )
                return json_response({"checks": rows})
            # ===== [연결 확인: 규정 검색] /api/rules =====
            if path == "/api/rules" and request.method == "GET":  # 규정 검색 연결 확인용 (AI 비용 0원)
                q = parse_qs(urlparse(request.url).query).get("q", [""])[0]
                return json_response(await self.search_api({"q": q, "mode": "hybrid"}))
            # ===== [연결 확인: 구글 시트] 관리자용 =====
            if path == "/api/sheet-ping" and request.method == "GET":  # 관리자용: 시트 연결만 확인 (AI 비용 0원, 비밀값은 길이만 보여줌)
                if request.headers.get("x-admin-token") != secret(self.env, "ADMIN_TOKEN"):
                    return json_response({"error": "권한이 없어요"}, 403)
                raw = getattr(self.env, "SHEET_SECRET", None)
                sec = secret(self.env, "SHEET_SECRET") or ""
                url = secret(self.env, "SHEET_WEBHOOK_URL") or ""
                async with httpx.AsyncClient(timeout=30, follow_redirects=True) as c:
                    r = await c.post(url, json={"secret": sec, "action": "ping"})
                return json_response({
                    "sheet_answer": r.text[:120],  # unknown action = 비밀값 맞음, unauthorized = 다름
                    "secret_length": len(sec),
                    "raw_length": len(str(raw)) if raw is not None else 0,
                    "url_looks_ok": url.startswith("https://script.google.com/macros/s/") and url.endswith("/exec"),
                })
            # ===== [연결 확인: Slack] 관리자용 =====
            if path == "/api/slack-ping" and request.method == "POST":  # 관리자용: Slack 연결만 확인 (AI 비용 0원)
                if request.headers.get("x-admin-token") != secret(self.env, "ADMIN_TOKEN"):
                    return json_response({"error": "권한이 없어요"}, 403)
                url = secret(self.env, "SLACK_WEBHOOK_URL") or ""
                async with httpx.AsyncClient(timeout=20) as c:
                    r = await c.post(url, json={"text": "검수 에이전트 연결 확인 메시지예요 (AI 호출 없음)"})
                return json_response({"slack_answer": r.text[:80], "status": r.status_code,
                                      "url_looks_ok": url.startswith("https://hooks.slack.com/services/")})
            if path == "/api/report":
                return json_response(await report(db))
            return json_response({"error": "없는 주소예요"}, 404)
        # ===== [오류 처리] 예상 못 한 오류 → '서버 오류가 났어요' =====
        except Exception as e:
            # 오류 내용에 키·비밀값이 섞여 나올 수 있어서 가리고 남겨요
            print("서버 오류:", redact(f"{type(e).__name__}: {e}"))
            return json_response({"error": "서버 오류가 났어요"}, 500)

    # ===== [검수 받기] 글·사진 확인, 하루 한도 확인 =====
    async def check(self, request, db):
        body = await request.json()
        text = str(body.get("text") or "").strip()[:6000]
        image = body.get("image")
        if not text and not image:
            return json_response({"error": "청구서 내용을 붙여 넣거나 사진을 올려 주세요"}, 400)
        if image and (image.get("media_type") not in ("image/jpeg", "image/png", "image/webp") or len(image.get("data", "")) > 7_000_000):
            return json_response({"error": "사진은 5MB 이하 JPG·PNG·WEBP만 돼요"}, 400)

        admin = secret(self.env, "ADMIN_TOKEN")
        is_admin = bool(admin) and request.headers.get("x-admin-token") == admin
        test = bool(body.get("test")) and is_admin  # 평가: 시트·Slack은 보내지 않음
        if not is_admin:
            today = (dt.datetime.utcnow() + dt.timedelta(hours=9)).strftime("%Y-%m-%d")
            n = await db.first("SELECT COUNT(*) AS n FROM checks WHERE source = 'web' AND date(created_at, '+9 hours') = ?", [today])
            if n["n"] >= MAX_CHECKS_PER_DAY:
                return json_response({"error": "오늘 검수 한도를 다 썼어요. 내일 다시 써 주세요."}, 429)

        # ===== [도구 준비 → 에이전트 실행] =====
        toolbox = Toolbox(
            db,
            search_api=self.search_api,
            sheet_url=secret(self.env, "SHEET_WEBHOOK_URL"),
            sheet_secret=secret(self.env, "SHEET_SECRET"),
            test=test,
            source="eval" if test else "web",
            site_url=f"{urlparse(request.url).scheme}://{urlparse(request.url).netloc}",
            slack_url=secret(self.env, "SLACK_WEBHOOK_URL"),
        )
        result = await check_document(secret(self.env, "ANTHROPIC_API_KEY"), toolbox, text, image)
        return json_response(result, 502 if "error" in result else 200)


    # ===== [도구: 규정 찾기 연결] docs-qa 검색 API 부르기 =====
    async def search_api(self, body: dict) -> dict:
        """docs-qa 검색 API 부르기.
        배포: 서비스 바인딩(DOCS_QA)으로 Worker끼리 내부 연결. 같은 계정의 workers.dev 주소끼리는 공개 주소로 부르면 막혀요.
        로컬: 서비스 바인딩이 없으면 DOCS_QA_URL(http://localhost:8788)로 직접."""
        binding = getattr(self.env, "DOCS_QA", None)
        if binding is not None:
            resp = await binding.fetch("https://docs-qa/api/search", method="POST", headers={"content-type": "application/json"}, body=json.dumps(body))
            text = await resp.text()
        else:
            async with httpx.AsyncClient(timeout=30) as c:
                text = (await c.post(f"{str(self.env.DOCS_QA_URL).rstrip('/')}/api/search", json=body)).text
        try:
            return json.loads(text)
        except ValueError:
            return {"error": f"검색 응답이 JSON이 아니에요: {text[:80]}"}


# ===== [보고서(SQL)] 판정별·종류별·자주 걸리는 조항 =====
async def report(db):
    """경영·재무 보고용 집계. 에이전트 검수 기록(checks)을 SQL로 묶어요."""
    base = "FROM checks WHERE source = 'web'"
    by_verdict = await db.all(f"SELECT verdict, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount {base} GROUP BY verdict ORDER BY n DESC")
    by_category = await db.all(
        f"""SELECT category, COUNT(*) AS n,
                   SUM(CASE WHEN verdict = '규정 위반' THEN 1 ELSE 0 END) AS violations,
                   SUM(CASE WHEN verdict = '보완 필요' THEN 1 ELSE 0 END) AS fixes
            {base} GROUP BY category ORDER BY n DESC"""
    )
    # 자주 걸리는 조항: issues(JSON 배열)를 펼쳐서 조항별로 셈
    top_rules = await db.all(
        """SELECT json_extract(j.value, '$.doc') AS doc, json_extract(j.value, '$.section') AS section, COUNT(*) AS n
             FROM checks c, json_each(c.issues) j
            WHERE c.source = 'web'
            GROUP BY doc, section ORDER BY n DESC LIMIT 5"""
    )
    totals = await db.first(f"SELECT COUNT(*) AS n, COALESCE(AVG(seconds), 0) AS avg_seconds, COALESCE(SUM(cost_krw), 0) AS cost {base}")
    return {"by_verdict": by_verdict, "by_category": by_category, "top_rules": top_rules, "totals": totals}
