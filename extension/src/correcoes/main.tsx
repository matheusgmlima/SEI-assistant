/**
 * Tela de correções (aba à parte): todos os achados dos agentes de um processo,
 * organizados por criticidade, com "Já alterei" / "Não é válida" (+ motivo).
 * Cada marcação vira um Veredito — é a evidência que o Controlador usa para
 * melhorar os prompts. "Já alterei" = achado procede; "Não é válida" = falso positivo.
 */
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseSaida, chaveAchado, type Problema, type Criticidade } from "@shared/agents/saida";
import type { Veredito, Falta } from "@shared/agents/controlador";
import { AGENTES, type AgenteId, type ResultadoAgente } from "@shared/agents/runner";

const processId = new URLSearchParams(location.search).get("proc") ?? "";
const sget = <T,>(k: string): Promise<T | undefined> => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k] as T)));
const sset = (o: Record<string, unknown>) => new Promise<void>((r) => chrome.storage.local.set(o, () => r()));

interface Item { chave: string; agente: AgenteId; nomeAgente: string; p: Problema; naoAchado: boolean }
const ORDEM: Criticidade[] = ["ALTA", "MÉDIA", "BAIXA"];
const CLASSE = { ALTA: "alta", MÉDIA: "media", BAIXA: "baixa" } as const;

function App() {
  const [revisao, setRevisao] = useState<{ em: string; documentos: { nome: string }[]; resultados: ResultadoAgente[] } | null | undefined>(undefined);
  const [vereditos, setVereditos] = useState<Veredito[]>([]);
  const [soPendentes, setSoPendentes] = useState(false);

  useEffect(() => {
    sget<typeof revisao>(`revisao_${processId}`).then((r) => setRevisao(r ?? null));
    sget<Veredito[]>("vereditos").then((v) => setVereditos(v ?? []));
    // a aba lateral também marca vereditos — mantém as duas telas em sincronia
    const ouvir = (ch: Record<string, chrome.storage.StorageChange>) => {
      if (ch.vereditos) setVereditos((ch.vereditos.newValue as Veredito[]) ?? []);
      if (ch[`revisao_${processId}`]) setRevisao(ch[`revisao_${processId}`].newValue as typeof revisao);
    };
    chrome.storage.onChanged.addListener(ouvir);
    return () => chrome.storage.onChanged.removeListener(ouvir);
  }, []);

  const itens = useMemo<Item[]>(() => (revisao?.resultados ?? []).flatMap((r) => {
    const nao = new Set(r.verificacao.naoEncontrados);
    return parseSaida(r.texto).problemas.map((p) => ({
      chave: `${processId}|${chaveAchado(r.agente, p)}`, agente: r.agente, nomeAgente: r.nome, p,
      naoAchado: p.trechos.some((t) => nao.has(t)),
    }));
  }), [revisao]);

  const porChave = new Map(vereditos.map((v) => [v.chave, v]));

  async function marcar(it: Item, veredito: Veredito["veredito"] | null, nota?: string) {
    // lê do storage na hora: outra tela pode ter gravado no meio-tempo
    const atuais = ((await sget<Veredito[]>("vereditos")) ?? []).filter((v) => v.chave !== it.chave);
    const novos = veredito ? [...atuais, {
      chave: it.chave, processId, agente: it.agente, veredito, criticidade: it.p.criticidade, onde: it.p.onde,
      problema: it.p.problema, trecho: it.p.trechos[0] ?? "", ...(nota ? { nota } : {}), em: new Date().toISOString(),
    }] : atuais;
    setVereditos(novos);
    await sset({ vereditos: novos });
  }

  if (revisao === undefined) return <p className="cor-vazio">Carregando…</p>;
  if (!revisao) return <p className="cor-vazio">Nenhuma revisão salva para este processo. Rode a revisão na aba “Revisão” do assistente.</p>;

  const feitos = itens.filter((i) => porChave.has(i.chave)).length;
  const visiveis = soPendentes ? itens.filter((i) => !porChave.has(i.chave)) : itens;

  return (
    <div className="cor">
      <header className="cor-topo">
        <div>
          <h1>Correções sugeridas</h1>
          <p className="cor-meta">Processo {processId} · revisado em {new Date(revisao.em).toLocaleString("pt-BR")} · {revisao.documentos.map((d) => d.nome).join(", ")}</p>
        </div>
        <div className="cor-progresso">
          <strong>{feitos} de {itens.length}</strong> avaliadas
          <div className="cor-barra"><span style={{ width: `${itens.length ? (feitos / itens.length) * 100 : 0}%` }} /></div>
          <label><input type="checkbox" checked={soPendentes} onChange={(e) => setSoPendentes(e.target.checked)} /> mostrar só pendentes</label>
        </div>
      </header>

      {itens.length === 0 && <p className="cor-vazio">Os agentes não apontaram nenhuma correção. 🎉</p>}

      {ORDEM.map((c) => {
        const grupo = visiveis.filter((i) => i.p.criticidade === c);
        if (!grupo.length) return null;
        return (
          <section key={c}>
            <h2 className={`cor-grupo cor-grupo--${CLASSE[c]}`}>{c === "ALTA" ? "Alta" : c === "MÉDIA" ? "Média" : "Baixa"} prioridade · {grupo.length}</h2>
            {grupo.map((it) => <Cartao key={it.chave} it={it} v={porChave.get(it.chave)} onMarcar={marcar} />)}
          </section>
        );
      })}

      <Faltou />
      <p className="cor-rodape">Suas avaliações alimentam o Controlador dos agentes: “Não é válida” com o motivo é o que mais ajuda a corrigir o agente.</p>
    </div>
  );
}

