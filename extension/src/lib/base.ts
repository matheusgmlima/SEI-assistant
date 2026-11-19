/**
 * Base de modelos — implementação LOCAL (IndexedDB deste navegador) de `FonteModelos`.
 * Provisória: quando o Postgres do tribunal chegar (db/schema.sql), troca-se só este
 * arquivo por chamadas à API; telas e agentes continuam iguais.
 * O export em JSON tem o mesmo formato das tabelas → carga direta no banco depois.
 */
import { openDB, type IDBPDatabase } from "idb";
import type { FonteModelos, Modelo, Grupo, TipoDocumento } from "@shared/base/modelos";
import { grupoDaUnidade } from "@shared/base/modelos";
import { sget, sset } from "./agentes";

let db: Promise<IDBPDatabase> | null = null;
const abrir = () => (db ??= openDB("sei-assistant-base", 1, {
  upgrade(d) { d.createObjectStore("modelos", { keyPath: "id" }).createIndex("por_grupo", "grupo"); },
}));

export const baseLocal: FonteModelos = {
  async listar(filtro) {
    const d = await abrir();
    const todos = (filtro?.grupo ? await d.getAllFromIndex("modelos", "por_grupo", filtro.grupo) : await d.getAll("modelos")) as Modelo[];
    return todos.filter((m) => !filtro?.tipo || m.tipo === filtro.tipo).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  },
  async salvar(m) { await (await abrir()).put("modelos", m); },
  async remover(id) { await (await abrir()).delete("modelos", id); },
};

// Caixinhas (quais unidades compartilham modelos) — configuradas pelo curador.
export const lerGrupos = async () => (await sget<Grupo[] | undefined>("baseGrupos")) ?? [];
export const salvarGrupos = (g: Grupo[]) => sset({ baseGrupos: g });

/** Caixinha da unidade logada no SEI (null se ainda não detectou a sessão). */
export async function grupoAtual(): Promise<string | null> {
  const sessao = await sget<{ unit?: string | null } | undefined>("session");
  return grupoDaUnidade(await lerGrupos(), sessao?.unit);
}

export async function modelosDoGrupo(grupo: string, tipo?: TipoDocumento) {
  return baseLocal.listar({ grupo, tipo });
}

// Export/import: arquivo para levar a base a um colega ou carregar no banco depois.
export async function exportarBase(): Promise<Blob> {
  const dados = { tipo: "sei-assistant-base", versao: 1, em: new Date().toISOString(), grupos: await lerGrupos(), modelos: await baseLocal.listar() };
  return new Blob([JSON.stringify(dados)], { type: "application/json" });
}
export async function importarBase(f: File): Promise<number> {
  const j = JSON.parse(await f.text());
  if (j.tipo !== "sei-assistant-base" || !Array.isArray(j.modelos)) throw new Error("arquivo não é um export da base de modelos");
  for (const m of j.modelos as Modelo[]) await baseLocal.salvar(m);
  const atuais = await lerGrupos();
  const nomes = new Set(atuais.map((g) => g.nome));
  await salvarGrupos([...atuais, ...((j.grupos ?? []) as Grupo[]).filter((g) => !nomes.has(g.nome))]);
  return j.modelos.length;
}
