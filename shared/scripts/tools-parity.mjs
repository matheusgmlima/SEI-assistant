// Paridade Python (original do Autonomia) × TypeScript (porte) das ferramentas.
// Uso: node shared/scripts/tools-parity.mjs   (precisa de python no PATH)
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import * as ts from "../src/agents/tools.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fonte = readFileSync(join(here, "../src/agents/fonte/ferramentas.py.txt"), "utf8");
const fixtures = JSON.parse(readFileSync(join(here, "tools-fixtures.json"), "utf8"));

// Harness Python: cada bloco "class Tools" do arquivo roda isolado (no original eles se sobrescrevem).
const harness = `
import json, re, sys
src = open(sys.argv[1], encoding="utf-8").read()
blocos = re.split(r"\\n(?=(?:import re|from datetime import datetime)\\s*\\n)", src)
metodos = {}
for b in blocos:
    if "class Tools" not in b: continue
    ns = {}
    try: exec(b, ns)
    except ImportError: continue
    inst = ns["Tools"]()
    for nome in re.findall(r"def (\\w+)\\(self", b): metodos[nome] = getattr(inst, nome)
casos = json.load(open(sys.argv[2], encoding="utf-8"))
print(json.dumps([metodos[c["tool"]](*c["args"]) for c in casos]))
`;
const dir = mkdtempSync(join(tmpdir(), "parity-"));
writeFileSync(join(dir, "h.py"), harness);
writeFileSync(join(dir, "casos.json"), JSON.stringify(fixtures));
const py = JSON.parse(execFileSync("python", ["-I", join(dir, "h.py"), join(here, "../src/agents/fonte/ferramentas.py.txt"), join(dir, "casos.json")], { encoding: "utf8" }));

// Corrigidas de propósito em relação ao Python — conferidas por resultado esperado, não por paridade.
const CORRIGIDAS = new Set(["extrair_prazos_do_texto", "listar_secoes_do_documento", "verificar_referencias_cruzadas"]);

let falhas = 0;
const check = (ok, nome, detalhe = "") => {
  if (!ok) falhas++;
  console.log(`${ok ? "OK  " : "FAIL"} ${nome}${!ok && detalhe ? "\n  " + detalhe : ""}`);
};

fixtures.forEach((c, i) => {
  if (CORRIGIDAS.has(c.tool)) return;
  const js = JSON.parse(JSON.stringify(ts[c.tool](...c.args)));
  check(isDeepStrictEqual(js, py[i]), `paridade ${c.tool} — ${c.nome}`,
    `python: ${JSON.stringify(py[i]).slice(0, 400)}\n  ts:     ${JSON.stringify(js).slice(0, 400)}`);
});

// Bug 1 (original): prazo de entrega e garantia viravam "recebimento definitivo".
const prazos = ts.extrair_prazos_do_texto(
  "6. DOS PRAZOS\n6.1. A entrega deverá ser efetivada no prazo de 30 (trinta) dias corridos.\n" +
  "6.2. O termo de recebimento definitivo será emitido em 5 (cinco) dias úteis.\n" +
  "6.3. A garantia dos bens será de 90 dias corridos.\n" +
  "6.4. O recebimento provisório ocorrerá em até 15 (quinze) dias, contados da entrega.\n" +
  "6.5. Os pagamentos serão realizados em até 10 (dez) dias após o recebimento definitivo.");
const cats = prazos.map((p) => `${p.valor}:${p.categoria}:${p.unidade}`);
check(isDeepStrictEqual(cats, [
  "30:prazo_entrega:corridos", "5:prazo_emissao_termo_recebimento_definitivo:úteis",
  "90:prazo_garantia:corridos", "15:prazo_recebimento_provisorio:null", "10:prazo_pagamento:null",
]), "corrigida extrair_prazos_do_texto — categoria pela frase e palavra mais próxima", JSON.stringify(cats));