function Cartao({ it, v, onMarcar }: { it: Item; v?: Veredito; onMarcar: (it: Item, v: Veredito["veredito"] | null, nota?: string) => void }) {
  const [motivo, setMotivo] = useState(v?.nota ?? "");
  useEffect(() => { setMotivo(v?.nota ?? ""); }, [v?.nota]); // avaliações salvas chegam depois do 1º render
  const estado = v?.veredito;
  const salvo = (v?.nota ?? "") === motivo.trim();

  return (
    <article className={`cor-item cor-item--${CLASSE[it.p.criticidade]} ${estado ? "cor-item--feito" : ""}`}>
      <div className="cor-corpo">
        <div className="cor-onde">📍 {it.p.onde} <span className="cor-agente">{it.nomeAgente}</span></div>
        <div className="cor-problema">{it.p.problema}</div>
        {it.p.trechos.map((t, i) => (
          <div key={i} className="cor-trecho">{t === "(ausente)" ? <em>Não consta no documento</em> : <>“{t}”</>}</div>
        ))}
        {it.naoAchado && <div className="cor-alerta">⚠ O trecho citado não foi encontrado no documento — confira com atenção.</div>}
        {it.p.correcao && <div className="cor-correcao"><strong>O que alterar:</strong> {it.p.correcao}</div>}
      </div>

      <div className="cor-acoes">
        <label className={`cor-op ${estado === "procede" ? "on" : ""}`}>
          <input type="checkbox" checked={estado === "procede"} onChange={(e) => onMarcar(it, e.target.checked ? "procede" : null)} /> Já alterei
        </label>
        <label className={`cor-op cor-op--inv ${estado === "falso_positivo" ? "on" : ""}`}>
          <input type="checkbox" checked={estado === "falso_positivo"} onChange={(e) => onMarcar(it, e.target.checked ? "falso_positivo" : null, motivo.trim() || undefined)} /> Não é válida
        </label>
        {estado === "falso_positivo" && (
          <div className="cor-motivo">
            <label>Quer dizer por que a alteração não é válida?</label>
            <textarea rows={3} value={motivo} placeholder="Ex.: o valor está correto, a tabela soma os itens com frete…" onChange={(e) => setMotivo(e.target.value)} />
            <button disabled={salvo} onClick={() => onMarcar(it, "falso_positivo", motivo.trim() || undefined)}>{salvo && motivo.trim() ? "✓ Motivo salvo" : "Salvar motivo"}</button>
          </div>
        )}
      </div>
    </article>
  );
}

function Faltou() {
  const [agente, setAgente] = useState<AgenteId>(AGENTES[0].id);
  const [texto, setTexto] = useState("");
  const [ok, setOk] = useState(false);
  async function enviar() {
    const faltas = (await sget<Falta[]>("faltas")) ?? [];
    await sset({ faltas: [...faltas, { processId, agente, texto: texto.trim(), em: new Date().toISOString() }] });
    setTexto(""); setOk(true);
  }
  return (
    <section className="cor-faltou">
      <h2>Faltou apontar algum erro?</h2>
      <div className="cor-faltou-linha">
        <select value={agente} onChange={(e) => setAgente(e.target.value as AgenteId)}>
          {AGENTES.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
        </select>
        <input value={texto} placeholder="Descreva o erro que os agentes não viram" onChange={(e) => { setTexto(e.target.value); setOk(false); }}
          onKeyDown={(e) => e.key === "Enter" && texto.trim() && enviar()} />
        <button disabled={!texto.trim()} onClick={enviar}>Registrar</button>
      </div>
      {ok && <p className="cor-ok">Registrado ✓ — o controlador vai considerar.</p>}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
