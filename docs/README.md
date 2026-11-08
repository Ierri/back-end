# Documentação do back-end

## Modelagem de dados

A modelagem está em [`modelagem/`](./modelagem/). Ela é uma especificação para revisão e implementação futura; a presença de uma coleção nos documentos não significa que ela já exista no código.

Ordem recomendada de leitura:

1. [`entrega-modelagem-equipe.md`](./modelagem/entrega-modelagem-equipe.md) — handoff, decisões, permissões, exemplos, riscos e checklist de aprovação.
2. [`der-completo.dbml`](./modelagem/der-completo.dbml) — DER completo para importar no dbdiagram.io.
3. [`modelagem-usuarios.md`](./modelagem/modelagem-usuarios.md) — conta, perfil, baseline existente e evolução proposta.
4. [`modelagem-colecoes-sociais.md`](./modelagem/modelagem-colecoes-sociais.md) — publicações, comentários, votos, seguidores, notificações, denúncias e outbox.
5. [`analise-modelagem-banco-ir.md`](./modelagem/analise-modelagem-banco-ir.md) — análise funcional e justificativas gerais.

### Situação

- `usuarios` e a autenticação local possuem implementação parcial no back-end.
- As demais coleções são propostas de modelagem.
- Decisões marcadas como pendentes precisam de aprovação antes de virarem contrato técnico.
- Campos, índices e regras novas devem ser introduzidos com compatibilidade para documentos existentes.

### Diagramas

- `der-completo.dbml` é o diagrama principal.
- `der-usuarios.dbml` é um recorte focado em usuários.
- O DBML é o único formato oficial dos diagramas de dados.
