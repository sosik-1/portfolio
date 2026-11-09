"""에이전트가 쓰는 도구들

Claude가 "무엇을 할지"를 고르고, 실제 일(검색·계산·DB 조회·기록·Slack 알림)은 이 코드가 해요.
- 계산(요일, 금액)은 AI가 암산하지 않고 코드로 정확하게
- 알림 받는 Slack 채널, DB에 쓰는 표는 코드가 고정 (문서 안에 "다른 곳으로 보내라"고 써 있어도 바꿀 수 없음)
"""

import datetime as dt
import json
import re

import httpx

# ===== [설정값] 판정·종류·공휴일 =====
VERDICTS = ["승인 가능", "보완 필요", "규정 위반"]
CATEGORIES = ["교통비", "식대", "회식비", "출장비", "접대비", "교육비", "구매", "기타"]

# 2026년 하반기 공휴일 일부 (시연용. 실제로는 공휴일 API나 회사 달력을 씀)
HOLIDAYS = {
    "2026-08-15": "광복절", "2026-08-17": "광복절 대체공휴일",
    "2026-09-24": "추석 연휴", "2026-09-25": "추석", "2026-09-26": "추석 연휴",
    "2026-10-03": "개천절", "2026-10-05": "개천절 대체공휴일", "2026-10-09": "한글날",
    "2026-12-25": "성탄절",
}
WEEKDAYS = "월화수목금토일"


def _nullable(t):
    return {"type": [t, "null"]}