// Bug 2 (original): título com dígito ou em Title Case sumia do mapa.
const sec = ts.listar_secoes_do_documento(
  "SUMÁRIO\n1. OBJETO ........................ 3\n1. DO OBJETO\n1.1. Texto corrido do item, sem ser título.\n" +
  "2. DA FUNDAMENTAÇÃO NA LEI 14.133\n3. Do Modelo De Execução\n4. DO PAGAMENTO\n4. DAS SANÇÕES");
check(isDeepStrictEqual(sec.secoes.map((s) => s.numero + " " + s.titulo),
  ["1 DO OBJETO", "2 DA FUNDAMENTAÇÃO NA LEI 14.133", "3 Do Modelo De Execução", "4 DO PAGAMENTO", "4 DAS SANÇÕES"]) &&
  isDeepStrictEqual(sec.numeros_repetidos, ["4"]),
  "corrigida listar_secoes_do_documento — dígito, Title Case, sumário fora, repetido detectado", JSON.stringify(sec));

// Casos vindos do TR real (BID 5.05): célula de tabela sozinha, linha quebrada com número,
// lista interna de critérios que reinicia em 1 — nenhum é numeração quebrada. Salto real continua sendo.
const real = "6. PERFIL PROFISSIONAL\n1. Pós-graduação em gestão\n2. Experiência em compras\n- 30 pontos\n60\n" +
  "ANEXO I - TERMO DE REFERÊNCIA\n20\nPontuação Total 100\n7. PRAZO DE VIGÊNCIA\n" +
  "15 no site do Banco, e não poderá adjudicar\n8. REQUISITOS\n10. OBRIGAÇÕES";
// Minuta real (BID): cláusulas por extenso + referências a outros documentos (TR, GN-2350-15)
const minuta = `CLÁUSULA QUINTA – DO PAGAMENTO\n5.1. Texto.\n5.2. Texto.\nCLÁUSULA SEXTA – DO VALOR
6.1. O valor global conforme estabelecido no item 15 do Anexo I – Termo de Referência.
6.2. Nos termos do item 4.10(c) da GN-2350-15, caso o pagamento.\nCLÁUSULA DÉCIMA TERCEIRA – X
13.1. Os relatórios previstos no item 13 e as atividades do item 4 do Anexo I – Termo de Referência.
13.2. Conforme o item 13.9 deste contrato e o item 5.4 do Estudo Técnico Preliminar.\n13.4. Pulou.`;
check(isDeepStrictEqual(ts.verificar_referencias_cruzadas(minuta).referencias_quebradas, ["13.9"]),
  "corrigida verificar_referencias_cruzadas — referência a outro documento e cláusula por extenso não quebram; 13.9 interna quebra",
  JSON.stringify(ts.verificar_referencias_cruzadas(minuta).referencias_quebradas));
check(isDeepStrictEqual(ts.verificar_numeracao_sequencial(minuta), [{ item: "13.4", nivel: 2, esperado: 3, encontrado: 4 }]),
  "corrigida verificar_numeracao_sequencial — 5.2 → 6.1 sob 'CLÁUSULA SEXTA' não é salto; 13.2 → 13.4 é",
  JSON.stringify(ts.verificar_numeracao_sequencial(minuta)));
check(isDeepStrictEqual(ts.verificar_numeracao_sequencial(real), [{ item: "10", nivel: 1, esperado: 9, encontrado: 10 }]),
  "corrigida verificar_numeracao_sequencial — lista interna/tabela/linha quebrada ignoradas, salto 8→10 detectado",
  JSON.stringify(ts.verificar_numeracao_sequencial(real)));
check(isDeepStrictEqual(ts.listar_secoes_do_documento(real).secoes.map((s) => s.numero), ["6", "7", "8", "10"]),
  "corrigida listar_secoes_do_documento — célula de tabela (60, 20) e item de lista não viram seção",
  JSON.stringify(ts.listar_secoes_do_documento(real).secoes));

console.log(falhas ? `\n${falhas} falha(s)` : `\nTUDO OK`);
process.exit(falhas ? 1 : 0);
