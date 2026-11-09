"""경비 검수 에이전트 평가

  python eval/run.py                 24건 전부 (건당 약 100원)
  python eval/run.py --ids 1,10,24   일부만
  python eval/run.py --base https://expense-agent.<계정>.workers.dev   (ADMIN_TOKEN 환경변수 필요)

채점(규칙, AI 비용 0원)
  1) 판정이 정답과 같은가 (승인 가능 / 보완 필요 / 규정 위반)
  2) 정답 조항을 근거로 짚었나 (예: 경비 처리 규정 제5조)
  3) 승인 가능인데 쓸데없는 문제를 지적하지 않았나
  4) 알림: 문제가 있을 때만 Slack으로 알렸나
테스트 모드로 돌려서 구글 시트·Slack은 실제로 보내지 않아요 (DB에는 source='eval'로 남음).
"""

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).parent

p = argparse.ArgumentParser()
p.add_argument("--base", default="http://localhost:8790")
p.add_argument("--ids", default=None)
p.add_argument("--workers", type=int, default=3)
args = p.parse_args()

token = os.environ.get("ADMIN_TOKEN")
if not token:
    m = re.search(r"ADMIN_TOKEN=(\S+)", (HERE.parent / ".dev.vars").read_text())
    token = m.group(1) if m else None
cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
if args.ids:
    want = {int(x) for x in args.ids.split(",")}
    cases = [c for c in cases if c["id"] in want]


def call(case):
    req = urllib.request.Request(
        f"{args.base}/api/check",
        data=json.dumps({"text": case["text"], "test": True}).encode(),
        headers={"content-type": "application/json", "x-admin-token": token or "", "user-agent": "docs-qa-eval/1.0"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        out = json.load(e)
    out["_wall"] = time.time() - t0
    return out


def doc_hit(issue, doc_kw, article):
    return doc_kw in (issue.get("doc") or "") and article in (issue.get("section") or "")


def grade(case, r):
    g = {"id": case["id"], "title": case["title"], "expect": case["verdict"]}
    if "error" in r:
        g.update(error=r["error"], verdict_ok=False, rules_ok=False, no_extra=False, mail_ok=False)
        return g
    issues = r.get("issues", [])
    g["got"] = r["verdict"]
    g["verdict_ok"] = r["verdict"] == case["verdict"]
    g["rules_ok"] = all(any(doc_hit(i, d, a) for i in issues) for d, a in case["rules"])
    # 정답 조항이 아닌 곳을 문제 삼았나 (지나친 지적)
    expected = case["rules"]
    g["extra"] = [f"{i.get('doc')} {i.get('section')}: {i['problem']}" for i in issues if not any(doc_hit(i, d, a) for d, a in expected)]
    g["no_extra"] = not g["extra"]
    g["mail_ok"] = r.get("notified") == (case["verdict"] != "승인 가능")
    g["seconds"] = r.get("seconds")
    g["cost"] = r.get("cost_krw", 0)
    g["tools"] = [s["tool"] for s in r.get("steps", [])]
    g["issues"] = [f"[{i['kind']}] {i['problem']} ({i.get('doc')} {i.get('section')})" for i in issues]
    return g


print(f"평가 {len(cases)}건 · 서버 {args.base}\n")
with ThreadPoolExecutor(args.workers) as ex:
    results = list(ex.map(lambda c: (c, call(c)), cases))
rows = [grade(c, r) for c, r in results]
for g in rows:
    mark = "O" if g["verdict_ok"] and g["rules_ok"] and g["mail_ok"] else "X"
    print(f"{mark} #{g['id']} {g['title']}: 정답 {g['expect']} / 에이전트 {g.get('got', '오류')}")
    for line in g.get("issues", []):
        print(f"     {line}")
    if g.get("error"):
        print(f"     오류: {g['error']}")

n = len(rows)
ok = [g for g in rows if "error" not in g]


def pct(k):
    c = sum(1 for g in rows if g.get(k))
    return f"{c}/{n} ({round(100 * c / n)}%)"


all_ok = sum(1 for g in rows if g["verdict_ok"] and g["rules_ok"] and g["mail_ok"])
secs = [g["seconds"] for g in ok if g.get("seconds")]
cost = sum(g.get("cost", 0) for g in ok)
tool_counts = [len(g["tools"]) for g in ok]
print("\n## 결과\n")
print("| 항목 | 결과 |")
print("|---|---|")
print(f"| 판정이 맞음 | {pct('verdict_ok')} |")
print(f"| 정답 조항을 근거로 짚음 | {pct('rules_ok')} |")
print(f"| 쓸데없는 지적 없음 | {pct('no_extra')} |")
print(f"| 알림을 맞게 보냄 (문제 있을 때만) | {pct('mail_ok')} |")
print(f"| 세 가지(판정·조항·알림) 모두 맞음 | {all_ok}/{n} ({round(100 * all_ok / n)}%) |")
if secs:
    print(f"| 한 건 평균 시간 | {sum(secs) / len(secs):.1f}초 (가장 오래 {max(secs):.0f}초) |")
    print(f"| 한 건 평균 도구 사용 | {sum(tool_counts) / len(tool_counts):.1f}번 |")
    print(f"| 비용 | 약 {round(cost):,}원 (건당 약 {round(cost / len(ok))}원) |")

wrong = [g for g in rows if not (g["verdict_ok"] and g["rules_ok"] and g["mail_ok"]) or g["extra"]]
if wrong:
    print("\n확인할 것:")
    for g in wrong:
        why = []
        if not g["verdict_ok"]:
            why.append(f"판정 {g.get('got')} (정답 {g['expect']})")
        if not g["rules_ok"]:
            why.append("정답 조항 못 짚음")
        if not g["mail_ok"]:
            why.append("알림 판단 틀림")
        if g.get("extra"):
            why.append("추가 지적: " + " | ".join(g["extra"]))
        print(f"  #{g['id']} {g['title']}: " + "; ".join(why))

out = HERE / "results"
out.mkdir(exist_ok=True)
f = out / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
f.write_text(json.dumps([{"grade": g, "raw": r} for g, (_, r) in zip(rows, results)], ensure_ascii=False, indent=1), encoding="utf-8")
print(f"\n저장: {f.relative_to(HERE.parent)}")
