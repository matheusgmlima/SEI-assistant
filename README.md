# SEI Assistant — TJPE

Sistema de apoio ao [SEI](https://sei.cloud.tjpe.jus.br) para o Tribunal de Justiça de Pernambuco.

Composto por uma extensão Chrome que detecta a sessão do usuário e um dashboard web para organização, auditoria e exportação de processos.

---

## Estrutura do projeto

```
sei-assistant/
├── extension/        # Chrome Extension (Manifest V3)
│   ├── manifest.json
│   └── src/
│       ├── background/   # Service worker — gerencia sessão e mensagens
│       ├── content/      # Injetado no SEI — detecta login e extrai dados
│       └── sidebar/      # UI da sidebar (React) — painel lateral no Chrome
│
├── dashboard/        # Dashboard web (React + Vite)
│   └── src/
│       ├── pages/        # Visão geral, Processos, Relatórios, Histórico
│       ├── components/   # Componentes reutilizáveis
│       ├── services/     # Comunicação com a extensão e processamento de dados
│       └── hooks/        # Hooks React customizados
│
└── shared/           # Tipos TypeScript compartilhados
    └── src/types/
        ├── session.ts    # SessionInfo, SessionStatus
        ├── process.ts    # SeiProcess, ProcessStatus
        └── messages.ts   # ExtMessage, MessageType
```

---

## Tecnologias

| Camada | Stack |
|---|---|
| Extensão | Chrome Manifest V3, React 18, Vite, TypeScript |
| Dashboard | React 18, React Router, Vite, TypeScript |
| Gerenciador de pacotes | pnpm (workspaces) |
| Linguagem | TypeScript 5 |

---

## Pré-requisitos

- Node.js >= 20
- pnpm >= 9

```bash
npm install -g pnpm
```

---

## Instalação

```bash
git clone https://github.com/matheusgmlima/SEI-assistent.git
cd SEI-assistent
pnpm install
```

---

## Desenvolvimento

**Extensão:**
```bash
pnpm dev:extension
```
Gera os arquivos em `extension/dist/`. Para carregar no Chrome:
1. Acesse `chrome://extensions`
2. Ative o **Modo do desenvolvedor**
3. Clique em **Carregar sem compactação**
4. Selecione a pasta `extension/`

**Dashboard:**
```bash
pnpm dev:dashboard
```
Disponível em `http://localhost:5173`

**Build completo:**
```bash
pnpm build
```

---

## Como funciona

```
Usuário loga no SEI (com 2FA)
        ↓
Content script detecta sessão ativa
        ↓
Sidebar abre → exibe painel com ações rápidas
        ↓
Usuário clica "Abrir dashboard"
        ↓
Dashboard abre em nova aba com os dados já carregados
```

A extensão nunca armazena credenciais. Ela piggybacka a sessão já autenticada do browser para fazer requisições ao SEI com os cookies existentes.

---

## Funcionalidades planejadas

- [x] Scaffold do projeto (extensão + dashboard + shared)
- [ ] Detecção de sessão (content script)
- [ ] Sidebar — layout base
- [ ] Dashboard — layout base
- [ ] Listagem de processos recebidos
- [ ] Extração de histórico de processos
- [ ] Geração de relatório Excel
- [ ] Geração de relatório PDF
- [ ] Auditoria de processos por período

---

## Contexto

O SEI (Sistema Eletrônico de Informações) é utilizado pelo TJPE para troca de documentos, mensagens, requerimentos e alocações. Este sistema de apoio foi criado para automatizar tarefas repetitivas e oferecer visibilidade sobre os processos sem interferir no fluxo de autenticação original do SEI.

---

## Licença

Uso interno — TJPE. Não distribuir externamente.
