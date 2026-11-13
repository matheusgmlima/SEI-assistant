/**
 * Revisão documental por agentes (aba do processo) + Controlador dos agentes.
 * Fluxo: listar documentos da árvore do SEI → ler (HTML/PDF) → rodar os agentes →
 * o servidor dá veredito em cada achado → o Controlador propõe melhoria de prompt,
 * testa a regressão nos casos salvos e só aplica com aprovação.
 */
import { useEffect, useMemo, useState } from "react";
import { GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { pdfToText } from "@shared/agents/pdf-text";
import { rodarAgente, agentesAplicaveis, montarMensagens, AGENTES, type AgenteId, type Documento, type Prompts, type ResultadoAgente, type LlmConfig } from "@shared/agents/runner";
import { parseSaida, chaveAchado, type Problema } from "@shared/agents/saida";
import type { Veredito, Falta } from "@shared/agents/controlador";
import { ehDocumentoPrincipal, type TipoDoc } from "@shared/agents/sei-docs";
import {
  promptsAtivos, sget, sset, configLlm, coletarEvidencias, proporMelhoria, testarProposta, aplicarVersao, voltarParaVersao,
  marcarEvento, registrarEvento, registrarRevisao, type Overrides, type RevisaoSalva, type Evidencias, type Proposta, type EventoControlador, type StatusControlador,
} from "../lib/agentes";

GlobalWorkerOptions.workerSrc = workerUrl;

// ── Cache de resultados: mesma entrada (documento + prompt + ferramentas + modelo) = mesma
// revisão — não paga de novo. Prompt aprovado pelo controlador ou documento editado muda a chave.
const CACHE_MAX = 80;
let filaCache = Promise.resolve(); // 6 agentes gravando ao mesmo tempo: serializa para não perder entrada
async function sha256(t: string) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function rodarComCache(id: AgenteId, docs: Documento[], cfg: LlmConfig, prompts: Prompts): Promise<ResultadoAgente & { doCache?: boolean }> {
  const ag = AGENTES.find((a) => a.id === id)!;
  const chave = await sha256(JSON.stringify([id, cfg.model, cfg.modelRapido, montarMensagens(ag, prompts, docs)]));
  const salvo = ((await sget<Record<string, ResultadoAgente> | undefined>("cacheAgentes")) ?? {})[chave];
  if (salvo && !salvo.erro) return { ...salvo, doCache: true };
  const r = await rodarAgente(id, docs, cfg, prompts);
  if (!r.erro) filaCache = filaCache.then(async () => {
    const c = (await sget<Record<string, ResultadoAgente> | undefined>("cacheAgentes")) ?? {};
    c[chave] = r;
    const chaves = Object.keys(c);
    for (const k of chaves.slice(0, Math.max(0, chaves.length - CACHE_MAX))) delete c[k]; // mais antigas primeiro
    await sset({ cacheAgentes: c });
  });
  return r;
}

const abrirCorrecoes = (proc: string) =>
  chrome.tabs.create({ url: chrome.runtime.getURL("dist/correcoes.html") + "?proc=" + encodeURIComponent(proc) });

function enviarAbaAtiva<T>(msg: unknown): Promise<T> {
  return new Promise((resolve, reject) => chrome.tabs.query({ url: "https://sei.cloud.tjpe.jus.br/*" }, (tabs) => {
    // prefere a aba do SEI que está à vista; a ativa pode ser a tela de correções
    const id = (tabs.find((t) => t.active) ?? tabs[0])?.id;
    if (!id) return reject(new Error("Abra o SEI numa aba do Chrome."));
    chrome.tabs.sendMessage(id, msg, (res) => {
      if (chrome.runtime.lastError || !res) return reject(new Error("Não consegui falar com o SEI. Recarregue a página do SEI (F5)."));
      res.ok ? resolve(res.dados as T) : reject(new Error(res.erro));
    });
  }));
}
/** Abre o processo no SEI se preciso (cliques no Controle de Processos → processo) e
 *  espera a página dele carregar. Mesma navegação segura da coleta do resumo. */
async function garantirProcessoAberto(processId: string) {
  const { pronto } = await enviarAbaAtiva<{ pronto: boolean }>({ type: "REVISAO_ABRIR", payload: { processId } });
  if (pronto) return;
  const chave = `revisaoAberta_${processId}`;
  await sset({ [chave]: null });
  const r = await new Promise<number | null>((resolve) => {
    const fim = setTimeout(() => { chrome.storage.onChanged.removeListener(ouvir); resolve(null); }, 45_000);
    function ouvir(ch: Record<string, chrome.storage.StorageChange>) {
      if (ch[chave]?.newValue == null) return;
      clearTimeout(fim); chrome.storage.onChanged.removeListener(ouvir); resolve(ch[chave].newValue as number);
    }
    chrome.storage.onChanged.addListener(ouvir);
  });
  if (r == null) throw new Error("O SEI demorou para abrir o processo. Tente de novo.");
  if (r === -1) throw new Error("Este processo não aparece no Controle de Processos da unidade. Abra-o manualmente no SEI e tente de novo.");
}

const base64ParaBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const ICONE: Record<TipoDoc | "?", string> = { pdf: "📕", interno: "📄", formulario: "📋", outro: "📎", "?": "📎" };

// ════════════════════════════════════════════════════════════════════════════════
// Aba "Revisão" do processo
// ════════════════════════════════════════════════════════════════════════════════
export function RevisaoPanel({ processId, hasApiKey, onSettings }: { processId: string; hasApiKey: boolean; onSettings: () => void }) {
  const [docs, setDocs] = useState<{ idInterno: string; numero: string; titulo: string; tipo: TipoDoc }[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [fase, setFase] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [status, setStatus] = useState<Partial<Record<AgenteId, "rodando" | "ok" | "erro">>>({});
  const [salva, setSalva] = useState<RevisaoSalva | null>(null);
  const [vereditos, setVereditos] = useState<Veredito[]>([]);

  useEffect(() => {
    sget<RevisaoSalva | undefined>(`revisao_${processId}`).then((r) => setSalva(r ?? null));
    sget<Veredito[] | undefined>("vereditos").then((v) => setVereditos(v ?? []));
    // a tela de correções também grava vereditos
    const ouvir = (ch: Record<string, chrome.storage.StorageChange>) => { if (ch.vereditos) setVereditos((ch.vereditos.newValue as Veredito[]) ?? []); };
    chrome.storage.onChanged.addListener(ouvir);
    return () => chrome.storage.onChanged.removeListener(ouvir);
  }, [processId]);

  async function listar() {
    setErro(null); setFase("Abrindo o processo no SEI…");
    try {
      await garantirProcessoAberto(processId);
      setFase("Lendo a árvore do processo…");
      const lista = await enviarAbaAtiva<typeof docs>({ type: "REVISAO_LISTAR", payload: { processId } });
      setDocs(lista);
      setSel(new Set((lista ?? []).filter((d) => ehDocumentoPrincipal(d.titulo)).map((d) => d.idInterno)));
    } catch (e) { setErro(String((e as Error).message)); }
    setFase(null);
  }

  async function revisar() {
    setErro(null); setStatus({});
    const cfg = await configLlm("agentes");
    if (!cfg) { onSettings(); return; }
    try {
      setFase("Conferindo se o processo está aberto no SEI…");
      await garantirProcessoAberto(processId); // a pessoa pode ter mudado de página depois de listar
      setFase(`Baixando ${sel.size} documento(s) do SEI…`);
      const lidos = await enviarAbaAtiva<{ idInterno: string; titulo: string; tipo: string; texto?: string; pdfBase64?: string; erro?: string }[]>({ type: "REVISAO_LER", payload: { ids: [...sel] } });
      const documentos: Documento[] = [];
      const avisos: string[] = [];
      for (const d of lidos) {
        if (d.erro) { avisos.push(`${d.titulo}: ${d.erro}`); continue; }
        setFase(`Extraindo texto: ${d.titulo.slice(0, 50)}…`);
        const texto = d.pdfBase64 ? (await pdfToText(base64ParaBytes(d.pdfBase64))).texto : d.texto ?? "";
        if (texto.trim().length < 200) { avisos.push(`${d.titulo}: sem texto legível (PDF escaneado?) — não analisado`); continue; }
        documentos.push({ nome: d.titulo, texto });
      }
      if (!documentos.length) throw new Error(avisos.join(" · ") || "Nenhum documento com texto.");
      if (avisos.length) setErro(avisos.join(" · "));
      await sset({ [`revisaoDocs_${processId}`]: documentos }); // casos para a regressão do controlador
      const ids = agentesAplicaveis(documentos);
      setFase(`Rodando ${ids.length} agentes em ${documentos.length} documento(s)…`);
      setStatus(Object.fromEntries(ids.map((i) => [i, "rodando"])));
      const overrides = (await sget<Overrides | undefined>("promptOverrides")) ?? {};
      const prompts = promptsAtivos(overrides);
      const res = await Promise.all(ids.map((id) => rodarComCache(id, documentos, cfg, prompts)
        .then((r) => { setStatus((s) => ({ ...s, [id]: "ok" })); return r; })
        .catch((e) => { setStatus((s) => ({ ...s, [id]: "erro" })); return { agente: id, nome: AGENTES.find((a) => a.id === id)!.nome, texto: "", erro: String((e as Error)?.message ?? e), ms: 0, tokens: { entrada: 0, saida: 0 }, chamadasFerramenta: [], verificacao: { total: 0, verificados: 0, naoEncontrados: [] }, violacoes: [] } as ResultadoAgente; })));
      for (const r of res) r.versaoPrompt = (overrides[r.agente]?.length ?? 0) + 1;
      void registrarRevisao({ em: new Date().toISOString(), processId, documentos: documentos.length,
        agentes: res.map((r) => ({ agente: r.agente, achados: parseSaida(r.texto).problemas.length, custoUsd: (r as { doCache?: boolean }).doCache ? 0 : r.custoUsd ?? 0,
          tokens: r.tokens.entrada + r.tokens.saida, versao: r.versaoPrompt ?? 1, doCache: !!(r as { doCache?: boolean }).doCache, erro: !!r.erro })) });
      const falhas = res.filter((r) => r.erro);
      if (falhas.length === res.length) throw new Error(`Nenhum agente rodou. ${falhas[0].erro} — confira em ⚙ se o provider é "LiteLLM TJPE" e a chave está correta (modelo usado: ${cfg.model}).`);
      if (falhas.length) setErro(`${falhas.length} agente(s) falharam: ${falhas[0].erro}`);
      const reaproveitados = res.filter((r) => (r as { doCache?: boolean }).doCache).length;
      const nova: RevisaoSalva = { em: new Date().toISOString(), modelo: cfg.model, reaproveitados, documentos: documentos.map((d) => ({ nome: d.nome, caracteres: d.texto.length })), resultados: res };
      await sset({ [`revisao_${processId}`]: nova });
      setSalva(nova);
      abrirCorrecoes(processId);
    } catch (e) { setErro(String((e as Error).message)); }
    setFase(null);
  }

  async function darVeredito(agente: AgenteId, p: Problema, veredito: Veredito["veredito"] | null) {
    const chave = `${processId}|${chaveAchado(agente, p)}`;
    const resto = vereditos.filter((v) => v.chave !== chave);
    const nota = veredito === "falso_positivo" ? vereditos.find((v) => v.chave === chave)?.nota : undefined; // não perde o motivo escrito na tela de correções
    const versao = salva?.resultados.find((r) => r.agente === agente)?.versaoPrompt;
    const novos = veredito ? [...resto, { chave, processId, agente, veredito, criticidade: p.criticidade, onde: p.onde, problema: p.problema, trecho: p.trechos[0] ?? "", ...(nota ? { nota } : {}), ...(versao ? { versao } : {}), em: new Date().toISOString() }] : resto;
    setVereditos(novos);
    await sset({ vereditos: novos });
  }

  async function registrarFalta(agente: AgenteId, texto: string) {
    const faltas = (await sget<Falta[] | undefined>("faltas")) ?? [];
    await sset({ faltas: [...faltas, { processId, agente, texto, em: new Date().toISOString() }] });
  }

  if (!hasApiKey) return (
    <div className="rev-vazio"><p>Configure a chave da IA para usar os agentes.</p><button className="btn-collect" onClick={onSettings}>⚙ Configurar</button></div>
  );

  const ocupado = !!fase;
  const tokens = salva?.resultados.filter((r) => !(r as { doCache?: boolean }).doCache).reduce((a, r) => a + r.tokens.entrada + r.tokens.saida, 0) ?? 0; // só o que foi pago nesta rodada

  return (
    <div className="rev">
      <div className="rev-passo">
        <button className="btn-collect" onClick={listar} disabled={ocupado}>
          {docs ? "↻ Atualizar lista de documentos" : "📂 Listar documentos do processo"}
        </button>
        {docs && (
          <>
            <div className="rev-docs">
              {docs.map((d) => (
                <label key={d.idInterno} className={`rev-doc ${sel.has(d.idInterno) ? "rev-doc--on" : ""}`}>
                  <input type="checkbox" checked={sel.has(d.idInterno)} disabled={ocupado}
                    onChange={() => setSel((s) => { const n = new Set(s); n.has(d.idInterno) ? n.delete(d.idInterno) : n.add(d.idInterno); return n; })} />
                  <span>{ICONE[d.tipo]}</span><span className="rev-doc-titulo">{d.titulo}</span>
                </label>
              ))}
            </div>
            <button className="btn-collect rev-rodar" onClick={revisar} disabled={ocupado || sel.size === 0}>
              ▶ Revisar {sel.size} documento(s) com os agentes
            </button>
            {sel.size === 1 && <p className="rev-dica">Com 2+ documentos o Validador de Consistência compara entre eles.</p>}
          </>
        )}
      </div>

      {fase && <div className="rev-fase"><span className="collect-spinner" />{fase}
        <div className="rev-status">{Object.entries(status).map(([id, s]) => <span key={id} className={`rev-st rev-st--${s}`}>{AGENTES.find((a) => a.id === id)?.nome.split(" ")[0]} {s === "ok" ? "✓" : s === "erro" ? "✗" : "…"}</span>)}</div>
      </div>}
      {erro && <div className="summary-error summary-error--inline"><p>{erro}</p></div>}

      {salva && !fase && (
        <div className="rev-resultados">
          <p className="processes-meta">
            Revisado em {new Date(salva.em).toLocaleString("pt-BR")} · {salva.documentos.length} doc(s) · {Math.round(tokens / 1000)} mil tokens{salva.reaproveitados ? ` · ${salva.reaproveitados} agente(s) reaproveitado(s) sem custo` : ""}
          </p>
          <button className="btn-collect" onClick={() => abrirCorrecoes(processId)}>📋 Abrir tela de correções</button>
          {salva.resultados.map((r) => <CartaoAgente key={r.agente} r={r} processId={processId} vereditos={vereditos} onVeredito={darVeredito} onFalta={registrarFalta} />)}
        </div>
      )}
    </div>
  );
}

function CartaoAgente({ r, processId, vereditos, onVeredito, onFalta }: {
  r: ResultadoAgente; processId: string; vereditos: Veredito[];
  onVeredito: (a: AgenteId, p: Problema, v: Veredito["veredito"] | null) => void; onFalta: (a: AgenteId, t: string) => void;
}) {
  const s = useMemo(() => parseSaida(r.texto), [r.texto]);
  // revisões antigas guardavam a falha no texto ("Erro: ...")
  const falha = r.erro ?? (r.texto.startsWith("Erro:") ? r.texto.slice(5).trim() : undefined);
  const [aberto, setAberto] = useState(s.problemas.length > 0 || !!falha);
  const [falta, setFalta] = useState("");
  const [faltaOk, setFaltaOk] = useState(false);
  const naoAchados = new Set(r.verificacao.naoEncontrados);
  const n = { ALTA: 0, MÉDIA: 0, BAIXA: 0 };
  s.problemas.forEach((p) => n[p.criticidade]++);

  return (
    <div className="rev-agente">
      <button className="rev-agente-head" onClick={() => setAberto((a) => !a)}>
        <span className="rev-agente-nome">{r.nome}</span>
        <span className="rev-badges">
          {n.ALTA > 0 && <span className="rev-badge rev-badge--alta">{n.ALTA} alta</span>}
          {n.MÉDIA > 0 && <span className="rev-badge rev-badge--media">{n.MÉDIA} média</span>}
          {n.BAIXA > 0 && <span className="rev-badge rev-badge--baixa">{n.BAIXA} baixa</span>}
          {falha && <span className="rev-badge rev-badge--alta">✗ falhou</span>}
          {!falha && s.problemas.length === 0 && <span className="rev-badge rev-badge--ok">✓ ok</span>}
        </span>
      </button>
      {aberto && (
        <div className="rev-agente-corpo">
          {falha && <div className="summary-error summary-error--inline"><p>Este agente não rodou: {falha}</p></div>}
          <p className="rev-resumo">{s.resumo}</p>
          {s.problemas.map((p) => {
            const meu = vereditos.find((v) => v.chave === `${processId}|${chaveAchado(r.agente, p)}`)?.veredito;
            return (
              <div key={p.n} className={`rev-prob rev-prob--${p.criticidade === "ALTA" ? "alta" : p.criticidade === "MÉDIA" ? "media" : "baixa"}`}>
                <div className="rev-prob-onde">{p.onde}</div>
                <div className="rev-prob-txt">{p.problema}</div>
                {p.trechos.map((t, i) => (
                  <div key={i} className="rev-trecho">
                    {t === "(ausente)" ? <em>(ausente no documento)</em> : <>“{t}”{naoAchados.has(t) && <span className="rev-alerta" title="Este trecho não foi encontrado no documento — desconfie deste achado"> ⚠ não encontrado</span>}</>}
                  </div>
                ))}
                {p.correcao && <div className="rev-corr">→ {p.correcao}</div>}
                <div className="rev-veredito">
                  <button className={meu === "procede" ? "on" : ""} onClick={() => onVeredito(r.agente, p, meu === "procede" ? null : "procede")}>✓ Já alterei</button>
                  <button className={meu === "falso_positivo" ? "on fp" : ""} onClick={() => onVeredito(r.agente, p, meu === "falso_positivo" ? null : "falso_positivo")}>✗ Não é válida</button>
                </div>
              </div>
            );
          })}
          {s.conferido && <p className="rev-conferido">Conferido: {s.conferido}</p>}
          <div className="rev-falta">
            <input placeholder="Faltou apontar algo? Descreva e tecle Enter" value={falta} onChange={(e) => { setFalta(e.target.value); setFaltaOk(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" && falta.trim()) { onFalta(r.agente, falta.trim()); setFalta(""); setFaltaOk(true); } }} />
            {faltaOk && <span className="rev-falta-ok">registrado ✓</span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// Tela do Controlador — painel: atividade automática, pendências e modo manual
// ════════════════════════════════════════════════════════════════════════════════
const ROTULO: Record<EventoControlador["tipo"], string> = {
  aplicado: "✓ Ajustado", pendente: "⏳ Aguardando sua decisão", sem_mudanca: "• Sem mudança (evidência insuficiente)",
  erro: "✗ Erro", descartado: "Descartado", desfeito: "↶ Desfeito",
};

export function ControladorScreen({ onBack }: { onBack: () => void }) {
  const [dados, setDados] = useState<Evidencias | null>(null);
  const [log, setLog] = useState<EventoControlador[]>([]);
  const [status, setStatus] = useState<StatusControlador | null>(null);
  const [proposta, setProposta] = useState<Proposta | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  async function carregar() {
    setDados(await coletarEvidencias());
    setLog((await sget<EventoControlador[] | undefined>("ctrlLog")) ?? []);
    setStatus((await sget<StatusControlador | undefined>("ctrlStatus")) ?? null);
  }
  useEffect(() => {
    carregar();
    const ouvir = (ch: Record<string, chrome.storage.StorageChange>) => { if (ch.ctrlLog || ch.ctrlStatus || ch.promptOverrides || ch.vereditos) carregar(); };
    chrome.storage.onChanged.addListener(ouvir);
    return () => chrome.storage.onChanged.removeListener(ouvir);
  }, []);

  const nome = (a: AgenteId) => AGENTES.find((x) => x.id === a)!.nome;

  async function propor(agente: AgenteId) {
    if (!dados) return;
    setErro(null); setAviso(null); setProposta(null); setOcupado(`Controlador analisando ${nome(agente)}…`);
    try { setProposta(await proporMelhoria(agente, dados)); } catch (e) { setErro(String((e as Error).message)); }
    setOcupado(null);
  }
  async function testar() {
    if (!proposta || !dados) return;
    setErro(null);
    try { const placar = await testarProposta(proposta, dados, setOcupado); setProposta({ ...proposta, placar }); }
    catch (e) { setErro(String((e as Error).message)); }
    setOcupado(null);
  }
  async function aplicar() {
    if (!proposta) return;
    const versao = await aplicarVersao(proposta.agente, proposta.prompt, proposta.mudancas, "manual");
    await registrarEvento({ agente: proposta.agente, tipo: "aplicado", diagnostico: proposta.diagnostico, mudancas: proposta.mudancas, placar: proposta.placar, versao });
    setAviso(`✓ Versão ${versao} do ${nome(proposta.agente)} aplicada — vale a partir da próxima revisão.`);
    setProposta(null);
  }
  async function decidirPendente(e: EventoControlador, aceitar: boolean) {
    if (aceitar && e.prompt) {
      const versao = await aplicarVersao(e.agente, e.prompt, e.mudancas ?? "", "manual");
      await marcarEvento(e.id, "aplicado", versao);
      setAviso(`✓ Versão ${versao} do ${nome(e.agente)} aplicada.`);
    } else await marcarEvento(e.id, "descartado");
  }
  async function desfazer(e: EventoControlador) {
    if (!e.versao) return;
    await voltarParaVersao(e.agente, e.versao - 1);
    await marcarEvento(e.id, "desfeito");
    setAviso(`↶ ${nome(e.agente)} voltou para a versão ${e.versao - 1}.`);
  }

  async function exportar() {
    const tudo = await sget<Record<string, unknown>>(null);
    const blob = new Blob([JSON.stringify({ tipo: "sei-assistant-controlador", em: new Date().toISOString(), vereditos: tudo.vereditos ?? [], faltas: tudo.faltas ?? [], promptOverrides: tudo.promptOverrides ?? {} }, null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `controlador-agentes-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  }
  async function importar(f: File) {
    try {
      const j = JSON.parse(await f.text());
      if (j.tipo !== "sei-assistant-controlador") throw new Error("arquivo não é um export do controlador");
      const atual = await sget<Record<string, unknown>>(null);
      const uniq = <T,>(xs: T[], k: (x: T) => string) => [...new Map(xs.map((x) => [k(x), x])).values()];
      await sset({
        vereditos: uniq([...((atual.vereditos as Veredito[]) ?? []), ...(j.vereditos ?? [])], (v) => v.chave),
        faltas: uniq([...((atual.faltas as Falta[]) ?? []), ...(j.faltas ?? [])], (x) => x.processId + x.agente + x.texto),
      });
    } catch (e) { setErro(`Importação falhou: ${(e as Error).message}`); }
  }

  // Desfazer só na versão que está ativa agora (desfazer uma antiga apagaria as posteriores)
  const versaoAtiva = (a: AgenteId) => (dados?.overrides[a]?.length ?? 0) + 1;

  return (
    <div className="screen screen--active">
      <header className="screen-header">
        <button className="btn-back" onClick={onBack}>‹</button>
        <span className="screen-title">Controlador dos agentes</span>
      </header>
      <div className="ctrl">
        <p className="ctrl-intro">O controlador roda sozinho quando uma avaliação é concluída na tela de correções. Ele só ajusta um agente automaticamente se o teste eliminar falso alarme sem perder nenhum acerto (dá para desfazer) — o resto fica aqui para você decidir.</p>
        {status?.fase && <div className="rev-fase"><span className="collect-spinner" />{status.fase}</div>}
        {aviso && <div className="rev-fase">{aviso}</div>}
        {!proposta && erro && <div className="summary-error summary-error--inline"><p>{erro}</p></div>}

        {log.length > 0 && (
          <div className="ctrl-log">
            <p className="ctrl-rot">Atividade recente</p>
            {log.slice(0, 12).map((e) => (
              <div key={e.id} className={`ctrl-evento ctrl-evento--${e.tipo}`}>
                <div className="ctrl-evento-top"><b>{nome(e.agente)}</b> · {ROTULO[e.tipo]}{e.versao ? ` (v${e.versao})` : ""}
                  <span className="ctrl-quando">{new Date(e.em).toLocaleString("pt-BR")}</span></div>
                {e.motivo && e.tipo === "pendente" && <div className="rev-dica">Não aplicado sozinho porque {e.motivo}.</div>}
                {(e.mudancas || e.diagnostico) && <details><summary>{e.tipo === "erro" ? "detalhe" : "o que mudou e por quê"}</summary>
                  {e.diagnostico && <pre className="ctrl-pre">{e.diagnostico}</pre>}{e.mudancas && <pre className="ctrl-pre">{e.mudancas}</pre>}</details>}
                {e.placar && <div className="ctrl-placar-linha">Falsos alarmes eliminados {e.placar.falsosPositivos.eliminados}/{e.placar.falsosPositivos.total} · acertos mantidos {e.placar.acertos.mantidos}/{e.placar.acertos.total}</div>}
                <div className="ctrl-acoes">
                  {e.tipo === "pendente" && <><button className="btn-collect" onClick={() => decidirPendente(e, true)}>✓ Aplicar</button>
                    <button className="btn-collect-reset" onClick={() => decidirPendente(e, false)}>Descartar</button></>}
                  {e.tipo === "aplicado" && e.versao === versaoAtiva(e.agente) &&
                    <button className="btn-collect-reset" onClick={() => desfazer(e)}>↶ Desfazer</button>}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="ctrl-rot">Agentes</p>
        {dados && AGENTES.map((a) => {
          const vs = dados.vereditos.filter((v) => v.agente === a.id);
          const fp = vs.filter((v) => v.veredito === "falso_positivo").length;
          const ok = vs.filter((v) => v.veredito === "procede").length;
          const fl = dados.faltas.filter((f) => f.agente === a.id).length;
          const sinais = dados.sinais.filter((s) => s.agente === a.id).reduce((n, s) => n + s.trechosNaoEncontrados.length + s.violacoes.length, 0);
          const hist = dados.overrides[a.id] ?? [];
          return (
            <div key={a.id} className="ctrl-agente">
              <div className="ctrl-agente-top">
                <span className="rev-agente-nome">{a.nome}</span>
                <span className="ctrl-versao">v{hist.length + 1}</span>
              </div>
              <div className="ctrl-num">
                <span>✓ {ok} procede</span><span className={fp ? "ruim" : ""}>✗ {fp} falso alarme</span>
                <span className={fl ? "ruim" : ""}>+ {fl} faltou</span><span className={sinais ? "ruim" : ""}>⚙ {sinais} sinal(is)</span>
              </div>
              <div className="ctrl-acoes">
                <button className="btn-collect-reset" disabled={!!ocupado || fp + fl + sinais === 0} onClick={() => propor(a.id)}>🧠 Propor melhoria (manual)</button>
                {hist.length > 0 && <button className="btn-collect-reset" onClick={() => voltarParaVersao(a.id, hist.length)}>↶ Voltar 1 versão</button>}
              </div>
            </div>
          );
        })}

        {proposta && (
          <div className="ctrl-proposta">
            <p className="rev-agente-nome">Proposta para {nome(proposta.agente)}</p>
            <p className="ctrl-rot">Diagnóstico</p><pre className="ctrl-pre">{proposta.diagnostico}</pre>
            <p className="ctrl-rot">Mudanças</p><pre className="ctrl-pre">{proposta.mudancas}</pre>
            <p className="ctrl-rot">Prompt revisado (pode editar)</p>
            <textarea className="ctrl-prompt" value={proposta.prompt} onChange={(e) => setProposta({ ...proposta, prompt: e.target.value, placar: undefined })} />
            {proposta.placar && (
              <div className="ctrl-placar">
                <div>Falsos alarmes eliminados: <b>{proposta.placar.falsosPositivos.eliminados}/{proposta.placar.falsosPositivos.total}</b></div>
                <div>Acertos mantidos: <b className={proposta.placar.acertos.perdidos.length ? "ruim" : ""}>{proposta.placar.acertos.mantidos}/{proposta.placar.acertos.total}</b></div>
                {proposta.placar.acertos.perdidos.map((x, i) => <div key={i} className="ruim">⚠ perdeu: {x}</div>)}
                {proposta.placar.falsosPositivos.persistentes.map((x, i) => <div key={i}>• ainda aponta: {x}</div>)}
              </div>
            )}
            {ocupado && <div className="rev-fase"><span className="collect-spinner" />{ocupado}</div>}
            {erro && <div className="summary-error summary-error--inline"><p>{erro}</p></div>}
            {!proposta.placar && !ocupado && <p className="rev-dica">1º clique em 🧪 Testar (roda o agente de novo nos processos já avaliados, leva ~1 min). Depois o Aprovar libera.</p>}
            <div className="ctrl-acoes">
              <button className="btn-collect-reset" disabled={!!ocupado} onClick={testar}>🧪 Testar nos casos salvos</button>
              <button className="btn-collect" disabled={!proposta.placar || !!ocupado} onClick={aplicar}
                title={proposta.placar ? "" : "Teste antes de aplicar"}>{proposta.placar ? "✓ Aprovar e aplicar" : "✓ Aprovar (teste primeiro)"}</button>
              <button className="btn-collect-reset" onClick={() => setProposta(null)}>Descartar</button>
            </div>
          </div>
        )}
        {!proposta && ocupado && <div className="rev-fase"><span className="collect-spinner" />{ocupado}</div>}

        <div className="ctrl-acoes ctrl-rodape">
          <button className="btn-collect-reset" onClick={exportar}>⬇ Exportar avaliações e versões</button>
          <label className="btn-collect-reset">⬆ Importar de um colega<input type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && importar(e.target.files[0])} /></label>
        </div>
      </div>
    </div>
  );
}
