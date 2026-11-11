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

let falhas = 0;
fixtures.forEach((c, i) => {
  const js = JSON.parse(JSON.stringify(ts[c.tool](...c.args)));
  const ok = isDeepStrictEqual(js, py[i]);
  if (!ok) falhas++;
  console.log(`${ok ? "OK  " : "FAIL"} ${c.tool} — ${c.nome}`);
  if (!ok) console.log("  python:", JSON.stringify(py[i]).slice(0, 600), "\n  ts:    ", JSON.stringify(js).slice(0, 600));
});
console.log(falhas ? `\n${falhas} divergência(s)` : `\nPARIDADE 100% (${fixtures.length} casos)`);
process.exit(falhas ? 1 : 0);
