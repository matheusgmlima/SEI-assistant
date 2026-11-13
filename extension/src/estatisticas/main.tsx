/**
 * Estatísticas dos agentes (modo desenvolvedor): precisão por versão do prompt, custo,
 * volume de achados e atividade do Controlador. Tudo calculado do storage local —
 * reflete só ESTE navegador até existir a base central.
 */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AGENTES, type AgenteId } from "@shared/agents/runner";
import type { Veredito, Falta } from "@shared/agents/controlador";
import { MODELO_AGENTES, MODELO_RAPIDO } from "@shared/agents/llm";
import type { RegistroRevisao, EventoControlador, Overrides } from "../lib/agentes";

interface Dados { revs: RegistroRevisao[]; vereditos: Veredito[]; faltas: Falta[]; log: EventoControlador[]; overrides: Overrides }

const usd = (n: number) => `US$ ${n.toFixed(n < 1 ? 3 : 2)}`;
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const media = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
/** Precisão = dos achados avaliados, quantos procediam ("Não sei avaliar" não conta). */
function precisao(vs: Veredito[]) {
  const ok = vs.filter((v) => v.veredito === "procede").length;
  const fp = vs.filter((v) => v.veredito === "falso_positivo").length;
  return ok + fp ? ok / (ok + fp) : null;
}

