import { useEffect, useRef, useState } from "react";
import type { SessionInfo, SeiProcess, ProcessDetails } from "@shared/index";
import type { AiConfig } from "../background/index";

// ─── Tipos de view ──────────────────────────────────────────────────────────────
type View = "main" | "processes" | "processDetail" | "settings";
type DetailTab = "resumo" | "tramitacao";

// ─── Tramitação — tipos e lógica ────────────────────────────────────────────────

interface DespachoItem {
  title: string;
  date: string | null;   // data extraída do conteúdo ou andamento
  docId: string | null;
}

interface UnitPhase {
  unit: string;
  enteredAt: string | null;
  leftAt: string | null;
  durationDays: number | null;
  despachos: DespachoItem[];
  isCurrent: boolean;
}

function parseDate(s: string): Date | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}`);
}

function fmtDate(s: string | null): string {
  if (!s) return "";
  // "dd/mm/yyyy hh:mm" → "dd/mm/yy"
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[1]}/${m[2]}/${m[3].slice(2)}` : s;
}

/** Extrai data de um bloco de conteúdo de despacho (se disponível). */
function extractDateFromContent(title: string, despachosContent: string | null): string | null {
  if (!despachosContent) return null;
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionMatch = despachosContent.match(
    new RegExp(`===\\s*${escapedTitle}\\s*===([\\s\\S]{0,800})`, "i")
  );
  if (!sectionMatch) return null;
  const dateMatch = sectionMatch[1].match(/(\d{2}\/\d{2}\/\d{4})/);
  return dateMatch?.[1] ?? null;
}

/** Extrai unidade do título de despacho com badge: "Despacho 3341475 UGP - BID" → "UGP - BID" */
function unitFromDespacho(title: string): string {
  const m = title.match(/despacho\s+\d+\s+(.*)/i);
  return m?.[1]?.trim() ?? "";
}

/** Normaliza nome de unidade para matching fuzzy (remove códigos numéricos longos) */
function normalizeUnit(u: string): string {
  return u.toLowerCase()
    .replace(/[-\s]+\d{7,}/g, "")  // remove códigos "1200001000" etc.
    .replace(/\s+/g, " ").trim();
}

function unitsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const na = normalizeUnit(a);
  const nb = normalizeUnit(b);
  if (na === nb) return true;
  // match parcial: um contém o outro (mínimo 5 chars para evitar falso positivo)
  if (na.length >= 5 && nb.length >= 5) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

function buildTramitacao(details: ProcessDetails): UnitPhase[] {
  const despachoTitles = details.documents.filter((d) => /^despacho\s+\d+/i.test(d));

  // Lista de despachos com sua unidade badge
  const allDespachos: DespachoItem[] = despachoTitles.map((title) => ({
    title,
    date: extractDateFromContent(title, details.despachosContent ?? null),
    docId: title.match(/\b(\d{5,8})\b/)?.[1] ?? null,
    unit: unitFromDespacho(title),
  } as DespachoItem & { unit: string }));

  // Mapa unidade normalizada → despachos
  const byUnit: Map<string, DespachoItem[]> = new Map();
  for (const d of allDespachos) {
    const unit = (d as DespachoItem & { unit: string }).unit || "—";
    if (!byUnit.has(unit)) byUnit.set(unit, []);
    byUnit.get(unit)!.push(d);
  }

  // ── Com andamento: fases com datas de entrada/saída por unidade ──────────────
  if (details.andamento.length > 0) {
    // Ordena andamento cronologicamente (mais antigo → mais recente)
    const sorted = [...details.andamento]
      .filter((e) => e.unit && e.date)
      .sort((a, b) => {
        const da = parseDate(a.date), db = parseDate(b.date);
        return (da?.getTime() ?? 0) - (db?.getTime() ?? 0);
      });

    // Reconstrói fases: cada vez que a unidade muda, abre nova fase
    const phases: UnitPhase[] = [];
    let current: UnitPhase | null = null;

    for (const e of sorted) {
      const u = e.unit!.trim();
      if (!current || current.unit !== u) {
        if (current) current.leftAt = e.date;
        // Fuzzy match: encontra despachos cuja unidade badge bate com a unidade do andamento
        const matchedDespachos: DespachoItem[] = [];
        byUnit.forEach((desps, dUnit) => {
          if (unitsMatch(u, dUnit)) matchedDespachos.push(...desps);
        });

        current = {
          unit: u,
          enteredAt: e.date,
          leftAt: null,
          durationDays: null,
          despachos: matchedDespachos,
          isCurrent: false,
        };
        phases.push(current);
      }
    }

    // Calcula durações e marca fase atual
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      p.isCurrent = i === phases.length - 1;
      if (p.enteredAt && p.leftAt) {
        const a = parseDate(p.enteredAt), b = parseDate(p.leftAt);
        if (a && b) p.durationDays = Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
      } else if (p.isCurrent && p.enteredAt) {
        const a = parseDate(p.enteredAt);
        if (a) p.durationDays = Math.round((Date.now() - a.getTime()) / 86400000);
      }
    }

    return phases;
  }

  // ── Sem andamento: usa apenas títulos com badge ───────────────────────────────
  const result: UnitPhase[] = [];
  for (const [unit, despachos] of byUnit.entries()) {
    if (unit === "—") continue;
    result.push({ unit, enteredAt: null, leftAt: null, durationDays: null, despachos, isCurrent: false });
  }
  if (result.length > 0) result[result.length - 1].isCurrent = true;
  return result;
}

