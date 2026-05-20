import { Routes, Route } from "react-router-dom";

/**
 * Páginas (implementadas nas próximas etapas):
 * /            → Visão geral (métricas + processos recentes)
 * /processos   → Lista completa de processos
 * /relatorios  → Geração de relatórios (Excel / PDF)
 * /historico   → Histórico de execuções
 */

// TODO: importar páginas reais
function Placeholder({ name }: { name: string }) {
  return <div style={{ padding: "2rem" }}>{name} — em desenvolvimento</div>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Placeholder name="Visão geral" />} />
      <Route path="/processos" element={<Placeholder name="Processos" />} />
      <Route path="/relatorios" element={<Placeholder name="Relatórios" />} />
      <Route path="/historico" element={<Placeholder name="Histórico" />} />
    </Routes>
  );
}
