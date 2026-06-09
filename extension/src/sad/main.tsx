import { StrictMode, useEffect, useMemo, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import type { ProcessDetails } from "@shared/index";
import {
  mapProcessToSad, rowsToTsv, sadHeaderTsv, SAD_COLUMNS, SAD_FIELD_META, SAD_REQUIRED, SAD_LISTS,
  sadFieldIssue, validateSadRow,
  type SadOverrides, type SadRow, type SadDefaults,
} from "@shared/index";
import { seedTestData, clearTestData } from "../dev/seed";
import "./sad.css";

interface Item {
  id: string;
  details: ProcessDetails;
  overrides: SadOverrides;
  row: SadRow;
}

const REQUIRED = new Set(SAD_REQUIRED);

function useItems() {
  const [procs, setProcs] = useState<ProcessDetails[]>([]);
  const [overrides, setOverrides] = useState<Record<string, SadOverrides>>({});
  const [loaded, setLoaded] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());

  const reload = useCallback(() => {
    chrome.storage.local.get(null, (all) => {
      const ps: ProcessDetails[] = [];
      const ov: Record<string, SadOverrides> = {};
      for (const k of Object.keys(all)) {
        if (k.startsWith("proc_")) ps.push(all[k] as ProcessDetails);
        else if (k.startsWith("sadOverrides_")) ov[k.slice("sadOverrides_".length)] = all[k] as SadOverrides;
      }
      ps.sort((a, b) => a.id.localeCompare(b.id));
      setProcs(ps); setOverrides(ov); setLoaded(true); setRefreshedAt(Date.now());
    });
  }, []);

  useEffect(() => {
    reload();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(c).some((k) => k.startsWith("proc_") || k.startsWith("sadOverrides_"))) reload();
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, [reload]);

  function setField(id: string, key: string, value: string) {
    setOverrides((prev) => {
      const cur = { ...(prev[id] ?? {}), [key]: value };
      chrome.storage.local.set({ [`sadOverrides_${id}`]: cur });
      return { ...prev, [id]: cur };
    });
  }

  // Zera as edições manuais (overrides) de um conjunto de processos
  function clearOverrides(ids: string[]) {
    setOverrides((prev) => {
      const n = { ...prev };
      for (const id of ids) { delete n[id]; chrome.storage.local.remove(`sadOverrides_${id}`); }
      return n;
    });
  }

  return { procs, overrides, loaded, setField, clearOverrides, reload, refreshedAt };
}

// Hook: padrões pessoais (auto-preenchimento dos campos manuais)
function useDefaults() {
  const [defaults, setDefaults] = useState<SadDefaults>({});
  useEffect(() => {
    chrome.storage.local.get("sadDefaults", (r) => setDefaults((r.sadDefaults as SadDefaults) ?? {}));
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.sadDefaults) setDefaults((c.sadDefaults.newValue as SadDefaults) ?? {});
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);
  function save(d: SadDefaults) {
    setDefaults(d);
    chrome.storage.local.set({ sadDefaults: d });
  }
  return { defaults, save };
}