// ─── AI Presets ─────────────────────────────────────────────────────────────────
const AI_PRESETS: Record<string, { baseUrl: string; model: string; label: string }> = {
  groq:   { baseUrl: "https://api.groq.com/openai/v1",  model: "llama-3.3-70b-versatile", label: "Groq (gratuito)" },
  openai: { baseUrl: "https://api.openai.com/v1",       model: "gpt-4o-mini",              label: "OpenAI" },
  custom: { baseUrl: "",                                 model: "",                         label: "Custom" },
};

// ─── Hook: sessão ───────────────────────────────────────────────────────────────
const DEFAULT_SESSION: SessionInfo = { status: "idle", username: null, unit: null, detectedAt: null };

function useSession() {
  const [session, setSession] = useState<SessionInfo>(DEFAULT_SESSION);
  useEffect(() => {
    function read() {
      chrome.storage.local.get("session", (r) => { if (r.session) setSession(r.session); });
    }
    read();
    const iv = setInterval(read, 3000);
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.session?.newValue) setSession(c.session.newValue);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => { clearInterval(iv); chrome.storage.onChanged.removeListener(fn); };
  }, []);
  return session;
}

// ─── Hook: lista de processos ───────────────────────────────────────────────────
function useProcesses() {
  const [processes, setProcesses] = useState<SeiProcess[]>([]);
  const [collectedAt, setCollectedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [notOnPage, setNotOnPage] = useState(false);

  function readStorage() {
    chrome.storage.local.get(["processes", "processesCollectedAt"], (r) => {
      if (r.processes) setProcesses(r.processes);
      if (r.processesCollectedAt) setCollectedAt(r.processesCollectedAt);
    });
  }

  function collect() {
    setLoading(true); setNotOnPage(false);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { setLoading(false); setNotOnPage(true); return; }
      chrome.tabs.sendMessage(tabId, { type: "COLLECT_PROCESSES" }, (res) => {
        setLoading(false);
        if (chrome.runtime.lastError || !res?.ok || !res?.onPage) { setNotOnPage(true); return; }
        setTimeout(readStorage, 300);
      });
    });
  }

  useEffect(() => {
    readStorage();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.processes?.newValue) setProcesses(c.processes.newValue);
      if (c.processesCollectedAt?.newValue) setCollectedAt(c.processesCollectedAt.newValue);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);

  return { processes, collectedAt, loading, notOnPage, collect };
}

