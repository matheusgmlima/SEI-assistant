import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProcessDetails, SessionInfo } from "@shared/index";
import { computeMetrics, type DashMetrics, type RiskSlice, type BarItem } from "./metrics";
import { Icon } from "../sidebar/ui";

// ─── Hook: carrega processos coletados do storage ───────────────────────────────
function useCollectedProcesses() {
  const [list, setList] = useState<ProcessDetails[]>([]);
  const [unit, setUnit] = useState<string | null>(null);
  const [naUnidade, setNaUnidade] = useState(0); // processos listados no Controle de Processos
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
      setNaUnidade(Array.isArray(all.processes) ? all.processes.length : 0);
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

  return { list, unit, naUnidade, loaded, reload, refreshedAt };
}

// ─── Gráficos (SVG/CSS puro) ─────────────────────────────────────────────────────
function Donut({ slices }: { slices: RiskSlice[] }) {
  const total = slices.reduce((a, s) => a + s.count, 0);
  const r = 52, cx = 60, cy = 60, c = 2 * Math.PI * r, sw = 16;
  let offset = 0;

  if (total === 0) return <div className="dash-empty-mini">Sem dados</div>;

  return (
    <div className="donut-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label={slices.map((s) => `${s.label}: ${s.count}`).join(", ")}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg)" strokeWidth={sw} />
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

function BarChart({ items, unit = "", color = "var(--p)", vazio = "Sem dados" }: { items: BarItem[]; unit?: string; color?: string; vazio?: string }) {
  if (items.length === 0) return <div className="dash-empty-mini">{vazio}</div>;
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
function Kpi({ value, label, hint, tone, info }: { value: string | number; label: string; hint?: string; tone?: string; info?: string }) {
  return (
    <div className={`kpi ${tone ? `kpi--${tone}` : ""}`} title={info}>
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
  const { list, unit, naUnidade, loaded, reload, refreshedAt } = useCollectedProcesses();
  const m: DashMetrics = useMemo(() => computeMetrics(list), [list]);
  const [reloaded, setReloaded] = useState(false);

  function doReload() {
    reload(); setReloaded(true); setTimeout(() => setReloaded(false), 1800);
  }
  const cobertura = naUnidade > 0 ? Math.min(1, m.total / naUnidade) : null;

  return (
    <div className="dash">
      <header className="dash-header">
        <div>
          <p className="dash-kicker">SEI Assistant · Painel da unidade</p>
          <h1 className="dash-title">{unit ?? "Sua unidade"}</h1>
          <p className="dash-sub">Atualizado às {new Date(refreshedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} com os processos que a extensão já leu.</p>
        </div>
        <button className="dash-reload" onClick={doReload}>
          {reloaded ? <><Icon n="ok" s={14} /> Atualizado</> : <><Icon n="atualizar" s={14} /> Atualizar</>}
        </button>
      </header>

      {!loaded ? (
        <div className="dash-loading">Carregando dados…</div>
      ) : m.total === 0 ? (
        <div className="dash-empty">
          <Icon n="painel" s={32} />
          <p className="dash-empty-title">Ainda não há processos lidos</p>
          <p className="dash-empty-desc">
            O painel é montado a partir dos processos que a extensão leu. Na barra lateral do SEI, abra
            <b> Meus processos</b> → <b>Ler vários</b>, escolha os processos e clique em <b>Ler</b>. Os números aparecem aqui sozinhos.
          </p>
        </div>
      ) : (
        <>
          {cobertura !== null && cobertura < 1 && (
            <div className="dash-cobertura">
              <div className="dash-cob-txt">
                <b>{m.total} de {naUnidade}</b> processos da unidade já foram lidos.
                <span> Os números abaixo valem só para esses. Para completar, use <b>Meus processos → Ler vários</b> na barra lateral.</span>
              </div>
              <div className="dash-cob-barra" aria-hidden="true"><span style={{ width: `${cobertura * 100}%` }} /></div>
            </div>
          )}

          <section className="kpi-row" aria-label="Indicadores">
            <Kpi value={m.total} label="Processos lidos" hint={`${m.auditados} com auditoria`} />
            <Kpi value={m.scoreMedia ?? "—"} label="Nota média de conformidade" hint="de 0 a 100" tone={scoreTone(m.scoreMedia)}
              info="Média das notas da aba Auditoria. Abaixo de 60 = atenção." />
            <Kpi value={m.tempoMedioParado ?? "—"} label="Dias na fase atual" hint="média dos processos em andamento" />
            <Kpi value={m.parados90} label="Parados há mais de 90 dias" hint={`${m.parados30} há mais de 30 dias`} tone={m.parados90 > 0 ? "alert" : undefined} />
            <Kpi value={m.concluidos} label="Concluídos" tone={m.concluidos > 0 ? "ok" : undefined} />
          </section>

          <Card title="Precisam de atenção" subtitle="Os mais arriscados e mais parados primeiro. Para resolver, abra o processo no SEI e use a barra lateral.">
            <div className="dash-table-wrap">
              <table className="dash-table">
                <thead>
                  <tr><th>Processo</th><th>Tipo</th><th>Risco</th><th>Situação</th><th className="num">Parado</th></tr>
                </thead>
                <tbody>
                  {m.atencao.map((a) => {
                    const rb = RISK_BADGE[a.risk] ?? RISK_BADGE.nao;
                    return (
                      <tr key={a.id}>
                        <td className="dt-id">{a.id}</td>
                        <td className="dt-type" title={a.type ?? ""}>{a.type ?? "—"}</td>
                        <td><span className={`rb ${rb.cls}`}>{rb.label}{a.score !== null ? ` · ${a.score}` : ""}</span></td>
                        <td>{a.statusLabel}</td>
                        <td className={`num ${a.diasParado !== null && a.diasParado > 30 ? "dt-alert" : ""}`}>
                          {a.diasParado !== null ? `${a.diasParado} dias` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="dash-grid">
            <Card title="Onde os processos demoram" subtitle="Tempo médio que cada unidade segura um processo">
              <BarChart items={m.gargalos.map((g) => ({ label: g.unit, count: g.mediaDias }))} unit=" dias" color="var(--warn-bar)"
                vazio="Precisa das datas de andamento: na barra lateral, abra um processo → aba Tramitação → “Buscar datas do andamento”." />
            </Card>

            <Card title="Risco dos processos" subtitle="Pela nota da auditoria">
              <Donut slices={m.riskDist} />
            </Card>

            <Card title="Por tipo de processo">
              <BarChart items={m.tipoDist} color="var(--p)" />
            </Card>

            <Card title="Por situação">
              <BarChart items={m.statusDist} color="var(--accent)" />
            </Card>
          </div>
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
