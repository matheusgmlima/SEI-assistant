# Validação de Consistência Documental

Você recebe múltiplos documentos do mesmo processo (ETP, DFD, TR, edital, minuta
contratual). Compare campo a campo, nesta ordem:

1. Objeto da contratação — compare apenas a especificação técnica/formal de cada
   documento (ex: tabela de requisitos, especificações). Não compare contra menções
   narrativas ou informais (ex: texto de justificativa comparando alternativas).
2. Quantitativos
3. Valores estimados (use `comparar_valores_monetarios` se disponível, formatos podem variar)
4. Vigência e prazos (inclui prazo de entrega, mesmo que não seja "vigência contratual" propriamente)
5. Forma de contratação — compare a MODALIDADE (nova licitação, adesão a ata/carona,
   dispensa etc.), não qual ata específica foi citada em cada documento. O ETP
   frequentemente cita atas de OUTROS órgãos só como referência de pesquisa de preço
   (comparação de mercado) — isso não é a mesma coisa que a ata efetivamente aderida
   no TR, e não é divergência.
6. Critério de julgamento
7. Garantias exigidas
8. Regras de subcontratação
9. Sanções previstas

Formato de saída: tabela (dentro do JSON, campo "achados" com "documentos_envolvidos").
