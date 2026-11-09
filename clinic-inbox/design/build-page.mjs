// 시안 화면(index.html) 만들기: template.html에 예시 데이터와 core.js의 가리기 코드를 넣어요
// 실행: node design/build-page.mjs
import fs from "node:fs";
const tpl = fs.readFileSync("design/template.html", "utf8");
const data = fs.readFileSync("design/data.js", "utf8");
const core = fs.readFileSync("core.js", "utf8");
const a = core.indexOf("// ===== [개인정보 가리기] =====");
const b = core.indexOf("// ===== [AI 지시문] =====");
const maskCode = "// core.js에서 그대로 가져온 가리기 코드 (실제 버전과 같음)\n" + core.slice(a, b).trim();
fs.writeFileSync("index.html", tpl.replace("/*DATA*/", data.trim()).replace("/*MASK*/", maskCode));
console.log("index.html 만듦");
