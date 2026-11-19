/**
 * Base de modelos (tela do curador): monta a "caixinha" da unidade com documentos
 * puxados do SEI — modelos oficiais e exemplos reais — que a revisão usa para comparar
 * e, depois, a geração de documentos usa de ponto de partida.
 */
import { useEffect, useState } from "react";
import { novoModelo, tipoPeloTitulo, ROTULO_TIPO, ROTULO_CATEGORIA, type Modelo, type Natureza, type TipoDocumento, type Grupo } from "@shared/base/modelos";
import { baseLocal, grupoAtual, lerGrupos, salvarGrupos, exportarBase, importarBase } from "../lib/base";
import { sget } from "../lib/agentes";
import { enviarAbaAtiva, garantirProcessoAberto, lerDoSei } from "./Revisao";
import { Icon, ScreenHeader } from "./ui";

type DocSei = { idInterno: string; numero: string; titulo: string; tipo: string };
const TIPOS = Object.keys(ROTULO_TIPO) as TipoDocumento[];

export function BaseScreen({ onBack }: { onBack: () => void }) {
  const [grupo, setGrupo] = useState<string | null>(null);
  const [grupos, setGrupos] = useState<Grupo[]>([]);
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [processo, setProcesso] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocSei[] | null>(null);
  const [escolha, setEscolha] = useState<Record<string, { tipo: TipoDocumento; natureza: Natureza }>>({});
  const [fase, setFase] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [editUnid, setEditUnid] = useState(false);
  const [unidTxt, setUnidTxt] = useState("");

  async function carregar() {
    const g = await grupoAtual();
    setGrupo(g);
    setGrupos(await lerGrupos());
    setModelos(g ? await baseLocal.listar({ grupo: g }) : []);
    setProcesso((await sget<string | null>("processoAberto")) ?? null);
  }
  useEffect(() => { carregar(); }, []);

  const meuGrupo = grupos.find((g) => g.nome === grupo);
  async function salvarUnidades() {
    if (!grupo) return;
    const unidades = unidTxt.split("\n").map((u) => u.trim()).filter(Boolean);
    const outros = grupos.filter((g) => g.nome !== grupo);
    await salvarGrupos([...outros, { nome: grupo, unidades }]);
    setEditUnid(false); carregar();
  }

  async function listar() {
    if (!processo) return;
    setErro(null); setFase("Lendo a árvore do processo…");
    try {
      await garantirProcessoAberto(processo);
      const l = await enviarAbaAtiva<DocSei[]>({ type: "REVISAO_LISTAR", payload: { processId: processo } });
      setDocs(l); setEscolha({});
    } catch (e) { setErro((e as Error).message); }
    setFase(null);
  }

  async function adicionar() {
    if (!grupo || !processo) return;
    const ids = Object.keys(escolha);
    setErro(null); setAviso(null);
    try {
      setFase(`Baixando ${ids.length} documento(s) do SEI…`);
      const { lidos, avisos } = await lerDoSei(ids, setFase);
      const login = (await sget<{ username?: string } | undefined>("session"))?.username ?? null;
      for (const d of lidos) {
        const e = escolha[d.idInterno];
        const numero = docs?.find((x) => x.idInterno === d.idInterno)?.numero;
        await baseLocal.salvar(novoModelo({ titulo: d.titulo, texto: d.texto, grupo, natureza: e.natureza, tipo: e.tipo,
          processoSei: processo, documentoSei: numero, criadoPor: login ?? undefined }));
      }
      setAviso(`${lidos.length} documento(s) adicionado(s) à caixinha ${grupo}.${avisos.length ? ` Não entraram: ${avisos.join(" · ")}` : ""}`);
      setDocs(null); setEscolha({}); carregar();
    } catch (e) { setErro((e as Error).message); }
    setFase(null);
  }

  async function alternarVigente(m: Modelo) { await baseLocal.salvar({ ...m, vigente: !m.vigente }); carregar(); }
  async function remover(m: Modelo) {
    if (!confirm(`Remover "${m.titulo}" da base? Não dá para desfazer.`)) return;
    await baseLocal.remover(m.id); carregar();
  }
  async function exportar() {
    const a = document.createElement("a"); a.href = URL.createObjectURL(await exportarBase());
    a.download = `base-modelos-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  }
  async function importar(f: File) {
    try { setAviso(`${await importarBase(f)} modelo(s) importado(s).`); carregar(); } catch (e) { setErro((e as Error).message); }
  }

  const porTipo = TIPOS.map((t) => [t, modelos.filter((m) => m.tipo === t)] as const).filter(([, ms]) => ms.length);

  return (
    <div className="screen screen--active">
      <ScreenHeader title="Base de modelos" sub={grupo ? `Caixinha: ${grupo}` : null} onBack={onBack} />
      <div className="ctrl base">
        <p className="ctrl-intro">Modelos e bons exemplos da sua unidade. A revisão compara cada documento com o modelo mais parecido daqui. Por enquanto a base fica <b>só neste navegador</b> — use Exportar para levar a um colega; quando o banco do tribunal chegar, ela é carregada lá.</p>

        {!grupo && <p className="aviso aviso--warn"><Icon n="alerta" /> Entre no SEI para identificar a sua unidade.</p>}

        {grupo && (
          <section className="set-card">
            <div className="set-card-head"><span className="set-card-title">Caixinha {grupo}</span>
              <button className="btn-link" onClick={() => { setUnidTxt((meuGrupo?.unidades ?? [grupo]).join("\n")); setEditUnid((v) => !v); }}>{editUnid ? "Cancelar" : "Unidades"}</button></div>
            <p className="set-help set-help--small">Compartilhada por: {(meuGrupo?.unidades ?? [grupo]).join(", ")}</p>
            {editUnid && <>
              <label className="settings-label" htmlFor="base-unid">Unidades que usam esta caixinha (uma por linha, como aparece no SEI)</label>
              <textarea id="base-unid" className="settings-input base-unid" rows={4} value={unidTxt} onChange={(e) => setUnidTxt(e.target.value)} />
              <button className="btn btn--primary btn--sm" onClick={salvarUnidades}>Salvar unidades</button>
            </>}
          </section>
        )}

        {grupo && (
          <section className="set-card">
            <span className="set-card-title"><Icon n="doc" /> Adicionar do SEI</span>
            {!processo ? <p className="set-help">Abra no SEI o processo que tem o modelo (ou o bom exemplo) e volte aqui.</p> : !docs ? (
              <>
                <p className="set-help">Processo aberto: <b className="mono">{processo}</b></p>
                <button className="btn btn--ghost btn--block" onClick={listar} disabled={!!fase}>Escolher documentos deste processo</button>
              </>
            ) : (
              <>
                <p className="set-help set-help--small"><b>Modelo oficial</b> = padrão da unidade (a revisão cobra o que ele tem). <b>Exemplo</b> = documento real bem feito (só inspira).</p>
                <div className="rev-docs">
                  {docs.map((d) => {
                    const e = escolha[d.idInterno];
                    return (
                      <div key={d.idInterno} className={`rev-doc base-doc ${e ? "rev-doc--on" : ""}`}>
                        <label className="rev-doc-sel">
                          <input type="checkbox" checked={!!e} disabled={!!fase} onChange={() => setEscolha((s) => {
                            const n = { ...s }; if (n[d.idInterno]) delete n[d.idInterno]; else n[d.idInterno] = { tipo: tipoPeloTitulo(d.titulo), natureza: "exemplo" }; return n; })} />
                          <span className="rev-doc-titulo" title={d.titulo}>{d.titulo}</span>
                        </label>
                        {e && (
                          <div className="base-doc-opts">
                            <select aria-label="Tipo" value={e.tipo} onChange={(ev) => setEscolha((s) => ({ ...s, [d.idInterno]: { ...e, tipo: ev.target.value as TipoDocumento } }))}>
                              {TIPOS.map((t) => <option key={t} value={t}>{ROTULO_TIPO[t]}</option>)}
                            </select>
                            <span className="rev-papel">
                              <button type="button" className={e.natureza === "modelo_oficial" ? "on" : ""} onClick={() => setEscolha((s) => ({ ...s, [d.idInterno]: { ...e, natureza: "modelo_oficial" } }))}>Modelo oficial</button>
                              <button type="button" className={e.natureza === "exemplo" ? "on" : ""} onClick={() => setEscolha((s) => ({ ...s, [d.idInterno]: { ...e, natureza: "exemplo" } }))}>Exemplo</button>
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="row">
                  <button className="btn btn--primary" onClick={adicionar} disabled={!!fase || !Object.keys(escolha).length}>Adicionar {Object.keys(escolha).length || ""} à base</button>
                  <button className="btn btn--ghost" onClick={() => setDocs(null)} disabled={!!fase}>Cancelar</button>
                </div>
              </>
            )}
          </section>
        )}

        {fase && <div className="rev-fase" role="status"><div className="rev-fase-txt"><span className="collect-spinner" />{fase}</div></div>}
        {aviso && <p className="aviso aviso--info">{aviso}</p>}
        {erro && <p className="aviso aviso--erro"><Icon n="alerta" /> {erro}</p>}

        {grupo && (
          <>
            <p className="ctrl-rot">Na caixinha ({modelos.length})</p>
            {!modelos.length && <p className="set-help">Nenhum modelo ainda.</p>}
            {porTipo.map(([t, ms]) => (
              <div key={t} className="base-grupo">
                <p className="audit-sub">{ROTULO_TIPO[t]}</p>
                {ms.map((m) => (
                  <details key={m.id} className={`base-modelo ${m.vigente ? "" : "base-modelo--off"}`}>
                    <summary>
                      <span className="base-modelo-tit">{m.titulo}</span>
                      <span className={`pill ${m.natureza === "modelo_oficial" ? "pill--ok" : ""}`}>{m.natureza === "modelo_oficial" ? "oficial" : "exemplo"}</span>
                    </summary>
                    <p className="set-help set-help--small">{ROTULO_CATEGORIA[m.categoria]} · {m.secoes.length} seções · processo {m.processoSei ?? "—"} · {new Date(m.criadoEm).toLocaleDateString("pt-BR")}{m.vigente ? "" : " · fora de uso"}</p>
                    <p className="set-help set-help--small">{m.resumo}</p>
                    <ol className="base-secoes">{m.secoes.map((s) => <li key={s.ordem}>{[s.numero, s.titulo].filter(Boolean).join(" ")}</li>)}</ol>
                    <div className="row">
                      <button className="btn btn--ghost btn--sm" onClick={() => alternarVigente(m)}>{m.vigente ? "Tirar de uso" : "Voltar a usar"}</button>
                      <button className="btn btn--ghost btn--sm" onClick={() => remover(m)}>Remover</button>
                    </div>
                  </details>
                ))}
              </div>
            ))}
          </>
        )}

        <div className="ctrl-acoes ctrl-rodape">
          <button className="btn-collect-reset" onClick={exportar}><Icon n="baixar" s={13} /> Exportar base</button>
          <label className="btn-collect-reset">Importar<input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importar(e.target.files[0])} /></label>
        </div>
      </div>
    </div>
  );
}
