# Base central — o que pedir à TI e como ligar

## Pedido à TI do tribunal

1. **PostgreSQL 14+** na rede do tribunal, com um schema/usuário para o SEI Assistant.
   - Se possível, com a extensão **pgvector** (busca semântica — opcional).
2. **Uma API na frente do banco** (o mais importante). A extensão roda no navegador de
   cada servidor e não pode guardar usuário/senha de banco (qualquer um extrairia do zip).
   Opções, da mais simples à mais trabalhosa:
   - **PostgREST** (um executável que expõe as tabelas como API HTTP, com permissões por
     papel no próprio Postgres) — quase zero código;
   - um serviço pequeno (Node/Python) numa máquina do tribunal.
   A API precisa ser acessível em `https://<algo>.tjpe.jus.br` a partir do Chrome dos servidores.
3. **Modelo de embedding no LiteLLM** (opcional, para a busca semântica): hoje a chave só
   tem modelos de chat. Pedir, por exemplo, `gemini-embedding-001` ou `text-embedding-005`
   (Vertex, 768 dimensões — o tamanho já previsto em `schema.sql`).

## Ligar

```bash
psql -h <host> -U <usuario> -d <banco> -f db/schema.sql
```

Depois:
- Cadastrar as caixinhas em `grupo` / `unidade` (o curador já as define na extensão; o export traz isso).
- Carregar a base que o curador montou localmente: na extensão, **Configurações → Opções
  avançadas → Base de modelos → Exportar base** gera um JSON com o mesmo formato das
  tabelas `modelo` e `secao`.
- Trocar `extension/src/lib/base.ts` (hoje IndexedDB) por chamadas à API — a interface
  `FonteModelos` (`shared/src/base/modelos.ts`) é a única coisa que as telas e os agentes usam.

## O que cada tabela guarda

| Tabela | Para quê |
|---|---|
| `grupo`, `unidade` | As caixinhas: quais unidades do SEI compartilham modelos (ex.: BID = UGP - BID + COORD. AQUISIÇÕES - BID). |
| `curador` | Quem pode colocar e aprovar modelos. |
| `modelo` | Modelos oficiais e exemplos reais (TR, ETP, minuta…), com metadados para achar o mais parecido e versão. |
| `secao` | Cada cláusula/seção do modelo, na ordem (comparar e gerar seção por seção). Vetor opcional. |
| `geracao` | Documentos gerados a partir de modelos (para saber quais modelos ajudam). |
| `avaliacao`, `falta` | "Já alterei" / "Não é válida" / "Faltou" dos servidores — o aprendizado dos agentes. |
| `versao_prompt` | Versões dos prompts aprovadas pelo controlador (só cresce). |
| `revisao` | Custo e achados de cada revisão (estatísticas). |

Os documentos têm dado pessoal: o banco e a API ficam **dentro** da rede do tribunal.