# ===== [도구 설명서] Claude에게 보여주는 도구 목록 =====
TOOLS = [
    {
        "name": "search_rules",
        "description": "회사 규정·매뉴얼(경비 처리 규정, 구매·견적 규정, 휴가 규정, 정보보안 수칙 등)에서 관련 조항을 찾는다. "
        "검사할 항목마다 따로 검색한다(예: '택시 이용 조건', '야근 식대 한도', '견적 몇 곳 받아야 하나'). 결과는 조각 번호(chunk_id)와 원문.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string", "description": "찾을 내용 (짧은 한국어 문장)"}},
            "required": ["query"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "name": "date_facts",
        "description": "날짜의 요일, 주말·공휴일 여부, 기준 날짜와의 차이(일)를 정확히 계산한다. 요일을 짐작하지 말고 이 도구를 쓴다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "dates": {"type": "array", "items": {"type": "string"}, "description": "YYYY-MM-DD 형식 날짜들"},
                "base_date": {**_nullable("string"), "description": "차이를 잴 기준 날짜(보통 제출일). 없으면 null"},
            },
            "required": ["dates", "base_date"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "name": "check_quote_math",
        "description": "견적서 금액을 계산해 확인한다: 품목별 수량×단가=금액, 공급가액=품목 금액 합, 부가세=공급가액의 10%(원 단위 이하 버림), 합계=공급가액+부가세. 견적서에 적힌 숫자를 그대로 넣는다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "quantity": {"type": "integer"},
                            "unit_price": {"type": "integer"},
                            "amount": {"type": "integer"},
                        },
                        "required": ["name", "quantity", "unit_price", "amount"],
                        "additionalProperties": False,
                    },
                },
                "supply_amount": _nullable("integer"),
                "vat": _nullable("integer"),
                "total": _nullable("integer"),
            },
            "required": ["items", "supply_amount", "vat", "total"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "name": "lookup_past_claims",
        "description": "회계 시스템의 과거 승인 내역을 조회한다. 같은 거래처 접대 횟수, 같은 업체에서 같은 물품을 산 횟수, 팀의 분기 회식비 사용액처럼 "
        "'이번 달/분기에 몇 번·얼마'를 따지는 규정이 있을 때 쓴다. 조건이 없으면 null.",
        "input_schema": {
            "type": "object",
            "properties": {
                "vendor": _nullable("string"),
                "item": _nullable("string"),
                "employee": _nullable("string"),
                "team": _nullable("string"),
                "category": {**_nullable("string"), "description": "교통비·식대·회식비·출장비·접대비·교육비·구매·기타 중 하나"},
                "date_from": {"type": "string", "description": "YYYY-MM-DD (이 날 포함)"},
                "date_to": {"type": "string", "description": "YYYY-MM-DD (이 날 포함)"},
            },
            "required": ["vendor", "item", "employee", "team", "category", "date_from", "date_to"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "name": "record_result",
        "description": "검수를 마치면 결과를 한 번만 기록한다(DB와 구글 시트). issues의 quote에는 search_rules 결과 원문에서 근거 문장을 한 글자도 바꾸지 않고 복사한다. "
        "문제가 없으면 verdict='승인 가능', issues=[].",
        "input_schema": {
            "type": "object",
            "properties": {
                "doc_type": {"type": "string", "enum": ["경비 청구", "견적서"]},
                "verdict": {"type": "string", "enum": VERDICTS},
                "employee": _nullable("string"),
                "team": _nullable("string"),
                "category": {"type": "string", "enum": CATEGORIES},
                "vendor": _nullable("string"),
                "amount": _nullable("integer"),
                "summary": {"type": "string", "description": "담당자가 목록에서 볼 한두 문장 요약"},
                "issues": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "problem": {"type": "string", "description": "무엇이 문제인지 (숫자 포함)"},
                            "kind": {"type": "string", "enum": ["규정 위반", "보완 필요"]},
                            "chunk_id": {"type": "integer"},
                            "quote": {"type": "string"},
                            "fix": {"type": "string", "description": "청구자가 할 일"},
                        },
                        "required": ["problem", "kind", "chunk_id", "quote", "fix"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["doc_type", "verdict", "employee", "team", "category", "vendor", "amount", "summary", "issues"],
            "additionalProperties": False,
        },
        "strict": True,
    },
    {
        "name": "notify_manager",
        "description": "검수 결과가 '보완 필요' 또는 '규정 위반'이면 record_result 다음에 재무팀 담당자에게 Slack 채널로 알린다. 받는 채널은 시스템이 정한다. '승인 가능'이면 보내지 않는다.",
        "input_schema": {
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "message": {"type": "string", "description": "청구자·금액·문제·근거 조항·할 일을 담은 짧은 본문"},
            },
            "required": ["subject", "message"],
            "additionalProperties": False,
        },
        "strict": True,
    },
]


# ===== [근거 문장 대조: 비교 준비] =====
def norm(s: str) -> str:
    """띄어쓰기·줄바꿈·일부 문장부호 차이는 무시하고 비교 (docs-qa의 근거 확인과 같은 규칙)"""
    return re.sub(r"[\s\"'“”‘’`*|·•]", "", str(s)).lower()


# ===== [도구 상자] 한 번의 검수 동안 쓰는 것들 =====
class Toolbox:
    """한 번의 검수 동안 쓰는 도구 묶음. 찾은 조각·기록 결과를 기억해요."""

    def __init__(self, db, search_api, sheet_url: str | None, sheet_secret: str | None, test: bool, source: str, site_url: str = "", slack_url: str | None = None):
        self.db = db
        self.site_url = site_url.rstrip("/")  # 상세 보기 링크를 만들 때 써요
        self.search_api = search_api  # async (body: dict) -> dict : docs-qa 검색 API를 부르는 함수
        self.sheet_url = sheet_url
        self.sheet_secret = sheet_secret
        self.slack_url = slack_url  # 재무팀 Slack 채널 웹훅 (비밀값, 코드에서 고정)
        self.test = test  # 평가용: 시트·Slack은 보내지 않고 보낸 척만
        self.source = source
        self.chunks: dict[int, dict] = {}
        self.result: dict | None = None
        self.check_id: int | None = None
        self.notified = False
        self.mail: dict | None = None

    # ===== [도구 고르기] 이름으로 도구 찾아 실행 =====
    async def run(self, name: str, args: dict):
        fn = getattr(self, f"t_{name}", None)
        if not fn:
            return {"error": f"없는 도구: {name}"}
        return await fn(**args)

    # ===== [도구: 규정 찾기] =====
    # ---------- 1. 규정 찾기 (docs-qa 검색 API 연동) ----------
    async def t_search_rules(self, query: str):
        data = await self.search_api({"q": query, "mode": "hybrid"})
        if "hits" not in data:
            return {"error": f"규정 검색 실패: {data.get('error', '응답 없음')}"}
        hits = data["hits"]
        out = []
        for h in hits[:4]:
            self.chunks[h["id"]] = h
            out.append({"chunk_id": h["id"], "doc": h["doc_title"], "section": h.get("section"), "text": h["text"]})
        return out

    # ===== [도구: 날짜 계산] =====
    # ---------- 2. 날짜 계산 ----------
    async def t_date_facts(self, dates: list, base_date=None):
        base = _date(base_date) if base_date else None
        out = []
        for s in dates:
            d = _date(s)
            if not d:
                out.append({"date": s, "error": "YYYY-MM-DD 형식이 아니에요"})
                continue
            item = {
                "date": d.isoformat(),
                "weekday": WEEKDAYS[d.weekday()] + "요일",
                "is_weekend": d.weekday() >= 5,
                "holiday": HOLIDAYS.get(d.isoformat()),
            }
            if base:
                item["days_before_base"] = (base - d).days
            out.append(item)
        return out

    # ===== [도구: 금액 계산] =====
    # ---------- 3. 견적 금액 계산 ----------
    async def t_check_quote_math(self, items: list, supply_amount=None, vat=None, total=None):
        problems = []
        line_sum = 0
        for it in items:
            expect = it["quantity"] * it["unit_price"]
            line_sum += it["amount"]
            if expect != it["amount"]:
                problems.append(f"{it['name']}: {it['quantity']} × {it['unit_price']:,} = {expect:,}원인데 {it['amount']:,}원으로 적혀 있음")
        supply = supply_amount if supply_amount is not None else line_sum
        if supply_amount is not None and supply_amount != line_sum:
            problems.append(f"공급가액 {supply_amount:,}원 ≠ 품목 금액 합 {line_sum:,}원")
        vat_expect = supply * 10 // 100
        if vat is not None and vat != vat_expect:
            problems.append(f"부가세 {vat:,}원 ≠ 공급가액의 10% {vat_expect:,}원")
        total_expect = supply + (vat if vat is not None else vat_expect)
        if total is not None and total != total_expect:
            problems.append(f"합계 {total:,}원 ≠ 공급가액+부가세 {total_expect:,}원")
        return {
            "ok": not problems,
            "problems": problems,
            "computed": {"line_sum": line_sum, "vat_10pct": vat_expect, "total": supply + vat_expect},
            "missing": [k for k, v in {"공급가액": supply_amount, "부가세": vat, "합계": total}.items() if v is None],
        }

    # ===== [도구: 과거 내역(SQL)] =====
    # ---------- 4. 과거 승인 내역 (SQL) ----------
    async def t_lookup_past_claims(self, vendor=None, item=None, employee=None, team=None, category=None, date_from="", date_to=""):
        where, params = ["spent_on BETWEEN ? AND ?"], [date_from, date_to]
        # 조건은 정해진 칸만 쓰고, 값은 ? 자리에 넣어서(SQL 주입 방지) 조회해요
        for col, val in (("vendor", vendor), ("item", item), ("employee", employee), ("team", team), ("category", category)):
            if val:
                where.append(f"{col} = ?")
                params.append(val)
        cond = " AND ".join(where)
        rows = await self.db.all(
            f"SELECT employee, team, category, vendor, item, amount, spent_on FROM past_claims WHERE {cond} ORDER BY spent_on LIMIT 20", params
        )
        agg = await self.db.first(f"SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM past_claims WHERE {cond}", params)
        return {"count": agg["count"], "total_amount": agg["total"], "rows": rows}

    # ===== [도구: 기록(DB·시트)] =====
    # ---------- 5. 결과 기록 (DB + 구글 시트) ----------
    async def t_record_result(self, **r):
        if self.result:
            return {"error": "이미 기록했어요. 한 번만 기록해요."}
        # ===== [근거 문장 대조] =====
        # 근거 확인: 인용한 문장이 그 조각 원문에 정말 있는지
        issues = []
        for i in r["issues"]:
            c = self.chunks.get(i["chunk_id"])
            ok = bool(c) and len(norm(i["quote"])) >= 4 and norm(i["quote"]) in norm(c["text"])
            issues.append({**i, "doc": c["doc_title"] if c else None, "section": c.get("section") if c else None, "verified": ok})
        if r["verdict"] != "승인 가능" and not issues:
            return {"error": "승인 가능이 아니면 issues에 문제를 하나 이상 적어야 해요."}
        unverified = [i["problem"] for i in issues if not i["verified"]]
        if unverified:
            # 근거가 원문과 안 맞으면 다시 쓰게 해요 (지어낸 근거 막기)
            return {"error": "다음 문제의 quote가 search_rules 원문과 일치하지 않아요. 원문을 그대로 복사해서 다시 기록하세요: " + " / ".join(unverified)}
        self.result = {**r, "issues": issues}
        row = await self.db.first(
            """INSERT INTO checks (source, doc_type, employee, team, category, vendor, amount, verdict, summary, issues)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id""",
            [self.source, r["doc_type"], r["employee"], r["team"], r["category"], r["vendor"], r["amount"], r["verdict"], r["summary"],
             json.dumps(issues, ensure_ascii=False)],
        )
        self.check_id = row["id"]
        sheet = await self._sheet({"action": "append", "row": {"id": self.check_id, **self.result,
                                   "detail_url": f"{self.site_url}/?id={self.check_id}",
                                   "issues": " / ".join(f"{i['problem']} ({i['doc']} {i['section']})" for i in issues)}})
        if sheet == "ok":
            await self.db.run("UPDATE checks SET sheet_ok = 1 WHERE id = ?", [self.check_id])
        return {"saved_id": self.check_id, "google_sheet": sheet}

    # ===== [도구: Slack 알림] =====
    # ---------- 6. 담당자 알림 (Slack) ----------
    async def t_notify_manager(self, subject: str, message: str):
        if not self.result:
            return {"error": "record_result를 먼저 해야 해요."}
        if self.result["verdict"] == "승인 가능":
            return {"error": "승인 가능은 알리지 않아요."}
        if self.notified:
            return {"error": "이미 보냈어요."}
        # mail 칸 이름은 예전(Gmail) 그대로 써요: DB·화면이 이 이름으로 읽어요
        self.mail = {"subject": subject[:120], "message": message[:2000]}
        sent = await self._slack(slack_blocks(self.check_id, self.result, self.mail, self.site_url))
        self.notified = True  # 에이전트가 알리기로 판단함 (평가는 이걸 채점)
        if sent == "ok":  # 실제로 Slack에 올라갔을 때만 기록 표에 '보냄'
            await self.db.run("UPDATE checks SET notified = 1 WHERE id = ?", [self.check_id])
        return {"slack": sent}

    # ===== [Slack 보내기] =====
    async def _slack(self, payload: dict) -> str:
        """Slack Incoming Webhook으로 보내요. 주소가 없거나 평가 중이면 보내지 않아요."""
        if self.test:
            return "테스트 모드라 보내지 않음"
        if not self.slack_url:
            return "Slack 주소가 설정되지 않아 DB에만 기록"
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                r = await c.post(self.slack_url, json=payload)
            return "ok" if r.status_code == 200 and r.text.strip() == "ok" else f"실패 ({r.status_code}): {r.text[:80]}"
        except Exception as e:  # Slack이 안 돼도 검수 결과는 DB·시트에 남아요
            return f"실패: {type(e).__name__}"

    # ===== [구글 시트 보내기] =====
    async def _sheet(self, payload: dict) -> str:
        """구글 Apps Script 웹 앱으로 보내요 (시트 기록). 주소가 없거나 평가 중이면 보내지 않아요."""
        if self.test:
            return "테스트 모드라 보내지 않음"
        if not self.sheet_url:
            return "구글 시트 주소가 설정되지 않아 DB에만 기록"
        try:
            async with httpx.AsyncClient(timeout=30, follow_redirects=True) as c:
                r = await c.post(self.sheet_url, json={"secret": self.sheet_secret, **payload})
            return "ok" if '"ok":true' in r.text.replace(" ", "") else f"실패: {r.text[:100]}"
        except Exception as e:  # 시트가 안 돼도 검수 결과는 DB에 남아요
            return f"실패: {e}"


# ===== [Slack 메시지 모양] =====
VERDICT_ICON = {"승인 가능": "🟢", "보완 필요": "🟡", "규정 위반": "🔴"}


def slack_blocks(check_id, r: dict, mail: dict, site_url: str) -> dict:
    """Slack Block Kit 메시지: 판정·청구자·금액·문제와 근거 조항·검수 기록 버튼"""
    amount = f"{r['amount']:,}원" if isinstance(r.get("amount"), int) else "-"
    who = " · ".join(x for x in (r.get("team"), r.get("employee")) if x) or "-"
    issues = "\n".join(
        f"• {i['problem']}\n      근거: _{i.get('doc') or ''} {i.get('section') or ''}_ “{i['quote'][:120]}”"
        for i in r["issues"][:4]
    ) or "-"
    detail = f"{site_url}/?id={check_id}"
    blocks = [
        {"type": "header", "text": {"type": "plain_text", "text": f"{VERDICT_ICON.get(r['verdict'], '')} {r['verdict']} · 검수 #{check_id}"[:150]}},
        {"type": "section", "fields": [
            {"type": "mrkdwn", "text": f"*종류*\n{r.get('doc_type', '')} · {r.get('category') or '-'}"},
            {"type": "mrkdwn", "text": f"*금액*\n{amount}"},
            {"type": "mrkdwn", "text": f"*청구자*\n{who}"},
            {"type": "mrkdwn", "text": f"*거래처*\n{r.get('vendor') or '-'}"},
        ]},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*{mail['subject']}*\n{r['summary'][:600]}"}},
        {"type": "section", "text": {"type": "mrkdwn", "text": f"*문제와 근거 조항*\n{issues}"[:2900]}},
        {"type": "actions", "elements": [
            {"type": "button", "text": {"type": "plain_text", "text": "검수 기록 보기"}, "url": detail, "style": "primary"},
        ]},
        {"type": "context", "elements": [{"type": "mrkdwn", "text": "경비·견적 검수 에이전트가 자동으로 보낸 알림이에요. 근거 문장은 규정 원문과 대조를 마쳤어요."}]},
    ]
    return {"text": f"{r['verdict']} · 검수 #{check_id} · {mail['subject']}", "blocks": blocks}


# ===== [날짜 읽기] =====
def _date(s):
    try:
        return dt.date.fromisoformat(str(s)[:10])
    except ValueError:
        return None
