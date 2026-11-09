"""Claude API 호출

Claude 공식 Python 라이브러리(anthropic)는 압축해도 3.4MB라서 Cloudflare 무료 요금제의 3MB 한도를 넘어요.
그래서 그 라이브러리가 안에서 쓰는 httpx로 Messages API를 직접 불러요 (압축 164KB).
"""

import asyncio

import httpx

# ===== [설정값] 주소·모델·가격 =====
API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-opus-5-5"

# 비용 계산용: Opus 5.5 가격(1백만 토큰당 달러)과 대략적인 환율
PRICE_IN, PRICE_OUT, PRICE_CACHE_READ, PRICE_CACHE_WRITE = 4.0, 20.0, 0.20, 5.0
KRW_PER_USD = 1400


# ===== [오류 처리] Claude 호출 실패 표시 =====
class ClaudeError(Exception):
    pass


# ===== [Claude 부르기] =====
async def create_message(api_key: str, body: dict) -> dict:
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2026-10-21",
        # 안전 필터가 거절하면 서버에서 다른 모델로 자동으로 다시 시도
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "content-type": "application/json",
    }
    payload = {"model": MODEL, "fallbacks": "default", **body}
    async with httpx.AsyncClient(timeout=120) as client:
        # ===== [다시 시도] 바쁠 때 최대 3번 =====
        for attempt in range(3):
            r = await client.post(API_URL, headers=headers, json=payload)
            # 429(너무 많은 요청)·5xx(서버 문제)는 잠깐 쉬었다가 다시 시도
            if r.status_code in (429, 500, 502, 503, 529) and attempt < 2:
                await asyncio.sleep(2 * (attempt + 1))
                continue
            break
    # ===== [오류 처리] 실패 응답이면 멈추기 =====
    if r.status_code != 200:
        raise ClaudeError(f"{r.status_code} {r.text[:300]}")
    return r.json()


# ===== [비용 계산] =====
def cost_krw(usage: dict) -> float:
    usd = (
        usage.get("input_tokens", 0) * PRICE_IN
        + usage.get("output_tokens", 0) * PRICE_OUT
        + usage.get("cache_read_input_tokens", 0) * PRICE_CACHE_READ
        + usage.get("cache_creation_input_tokens", 0) * PRICE_CACHE_WRITE
    ) / 1e6
    return usd * KRW_PER_USD