// Hook: controle de "já lançado na planilha" (mapa id → data ISO)
function useLaunched() {
  const [launched, setLaunched] = useState<Record<string, string>>({});
  useEffect(() => {
    chrome.storage.local.get("sadLaunched", (r) => setLaunched((r.sadLaunched as Record<string, string>) ?? {}));
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (c.sadLaunched) setLaunched((c.sadLaunched.newValue as Record<string, string>) ?? {});
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, []);
  function setMany(ids: string[], value: boolean) {
    setLaunched((prev) => {
      const n = { ...prev };
      for (const id of ids) { if (value) n[id] = new Date().toISOString(); else delete n[id]; }
      chrome.storage.local.set({ sadLaunched: n });
      return n;
    });
  }
  return { launched, toggle: (id: string, v: boolean) => setMany([id], v), setMany };
}

function ControleSad() {
  const { procs, overrides, loaded, setField, clearOverrides, reload, refreshedAt } = useItems();
  const { defaults, save: saveDefaults } = useDefaults();
  const { launched, toggle: toggleLaunched, setMany: setManyLaunched } = useLaunched();
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [reloaded, setReloaded] = useState(false);
  const [picking, setPicking] = useState(false);        // tela de seleção de revisão
  const [focusIds, setFocusIds] = useState<string[] | null>(null); // ids no modo foco
  const [showTut, setShowTut] = useState(false);        // tutorial / como usar
  const [lastCopied, setLastCopied] = useState<string[]>([]); // ids da última cópia

  // Mostra o tutorial automaticamente na primeira visita
  useEffect(() => {
    chrome.storage.local.get("sadTutorialSeen", (r) => { if (!r.sadTutorialSeen) setShowTut(true); });
  }, []);
  function closeTutorial() {
    setShowTut(false);
    chrome.storage.local.set({ sadTutorialSeen: true });
  }

  function doReload() {
    reload();
    setReloaded(true);
    setTimeout(() => setReloaded(false), 1800);
  }

  const items: Item[] = useMemo(
    () => procs.map((d) => {
      const ov = overrides[d.id] ?? {};
      return { id: d.id, details: d, overrides: ov, row: mapProcessToSad(d, ov, defaults) };
    }),
    [procs, overrides, defaults]
  );

  const visible = onlyIncomplete ? items.filter((i) => i.row.missingRequired.length > 0) : items;
  const completos = items.filter((i) => i.row.missingRequired.length === 0).length;
  // progresso total de campos manuais ainda pendentes
  const totalPendentes = items.reduce((acc, i) => acc + i.row.missingRequired.length, 0);
  // processos que precisam de atenção (preencher ou conferir) — alvo do modo foco
  const pendentes = items.filter((i) => hasPending(i.row));

  // Resumo agregado para o painel do topo
  const summary = useMemo(() => {
    let total = 0;
    const porModalidade: Record<string, number> = {};
    let comAviso = 0;
    for (const it of items) {
      const num = Number((it.row.values.valorEstimado ?? "").replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", "."));
      if (isFinite(num) && num > 0) total += num;
      const mod = it.row.values.modalidade || "—";
      porModalidade[mod] = (porModalidade[mod] ?? 0) + 1;
      if (validateSadRow(it.row).length > 0) comAviso++;
    }
    const naoLancados = items.filter((i) => !launched[i.id]).length;
    return { total, porModalidade, comAviso, naoLancados };
  }, [items, launched]);

  function copyTsv(list: Item[]) {
    navigator.clipboard.writeText(rowsToTsv(list.map((i) => i.row))).then(() => {
      setLastCopied(list.map((i) => i.id));
      setCopied(true); setTimeout(() => setCopied(false), 7000);
    });
  }

  function downloadCsv(list: Item[]) {
    const toCsv = (tsv: string) => tsv.split("\n").map((line) =>
      line.split("\t").map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const csv = "﻿" + toCsv(sadHeaderTsv()) + "\r\n" + toCsv(rowsToTsv(list.map((i) => i.row)));
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `Controle_SAD_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="sad">
      <header className="sad-header">
        <div className="sad-header-left">
          <h1 className="sad-title">Controle SAD</h1>
          {items.length > 0 && (
            <p className="sad-sub">{items.length} processos · {completos} prontos · {new Date(refreshedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</p>
          )}
        </div>
        <div className="sad-actions">
          {items.length > 0 && (
            <>
              <button className="sad-btn sad-btn-focus" onClick={() => setPicking(true)}>🎯 Revisar</button>
              <button className="sad-btn sad-btn-primary" onClick={() => copyTsv(visible)} disabled={visible.length === 0}>
                📋 Copiar {visible.length}
              </button>
            </>
          )}
          <button className="sad-btn sad-btn-ghost" onClick={() => setShowTut(true)} title="Como usar esta tela">❓ Como usar</button>
          {items.length > 0 && (
            <KebabMenu
              items={[
                { label: reloaded ? "✓ Atualizado" : "Recarregar dados", onClick: doReload },
                { label: "Baixar CSV", onClick: () => downloadCsv(visible) },
                { sep: true },
                { label: "Zerar todas as edições", onClick: () => {
                  if (confirm("Apagar todas as suas edições manuais? Os campos voltam ao valor sugerido pelo assistente.")) {
                    clearOverrides(items.map((i) => i.id));
                  }
                } },
                { sep: true },
                { label: "Carregar exemplos", onClick: () => seedTestData() },
                { label: "Limpar exemplos", onClick: () => clearTestData() },
              ]}
            />
          )}
        </div>
      </header>

      {showTut && <Tutorial onClose={closeTutorial} />}

      {copied && (
        <div className="sad-toast">
          <span>✓ Copiado! Na planilha, clique na célula <b>A</b> da 1ª linha vazia e tecle <b>Ctrl+V</b>.</span>
          {lastCopied.length > 0 && (
            <button className="sad-toast-action" onClick={() => { setManyLaunched(lastCopied, true); setCopied(false); }}>
              Marcar {lastCopied.length} como lançado(s)
            </button>
          )}
        </div>
      )}

      {!loaded ? (
        <div className="sad-empty">Carregando…</div>
      ) : items.length === 0 ? (
        <div className="sad-empty">
          <div className="sad-empty-icon">📋</div>
          <p className="sad-empty-title">Nenhum processo coletado</p>
          <p className="sad-empty-desc">Colete processos no SEI Assistant e eles aparecem aqui prontos para exportar.</p>
          <button className="sad-btn sad-btn-primary" style={{ marginTop: 18 }} onClick={() => seedTestData()}>🧪 Carregar 4 exemplos</button>
          <p className="sad-empty-note">Dados fictícios para testar sem coletar do SEI.</p>
        </div>
      ) : (
        <>
          {/* Painel-resumo */}
          <SummaryPanel summary={summary} count={items.length} />

          {/* Padrões pessoais — discreto */}
          <DefaultsBar defaults={defaults} onSave={saveDefaults} />

          {/* Barra de progresso */}
          <div className="sad-progress">
            <div className="sad-progress-track">
              <div className="sad-progress-fill" style={{ width: `${items.length ? (completos / items.length) * 100 : 0}%` }} />
            </div>
            <span className="sad-count">
              <strong>{completos}/{items.length}</strong> prontos{totalPendentes > 0 && <span className="sad-pend"> · {totalPendentes} a preencher</span>}
            </span>
            <label className="sad-filter">
              <input type="checkbox" checked={onlyIncomplete} onChange={(e) => setOnlyIncomplete(e.target.checked)} />
              Só pendentes
            </label>
          </div>

          <div className="sad-list">
            {visible.map((it) => (
              <SadCard
                key={it.id}
                item={it}
                launchedAt={launched[it.id]}
                onToggleLaunched={(v) => toggleLaunched(it.id, v)}
                onField={(k, v) => setField(it.id, k, v)}
              />
            ))}
          </div>
        </>
      )}

      {/* Seleção de quais processos revisar */}
      {picking && (
        <ReviewPicker
          items={items}
          defaultSelected={pendentes.map((i) => i.id)}
          onClose={() => setPicking(false)}
          onClear={(ids) => clearOverrides(ids)}
          onStart={(ids) => { setPicking(false); setFocusIds(ids); }}
        />
      )}

      {/* Modo foco com os processos escolhidos */}
      {focusIds && (
        <FocusMode
          items={items.filter((i) => focusIds.includes(i.id))}
          onField={(id, k, v) => setField(id, k, v)}
          onClear={(id) => clearOverrides([id])}
          onClose={() => setFocusIds(null)}
          onExport={() => { copyTsv(items); setFocusIds(null); }}
        />
      )}
    </div>
  );
}

// ── Tutorial / Como usar ────────────────────────────────────────────────────────
const TUT_STEPS = [
  {
    icon: "📋",
    title: "O que é esta tela",
    body: "Ela transforma os processos que você coletou no SEI Assistant em linhas prontas da planilha de Controle SAD. O assistente já preenche a maior parte dos campos automaticamente — você só revisa e completa o que falta.",
  },
  {
    icon: "⚡",
    title: "1. Configure “Meus padrões”",
    body: "Defina uma vez o seu nome (Responsável SAD), a prioridade e a situação no PCA mais comuns. Esses valores passam a preencher sozinhos todos os processos — você não digita a mesma coisa de novo.",
  },
  {
    icon: "🏷️",
    title: "2. Entenda as marcas dos campos",
    body: "🔴 preencher = obrigatório e vazio · 🟠 confira = o assistente sugeriu, mas vale conferir · ⚪ opcional = não exigido, preencha só se tiver a informação. O que não tem marca já está preenchido.",
  },
  {
    icon: "🎯",
    title: "3. Revise no modo foco",
    body: "Clique em “Revisar”, escolha quais processos quer completar e preencha um por vez, vendo só o que falta. Use as setas ← → para navegar. Pode “Zerar” as edições de um processo para recomeçar do zero.",
  },
  {
    icon: "📎",
    title: "4. Copie para a planilha",
    body: "Clique em “Copiar”, abra a aba Acompanhamento_SAD, selecione a célula A da 1ª linha vazia e tecle Ctrl+V. As colunas calculadas (com fórmula) você arrasta depois.",
  },
];

function Tutorial({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const last = step >= TUT_STEPS.length - 1;
  const s = TUT_STEPS[step];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && !last) setStep((x) => x + 1);
      else if (e.key === "ArrowLeft" && step > 0) setStep((x) => x - 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, last]);

  return (
    <div className="focus-overlay">
      <div className="tut">
        <button className="focus-close tut-close" onClick={onClose} title="Fechar (Esc)">✕</button>
        <div className="tut-icon">{s.icon}</div>
        <h2 className="tut-title">{s.title}</h2>
        <p className="tut-body">{s.body}</p>

        <div className="tut-dots">
          {TUT_STEPS.map((_, i) => (
            <button key={i} className={`tut-dot ${i === step ? "tut-dot--on" : ""}`} onClick={() => setStep(i)} aria-label={`Passo ${i + 1}`} />
          ))}
        </div>

        <div className="tut-nav">
          <button className="sad-btn sad-btn-ghost" onClick={() => setStep((x) => x - 1)} disabled={step === 0}>← Voltar</button>
          {last ? (
            <button className="sad-btn sad-btn-primary" onClick={onClose}>Começar ✓</button>
          ) : (
            <button className="sad-btn sad-btn-primary" onClick={() => setStep((x) => x + 1)}>Próximo →</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Seletor: escolher quais processos revisar ───────────────────────────────────
function ReviewPicker({ items, defaultSelected, onStart, onClear, onClose }: {
  items: Item[];
  defaultSelected: string[];
  onStart: (ids: string[]) => void;
  onClear: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set(defaultSelected));

  function toggle(id: string) {
    setSel((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  const selected = items.filter((i) => sel.has(i.id));

  return (
    <div className="focus-overlay">
      <div className="picker">
        <div className="picker-head">
          <div>
            <h2 className="picker-title">Escolha o que revisar</h2>
            <p className="picker-sub">Marque os processos que quer abrir no modo foco.</p>
          </div>
          <button className="focus-close" onClick={onClose} title="Fechar">✕</button>
        </div>

        <div className="picker-tools">
          <button className="picker-link" onClick={() => setSel(new Set(items.map((i) => i.id)))}>Todos</button>
          <button className="picker-link" onClick={() => setSel(new Set(defaultSelected))}>Só pendentes</button>
          <button className="picker-link" onClick={() => setSel(new Set())}>Nenhum</button>
        </div>

        <div className="picker-list">
          {items.map((it) => {
            const pend = hasPending(it.row);
            const checked = sel.has(it.id);
            return (
              <label key={it.id} className={`picker-item ${checked ? "picker-item--on" : ""}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(it.id)} />
                <span className="picker-item-main">
                  <span className="picker-item-id">{it.id}</span>
                  <span className="picker-item-obj">{it.row.values.objeto || "(sem objeto)"}</span>
                </span>
                <span className={`picker-badge ${pend ? "picker-badge--pend" : "picker-badge--ok"}`}>
                  {pend ? `${it.row.missingRequired.length || "•"} pendente${it.row.missingRequired.length === 1 ? "" : "s"}` : "✓ ok"}
                </span>
              </label>
            );
          })}
        </div>

        <div className="picker-footer">
          <button
            className="sad-btn sad-btn-ghost sad-btn-danger"
            disabled={selected.length === 0}
            onClick={() => {
              if (confirm(`Zerar as edições de ${selected.length} processo(s)? Os campos voltam ao valor sugerido.`)) onClear([...sel]);
            }}
          >↺ Zerar edições ({selected.length})</button>
          <button className="sad-btn sad-btn-focus" disabled={selected.length === 0} onClick={() => onStart([...sel])}>
            Revisar {selected.length} →
          </button>
        </div>
      </div>
    </div>
  );
}

