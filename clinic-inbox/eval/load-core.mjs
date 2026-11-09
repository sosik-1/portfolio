// core.js(평범한 스크립트)를 Node에서 읽어 함수들을 꺼내요. n8n Code 노드에 들어가는 글과 똑같은 파일이에요.
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "core.js");
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(file, "utf8") +
  "\n;({ MODEL, PROCEDURES, TYPES, URGENCIES, AD_RISKS, mask, restore, buildRequest, parseResponse, safetyNet, departmentOf })", ctx);
export const core = vm.runInContext("({ MODEL, PROCEDURES, TYPES, URGENCIES, AD_RISKS, mask, restore, buildRequest, parseResponse, safetyNet, departmentOf })", ctx);
