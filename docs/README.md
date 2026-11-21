# Documentação do back-end

> **Atualização em 21/11/2026:** leia primeiro o [contrato de persistência MongoDB](./modelagem/contrato-banco.md). Ele registra o estado observado na `staging`, schemas e índices declarados, transações, dados iniciais e pendências. Os documentos abaixo preservam o desenho de produto e podem descrever coleções ainda não implementadas.

## Modelagem de dados

A modelagem está em [`modelagem/`](./modelagem/). Ela é uma especificação para revisão e implementação futura; a presença de uma coleção nos documentos não significa que ela já exista no código.

Ordem recomendada de leitura:

1. [`entrega-modelagem-equipe.md`](./modelagem/entrega-modelagem-equipe.md) — handoff, decisões, permissões, exemplos, riscos e checklist de aprovação.
2. [`der-completo.dbml`](./modelagem/der-completo.dbml) — DER completo para importar no dbdiagram.io.
3. [`modelagem-usuarios.md`](./modelagem/modelagem-usuarios.md) — conta, perfil, baseline existente e evolução proposta.
4. [`modelagem-colecoes-sociais.md`](./modelagem/modelagem-colecoes-sociais.md) — publicações, comentários, votos, seguidores, notificações, denúncias e outbox.
5. [`analise-modelagem-banco-ir.md`](./modelagem/analise-modelagem-banco-ir.md) — análise funcional e justificativas gerais.

### Situação

- `usuarios`, `publicacoes` e `uploads_midias` possuem implementação no back-end; as demais coleções com schema nesta revisão estão listadas no contrato.
- Notificações, denúncias e outbox permanecem propostas de modelagem.
- Decisões de produto pendentes não devem ser tratadas como fluxos já implementados.
- Campos, índices e regras novas devem ser introduzidos com compatibilidade para documentos existentes.

### Diagramas

- `der-completo.dbml` é o diagrama principal.
- `der-usuarios.dbml` é um recorte focado em usuários.
- O DBML é o único formato oficial dos diagramas de dados.
