/**
 * Aba "Gerar" do processo: escolhe na caixinha da unidade o modelo mais parecido com o
 * processo, pede à IA a adaptação e entrega um Word com os trechos a conferir destacados.
 */
import { useEffect, useMemo, useState } from "react";
import type { ProcessDetails } from "@shared/index";
import { escolherModelos, categoriaDoTexto, ROTULO_TIPO, ROTULO_CATEGORIA, type Modelo, type TipoDocumento } from "@shared/base/modelos";
import { contextoDoProcesso, mensagensGeracao, lerRascunho, type Rascunho } from "@shared/base/gerar";
import { chatCompletion } from "@shared/agents/llm";
import { grupoAtual, modelosDoGrupo } from "../lib/base";
import { configLlm, sget, sset } from "../lib/agentes";
import { rascunhoParaDocx } from "../lib/docx";
import { Icon } from "./ui";

interface Salvo { em: string; modeloId: string; modeloTitulo: string; tipo: TipoDocumento; rascunho: Rascunho }

export function GerarPanel({ processId, details, hasApiKey, onSettings, onBase }: {
  processId: string; details: ProcessDetails; hasApiKey: boolean; onSettings: () => void; onBase: () => void;
}) {
  const [grupo, setGrupo] = useState<string | null | undefined>(undefined);
  const [base, setBase] = useState<Modelo[]>([]);
  const [tipo, setTipo] = useState<TipoDocumento | null>(null);
  const [notas, setNotas] = useState("");
  const [modeloId, setModeloId] = useState<string | null>(null);
  const [fase, setFase] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvo, setSalvo] = useState<Salvo | null>(null);

  useEffect(() => {
    grupoAtual().then(async (g) => { setGrupo(g); if (g) setBase((await modelosDoGrupo(g)).filter((m) => m.vigente)); });
    sget<Salvo | undefined>(`rascunho_${processId}`).then((s) => setSalvo(s ?? null));
  }, [processId]);

  const tipos = useMemo(() => [...new Set(base.map((m) => m.tipo))], [base]);
  useEffect(() => { if (!tipo && tipos.length) setTipo(tipos.includes("tr") ? "tr" : tipos[0]); }, [tipos, tipo]);

  const contexto = useMemo(() => contextoDoProcesso(details, notas), [details, notas]);
  const candidatos = useMemo(() => tipo && grupo ? escolherModelos(base, { grupo, tipo, texto: contexto }, 3) : [], [base, tipo, grupo, contexto]);
  useEffect(() => { setModeloId(candidatos[0]?.modelo.id ?? null); }, [candidatos]);
  const categoria = categoriaDoTexto(contexto);
  const poucoContexto = !details.summary && (details.despachosContent ?? "").length < 500;

  async function gerar() {
    const m = base.find((x) => x.id === modeloId);
    if (!m) return;
    const cfg = await configLlm("agentes");
    if (!cfg) { onSettings(); return; }
    setErro(null); setFase(`Adaptando “${m.titulo}” a este processo… (1 a 2 minutos)`);
    try {
      const r = await chatCompletion(cfg, mensagensGeracao(m, contexto), { temperature: 0.2, tag: "gerar-documento" });
      const texto = String((r as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? "");
      const rascunho = lerRascunho(texto);
      if (!rascunho.secoes.length) throw new Error("A IA não devolveu o documento no formato esperado. Tente de novo.");
      const s: Salvo = { em: new Date().toISOString(), modeloId: m.id, modeloTitulo: m.titulo, tipo: m.tipo, rascunho };
      await sset({ [`rascunho_${processId}`]: s });
      setSalvo(s);
    } catch (e) { setErro((e as Error).message); }
    setFase(null);
  }

  async function baixar() {
    if (!salvo) return;
    const blob = await rascunhoParaDocx(salvo.rascunho, { titulo: ROTULO_TIPO[salvo.tipo].toUpperCase(), processo: processId, modelo: salvo.modeloTitulo });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${ROTULO_TIPO[salvo.tipo]} - ${processId} - rascunho.docx`.replace(/[\\/:*?"<>|]/g, "-");
    a.click();
  }

  if (!hasApiKey) return (
    <div className="rev-vazio"><Icon n="chave" s={24} /><p>A geração usa a IA do tribunal. Configure a chave de acesso.</p>
      <button className="btn btn--primary" onClick={onSettings}>Configurar chave</button></div>
  );
  if (grupo === undefined) return <p className="processes-meta">Carregando a base…</p>;
  if (!grupo || !base.length) return (
    <div className="rev-vazio">
      <Icon n="doc" s={24} />
      <p><b>A caixinha {grupo ?? "da unidade"} ainda não tem modelos.</b></p>
      <p>Para gerar documentos, o curador da unidade precisa cadastrar modelos (TR, ETP, minuta…) na Base de modelos.</p>
      <button className="btn btn--ghost" onClick={onBase}>Abrir base de modelos</button>
    </div>
  );

  return (
    <div className="rev gerar">
      <p className="rev-intro">Monta a base de um documento para este processo a partir dos modelos da caixinha <b>{grupo}</b>. Sai um Word com os trechos a conferir <mark>destacados</mark>.</p>

      <section className="set-card">
        <label className="settings-label" htmlFor="ger-tipo">Documento a gerar</label>
        <select id="ger-tipo" className="settings-select" value={tipo ?? ""} onChange={(e) => setTipo(e.target.value as TipoDocumento)} disabled={!!fase}>
          {tipos.map((t) => <option key={t} value={t}>{ROTULO_TIPO[t]} ({base.filter((m) => m.tipo === t).length} na base)</option>)}
        </select>

        <p className="settings-label">Este processo parece</p>
        <p className="set-help">{categoria !== "outro" ? <b>{ROTULO_CATEGORIA[categoria]}</b> : "Categoria não identificada"}{details.description ? ` — ${details.description}` : ""}</p>
        {poucoContexto && <p className="aviso aviso--warn"><Icon n="alerta" /> A extensão ainda leu pouco deste processo. Use “Ler o processo” e “Gerar resumo”, ou descreva o objeto abaixo.</p>}

        <label className="settings-label" htmlFor="ger-notas">Informações para o documento (opcional)</label>
        <textarea id="ger-notas" className="settings-input ger-notas" rows={3} value={notas} disabled={!!fase} onChange={(e) => setNotas(e.target.value)}
          placeholder="Ex.: 120 cadeiras e 40 mesas, entrega em 30 dias no Fórum do Recife, valor estimado R$ 180 mil" />

        <p className="settings-label">Modelo mais parecido</p>
        <div className="ger-modelos" role="radiogroup" aria-label="Modelo">
          {candidatos.map(({ modelo, motivo }, i) => (
            <label key={modelo.id} className={`ger-modelo ${modeloId === modelo.id ? "on" : ""}`}>
              <input type="radio" name="ger-modelo" checked={modeloId === modelo.id} onChange={() => setModeloId(modelo.id)} disabled={!!fase} />
              <span><b>{modelo.titulo}</b>{i === 0 && <span className="pill pill--ok">mais parecido</span>}<small>{motivo}</small></span>
            </label>
          ))}
        </div>
        <button className="btn btn--primary btn--block" onClick={gerar} disabled={!!fase || !modeloId}>
          <Icon n="play" s={14} /> {salvo ? "Gerar de novo" : "Gerar rascunho"}
        </button>
      </section>

      {fase && <div className="rev-fase" role="status"><div className="rev-fase-txt"><span className="collect-spinner" />{fase}</div></div>}
      {erro && <p className="aviso aviso--erro"><Icon n="alerta" /> {erro}</p>}

      {salvo && !fase && (
        <section className="rev-resultado">
          <p className="rev-resultado-rot">Rascunho · {new Date(salvo.em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</p>
          <p className="rev-resultado-num">{ROTULO_TIPO[salvo.tipo]} com <b>{salvo.rascunho.pontos.length}</b> ponto{salvo.rascunho.pontos.length === 1 ? "" : "s"} a conferir</p>
          <p className="rev-dica">Baseado em: {salvo.modeloTitulo} · {salvo.rascunho.secoes.length} seções{salvo.rascunho.pendencias.length ? ` · ${salvo.rascunho.pendencias.length} pendência(s)` : ""}</p>
          <button className="btn btn--primary btn--block" onClick={baixar}><Icon n="baixar" s={14} /> Baixar Word</button>
          {salvo.rascunho.pendencias.length > 0 && (
            <div className="ger-pend"><p className="audit-sub">Antes de usar</p>
              <ul>{salvo.rascunho.pendencias.map((p, i) => <li key={i}>{p}</li>)}</ul></div>
          )}
          <details className="rev-detalhe">
            <summary>Ver os pontos a conferir</summary>
            <ol className="ger-pontos">{salvo.rascunho.pontos.map((p) => (
              <li key={p.n}><mark>{p.trecho}</mark> <span>— {p.motivo}</span>{p.secao && <small>{p.secao}</small>}</li>
            ))}</ol>
          </details>
        </section>
      )}
    </div>
  );
}