// Menu "⋯" para ações secundárias (mantém o header limpo)
function KebabMenu({ items }: { items: ({ label: string; onClick: () => void } | { sep: true })[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="kebab">
      <button className="kebab-btn" onClick={() => setOpen((o) => !o)} title="Mais opções">⋯</button>
      {open && (
        <>
          <div className="kebab-backdrop" onClick={() => setOpen(false)} />
          <div className="kebab-menu">
            {items.map((it, i) =>
              "sep" in it
                ? <div key={i} className="kebab-sep" />
                : <button key={i} className="kebab-item" onClick={() => { it.onClick(); setOpen(false); }}>{it.label}</button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Painel-resumo do topo — visão geral rápida
function SummaryPanel({ summary, count }: {
  summary: { total: number; porModalidade: Record<string, number>; comAviso: number; naoLancados: number };
  count: number;
}) {
  const fmtBRL = (n: number) =>
    n >= 1_000_000 ? `R$ ${(n / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`
    : n >= 1000 ? `R$ ${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`
    : `R$ ${n.toLocaleString("pt-BR")}`;
  const mods = Object.entries(summary.porModalidade).sort((a, b) => b[1] - a[1]);

  return (
    <div className="sad-summary">
      <div className="sad-sum-card">
        <span className="sad-sum-value">{fmtBRL(summary.total)}</span>
        <span className="sad-sum-label">Valor total estimado</span>
      </div>
      <div className="sad-sum-card">
        <span className="sad-sum-value">{count}</span>
        <span className="sad-sum-label">Processos</span>
        <span className="sad-sum-mods">{mods.slice(0, 3).map(([m, n]) => `${m} ${n}`).join(" · ") || "—"}</span>
      </div>
      <div className={`sad-sum-card ${summary.comAviso > 0 ? "sad-sum-card--warn" : ""}`}>
        <span className="sad-sum-value">{summary.comAviso}</span>
        <span className="sad-sum-label">Com dados a verificar</span>
      </div>
      <div className={`sad-sum-card ${summary.naoLancados > 0 ? "sad-sum-card--info" : "sad-sum-card--ok"}`}>
        <span className="sad-sum-value">{summary.naoLancados}</span>
        <span className="sad-sum-label">A lançar na planilha</span>
      </div>
    </div>
  );
}

// Barra de padrões pessoais — preenche automaticamente os campos manuais repetitivos
function DefaultsBar({ defaults, onSave }: { defaults: SadDefaults; onSave: (d: SadDefaults) => void }) {
  const [open, setOpen] = useState(false);
  const has = !!(defaults.responsavelSad || defaults.prioridade || defaults.situacaoPca);

  function set(key: keyof SadDefaults, value: string) {
    onSave({ ...defaults, [key]: value });
  }

  return (
    <div className={`sad-defaults ${has ? "sad-defaults--on" : ""}`}>
      <button className="sad-defaults-head" onClick={() => setOpen((o) => !o)}>
        <span className="sad-defaults-title">
          ⚡ Meus padrões
          {has
            ? <span className="sad-defaults-summary">{[defaults.responsavelSad, defaults.prioridade].filter(Boolean).join(" · ")}</span>
            : <span className="sad-defaults-hint">configure uma vez e preencha sozinho</span>}
        </span>
        <span className="sad-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="sad-defaults-body">
          <p className="sad-defaults-desc">Estes valores preenchem automaticamente os campos vazios de <b>todos</b> os processos. Você ainda pode mudar caso a caso.</p>
          <div className="sad-defaults-grid">
            <div className="sad-field">
              <label>Responsável SAD (você)</label>
              <select value={defaults.responsavelSad ?? ""} onChange={(e) => set("responsavelSad", e.target.value)}>
                <option value="">—</option>
                {SAD_LISTS.servidores.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div className="sad-field">
              <label>Prioridade padrão</label>
              <select value={defaults.prioridade ?? ""} onChange={(e) => set("prioridade", e.target.value)}>
                <option value="">—</option>
                {SAD_LISTS.prioridade.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <div className="sad-field">
              <label>Situação no PCA padrão</label>
              <select value={defaults.situacaoPca ?? ""} onChange={(e) => set("situacaoPca", e.target.value)}>
                <option value="">—</option>
                {SAD_LISTS.pca.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Campos inferidos propensos a erro de extração — sempre vale conferir
const REVIEW_KEYS = new Set([
  "unidadeDemandante", "evento", "modalidade", "contratada",
  "valorEstimado", "dataVigencia", "dataRecebSad", "statusAtual",
]);

type Attention = "req" | "review" | null;

function attentionOf(row: SadRow, key: string): Attention {
  const val = row.values[key] ?? "";
  if (REQUIRED.has(key) && !val) return "req";
  if (REVIEW_KEYS.has(key) && row.sources[key] === "inferido" && val) return "review";
  return null;
}

// Precisa de atenção: obrigatório/sugestão OU valor suspeito (validação)
function needsAttention(row: SadRow, key: string): boolean {
  return attentionOf(row, key) !== null || sadFieldIssue(row, key) !== null;
}

function hasPending(row: SadRow): boolean {
  return SAD_COLUMNS.some((c) => !c.calc && needsAttention(row, c.key));
}

function Field({ col, val, src, attention, issue, onChange }: {
  col: typeof SAD_COLUMNS[number]; val: string; src: string; attention: Attention;
  issue?: string | null; onChange: (v: string) => void;
}) {
  const meta = SAD_FIELD_META[col.key] ?? { type: "text" as const };
  const isProc = col.key === "processoSei";
  const req = REQUIRED.has(col.key);
  const hasIssue = !!issue;

  return (
    <div className={`sad-field ${hasIssue ? "sad-field--issue" : attention === "req" ? "sad-field--req" : attention === "review" ? "sad-field--review" : ""}`}>
      <label>
        <span className="sad-field-name">{req && <span className="req">★</span>}{col.letter} · {col.header}</span>
        {hasIssue && <span className="tag tag-issue">verificar</span>}
        {!hasIssue && attention === "req" && <span className="tag tag-req">preencher</span>}
        {!hasIssue && attention === "review" && <span className="tag tag-review">confira</span>}
        {!hasIssue && !attention && !val && !req && <span className="tag tag-optional">opcional</span>}
        {!hasIssue && !attention && val && <span className={`src-tag src-${src}`} />}
      </label>
      {isProc ? (
        <input value={val} readOnly className="ro" />
      ) : meta.type === "select" ? (
        <select value={val} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {val && !meta.list!.includes(val) && <option value={val}>{val} (sugerido)</option>}
          {meta.list!.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : meta.type === "area" ? (
        <textarea rows={2} value={val} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input value={val} onChange={(e) => onChange(e.target.value)} />
      )}
      {hasIssue && <span className="sad-field-issue-msg">⚠ {issue}</span>}
    </div>
  );
}

function SadCard({ item, launchedAt, onToggleLaunched, onField }: {
  item: Item;
  launchedAt?: string;
  onToggleLaunched: (v: boolean) => void;
  onField: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const { row, details } = item;
  const editable = SAD_COLUMNS.filter((c) => !c.calc);

  const attentionCols = editable.filter((c) => needsAttention(row, c.key));
  const restCols = editable.filter((c) => !needsAttention(row, c.key));
  const nReq = attentionCols.filter((c) => attentionOf(row, c.key) === "req").length;
  const nReview = attentionCols.filter((c) => attentionOf(row, c.key) === "review").length;
  const issues = validateSadRow(row);
  const complete = nReq === 0;
  const launchedStr = launchedAt ? new Date(launchedAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) : null;

  return (
    <div className={`sad-card ${complete ? "" : "sad-card--incomplete"}`}>
      <div className="sad-card-head" onClick={() => setOpen((o) => !o)}>
        <span className="sad-card-id">{details.id}</span>
        <span className="sad-card-obj">{row.values.objeto || "(sem objeto)"}</span>
        <span className="sad-head-badges">
          {launchedStr && <span className="sad-badge sad-badge--launched">✓ lançado {launchedStr}</span>}
          {issues.length > 0 && <span className="sad-badge sad-badge--issue">{issues.length} verificar</span>}
          {nReq > 0 && <span className="sad-badge sad-badge--req">{nReq} preencher</span>}
          {nReview > 0 && <span className="sad-badge sad-badge--review">{nReview} conferir</span>}
          {complete && nReview === 0 && issues.length === 0 && <span className="sad-badge sad-badge--ok">✓ Completo</span>}
        </span>
        <span className="sad-chevron">{open ? "▾" : "▸"}</span>
      </div>

      {open && (
        <div className="sad-card-body">
          {/* Bloco de atenção — só o que importa */}
          {attentionCols.length > 0 ? (
            <div className="sad-attention">
              <p className="sad-block-title">
                <span className="sad-block-icon">⚠️</span> Revisar e completar
                <span className="sad-block-hint">campos obrigatórios e sugestões a conferir</span>
              </p>
              <div className="sad-grid">
                {attentionCols.map((c) => (
                  <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                    attention={attentionOf(row, c.key)} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(c.key, v)} />
                ))}
              </div>
            </div>
          ) : (
            <div className="sad-allgood">✓ Nada a revisar — todos os campos-chave estão preenchidos.</div>
          )}

          {/* Demais campos — recolhidos por padrão */}
          <button className="sad-toggle-all" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "▾ Ocultar demais campos" : `▸ Ver demais campos (${restCols.length})`}
          </button>
          {showAll && (
            <div className="sad-rest">
              <p className="sad-rest-note">
                Estes campos <b>não são exigidos</b> para exportar. Os marcados <span className="tag tag-optional">opcional</span> você preenche só se tiver a informação; os demais já foram preenchidos pelo assistente.
              </p>
              <div className="sad-grid">
                {restCols.map((c) => (
                  <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                    attention={null} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(c.key, v)} />
                ))}
              </div>
            </div>
          )}

          {/* Controle de lançamento na planilha */}
          <div className="sad-launch">
            <label className="sad-launch-check">
              <input type="checkbox" checked={!!launchedAt} onChange={(e) => onToggleLaunched(e.target.checked)} />
              {launchedStr ? `Lançado na planilha em ${launchedStr}` : "Marcar como lançado na planilha"}
            </label>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Modo Foco — revisar/preencher um processo por vez ───────────────────────────
function FocusMode({ items, onField, onClear, onClose, onExport }: {
  items: Item[];
  onField: (id: string, key: string, value: string) => void;
  onClear: (id: string) => void;
  onClose: () => void;
  onExport: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const total = items.length;
  const item = items[Math.min(idx, total - 1)];

  const go = (d: number) => { setShowAll(false); setIdx((i) => Math.max(0, Math.min(total - 1, i + d))); };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [total]);

  if (!item) {
    return (
      <div className="focus-overlay">
        <div className="focus-done">
          <div className="focus-done-icon">✓</div>
          <p className="focus-done-title">Tudo revisado!</p>
          <p className="focus-done-desc">Nenhum processo com campos pendentes.</p>
          <div className="focus-done-actions">
            <button className="sad-btn sad-btn-primary" onClick={onExport}>📋 Copiar para a planilha</button>
            <button className="sad-btn sad-btn-ghost" onClick={onClose}>Fechar</button>
          </div>
        </div>
      </div>
    );
  }

  const { row, details } = item;
  const editable = SAD_COLUMNS.filter((c) => !c.calc);
  const attentionCols = editable.filter((c) => needsAttention(row, c.key));
  const restCols = editable.filter((c) => !needsAttention(row, c.key));
  const nReq = attentionCols.filter((c) => attentionOf(row, c.key) === "req").length;
  const isLast = idx >= total - 1;
  const pct = Math.round(((idx + 1) / total) * 100);

  return (
    <div className="focus-overlay">
      <div className="focus-top">
        <span className="focus-pos">Revisão {idx + 1} de {total}</span>
        <div className="focus-bar"><div className="focus-bar-fill" style={{ width: `${pct}%` }} /></div>
        <button className="focus-close" onClick={onClose} title="Sair (Esc)">✕</button>
      </div>

      <div className="focus-body">
        <div className="focus-card">
          <div className="focus-card-top">
            <div>
              <div className="focus-proc">{details.id}</div>
              <div className="focus-obj">{row.values.objeto || "(sem objeto)"}</div>
            </div>
            <button
              className="focus-reset"
              title="Zerar minhas edições deste processo e voltar às sugestões"
              onClick={() => { if (confirm("Zerar suas edições deste processo?")) onClear(item.id); }}
            >↺ Zerar</button>
          </div>

          {attentionCols.length === 0 ? (
            <div className="focus-allgood">✓ Este processo já está completo.</div>
          ) : (
            <>
              <p className="focus-fields-title">
                {nReq > 0 ? `Preencha os ${nReq} campo(s) obrigatório(s)` : "Confira as sugestões"}
              </p>
              <div className="focus-fields">
                {attentionCols.map((c) => (
                  <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                    attention={attentionOf(row, c.key)} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(item.id, c.key, v)} />
                ))}
              </div>
            </>
          )}

          <button className="sad-toggle-all" onClick={() => setShowAll((s) => !s)}>
            {showAll ? "▾ Ocultar demais campos" : `▸ Ver/editar demais campos (${restCols.length})`}
          </button>
          {showAll && (
            <div className="focus-fields">
              {restCols.map((c) => (
                <Field key={c.key} col={c} val={row.values[c.key] ?? ""} src={row.sources[c.key] ?? "vazio"}
                  attention={null} issue={sadFieldIssue(row, c.key)} onChange={(v) => onField(item.id, c.key, v)} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="focus-nav">
        <button className="sad-btn sad-btn-ghost" onClick={() => go(-1)} disabled={idx === 0}>← Anterior</button>
        <span className="focus-hint">use ← → para navegar</span>
        {isLast ? (
          <button className="sad-btn sad-btn-primary" onClick={onExport}>✓ Concluir e copiar</button>
        ) : (
          <button className="sad-btn sad-btn-primary" onClick={() => go(1)}>Próximo →</button>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ControleSad /></StrictMode>
);
