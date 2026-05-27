import { useEffect, useRef, useState } from "react";
import type { SessionInfo, SeiProcess, ProcessDetails } from "@shared/index";
import type { AiConfig } from "../background/index";

// ─── Tipos de view ──────────────────────────────────────────────────────────────
type View = "main" | "processes" | "processDetail" | "settings";
type DetailTab = "resumo" | "tramitacao";

// ─── Utilitários de tramitação ──────────────────────────────────────────────────

interface UnitPhase {
  unit: string;
  enteredAt: string | null;
  leftAt: string | null;
  durationDays: number | null;
  despachos: string[];
}

function parseDate(s: string): Date | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}`);
}

function buildTramitacao(details: ProcessDetails): UnitPhase[] {
  // Extrai unidade do título do despacho: "Despacho 3341475 UGP - BID" → "UGP - BID"
  function unitFromDespacho(title: string): string {
    const m = title.match(/despacho\s+\d+\s+(.*)/i);
    return m?.[1]?.trim() ?? "";
  }

  // Agrupa despachos por unidade
  const byUnit: Record<string, string[]> = {};
  for (const doc of details.documents) {
    if (/despacho/i.test(doc)) {
      const u = unitFromDespacho(doc) || "—";
      (byUnit[u] = byUnit[u] ?? []).push(doc);
    }
  }

  if (details.andamento.length === 0) {
    // Sem andamento: lista unidades dos despachos em ordem de aparição
    // Filtra a entrada "—" que ocorre quando não há badge de unidade
    return Object.entries(byUnit)
      .filter(([unit]) => unit !== "—")
      .map(([unit, despachos]) => ({
        unit,
        enteredAt: null,
        leftAt: null,
        durationDays: null,
        despachos,
      }));
  }

  // Com andamento: reconstrói fases por unidade
  const phaseMap: Record<string, { entered: string; left: string | null }> = {};
  const order: string[] = [];

  for (const e of [...details.andamento].reverse()) {
    const u = e.unit?.trim();
    if (!u) continue;
    if (!phaseMap[u]) {
      phaseMap[u] = { entered: e.date, left: null };
      order.push(u);
    } else {
      // atualiza a data mais recente como "left"
      const entered = parseDate(phaseMap[u].entered);
      const cur = parseDate(e.date);
      if (cur && entered && cur > entered) {
        phaseMap[u].left = e.date;
      }
    }
  }

  return order.map((unit) => {
    const { entered, left } = phaseMap[unit];
    let durationDays: number | null = null;
    if (entered && left) {
      const a = parseDate(entered), b = parseDate(left);
      if (a && b) durationDays = Math.round(Math.abs(b.getTime() - a.getTime()) / 86400000);
    }

    // Match fuzzy de unidade: compara primeiras 6 letras
    const key6 = unit.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const matchedKey = Object.keys(byUnit).find((k) =>
      k.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) === key6
    );

    return {
      unit,
      enteredAt: entered,
      leftAt: left,
      durationDays,
      despachos: matchedKey ? byUnit[matchedKey] : [],
    };
  });
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
    chrome.storage.local.get(key, (r) => { if (r[key]) setDetails(r[key]); });
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

// ── Componente: Timeline de Tramitação ──────────────────────────────────────────
function TramitacaoTimeline({ details }: { details: ProcessDetails }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const phases = buildTramitacao(details);

  if (phases.length === 0) {
    return (
      <div className="tram-empty">
        <p>Dados insuficientes.</p>
        <p className="tram-hint">Clique em <strong>Consultar Andamento</strong> no SEI e reabra o processo.</p>
      </div>
    );
  }

  return (
    <div className="tram-list">
      {phases.map((phase, i) => (
        <div key={i} className="tram-phase">
          <div className="tram-connector">
            <div className={`tram-dot ${i === phases.length - 1 ? "tram-dot--last" : ""}`} />
            {i < phases.length - 1 && <div className="tram-line" />}
          </div>
          <div className="tram-content">
            <p className="tram-unit">{phase.unit}</p>
            <div className="tram-meta">
              {phase.enteredAt && <span className="tram-date">Entrada: {phase.enteredAt}</span>}
              {phase.leftAt   && <span className="tram-date">Saída: {phase.leftAt}</span>}
              {phase.durationDays !== null && (
                <span className="tram-duration">{phase.durationDays}d</span>
              )}
            </div>
            {phase.despachos.length > 0 && (
              <button
                className="tram-toggle"
                onClick={() => setExpanded((prev) => ({ ...prev, [i]: !prev[i] }))}
              >
                {expanded[i] ? "▾" : "▸"} {phase.despachos.length} despacho{phase.despachos.length > 1 ? "s" : ""}
              </button>
            )}
            {expanded[i] && (
              <ul className="tram-despachos">
                {phase.despachos.map((d, j) => (
                  <li key={j} className="tram-despacho-item">{d}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}
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

  useEffect(() => {
    if (details?.summary && summaryRef.current) {
      summaryRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [details?.summary]);

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
          {tab === "tramitacao" && <TramitacaoTimeline details={details} />}

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
            const despachos = details.documents.filter(d => /despacho/i.test(d));
            const outros = details.documents.filter(d => !/despacho/i.test(d));
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
