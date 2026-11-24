# Ierri

**Share. Review. Inspire.**

Rede social pública de interfaces e design, construída com Next.js e shadcn/ui.

## Memória do projeto

- Fonte canônica dos contratos MongoDB: schemas em `src/usuarios/schemas`, `src/publicacoes/schemas` e `src/comentarios/schemas`. Os documentos em `docs/modelagem` descrevem o domínio e distinguem o que já funciona das propostas.
- Modelos sociais consolidados: `Usuario`, `Tecnologia`, `Seguidor`, `Voto` e `PublicacaoSalva`. O único `Comentario` pertence ao módulo `comentarios`; o limite técnico atual de conteúdo é de 2.000 caracteres e ainda depende de validação do produto.
- Publicações, comentários, consulta e edição de perfis, catálogo público e seleção de stacks têm APIs. Seguidores, votos, salvos, gestão administrativa de tecnologias e papéis ainda não têm fluxos. Perfis privados ocultam biografia e stacks de terceiros, mas a política global de acesso a conteúdos e de bloqueio de contas continua pendente. Os contadores sociais de usuário são projeções sem manutenção automática.
- Comentários preservam idempotência e reconciliação sem transações entre documentos. A adoção de replica set e transações depende de uma etapa futura.
- Referência de origem: [PR #9](https://github.com/Ierri/back-end/pull/9) como proposta de modelagem e [PR #10](https://github.com/Ierri/back-end/pull/10) como implementação funcional de comentários. Esta consolidação mantém os contratos do PR #10.
