// Node에서 sample-docs 폴더의 파일을 읽어 서버에 보낼 형태로 바꿔요.
import fs from "node:fs";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfToPages, textToPages, kindOf, titleOf } from "../public/extract.js";

export const SAMPLE_DIR = path.join(import.meta.dirname, "..", "sample-docs");

export async function readDoc(file) {
  const name = path.basename(file);
  const kind = kindOf(name);
  const pages =
    kind === "pdf"
      ? await pdfToPages(pdfjs, new Uint8Array(fs.readFileSync(file)))
      : textToPages(fs.readFileSync(file, "utf8"));
  return { title: titleOf(name), kind, pages };
}

export const sampleFiles = () =>
  fs.readdirSync(SAMPLE_DIR).filter((f) => kindOf(f)).sort().map((f) => path.join(SAMPLE_DIR, f));