// ─── Hook: detalhes de processo ─────────────────────────────────────────────────
function useProcessDetails(processId: string | null) {
  const [details, setDetails] = useState<ProcessDetails | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  useEffect(() => {
    if (!processId) return;
    const key = `proc_${processId}`;

    // 1. Carrega do storage imediatamente
    chrome.storage.local.get(key, (r) => {
      const stored: ProcessDetails | undefined = r[key];
      if (stored) setDetails(stored);

      // 2. Se andamento vazio no storage, busca do DB (sessão anterior)
      if (!stored?.andamento?.length) {
        chrome.runtime.sendMessage(
          { type: "GET_DB_ANDAMENTO", payload: { processId } },
          (res) => {
            if (res?.ok && res.andamento?.length > 0) {
              setDetails((prev) => prev
                ? { ...prev, andamento: res.andamento }
                : { id: processId, type: null, description: null, currentUnit: null,
                    parties: [], documents: [], andamento: res.andamento,
                    extractedAt: Date.now(), summary: null, despachosContent: null,
                    documentLinks: {} }
              );
            }
          }
        );
      }
    });

    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c[key]?.newValue) setDetails(c[key].newValue);
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, [processId]);

  function generateSummary() {
    if (!processId) return;
    setSummarizing(true); setSummaryError(null);
    chrome.runtime.sendMessage(
      { type: "SUMMARIZE_PROCESS", payload: { processId } },
      (res) => {
        setSummarizing(false);
        if (!res?.ok) setSummaryError(res?.error ?? "Erro desconhecido.");
      }
    );
  }

  return { details, summarizing, summaryError, generateSummary };
}

// ─── Hook: config de IA ─────────────────────────────────────────────────────────
function useAiConfig() {
  const [config, setConfig] = useState<AiConfig | null>(null);

  useEffect(() => {
    chrome.storage.local.get("aiConfig", (r) => { if (r.aiConfig) setConfig(r.aiConfig); });
  }, []);

  function save(cfg: AiConfig) {
    chrome.storage.local.set({ aiConfig: cfg });
    setConfig(cfg);
  }

  return { config, save };
}

// ─── Componentes ────────────────────────────────────────────────────────────────

function IdleScreen() {
  return (
    <div className="screen screen--idle">
      <div className="idle-icon">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="18" stroke="var(--color-primary)" strokeWidth="2" strokeDasharray="4 3"/>
          <path d="M13 20h14M20 13v14" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </div>
      <p className="idle-title">Aguardando login</p>
      <p className="idle-desc">Faça login no SEI para ativar o assistente.</p>
      <p className="idle-hint">Já está logado? Recarregue a página do SEI.</p>
    </div>
  );
}

// ── Tela: Configurações ─────────────────────────────────────────────────────────
function SettingsScreen({ onBack }: { onBack: () => void }) {
  const { config, save } = useAiConfig();
  const [provider, setProvider] = useState<string>(config?.provider ?? "groq");
  const [apiKey, setApiKey] = useState(config?.apiKey ?? "");
  const [model, setModel] = useState(config?.model ?? AI_PRESETS.groq.model);
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? AI_PRESETS.groq.baseUrl);
  const [saved, setSaved] = useState(false);

  function handleProviderChange(p: string) {
    setProvider(p);
    if (p !== "custom") {
      setModel(AI_PRESETS[p].model);
      setBaseUrl(AI_PRESETS[p].baseUrl);
    }
  }

  function handleSave() {
    save({ provider: provider as AiConfig["provider"], apiKey, model, baseUrl });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="screen screen--active">
      <header className="screen-header">
        <button className="btn-back" onClick={onBack}>‹</button>
        <span className="screen-title">Configurações IA</span>
      </header>

      <div className="settings-body">
        <label className="settings-label">Provider</label>
        <select className="settings-select" value={provider} onChange={(e) => handleProviderChange(e.target.value)}>
          {Object.entries(AI_PRESETS).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>

        <label className="settings-label">API Key</label>
        <input
          className="settings-input"
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
        />

        <label className="settings-label">Modelo</label>
        <input
          className="settings-input"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />

        {provider === "custom" && (
          <>
            <label className="settings-label">Base URL</label>
            <input
              className="settings-input"
              placeholder="https://..."
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </>
        )}

        <button className="btn-save" onClick={handleSave} disabled={!apiKey}>
          {saved ? "✓ Salvo!" : "Salvar"}
        </button>

        <p className="settings-hint">
          Groq é gratuito — crie sua chave em <strong>console.groq.com</strong>
        </p>
      </div>
    </div>
  );
}

