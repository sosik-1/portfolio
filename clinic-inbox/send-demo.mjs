// 시연: 네 채널에서 들어온 것처럼 예시 문의를 n8n에 보내요 (AI 비용 약 50원)
// 실행: node send-demo.mjs   (n8n이 켜져 있어야 함)
// 실제 운영에선 카카오 상담톡·인스타그램·네이버 톡톡·홈페이지 폼 연결이 이 모양으로 바꿔서 보내요.
const URL = "http://localhost:5680/webhook/clinic-inquiry";
const DEMO = [
  { channel: "카카오톡", name: "윤재희", phone: "010-3390-6612", text: "코 수술 3일째인데 콧속에서 피가 계속 나요. 거즈를 갈아도 멈추지 않아요." },
  { channel: "인스타 DM", name: "박지훈", phone: "", text: "코 수술 전후 사진 더 보내주실 수 있나요? 실제 사례 보고 정하고 싶어요." },
  { channel: "네이버 톡톡", name: "이하은", phone: "", text: "다음주 화요일 오후 2시에 리프팅 예약 잡고 싶어요. 이하은 010 5521 8840 입니다." },
  { channel: "홈페이지", name: "최민재", phone: "010-7712-0459", text: "지방흡입 받은 지 4일째인데 어젯밤부터 열이 38.5도까지 올라요. 최민재 / 주민번호 920314-1234567" },
  { channel: "카카오톡", name: "김서연", phone: "010-2847-3391", text: "안녕하세요 김서연입니다. 쌍꺼풀 수술 가격이 궁금해요. 부분절개랑 매몰 차이도 알려주세요." },
  { channel: "인스타 DM", name: "오세린", phone: "", text: "피부 레이저 이벤트 가격 아직 하나요? 친구랑 같이 가면 더 할인돼요?" },
];
const res = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ inquiries: DEMO }) });
const out = await res.json();
console.log(`받음 ${out.received}건 · 약 ${out.costKrw}원`);
for (const r of out.results) console.log(`${r.id}  ${r.urgency.padEnd(2)}  ${r.department.padEnd(6)}  ${r.procedure} · ${r.types.join("+")}${r.ad_risk !== "없음" ? " · 주의:" + r.ad_risk : ""}  ${r.summary}`);
console.log("상담실장 화면: http://localhost:5680/webhook/clinic-board");
