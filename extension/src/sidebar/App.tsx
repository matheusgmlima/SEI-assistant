/**
 * extension/src/sidebar/App.tsx
 *
 * Root da sidebar — reage ao estado de sessão armazenado pelo background.
 */

import { useEffect, useState } from "react";
import type { SessionInfo } from "@shared/index";

const DEFAULT_SESSION: SessionInfo = {
  status: "idle",
  username: null,
  unit: null,
  detectedAt: null,
};

// ─────────────────────────────────────────
// Hook: lê e observa o estado da sessão
// ─────────────────────────────────────────

function useSession() {
  const [session, setSession] = useState<SessionInfo>(DEFAULT_SESSION);

  useEffect(() => {
    function readStorage() {
      chrome.storage.local.get("session", (result) => {
        if (result.session) setSession(result.session as SessionInfo);
      });
    }

    // Leitura imediata
    readStorage();

    // Polling a cada 3s — garante que o estado fica sincronizado
    // mesmo quando o usuário já está logado ao abrir a sidebar
    const interval = setInterval(readStorage, 3000);

    // Observa mudanças no storage em tempo real
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.session?.newValue) {
        setSession(changes.session.newValue as SessionInfo);
      }
    };

    chrome.storage.onChanged.addListener(listener);

    return () => {
      clearInterval(interval);
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  return session;
}

// ─────────────────────────────────────────
// Componentes de tela
// ─────────────────────────────────────────

function IdleScreen() {
  return (
    <div className="screen screen--idle">
      <div className="idle-icon">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <circle cx="20" cy="20" r="18" stroke="var(--color-primary)" strokeWidth="2" strokeDasharray="4 3" />
          <path d="M13 20h14M20 13v14" stroke="var(--color-primary)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>
      <p className="idle-title">Aguardando login</p>
      <p className="idle-desc">Faça login no SEI para ativar o assistente.</p>
      <p className="idle-hint">Já está logado? Recarregue a página do SEI.</p>
    </div>
  );
}

function ActiveScreen({ session }: { session: SessionInfo }) {
  function openDashboard() {
    chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
  }

  return (
    <div className="screen screen--active">
      {/* Header */}
      <header className="sidebar-header">
        <div className="sidebar-logo" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1L13 4V10L7 13L1 10V4L7 1Z" stroke="white" strokeWidth="1.5" />
          </svg>
        </div>
        <div>
          <p className="sidebar-title">SEI Assistant</p>
          <p className="sidebar-subtitle">TJPE</p>
        </div>
      </header>

      {/* Status */}
      <div className="status-badge">
        <span className="status-dot" aria-hidden="true" />
        <span>Sessão ativa</span>
      </div>

      {/* Usuário */}
      {(session.username || session.unit) && (
        <div className="user-info">
          {session.username && <p className="user-name">{session.username}</p>}
          {session.unit && <p className="user-unit">{session.unit}</p>}
        </div>
      )}

      {/* Ações */}
      <nav className="actions" aria-label="Ações rápidas">
        <p className="actions-label">Ações rápidas</p>

        <ActionItem
          icon="📋"
          title="Meus processos"
          desc="Listar processos recebidos"
          onClick={() => {/* próxima etapa */}}
        />
        <ActionItem
          icon="📄"
          title="Resumir documento"
          desc="Documento aberto no SEI"
          onClick={() => {/* próxima etapa */}}
        />
        <ActionItem
          icon="📊"
          title="Gerar relatório"
          desc="Exportar período"
          onClick={() => {/* próxima etapa */}}
        />
      </nav>

      {/* Footer */}
      <footer className="sidebar-footer">
        <button className="btn-dashboard" onClick={openDashboard}>
          Abrir dashboard →
        </button>
      </footer>
    </div>
  );
}

function ActionItem({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: string;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button className="action-item" onClick={onClick}>
      <span className="action-icon" aria-hidden="true">{icon}</span>
      <span className="action-text">
        <span className="action-title">{title}</span>
        <span className="action-desc">{desc}</span>
      </span>
      <span className="action-arrow" aria-hidden="true">›</span>
    </button>
  );
}

// ─────────────────────────────────────────
// Root
// ─────────────────────────────────────────

export default function App() {
  const session = useSession();

  return (
    <main className="app">
      {session.status === "idle" || session.status === "expired"
        ? <IdleScreen />
        : <ActiveScreen session={session} />
      }
    </main>
  );
}