// ── Componente: Árvore de Tramitação ────────────────────────────────────────────
function TramitacaoTimeline({ details }: { details: ProcessDetails }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const phases = buildTramitacao(details);
  const hasAndamento = details.andamento.length > 0;

  if (phases.length === 0) {
    return (
      <div className="tram-empty">
        <p>Nenhum despacho com unidade identificada.</p>
        <p className="tram-hint">
          Para ver datas completas, clique em <strong>Consultar Andamento</strong> no SEI.
        </p>
      </div>
    );
  }

  const totalDays = phases.reduce((acc, p) => acc + (p.durationDays ?? 0), 0);

  return (
    <div className="tram-tree">
      {!hasAndamento && (
        <div className="tram-notice">
          Sem datas — abra o processo no SEI e clique em <strong>Consultar Andamento</strong>. O assistente extrai automaticamente.
        </div>
      )}

      {phases.map((phase, i) => {
        const isOpen = expanded[i];
        const pct = totalDays > 0 && phase.durationDays !== null
          ? Math.round((phase.durationDays / totalDays) * 100)
          : null;

        return (
          <div key={i} className={`tram-node ${phase.isCurrent ? "tram-node--current" : ""}`}>
            {/* Linha vertical conectora */}
            <div className="tram-spine">
              <div className={`tram-bullet ${phase.isCurrent ? "tram-bullet--active" : ""}`} />
              {i < phases.length - 1 && <div className="tram-spine-line" />}
            </div>

            <div className="tram-body">
              {/* Cabeçalho da unidade */}
              <div className="tram-header" onClick={() => setExpanded((p) => ({ ...p, [i]: !isOpen }))}>
                <span className="tram-unit-name">{phase.unit}</span>
                <div className="tram-header-right">
                  {phase.durationDays !== null && (
                    <span className={`tram-badge ${phase.isCurrent ? "tram-badge--active" : ""}`}>
                      {phase.isCurrent ? `${phase.durationDays}d ●` : `${phase.durationDays}d`}
                    </span>
                  )}
                  {phase.despachos.length > 0 && (
                    <span className="tram-chevron">{isOpen ? "▾" : "▸"}</span>
                  )}
                </div>
              </div>

              {/* Datas */}
              {(phase.enteredAt || phase.leftAt) && (
                <div className="tram-dates">
                  {phase.enteredAt && <span>↓ {fmtDate(phase.enteredAt)}</span>}
                  {phase.leftAt    && <span>↑ {fmtDate(phase.leftAt)}</span>}
                  {pct !== null    && <span className="tram-pct">{pct}% do tempo</span>}
                </div>
              )}

              {/* Barra de proporção (quando há andamento) */}
              {hasAndamento && pct !== null && (
                <div className="tram-bar-track">
                  <div
                    className={`tram-bar-fill ${phase.isCurrent ? "tram-bar-fill--active" : ""}`}
                    style={{ width: `${Math.max(pct, 2)}%` }}
                  />
                </div>
              )}

              {/* Lista de despachos — sempre visível se houver */}
              {phase.despachos.length > 0 && (
                <ul className="tram-despachos">
                  {phase.despachos.map((d, j) => (
                    <li key={j} className="tram-despacho-item">
                      <span className="tram-despacho-id">#{d.docId ?? "—"}</span>
                      <span className="tram-despacho-title">
                        {d.title.replace(/despacho\s+\d+\s*/i, "").trim() || d.title}
                      </span>
                      {d.date && <span className="tram-despacho-date">{fmtDate(d.date)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      })}

      {hasAndamento && totalDays > 0 && (
        <div className="tram-total">Total: {totalDays} dias no processo</div>
      )}
    </div>
  );
}

// ── Tela: Detalhe do processo ───────────────────────────────────────────────────
function ProcessDetailScreen({
  processId,
  onBack,
  onSettings,
}: {
  processId: string;
  onBack: () => void;
  onSettings: () => void;
}) {
  const { details, summarizing, summaryError, generateSummary } = useProcessDetails(processId);
  const { config } = useAiConfig();
  const hasApiKey = !!config?.apiKey;
  const summaryRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<DetailTab>("resumo");
  const [expanding, setExpanding] = useState(false);
  const [generatingTram, setGeneratingTram] = useState(false);
  const [tramError, setTramError] = useState<string | null>(null);
  const [waitingForSei, setWaitingForSei] = useState(false);

  // Quando andamento chega via storage.onChanged enquanto aguardando, limpa o loading
  useEffect(() => {
    if (waitingForSei && (details?.andamento?.length ?? 0) > 0) {
      setGeneratingTram(false);
      setWaitingForSei(false);
      setTramError(null);
    }
  }, [details?.andamento?.length, waitingForSei]);

  function generateTramitacao() {
    setGeneratingTram(true); setTramError(null); setWaitingForSei(false);
    chrome.runtime.sendMessage(
      { type: "GET_ANDAMENTO", payload: { processId } },
      (res) => {
        if (res?.ok) {
          // Andamento já estava no storage — loading pode parar
          setGeneratingTram(false);
          setWaitingForSei(false);
        } else {
          // Sem andamento: mantém loading e avisa para abrir o SEI
          setWaitingForSei(true);
          setTramError(res?.error ?? "Não foi possível buscar o histórico.");
        }
      }
    );
  }

  useEffect(() => {
    if (details?.summary && summaryRef.current) {
      summaryRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [details?.summary]);

  function expandTree() {
    setExpanding(true);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0]?.id;
      if (!tabId) { setExpanding(false); return; }
      // Sem frameId → todos os frames recebem (all_frames: true no content script)
      chrome.tabs.sendMessage(tabId, { type: "EXPAND_TREE" }, () => {
        if (chrome.runtime.lastError) { /* ignora se nenhum frame responder */ }
        setTimeout(() => setExpanding(false), 3000);
      });
    });
  }

  const timeAgo = details?.extractedAt
    ? (() => {
        const d = Math.floor((Date.now() - details.extractedAt) / 1000);
        if (d < 60) return `${d}s atrás`;
        if (d < 3600) return `${Math.floor(d / 60)}min atrás`;
        return `${Math.floor(d / 3600)}h atrás`;
      })()
    : null;

  return (
    <div className="screen screen--active detail-screen">
      <header className="screen-header">
        <button className="btn-back" onClick={onBack}>‹</button>
        <span className="screen-title" title={processId}>{processId}</span>
        <button
          className="btn-refresh"
          title="Expandir todas as pastas da árvore"
          onClick={expandTree}
          disabled={expanding}
          style={{ fontSize: "12px" }}
        >
          {expanding ? "⏳" : "📂"}
        </button>
      </header>

      {!details && (
        <div className="detail-waiting">
          <p className="detail-waiting-title">Aguardando dados…</p>
          <p className="detail-waiting-desc">
            Abra o processo <strong>{processId}</strong> no SEI para carregar as informações.
          </p>
        </div>
      )}

      {details && (
        <div className="detail-body">
          {timeAgo && <p className="processes-meta">Dados coletados {timeAgo}</p>}

          {/* Abas */}
          <div className="detail-tabs">
            <button
              className={`detail-tab ${tab === "resumo" ? "detail-tab--active" : ""}`}
              onClick={() => setTab("resumo")}
            >Resumo</button>
            <button
              className={`detail-tab ${tab === "tramitacao" ? "detail-tab--active" : ""}`}
              onClick={() => setTab("tramitacao")}
            >Tramitação</button>
          </div>

          {/* Aba: Tramitação */}
          {tab === "tramitacao" && (
            <>
              <div style={{ display: "flex", gap: "6px", margin: "6px 0" }}>
                <button
                  className="btn-summarize"
                  style={{ flex: 1, fontSize: "11px", padding: "6px" }}
                  onClick={generateTramitacao}
                  disabled={generatingTram}
                >
                  {generatingTram ? "⏳ Aguardando SEI…" : "🤖 Gerar Tramitação"}
                </button>
              </div>
              {waitingForSei && (
                <div className="summary-loading" style={{ margin: "0 0 6px", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span className="tram-spinner" />
                  <span>Abra <strong>Consultar Andamento</strong> no SEI. O assistente vai extrair automaticamente.</span>
                </div>
              )}
              {tramError && !waitingForSei && (
                <div className="summary-error" style={{ margin: "0 0 6px" }}>
                  <p>{tramError}</p>
                </div>
              )}
              <TramitacaoTimeline details={details} />
            </>
          )}

          {/* Aba: Resumo — conteúdo original */}
          {tab === "resumo" && <>

          {/* Metadados */}
          {details.type && <div className="detail-field"><span className="detail-key">Tipo</span><span className="detail-val">{details.type}</span></div>}
          {details.description && <div className="detail-field"><span className="detail-key">Especificação</span><span className="detail-val">{details.description}</span></div>}
          {details.currentUnit && <div className="detail-field"><span className="detail-key">Unidade</span><span className="detail-val">{details.currentUnit}</span></div>}
          {details.parties.length > 0 && (
            <div className="detail-field"><span className="detail-key">Interessados</span><span className="detail-val">{details.parties.join(", ")}</span></div>
          )}

          {/* Andamento */}
          {details.andamento.length > 0 && (
            <div className="detail-section">
              <p className="detail-section-title">Últimos andamentos</p>
              {details.andamento.slice(0, 5).map((a, i) => (
                <div key={i} className="andamento-item">
                  <span className="andamento-date">{a.date}</span>
                  <span className="andamento-desc">{a.description}</span>
                  {a.unit && <span className="andamento-unit">{a.unit}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Documentos — Despachos */}
          {details.documents.length > 0 && (() => {
            const despachos = details.documents.filter(d => /^despacho\s+\d+/i.test(d));
            const outros = details.documents.filter(d => !/^despacho\s+\d+/i.test(d));
            return (
              <>
                {despachos.length > 0 && (
                  <div className="detail-section">
                    <p className="detail-section-title">Despachos ({despachos.length})</p>
                    <p className="detail-docs">{despachos.join(" · ")}</p>
                  </div>
                )}
                {outros.length > 0 && (
                  <div className="detail-section">
                    <p className="detail-section-title">Outros documentos ({outros.length})</p>
                    <p className="detail-docs">{outros.slice(0, 10).join(" · ")}{outros.length > 10 ? ` · +${outros.length - 10} mais` : ""}</p>
                  </div>
                )}
              </>
            );
          })()}

          {/* Resumo IA */}
          <div className="detail-section" ref={summaryRef}>
            <p className="detail-section-title">Resumo com IA</p>

            {!hasApiKey && (
              <div className="summary-no-key">
                <p>Nenhuma API key configurada.</p>
                <button className="btn-config-link" onClick={onSettings}>
                  Configurar agora →
                </button>
              </div>
            )}

            {hasApiKey && !details.summary && !summarizing && (
              <button className="btn-summarize" onClick={generateSummary}>
                ✨ Gerar resumo
              </button>
            )}

            {summarizing && (
              <div className="summary-loading">Gerando resumo…</div>
            )}

            {summaryError && (
              <div className="summary-error">
                <p>{summaryError}</p>
                <button className="btn-summarize btn-summarize--retry" onClick={generateSummary}>
                  Tentar novamente
                </button>
              </div>
            )}

            {details.summary && !summarizing && (
              <div className="summary-content">
                {details.summary.split("\n").map((line, i) => {
                  if (line.startsWith("**") && line.endsWith("**")) {
                    return <p key={i} className="summary-heading">{line.replace(/\*\*/g, "")}</p>;
                  }
                  if (line.trim() === "") return <br key={i} />;
                  return <p key={i} className="summary-line">{line}</p>;
                })}
                <button className="btn-summarize btn-summarize--retry" onClick={generateSummary}>
                  ↺ Regenerar
                </button>
              </div>
            )}
          </div>

          </> /* fim aba resumo */}
        </div>
      )}
    </div>
  );
}

// ── Tela: Lista de processos ────────────────────────────────────────────────────
function ProcessListScreen({
  onBack,
  onSelect,
}: {
  onBack: () => void;
  onSelect: (id: string) => void;
}) {
  const { processes, collectedAt, loading, notOnPage, collect } = useProcesses();

  useEffect(() => { collect(); }, []);

  const timeAgo = collectedAt
    ? (() => {
        const d = Math.floor((Date.now() - collectedAt) / 1000);
        if (d < 60) return `${d}s atrás`;
        if (d < 3600) return `${Math.floor(d / 60)}min atrás`;
        return `${Math.floor(d / 3600)}h atrás`;
      })()
    : null;

  return (
    <div className="screen screen--active">
      <header className="screen-header">
        <button className="btn-back" onClick={onBack}>‹</button>
        <span className="screen-title">Meus Processos</span>
        <button className="btn-refresh" onClick={collect} disabled={loading}
          title="Abra 'Controle de Processos' no SEI antes de atualizar">
          {loading ? "…" : "↻"}
        </button>
      </header>

      {timeAgo && <p className="processes-meta">Atualizado {timeAgo}</p>}

      {notOnPage && (
        <div className="processes-hint">
          Abra <strong>Controle de Processos</strong> no SEI e clique em ↻
        </div>
      )}

      {loading && <div className="processes-loading">Coletando processos…</div>}

      {!loading && !notOnPage && processes.length === 0 && (
        <div className="processes-empty">
          Nenhum processo encontrado.<br />
          Navegue até "Controle de Processos" no SEI.
        </div>
      )}

      <div className="process-list">
        {processes.map((p) => (
          <button key={p.id} className="process-item process-item--clickable" onClick={() => onSelect(p.id)}>
            <div className="process-id">{p.id}</div>
            {p.type && <div className="process-type">{p.type}</div>}
            {p.description && (
              <div className="process-desc" title={p.description}>
                {p.description.length > 55 ? p.description.slice(0, 55) + "…" : p.description}
              </div>
            )}
            <div className="process-meta-row">
              {p.lastUpdate && <span className="process-date">🕐 {p.lastUpdate}</span>}
              {p.assignedTo && <span className="process-assigned">👤 {p.assignedTo}</span>}
              <span className="process-detail-hint">Ver detalhes →</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Tela: Principal ─────────────────────────────────────────────────────────────
function ActiveScreen({ session }: { session: SessionInfo }) {
  const [view, setView] = useState<View>("main");
  const [selectedProcess, setSelectedProcess] = useState<string | null>(null);

  if (view === "settings") return <SettingsScreen onBack={() => setView("main")} />;

  if (view === "processDetail" && selectedProcess) {
    return (
      <ProcessDetailScreen
        processId={selectedProcess}
        onBack={() => setView("processes")}
        onSettings={() => setView("settings")}
      />
    );
  }

  if (view === "processes") {
    return (
      <ProcessListScreen
        onBack={() => setView("main")}
        onSelect={(id) => { setSelectedProcess(id); setView("processDetail"); }}
      />
    );
  }

  return (
    <div className="screen screen--active">
      <header className="sidebar-header">
        <div className="sidebar-logo">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L13 4V10L7 13L1 10V4L7 1Z" stroke="white" strokeWidth="1.5"/>
          </svg>
        </div>
        <div style={{ flex: 1 }}>
          <p className="sidebar-title">SEI Assistant</p>
          <p className="sidebar-subtitle">TJPE</p>
        </div>
        <button className="btn-gear" onClick={() => setView("settings")} title="Configurações IA">⚙</button>
      </header>

      <div className="status-badge">
        <span className="status-dot"/>
        <span>Sessão ativa</span>
      </div>

      {(session.username || session.unit) && (
        <div className="user-info">
          {session.username && <p className="user-name">{session.username}</p>}
          {session.unit && <p className="user-unit">{session.unit}</p>}
        </div>
      )}

      <nav className="actions">
        <p className="actions-label">Ações rápidas</p>
        <ActionItem icon="📋" title="Meus processos" desc="Listar e resumir processos" onClick={() => setView("processes")}/>
        <ActionItem icon="📄" title="Resumir documento" desc="Documento aberto no SEI" onClick={() => {}}/>
        <ActionItem icon="📊" title="Gerar relatório" desc="Exportar período" onClick={() => {}}/>
      </nav>

      <footer className="sidebar-footer">
        <button className="btn-dashboard" onClick={() => chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" })}>
          Abrir dashboard →
        </button>
      </footer>
    </div>
  );
}

function ActionItem({ icon, title, desc, onClick }: { icon: string; title: string; desc: string; onClick: () => void }) {
  return (
    <button className="action-item" onClick={onClick}>
      <span className="action-icon">{icon}</span>
      <span className="action-text">
        <span className="action-title">{title}</span>
        <span className="action-desc">{desc}</span>
      </span>
      <span className="action-arrow">›</span>
    </button>
  );
}

// ─── Root ───────────────────────────────────────────────────────────────────────
export default function App() {
  const session = useSession();
  return (
    <main className="app">
      {session.status === "idle" || session.status === "expired"
        ? <IdleScreen />
        : <ActiveScreen session={session} />}
    </main>
  );
}
