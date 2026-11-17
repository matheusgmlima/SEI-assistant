/**
 * Tela de correções (aba à parte): todos os achados dos agentes de um processo,
 * organizados por criticidade, com "Já alterei" / "Não é válida" (+ motivo).
 * Cada marcação vira um Veredito — é a evidência que o Controlador usa para
 * melhorar os prompts. "Já alterei" = achado procede; "Não é válida" = falso positivo.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseSaida, chaveAchado, type Problema, type Criticidade } from "@shared/agents/saida";
import type { Veredito, Falta } from "@shared/agents/controlador";
import type { EventoControlador, StatusControlador } from "../lib/agentes";
import { AGENTES, type AgenteId, type ResultadoAgente } from "@shared/agents/runner";
import { Icon } from "../sidebar/ui";

const processId = new URLSearchParams(location.search).get("proc") ?? "";
const sget = <T,>(k: string): Promise<T | undefined> => new Promise((r) => chrome.storage.local.get(k, (v) => r(v[k] as T)));
const sset = (o: Record<string, unknown>) => new Promise<void>((r) => chrome.storage.local.set(o, () => r()));

interface Item { chave: string; agente: AgenteId; nomeAgente: string; p: Problema; naoAchado: boolean; versao?: number }
const ORDEM: Criticidade[] = ["ALTA", "MÉDIA", "BAIXA"];
const CLASSE = { ALTA: "alta", MÉDIA: "media", BAIXA: "baixa" } as const;
const TITULO = { ALTA: "Prioridade alta", MÉDIA: "Prioridade média", BAIXA: "Prioridade baixa" } as const;
const DICA = { ALTA: "Podem gerar questionamento ou nulidade — vale corrigir antes de seguir.", MÉDIA: "Afetam clareza ou conformidade.", BAIXA: "Ajustes de forma: português, numeração, padronização." } as const;

function App() {
  const [revisao, setRevisao] = useState<{ em: string; documentos: { nome: string; papel?: string }[]; resultados: ResultadoAgente[] } | null | undefined>(undefined);
  const [vereditos, setVereditos] = useState<Veredito[]>([]);
  const [soPendentes, setSoPendentes] = useState(false);
  const [ctrl, setCtrl] = useState<{ status: StatusControlador | null; eventos: EventoControlador[] }>({ status: null, eventos: [] });
  const abertaEm = useRef(new Date().toISOString());
  const disparado = useRef(false);

  useEffect(() => {
    sget<typeof revisao>(`revisao_${processId}`).then((r) => setRevisao(r ?? null));
    sget<Veredito[]>("vereditos").then((v) => setVereditos(v ?? []));
    // a aba lateral também marca vereditos — mantém as duas telas em sincronia
    const ouvir = (ch: Record<string, chrome.storage.StorageChange>) => {
      if (ch.vereditos) setVereditos((ch.vereditos.newValue as Veredito[]) ?? []);
      if (ch[`revisao_${processId}`]) setRevisao(ch[`revisao_${processId}`].newValue as typeof revisao);
      if (ch.ctrlStatus || ch.ctrlLog) Promise.all([sget<StatusControlador>("ctrlStatus"), sget<EventoControlador[]>("ctrlLog")])
        .then(([status, log]) => setCtrl({ status: status ?? null, eventos: (log ?? []).filter((e) => e.em > abertaEm.current) }));
    };
    chrome.storage.onChanged.addListener(ouvir);
    return () => chrome.storage.onChanged.removeListener(ouvir);
  }, []);

  const itens = useMemo<Item[]>(() => (revisao?.resultados ?? []).flatMap((r) => {
    const nao = new Set(r.verificacao.naoEncontrados);
    return parseSaida(r.texto).problemas.map((p) => ({
      chave: `${processId}|${chaveAchado(r.agente, p)}`, agente: r.agente, nomeAgente: r.nome, p,
      naoAchado: p.trechos.some((t) => nao.has(t)), versao: r.versaoPrompt,
    }));
  }), [revisao]);

  const porChave = new Map(vereditos.map((v) => [v.chave, v]));

  // Concluiu a avaliação → controlador roda sozinho em segundo plano (o service worker
  // decide por agente se há evidência nova suficiente; disparar de novo não custa nada).
  function concluir() {
    disparado.current = true;
    chrome.runtime.sendMessage({ type: "CONTROLADOR_AUTO" });
  }
  const tudoAvaliado = itens.length > 0 && itens.every((i) => porChave.has(i.chave));
  useEffect(() => { if (tudoAvaliado && !disparado.current) concluir(); }, [tudoAvaliado]);

  async function marcar(it: Item, veredito: Veredito["veredito"] | null, nota?: string) {
    // lê do storage na hora: outra tela pode ter gravado no meio-tempo
    const atuais = ((await sget<Veredito[]>("vereditos")) ?? []).filter((v) => v.chave !== it.chave);
    const novos = veredito ? [...atuais, {
      chave: it.chave, processId, agente: it.agente, veredito, criticidade: it.p.criticidade, onde: it.p.onde,
      problema: it.p.problema, trecho: it.p.trechos[0] ?? "", ...(nota ? { nota } : {}), ...(it.versao ? { versao: it.versao } : {}), em: new Date().toISOString(),
    }] : atuais;
    setVereditos(novos);
    await sset({ vereditos: novos });
  }

  if (revisao === undefined) return <p className="cor-vazio">Carregando…</p>;
  if (!revisao) return (
    <div className="cor-vazio"><Icon n="doc" s={28} /><p><b>Nenhuma revisão salva para este processo.</b></p>
      <p>Na barra lateral do SEI, abra o processo e use a aba “Revisar”.</p></div>
  );

  const feitos = itens.filter((i) => porChave.has(i.chave)).length;
  const visiveis = soPendentes ? itens.filter((i) => !porChave.has(i.chave)) : itens;
  const pct = itens.length ? (feitos / itens.length) * 100 : 0;

  return (
    <div className="cor">
      <header className="cor-barra-topo">
        <div className="cor-barra-topo-in">
          <div className="cor-titulo">
            <h1>Correções sugeridas</h1>
            <p className="cor-meta">Processo <b>{processId}</b> · revisado em {new Date(revisao.em).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</p>
          </div>
          <div className="cor-progresso" aria-label="Progresso da avaliação">
            <span><strong>{feitos}</strong> de {itens.length} avaliadas</span>
            <div className="cor-barra"><span style={{ width: `${pct}%` }} /></div>
            <label className="cor-filtro"><input type="checkbox" checked={soPendentes} onChange={(e) => setSoPendentes(e.target.checked)} /> Só as que faltam</label>
          </div>
        </div>
      </header>

      <div className="cor-docs">{revisao.documentos.map((d) => <span key={d.nome} className={`cor-doc ${d.papel === "referencia" ? "cor-doc--ref" : ""}`}><Icon n="doc" s={13} />{d.nome}{d.papel === "referencia" && <small> · referência</small>}</span>)}</div>

      {feitos === 0 && itens.length > 0 && (
        <section className="cor-como">
          <p className="cor-como-tit">Como usar esta lista</p>
          <ol>
            <li>Abra o documento no SEI e procure o <b>local</b> indicado em cada correção.</li>
            <li>Concordou e corrigiu? Marque <b>Já alterei</b>. Use “Copiar sugestão” para colar o texto.</li>
            <li>Discorda? Marque <b>Não é válida</b> e diga em uma frase o porquê — é isso que ensina a revisão a não repetir o erro.</li>
          </ol>
        </section>
      )}

      {tudoAvaliado && (
        <div className="cor-fim"><Icon n="ok" s={18} /><div><b>Tudo avaliado — obrigado!</b> Suas respostas já estão sendo usadas para melhorar os revisores. Pode fechar esta aba.</div></div>
      )}
      {!tudoAvaliado && feitos > 0 && (
        <div className="cor-parcial"><span>Não vai avaliar todas agora? Envie o que já marcou.</span>
          <button className="btn btn--ghost btn--sm" onClick={concluir}>Enviar avaliações</button></div>
      )}

      {(ctrl.status?.fase || ctrl.eventos.length > 0) && (
        <div className="cor-ctrl" role="status">
          {ctrl.status?.fase && <p><span className="collect-spinner" /> {ctrl.status.fase}</p>}
          {ctrl.eventos.map((e) => (
            <p key={e.id}><b>{AGENTES.find((a) => a.id === e.agente)?.nome}:</b> {
              e.tipo === "aplicado" ? `ajustado (versão ${e.versao}) — vale na próxima revisão.`
              : e.tipo === "pendente" ? `melhoria proposta, aguardando aprovação (${e.motivo}).`
              : e.tipo === "sem_mudanca" ? "sem mudança por enquanto — ainda há pouca evidência."
              : e.tipo === "erro" ? `não foi possível ajustar: ${e.diagnostico}` : e.tipo}</p>
          ))}
        </div>
      )}

      {itens.length === 0 && <div className="cor-vazio"><Icon n="ok" s={28} /><p><b>Nenhuma correção sugerida.</b> Os revisores não encontraram problemas nestes documentos.</p></div>}

      {ORDEM.map((c) => {
        const grupo = visiveis.filter((i) => i.p.criticidade === c);
        if (!grupo.length) return null;
        return (
          <section key={c} className="cor-secao">
            <h2 className={`cor-grupo cor-grupo--${CLASSE[c]}`}><span className="cor-grupo-dot" />{TITULO[c]} <span className="cor-grupo-n">{grupo.length}</span></h2>
            <p className="cor-grupo-dica">{DICA[c]}</p>
            {grupo.map((it) => <Cartao key={it.chave} it={it} v={porChave.get(it.chave)} onMarcar={marcar} />)}
          </section>
        );
      })}
      {soPendentes && visiveis.length === 0 && itens.length > 0 && <p className="cor-vazio">Nenhuma pendente. <button className="btn-link" onClick={() => setSoPendentes(false)}>Mostrar todas</button></p>}

      <Faltou />
    </div>
  );
}

function Cartao({ it, v, onMarcar }: { it: Item; v?: Veredito; onMarcar: (it: Item, v: Veredito["veredito"] | null, nota?: string) => void }) {
  const [motivo, setMotivo] = useState(v?.nota ?? "");
  useEffect(() => { setMotivo(v?.nota ?? ""); }, [v?.nota]); // avaliações salvas chegam depois do 1º render
  const estado = v?.veredito;
  const salvo = (v?.nota ?? "") === motivo.trim();

  const [copiado, setCopiado] = useState(false);
  function copiar() {
    navigator.clipboard.writeText(it.p.correcao).then(() => { setCopiado(true); setTimeout(() => setCopiado(false), 1500); });
  }
  const opcao = (val: NonNullable<Veredito["veredito"]>, rot: string, cls: string, nota?: string) => (
    <button className={`cor-op ${cls} ${estado === val ? "on" : ""}`} aria-pressed={estado === val}
      onClick={() => onMarcar(it, estado === val ? null : val, nota)}>
      <span className="cor-op-marca">{estado === val && <Icon n="ok" s={12} />}</span>{rot}
    </button>
  );

  return (
    <article className={`cor-item cor-item--${CLASSE[it.p.criticidade]} ${estado ? "cor-item--feito" : ""}`}>
      <div className="cor-corpo">
        <div className="cor-onde">{it.p.onde}</div>
        <div className="cor-problema">{it.p.problema}</div>
        {it.p.trechos.map((t, i) => (
          <blockquote key={i} className="cor-trecho">{t === "(ausente)" ? <em>Não consta no documento</em> : <>“{t}”</>}</blockquote>
        ))}
        {it.naoAchado && <div className="cor-alerta"><Icon n="alerta" s={13} /> Este trecho não foi encontrado no documento — confira com atenção antes de alterar.</div>}
        {it.p.correcao && (
          <div className="cor-correcao">
            <div><strong>Sugestão:</strong> {it.p.correcao}</div>
            <button className="btn-link" onClick={copiar}>{copiado ? <><Icon n="ok" s={12} /> Copiado</> : "Copiar sugestão"}</button>
          </div>
        )}
        <div className="cor-agente">Apontado por: {it.nomeAgente}</div>
      </div>

      <div className="cor-acoes" role="group" aria-label="Sua avaliação">
        <span className="cor-acoes-rot">Sua avaliação</span>
        {opcao("procede", "Já alterei", "cor-op--ok")}
        {opcao("falso_positivo", "Não é válida", "cor-op--inv", motivo.trim() || undefined)}
        {opcao("incerto", "Não sei avaliar", "cor-op--inc")}
        {estado === "falso_positivo" && (
          <div className="cor-motivo">
            <label htmlFor={`m-${it.chave}`}>Por que não é válida?</label>
            <textarea id={`m-${it.chave}`} rows={3} value={motivo} placeholder="Ex.: o valor está correto, a tabela soma os itens com frete…" onChange={(e) => setMotivo(e.target.value)} />
            <button className="btn btn--primary btn--sm" disabled={salvo} onClick={() => onMarcar(it, "falso_positivo", motivo.trim() || undefined)}>{salvo && motivo.trim() ? "Motivo salvo" : "Salvar motivo"}</button>
            {!v?.nota && <span className="cor-dica">Sem o motivo, esta avaliação ajuda pouco.</span>}
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
      <p className="cor-dica">Se você viu um problema que os revisores não pegaram, conte aqui — ele entra no aprendizado.</p>
      <div className="cor-faltou-linha">
        <select aria-label="Tipo de erro" value={agente} onChange={(e) => setAgente(e.target.value as AgenteId)}>
          {AGENTES.map((a) => <option key={a.id} value={a.id}>{a.nome}</option>)}
        </select>
        <input value={texto} placeholder="Descreva o erro que os agentes não viram" onChange={(e) => { setTexto(e.target.value); setOk(false); }}
          onKeyDown={(e) => e.key === "Enter" && texto.trim() && enviar()} />
        <button className="btn btn--primary btn--sm" disabled={!texto.trim()} onClick={enviar}>Registrar</button>
      </div>
      {ok && <p className="cor-ok">Registrado, obrigado.</p>}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
