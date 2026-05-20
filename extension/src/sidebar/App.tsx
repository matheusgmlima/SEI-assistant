/**
 * sidebar/App.tsx
 * Root da sidebar — controla qual tela exibir com base no estado da sessão
 *
 * Estados:
 * - idle       → aguardando login no SEI
 * - detected   → sessão detectada, exibir painel principal
 * - loading    → carregando dados do SEI
 * - error      → falha na comunicação
 */

// TODO: consumir estado de sessão do chrome.storage
// TODO: renderizar tela correta por estado

export default function App() {
  return (
    <div>
      {/* Placeholder — telas implementadas na próxima etapa */}
      <p>SEI Assistant carregando...</p>
    </div>
  );
}
