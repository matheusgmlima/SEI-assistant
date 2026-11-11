// Uso: node shared/scripts/pdf2txt.mjs entrada.pdf saida.txt
import { readFileSync, writeFileSync } from "node:fs";
import { pdfToText } from "../src/agents/pdf-text.ts";
const [, , inp, out] = process.argv;
const { texto, paginas } = await pdfToText(new Uint8Array(readFileSync(inp)));
writeFileSync(out, texto, "utf8");
console.log(`${inp}: ${paginas} páginas, ${texto.length} caracteres`);
