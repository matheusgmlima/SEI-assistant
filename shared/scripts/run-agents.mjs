// Roda os agentes de revisão em documentos, via LiteLLM.
// Uso: node shared/scripts/run-agents.mjs --model vertex_ai/claude-sonnet-4-6 --out pasta doc1.pdf [doc2.pdf ...] [--only a4-estrutura,a6-inconsistencias]
// A chave vem de sei-assistant/.env (LITELLM_KEY=...) e nunca é impressa.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { pdfToText } from "../src/agents/pdf-text.ts";
import { rodarAgente, agentesAplicaveis } from "../src/agents/runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const raiz = join(here, "../..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const model = opt("--model", "vertex_ai/claude-sonnet-4-6");
const outDir = opt("--out", join(raiz, ".agentes-saida"));
const only = opt("--only", "");
const KEY = readFileSync(join(raiz, ".env"), "utf8").match(/^LITELLM_KEY=(.+)$/m)?.[1]?.trim();
if (!KEY) throw new Error("LITELLM_KEY ausente em sei-assistant/.env");

const pdir = join(here, "../src/agents/prompts");
const agentes = Object.fromEntries(readdirSync(pdir).filter((f) => /^a\d.*\.md$/.test(f)).map((f) => [f.replace(".md", ""), readFileSync(join(pdir, f), "utf8")]));
const prompts = { comum: readFileSync(join(pdir, "_comum.md"), "utf8"), lei: readFileSync(join(here, "../src/agents/conhecimento/lei14133.md"), "utf8"), agentes };

const docs = [];
for (const f of args) {
  const texto = f.endsWith(".pdf") ? (await pdfToText(new Uint8Array(readFileSync(f)))).texto : readFileSync(f, "utf8");
  docs.push({ nome: basename(f).replace(/\.(pdf|txt)$/i, ""), texto });
}
const ids = agentesAplicaveis(docs).filter((id) => !only || only.split(",").includes(id));
mkdirSync(outDir, { recursive: true });
const cfg = { baseUrl: "https://litellm.cloud.tjpe.jus.br/v1", apiKey: KEY, model };
console.log(`${ids.length} agente(s) · modelo ${model} · ${docs.map((d) => `${d.nome} (${d.texto.length} chars)`).join(", ")}\n`);

const res = await Promise.allSettled(ids.map((id) => rodarAgente(id, docs, cfg, prompts)));
let entrada = 0, saida = 0;
res.forEach((r, i) => {
  if (r.status === "rejected") { console.log(`✗ ${ids[i]}: ${r.reason}`); return; }
  const v = r.value;
  entrada += v.tokens.entrada; saida += v.tokens.saida;
  writeFileSync(join(outDir, `${v.agente}.txt`), v.texto, "utf8");
  console.log(`== ${v.nome} · ${(v.ms / 1000).toFixed(0)}s · ${v.tokens.entrada}→${v.tokens.saida} tokens · trechos ${v.verificacao.verificados}/${v.verificacao.total} conferidos` +
    (v.chamadasFerramenta.length ? ` · ferramentas: ${v.chamadasFerramenta.join("; ")}` : ""));
  v.violacoes.forEach((x) => console.log(`   ⚙ formato corrigido: ${x}`));
  v.verificacao.naoEncontrados.forEach((t) => console.log(`   ⚠ trecho NÃO encontrado no documento: "${t.slice(0, 120)}"`));
});
console.log(`\nTotal: ${entrada} tokens de entrada, ${saida} de saída. Saídas em ${outDir}`);
