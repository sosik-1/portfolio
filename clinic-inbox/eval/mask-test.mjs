// 개인정보 가리기 시험 (AI 안 씀, 0원): node eval/mask-test.mjs
import { core } from "./load-core.mjs";
const ROSTER = ["김서연", "박지훈", "최민재"];
const T = [
  { text: "안녕하세요 김서연입니다. 연락은 010-2847-3391로 주세요.", own: ["김서연"], gone: ["김서연", "2847", "3391"], has: ["[환자1]", "[연락처1]"] },
  { text: "서연이에요! 01028473391 로 문자 주세요", own: ["김서연"], gone: ["서연", "01028473391"], has: ["[환자1]", "[연락처1]"] },
  { text: "이하은 010 5521 8840 입니다", own: ["이하은"], gone: ["이하은", "5521"], has: ["[환자1]", "[연락처1]"] },
  { text: "번호 010.7712.0459 / 주민번호 920314-1234567", own: [], gone: ["7712", "920314", "1234567"], has: ["[연락처1]", "[주민번호]"] },
  { text: "주민번호 9203142234567 적어요", own: [], gone: ["9203142234567"], has: ["[주민번호]"] },
  { text: "집 전화 02-345-6789 또는 031 456 7890", own: [], gone: ["345-6789", "456 7890"], has: ["[연락처1]", "[연락처2]"] },
  { text: "답장은 minseo.j@example.com 으로", own: [], gone: ["minseo.j@example.com"], has: ["[이메일1]"] },
  { text: "인스타 @serin_o 로 DM 주세요", own: [], gone: ["@serin_o"], has: ["[계정1]"] },
  { text: "박지훈 보호자인데요, 지훈이가 수술 후 열이 나요. 010-1111-2222, 다시 010-1111-2222", own: ["박지훈"], gone: ["박지훈", "지훈", "1111"], has: ["[환자1]", "[연락처1]"], notHas: ["[연락처2]"] },
  { text: "최민재 님 소개로 왔어요", own: ["정유나"], gone: ["최민재"], has: ["[환자1]"] },
  { text: "11월 15일 오후 2시 예약, 2026-11-09에 결제했어요. 38.5도", own: [], gone: [], has: [], same: true },
];
let fail = 0;
for (const [i, t] of T.entries()) {
  const m = core.mask(t.text, t.own, ROSTER);
  const bad = [
    ...t.gone.filter((g) => m.masked.includes(g)).map((g) => `남음 "${g}"`),
    ...t.has.filter((h) => !m.masked.includes(h)).map((h) => `없음 ${h}`),
    ...(t.notHas || []).filter((h) => m.masked.includes(h)).map((h) => `있으면 안 됨 ${h}`),
    ...(t.same && m.masked !== t.text ? ["바뀌면 안 되는데 바뀜"] : []),
  ];
  const back = core.restore(m.masked, m.map);
  if (/\[(환자|연락처|이메일|계정)\d+\]/.test(back)) bad.push("되돌린 뒤 표시가 남음");
  if (bad.length) fail++;
  console.log(`${bad.length ? "x" : "."} ${i + 1}. ${m.masked}${bad.length ? "   ← " + bad.join(", ") : ""}`);
}
console.log(`\n가리기 시험 ${T.length - fail}/${T.length}`);
process.exit(fail ? 1 : 0);