function App() {
  const [d, setD] = useState<Dados | null>(null);
  useEffect(() => {
    const carregar = () => chrome.storage.local.get(["statsRevisoes", "vereditos", "faltas", "ctrlLog", "promptOverrides"], (r) =>
      setD({ revs: r.statsRevisoes ?? [], vereditos: r.vereditos ?? [], faltas: r.faltas ?? [], log: r.ctrlLog ?? [], overrides: r.promptOverrides ?? {} }));
    carregar();
    chrome.storage.onChanged.addListener(carregar);
    return () => chrome.storage.onChanged.removeListener(carregar);
  }, []);
  if (!d) return <p className="est-vazio">Carregando…</p>;

  const pagas = d.revs.filter((r) => r.agentes.some((a) => !a.doCache));
  const custoRev = (r: RegistroRevisao) => r.agentes.reduce((a, x) => a + x.custoUsd, 0);
  const custoTotal = d.revs.reduce((a, r) => a + custoRev(r), 0);
  const avaliados = d.vereditos.filter((v) => v.veredito !== "incerto");
  const aplicados = d.log.filter((e) => e.tipo === "aplicado").length;

  // custo por dia (últimos 14 dias com revisão)
  const porDia = new Map<string, number>();
  for (const r of d.revs) porDia.set(r.em.slice(0, 10), (porDia.get(r.em.slice(0, 10)) ?? 0) + custoRev(r));
  const dias = [...porDia.entries()].sort().slice(-14);
  const maxDia = Math.max(0.0001, ...dias.map(([, v]) => v));

  function exportar() {
    const blob = new Blob([JSON.stringify({ tipo: "sei-assistant-estatisticas", em: new Date().toISOString(), ...d }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `estatisticas-agentes-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  }

  return (
    <div className="est">
      <header className="est-topo">
        <div><h1>Estatísticas dos agentes</h1><p className="est-meta">Modo desenvolvedor · dados deste navegador</p></div>
        <button className="est-btn" onClick={exportar}>⬇ Exportar dados brutos</button>
      </header>

      <section className="est-cards">
        <Card rot="Revisões rodadas" val={String(d.revs.length)} sub={`${d.revs.length - pagas.length} 100% do cache`} />
        <Card rot="Custo total" val={usd(custoTotal)} sub={`média ${usd(media(pagas.map(custoRev)))} por revisão paga`} />
        <Card rot="Achados avaliados" val={String(avaliados.length)} sub={`${d.vereditos.length - avaliados.length} “não sei” · ${d.faltas.length} faltou`} />
        <Card rot="Precisão geral" val={pct(precisao(d.vereditos))} sub="achados avaliados que procediam" />
        <Card rot="Ajustes do controlador" val={String(aplicados)} sub={`${d.log.filter((e) => e.tipo === "pendente").length} pendente(s) · ${d.log.filter((e) => e.tipo === "desfeito").length} desfeito(s)`} />
      </section>

      <h2>Por agente</h2>
      <div className="est-tabela-wrap">
        <table className="est-tabela">
          <thead><tr><th>Agente</th><th>Versão</th><th>Modelo</th><th>Achados/revisão</th><th>Avaliados</th><th>Precisão</th><th>Falso alarme</th><th>Faltou</th><th>Custo/revisão</th></tr></thead>
          <tbody>
            {AGENTES.map((a) => {
              const vs = d.vereditos.filter((v) => v.agente === a.id);
              const runs = d.revs.flatMap((r) => r.agentes.filter((x) => x.agente === a.id && !x.erro));
              return (
                <tr key={a.id}>
                  <td>{a.nome}</td>
                  <td>v{(d.overrides[a.id]?.length ?? 0) + 1}</td>
                  <td className="est-mono">{a.rapido ? MODELO_RAPIDO : MODELO_AGENTES}</td>
                  <td>{runs.length ? media(runs.map((x) => x.achados)).toFixed(1) : "—"}</td>
                  <td>{vs.filter((v) => v.veredito !== "incerto").length}</td>
                  <td><Barra v={precisao(vs)} /></td>
                  <td>{vs.filter((v) => v.veredito === "falso_positivo").length}</td>
                  <td>{d.faltas.filter((f) => f.agente === a.id).length}</td>
                  <td>{runs.filter((x) => !x.doCache).length ? usd(media(runs.filter((x) => !x.doCache).map((x) => x.custoUsd))) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Evolução por versão do prompt</h2>
      <p className="est-meta">A versão melhora quando a precisão sobe sem o “faltou” crescer. Avaliações feitas antes deste registro contam como v1.</p>
      {AGENTES.map((a) => <Evolucao key={a.id} agente={a.id} nome={a.nome} d={d} />)}

      <h2>Custo por dia</h2>
      {dias.length === 0 ? <p className="est-meta">Sem revisões registradas ainda.</p> : (
        <div className="est-dias">
          {dias.map(([dia, v]) => (
            <div key={dia} className="est-dia"><span>{dia.slice(8, 10)}/{dia.slice(5, 7)}</span>
              <div className="est-dia-barra"><i style={{ width: `${(v / maxDia) * 100}%` }} /></div><b>{usd(v)}</b></div>
          ))}
        </div>
      )}

      <h2>Atividade do controlador</h2>
      {d.log.length === 0 ? <p className="est-meta">Nenhum ciclo ainda.</p> : (
        <div className="est-tabela-wrap">
          <table className="est-tabela">
            <thead><tr><th>Quando</th><th>Agente</th><th>Resultado</th><th>Falsos alarmes eliminados</th><th>Acertos mantidos</th></tr></thead>
            <tbody>{d.log.map((e) => (
              <tr key={e.id}><td>{new Date(e.em).toLocaleString("pt-BR")}</td><td>{AGENTES.find((a) => a.id === e.agente)?.nome}</td>
                <td>{e.tipo}{e.versao ? ` (v${e.versao})` : ""}</td>
                <td>{e.placar ? `${e.placar.falsosPositivos.eliminados}/${e.placar.falsosPositivos.total}` : "—"}</td>
                <td>{e.placar ? `${e.placar.acertos.mantidos}/${e.placar.acertos.total}` : "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Evolucao({ agente, nome, d }: { agente: AgenteId; nome: string; d: Dados }) {
  const hist = d.overrides[agente] ?? [];
  const versoes = [{ versao: 1, em: "", origem: "pacote", motivo: "versão original" }, ...hist.map((h) => ({ versao: h.versao, em: h.em, origem: h.origem ?? "manual", motivo: h.motivo }))];
  const vs = d.vereditos.filter((v) => v.agente === agente);
  if (versoes.length === 1 && vs.length === 0) return null;
  return (
    <div className="est-evo">
      <p className="est-evo-nome">{nome}</p>
      {versoes.map((v) => {
        const dela = vs.filter((x) => (x.versao ?? 1) === v.versao);
        const runs = d.revs.flatMap((r) => r.agentes.filter((x) => x.agente === agente && x.versao === v.versao && !x.erro));
        return (
          <div key={v.versao} className="est-evo-linha">
            <span className="est-evo-v">v{v.versao}</span>
            <span className="est-evo-info">{v.origem}{v.em ? ` · ${new Date(v.em).toLocaleDateString("pt-BR")}` : ""} — <span title={v.motivo}>{v.motivo.split("\n")[0].slice(0, 90)}</span></span>
            <span>{dela.filter((x) => x.veredito !== "incerto").length} avaliados</span>
            <span>{runs.length ? `${media(runs.map((x) => x.achados)).toFixed(1)} achados/rev.` : "—"}</span>
            <Barra v={precisao(dela)} />
          </div>
        );
      })}
    </div>
  );
}

const Card = ({ rot, val, sub }: { rot: string; val: string; sub: string }) => (
  <div className="est-card"><span>{rot}</span><strong>{val}</strong><small>{sub}</small></div>
);
const Barra = ({ v }: { v: number | null }) => (
  <span className="est-barra" title={v == null ? "sem avaliações" : ""}><i style={{ width: `${(v ?? 0) * 100}%` }} className={v != null && v < 0.5 ? "ruim" : ""} /><b>{pct(v)}</b></span>
);

createRoot(document.getElementById("root")!).render(<App />);
