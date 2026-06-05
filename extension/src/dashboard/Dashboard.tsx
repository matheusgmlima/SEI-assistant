import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProcessDetails, SessionInfo } from "@shared/index";
import { computeMetrics, type DashMetrics, type RiskSlice, type BarItem } from "./metrics";

// ─── Hook: carrega processos coletados do storage ───────────────────────────────
function useCollectedProcesses() {
  const [list, setList] = useState<ProcessDetails[]>([]);
  const [unit, setUnit] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number>(Date.now());

  const reload = useCallback(() => {
    chrome.storage.local.get(null, (all) => {
      const procs: ProcessDetails[] = [];
      for (const k of Object.keys(all)) {
        if (k.startsWith("proc_")) procs.push(all[k] as ProcessDetails);
      }
      setList(procs);
      const s = all.session as SessionInfo | undefined;
      setUnit(s?.unit ?? null);
      setLoaded(true); setRefreshedAt(Date.now());
    });
  }, []);

  useEffect(() => {
    reload();
    const fn = (c: Record<string, chrome.storage.StorageChange>) => {
      if (Object.keys(c).some((k) => k.startsWith("proc_"))) reload();
    };
    chrome.storage.onChanged.addListener(fn);
    return () => chrome.storage.onChanged.removeListener(fn);
  }, [reload]);

  return { list, unit, loaded, reload, refreshedAt };
}

// ─── Gráficos (SVG/CSS puro) ─────────────────────────────────────────────────────
function Donut({ slices }: { slices: RiskSlice[] }) {
  const total = slices.reduce((a, s) => a + s.count, 0);
  const r = 52, cx = 60, cy = 60, c = 2 * Math.PI * r, sw = 16;
  let offset = 0;

  if (total === 0) return <div className="dash-empty-mini">Sem dados</div>;

  return (
    <div className="donut-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#eef1f6" strokeWidth={sw} />
        {slices.map((s, i) => {
          const frac = s.count / total;
          const dash = frac * c;
          const seg = (
            <circle
              key={i}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={sw}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
          offset += dash;
          return seg;
        })}
        <text x={cx} y={cy - 2} textAnchor="middle" className="donut-total">{total}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" className="donut-sub">processos</text>
      </svg>
      <div className="donut-legend">
        {slices.map((s, i) => (
          <div key={i} className="donut-leg-item">
            <span className="donut-leg-dot" style={{ background: s.color }} />
            <span className="donut-leg-label">{s.label}</span>
            <span className="donut-leg-count">{s.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function BarChart({ items, unit = "", color = "var(--p)" }: { items: BarItem[]; unit?: string; color?: string }) {
  if (items.length === 0) return <div className="dash-empty-mini">Sem dados</div>;
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <div className="bars">
      {items.map((it, i) => (
        <div key={i} className="bar-row">
          <span className="bar-label" title={it.label}>{it.label}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(it.count / max) * 100}%`, background: color }} />
          </div>
          <span className="bar-value">{it.count}{unit}</span>
        </div>
      ))}
    </div>
  );
}

// ─── KPI ─────────────────────────────────────────────────────────────────────────
function Kpi({ value, label, hint, tone }: { value: string | number; label: string; hint?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ? `kpi--${tone}` : ""}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

const RISK_BADGE: Record<string, { label: string; cls: string }> = {
  critico: { label: "Crítico", cls: "rb-critico" },
  alto: { label: "Alto", cls: "rb-alto" },
  medio: { label: "Médio", cls: "rb-medio" },
  baixo: { label: "Conforme", cls: "rb-baixo" },
  nao: { label: "A analisar", cls: "rb-nao" },
};

// ─── App ───────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { list, unit, loaded, reload, refreshedAt } = useCollectedProcesses();
  const m: DashMetrics = useMemo(() => computeMetrics(list), [list]);
  const [reloaded, setReloaded] = useState(false);

  function doReload() {
    reload(); setReloaded(true); setTimeout(() => setReloaded(false), 1800);
  }

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <h1 className="dash-title">Painel da Unidade</h1>
          <p className="dash-sub">{unit ?? "SEI Assistant — TJPE"}</p>
        </div>
        <div className="dash-head-right">
          <button className="dash-reload" onClick={doReload}>{reloaded ? "✓ Atualizado" : "🔄 Recarregar"}</button>
          <div className="dash-updated">{m.total} processos · dados de {new Date(refreshedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</div>
        </div>
      </header>

      {!loaded ? (
        <div className="dash-loading">Carregando dados…</div>
      ) : m.total === 0 ? (
        <div className="dash-empty">
          <p className="dash-empty-title">Nenhum processo coletado ainda</p>
          <p className="dash-empty-desc">
            Abra processos no SEI e use “Coletar dados do processo” na barra lateral.
            As métricas aparecem aqui automaticamente.
          </p>
        </div>
      ) : (
        <>
          {/* KPIs */}
          <div className="kpi-row">
            <Kpi value={m.total} label="Processos" hint={`${m.auditados} auditados`} />
            <Kpi value={m.scoreMedia ?? "—"} label="Score médio" hint="conformidade" tone={scoreTone(m.scoreMedia)} />
            <Kpi value={m.tempoMedioParado ?? "—"} label="Dias na fase" hint="média (em curso)" />
            <Kpi value={m.parados90} label="Parados +90d" hint={`${m.parados30} parados +30d`} tone={m.parados90 > 0 ? "alert" : undefined} />
            <Kpi value={m.concluidos} label="Concluídos" tone="ok" />
          </div>

          {/* Grid de gráficos */}
          <div className="dash-grid">
            <Card title="Distribuição de risco">
              <Donut slices={m.riskDist} />
            </Card>

            <Card title="Gargalos por unidade" subtitle="tempo médio que processos passam em cada unidade">
              <BarChart items={m.gargalos.map((g) => ({ label: g.unit, count: g.mediaDias }))} unit="d" color="#C2410C" />
            </Card>

            <Card title="Processos por tipo">
              <BarChart items={m.tipoDist} color="var(--p)" />
            </Card>

            <Card title="Por situação">
              <BarChart items={m.statusDist} color="#0EA5E9" />
            </Card>
          </div>

          {/* Atenção */}
          <Card title="Precisam de atenção" subtitle="ordenado por risco e tempo parado">
            <table className="dash-table">
              <thead>
                <tr><th>Processo</th><th>Tipo</th><th>Risco</th><th>Situação</th><th>Parado</th></tr>
              </thead>
              <tbody>
                {m.atencao.map((a) => {
                  const rb = RISK_BADGE[a.risk] ?? RISK_BADGE.nao;
                  return (
                    <tr key={a.id}>
                      <td className="dt-id">{a.id}</td>
                      <td className="dt-type">{a.type ?? "—"}</td>
                      <td><span className={`rb ${rb.cls}`}>{rb.label}{a.score !== null ? ` · ${a.score}` : ""}</span></td>
                      <td>{a.statusLabel}</td>
                      <td className={a.diasParado !== null && a.diasParado > 30 ? "dt-alert" : ""}>
                        {a.diasParado !== null ? `${a.diasParado}d` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="dash-card">
      <div className="dash-card-head">
        <h2 className="dash-card-title">{title}</h2>
        {subtitle && <span className="dash-card-sub">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function scoreTone(score: number | null): string | undefined {
  if (score === null) return undefined;
  if (score < 60) return "alert";
  if (score < 80) return "warn";
  return "ok";
}
