# IR / Ierri — entrega da modelagem de dados para a equipe

**Data de consolidação:** 08/11/2026  
**Versão:** 1.0  
**Banco principal:** MongoDB  
**Armazenamento temporário e cache:** Redis  
**Arquivos de mídia:** Object Storage  
**Status:** modelagem estrutural concluída; decisões de produto identificadas aguardam validação

## 1. Objetivo deste documento

Este é o documento de handoff da modelagem de dados do IR / Ierri. Ele permite que produto, design, back-end, QA e segurança revisem o mesmo escopo, aprovem as decisões pendentes e planejem a implementação sem depender de interpretações informais.

Este documento não altera nem substitui o back-end atual. Ele descreve a estrutura recomendada, as regras de domínio e os pontos que ainda precisam de aprovação.

## 2. Artefatos entregues

| Artefato | Finalidade |
|---|---|
| [`der-completo.dbml`](./der-completo.dbml) | DER completo para visualização no dbdiagram.io |
| [`der-usuarios.dbml`](./der-usuarios.dbml) | Recorte visual da coleção `usuarios` |
| [`modelagem-usuarios.md`](./modelagem-usuarios.md) | Especificação detalhada de conta e perfil |
| [`modelagem-colecoes-sociais.md`](./modelagem-colecoes-sociais.md) | Especificação detalhada das demais coleções |
| [`analise-modelagem-banco-ir.md`](./analise-modelagem-banco-ir.md) | Análise funcional, técnica e visão geral do domínio |

O arquivo oficial para visualizar o modelo completo é `der-completo.dbml`. O formato DBML foi adotado como principal porque representa entidades, campos, índices e relacionamentos de maneira textual e versionável.

## 3. Escopo funcional coberto

A modelagem contempla:

- cadastro, autenticação local e perfil;
- tecnologias/stacks do usuário;
- perfis públicos e privados;
- publicações com múltiplas mídias;
- feed cronológico e ranking por score;
- comentários e respostas em árvore;
- upvote, downvote e troca de voto;
- publicações salvas;
- seguidores e solicitações para perfis privados;
- notificações individuais e agrupadas;
- denúncias e moderação mínima;
- eventos outbox para processamento confiável;
- integração conceitual com Redis e Object Storage.

Ficam fora da baseline atual:

- OAuth;
- OTP ou código por e-mail;
- refresh token;
- mensagens privadas;
- grupos ou comunidades;
- histórico de versões de posts e comentários;
- moderação automática por inteligência artificial;
- tags específicas por publicação;
- monetização.

## 4. Estado atual versus evolução proposta

| Componente | Situação | Observação |
|---|---|---|
| `usuarios` | Parcialmente implementada | Campos básicos, autenticação local e índices únicos já existem |
| Sessões Redis | Implementadas | Sessões JWT revogáveis e temporárias |
| `tecnologias` | Proposta | Catálogo compartilhado de stacks |
| `publicacoes` | Proposta | Agregado principal do domínio social |
| `comentarios` | Proposta | Coleção separada e árvore limitada |
| `votos` | Proposta | Um voto por usuário e publicação |
| `publicacoes_salvas` | Proposta | Relação idempotente |
| `seguidores` | Proposta | Suporta perfil público e privado |
| `notificacoes` | Proposta | Persistência durável e agrupamento |
| `denuncias` | Proposta | Moderação mínima |
| `eventos_outbox` | Recomendação técnica | Confiabilidade entre persistência e efeitos assíncronos |
| Object Storage | Necessário, não definido | Provedor ainda deve ser escolhido pela equipe |

Nenhuma coleção proposta deve ser tratada como implementada apenas por aparecer nos documentos.

## 5. Arquitetura de persistência

```text
MongoDB
├── fonte de verdade de contas e perfis
├── fonte de verdade de conteúdo e relações sociais
├── votos, denúncias e notificações duráveis
└── dados necessários para reconstruir contadores e rankings

Redis
├── sessões temporárias já existentes
├── rate limit
├── cache e feed projetado
├── idempotência temporária
└── contadores de não lidas opcionais

Object Storage
├── imagens
├── vídeos
└── arquivos derivados ou miniaturas
```

Regra central: todo dado armazenado apenas no Redis deve poder ser reconstruído a partir do MongoDB ou expirar sem perda de informação de negócio.

## 6. Catálogo das coleções

| Coleção | Responsabilidade | Crescimento esperado | Estratégia de exclusão |
|---|---|---:|---|
| `usuarios` | Conta, perfil e projeções do criador | Uma por conta | Lógica e posterior anonimização |
| `tecnologias` | Catálogo de stacks | Baixo | Desativação |
| `publicacoes` | Conteúdo, mídias e contadores | Alto | Lógica |
| `comentarios` | Comentários e respostas | Muito alto | Lógica |
| `votos` | Voto individual | Muito alto | Física ao remover voto |
| `publicacoes_salvas` | Salvamento individual | Alto | Física |
| `seguidores` | Relação entre usuários | Muito alto | Física no MVP |
| `notificacoes` | Histórico de eventos do usuário | Muito alto | Retenção configurável |
| `denuncias` | Auditoria de moderação | Médio | Retenção administrativa |
| `eventos_outbox` | Entrega confiável de efeitos | Muito alto | TTL após processamento e retenção |

## 7. Relacionamentos principais

| Origem | Relação | Destino | Cardinalidade |
|---|---|---|---|
| Usuário | seleciona | Tecnologia | N:N por array limitado de referências |
| Usuário | cria | Publicação | 1:N |
| Publicação | incorpora | Mídia | 1:1..10 |
| Usuário | escreve | Comentário | 1:N |
| Publicação | recebe | Comentário | 1:N |
| Comentário | responde | Comentário | 0..1:N, até profundidade 2 |
| Usuário | realiza | Voto | 1:N |
| Publicação | recebe | Voto | 1:N |
| Usuário | salva | Publicação | N:N via coleção associativa |
| Usuário | segue | Usuário | N:N autorreferente |
| Usuário | recebe | Notificação | 1:N |
| Usuário | registra | Denúncia | 1:N |

Mídias aparecem separadas no DER apenas para facilitar a leitura, mas são subdocumentos incorporados em `publicacoes`.

## 8. Decisões consolidadas

| ID | Tema | Decisão | Estado |
|---|---|---|---|
| AP-001 | Banco principal | MongoDB é a fonte de verdade | Consolidada |
| AP-002 | Sessões | Redis armazena apenas estado temporário e reconstruível | Implementada para autenticação |
| AP-003 | Nomenclatura | Coleções e campos internos em português | Alinhada ao back-end |
| AP-004 | Usuários | Evoluir `usuarios`; não criar coleção paralela `users` | Consolidada |
| AP-005 | Comentários | Três níveis visuais, profundidade de 0 a 2 | Aprovada |
| AP-006 | Score | `upvotes - downvotes` | Aprovada |
| AP-007 | Downvote | Anônimo para usuários e sem notificação | Aprovada |
| AP-008 | Voto | Um voto por usuário e publicação | Consolidada |
| AP-009 | Perfil privado | Follow depende de aprovação | Aprovada |
| AP-010 | Conteúdo privado | Visível ao autor e seguidores aceitos | Aprovada em nível funcional |
| AP-011 | Upload | Até 10 arquivos e 200 MB agregados | Aprovada para o MVP |
| AP-012 | Imagens | JPEG, PNG e WebP; até 10 MB por arquivo | Aprovada para o MVP |
| AP-013 | Vídeos | MP4/H.264 e WebM; até 100 MB e 120 segundos | Aprovada para o MVP |
| AP-014 | Edição | Posts e comentários editáveis, sem histórico no MVP | Aprovada |
| AP-015 | Exclusão de comentário | Exclusão lógica preserva a árvore | Consolidada |
| AP-016 | Salvamento | Relação única e idempotente | Consolidada |
| AP-017 | Tecnologias | Vinculadas ao perfil por `stack_ids` | Alinhada à interface |
| AP-018 | Arquivos | Binários fora do MongoDB | Consolidada |
| AP-019 | Paginação | Cursor em listas grandes | Recomendação técnica |
| AP-020 | Contadores | Projeções reconciliáveis, não fonte de verdade | Recomendação técnica |

## 9. Registro de decisões pendentes

As recomendações abaixo servem como ponto de partida. A coluna “decisão final” deve ser preenchida pela equipe responsável.

| ID | Decisão necessária | Recomendação de modelagem | Responsável sugerido | Decisão final |
|---|---|---|---|---|
| PD-001 | Limite de `nome` | 2 a 100 caracteres | Produto | Pendente |
| PD-002 | Limite de `username` | 3 a 30 caracteres | Produto + Back-end | Pendente |
| PD-003 | Edição de `username` | Permitir com período de reserva e auditoria futura | Produto + Segurança | Pendente |
| PD-004 | Reutilização de e-mail/username | Não reutilizar enquanto não houver anonimização formal | Produto + Jurídico | Pendente |
| PD-005 | Limite de biografia | 500 caracteres | Produto | Pendente |
| PD-006 | Limite de stacks | 20 tecnologias por perfil | Produto | Pendente |
| PD-007 | Limite de texto do post | Definir após validar a interface; sugestão de 5.000 | Produto + Design | Pendente |
| PD-008 | Limite de comentário | Sugestão de 2.000 caracteres | Produto + Design | Pendente |
| PD-009 | Troca de mídias após publicação | Permitir somente enquanto não houver interações, ou criar nova publicação | Produto | Pendente |
| PD-010 | Restaurar publicação arquivada | Permitir retorno para `publicada` mantendo datas originais | Produto | Pendente |
| PD-011 | Busca | Atlas Search se houver infraestrutura; texto nativo no MVP simples | Arquitetura | Pendente |
| PD-012 | Perfil privado | Definir quais campos básicos continuam públicos | Produto + Privacidade | Pendente |
| PD-013 | Salvamento de conteúdo privado | Revalidar autorização em toda leitura | Produto + Segurança | Pendente |
| PD-014 | Janela de agrupamento de upvotes | Uma hora | Produto | Pendente |
| PD-015 | Marcos de trending | 10, 50, 100, 500 e 1.000 de score | Produto | Pendente |
| PD-016 | Destinatário de trending | Somente o autor no MVP | Produto | Pendente |
| PD-017 | Retenção de notificações | Sugestão inicial de 12 meses | Produto + Infraestrutura | Pendente |
| PD-018 | Retenção de denúncias | Definir conforme auditoria e política jurídica | Jurídico + Segurança | Pendente |
| PD-019 | Retenção de arquivos excluídos | Quarentena antes da remoção física | Segurança + Infraestrutura | Pendente |
| PD-020 | Retenção de outbox | TTL após período operacional, por exemplo 30 dias | Infraestrutura | Pendente |
| PD-021 | Anonimização de conta | Definir prazo, campos e obrigações legais | Jurídico + Segurança | Pendente |
| PD-022 | Histórico de unfollow/recusa | Não manter no MVP; reavaliar para auditoria | Produto | Pendente |
| PD-023 | Provedor de Object Storage | Escolher S3, MinIO, Cloudinary ou equivalente | Arquitetura + Infraestrutura | Pendente |
| PD-024 | Transações MongoDB | Usar replica set; sem isso, exigir idempotência e reconciliação | Arquitetura | Pendente |

## 10. Matriz de permissões proposta

Legenda: `L` leitura, `C` criação, `E` edição, `X` exclusão/remoção, `M` moderação, `—` sem acesso.

### Conteúdo e relações sociais

| Recurso/ação | Visitante | Usuário ativo | Autor/dono | Seguidor aceito | Moderador | Administrador |
|---|---:|---:|---:|---:|---:|---:|
| Perfil público | L | L | L/E | L | L | L/M |
| Perfil privado básico | Pendente | Pendente | L/E | L | L | L/M |
| Dados privados da conta | — | — | L/E | — | — | L/M controlado |
| Publicação pública | L | L | L/E/X | L | L/M | L/M |
| Publicação para seguidores | — | Se autorizado | L/E/X | L | L/M | L/M |
| Criar publicação | — | C | C | C | C | C |
| Comentário visível | L | L/C | L/C/E/X próprio | L/C | L/M | L/M |
| Votar | — | C/E/X próprio | C/E/X próprio | C/E/X próprio | C/E/X próprio | C/E/X próprio |
| Salvar publicação | — | C/X próprio | C/X próprio | C/X próprio | C/X próprio | C/X próprio |
| Seguir perfil público | — | C/X próprio | — | C/X próprio | C/X próprio | C/X próprio |
| Solicitar perfil privado | — | C/X próprio | — | C/X próprio | C/X próprio | C/X próprio |
| Aprovar solicitação | — | — | E/X recebida | — | — | M excepcional |
| Notificação | — | — | L/E própria | — | — | M somente com justificativa |
| Criar denúncia | — | C | C | C | C | C |
| Analisar denúncia | — | — | — | — | L/E/M | L/E/M |

### Regras de autorização

1. Ser autor não substitui verificação de status da conta.
2. Perfil `bloqueado` não cria nem altera conteúdo.
3. Seguidor `pendente` não acessa conteúdo restrito.
4. Salvamento não concede acesso a conteúdo que deixou de ser autorizado.
5. Moderação não permite leitura de `senha_hash`.
6. Ações administrativas precisam de trilha de auditoria, mesmo que a coleção específica seja uma evolução posterior.
7. Consultas em cache devem aplicar as mesmas regras de autorização do MongoDB.

## 11. Matriz CRUD e responsabilidade

| Coleção | Cria | Lê | Atualiza | Remove/encerra | Fonte de verdade |
|---|---|---|---|---|---|
| `usuarios` | Cadastro | Auth, perfil, feed | Usuário/admin | Exclusão lógica | Conta e perfil |
| `tecnologias` | Admin | Perfis e busca | Admin | Desativação | Catálogo |
| `publicacoes` | Usuário | Feed, perfil, detalhe | Autor/moderação | Exclusão lógica | Conteúdo do post |
| `comentarios` | Usuário | Detalhe do post | Autor/moderação | Exclusão lógica | Conteúdo do comentário |
| `votos` | Usuário | Estado do voto e agregações | Mesmo usuário | Física | Voto individual |
| `publicacoes_salvas` | Usuário | Lista pessoal | Não se aplica | Física | Salvamento individual |
| `seguidores` | Usuário | Autorização e listas | Participantes conforme fluxo | Física no MVP | Relação social |
| `notificacoes` | Processador de eventos | Destinatário | Leitura/agrupamento | Retenção | Notificação durável |
| `denuncias` | Usuário | Moderação | Moderador | Encerramento por status | Histórico de denúncia |
| `eventos_outbox` | Transação de domínio | Worker | Worker | TTL controlado | Entrega pendente/processada |

## 12. Exemplos de documentos MongoDB

Os valores abaixo são ilustrativos. IDs, URLs e datas não representam dados reais.

### `usuarios`

```javascript
{
  _id: ObjectId("690f00000000000000000001"),
  nome: "Ana Silva",
  email: "ana@example.com",
  username: "ana_silva",
  senha_hash: "<hash-nao-exposto>",
  biografia: "Designer e desenvolvedora front-end.",
  avatar_url: "https://cdn.example.com/avatars/ana.webp",
  stack_ids: [ObjectId("690f10000000000000000001")],
  visibilidade_perfil: "publico",
  papeis: ["usuario"],
  status: "ativo",
  contadores: { publicacoes: 1, seguidores: 12, seguindo: 8, score: 24 },
  email_verificado_em: null,
  termos_aceitos_em: ISODate("2026-11-08T12:00:00Z"),
  versao_termos_aceita: "2026-10",
  criado_em: ISODate("2026-11-08T12:00:00Z"),
  atualizado_em: ISODate("2026-11-08T12:00:00Z"),
  excluido_em: null
}
```

### `tecnologias`

```javascript
{
  _id: ObjectId("690f10000000000000000001"),
  nome: "React",
  slug: "react",
  categoria: "frontend",
  icone_url: "https://cdn.example.com/technologies/react.svg",
  ativo: true,
  criado_em: ISODate("2026-11-08T12:00:00Z"),
  atualizado_em: ISODate("2026-11-08T12:00:00Z")
}
```

### `publicacoes`

```javascript
{
  _id: ObjectId("690f20000000000000000001"),
  slug: "dashboard-financeiro-690f20",
  autor_id: ObjectId("690f00000000000000000001"),
  conteudo: "Gostaria de feedback sobre a hierarquia visual deste dashboard.",
  midias: [
    {
      _id: ObjectId("690f21000000000000000001"),
      tipo: "imagem",
      url: "https://cdn.example.com/posts/dashboard.webp",
      chave_storage: "posts/690f20/dashboard.webp",
      mime_type: "image/webp",
      tamanho_bytes: 845231,
      largura: 1440,
      altura: 900,
      duracao_segundos: null,
      texto_alternativo: "Dashboard financeiro em tema escuro",
      ordem: 0
    }
  ],
  visibilidade: "publico",
  status: "publicada",
  contadores: { upvotes: 28, downvotes: 4, score: 24, comentarios: 3, salvamentos: 7 },
  publicada_em: ISODate("2026-11-08T13:00:00Z"),
  editada_em: null,
  criada_em: ISODate("2026-11-08T12:58:00Z"),
  atualizada_em: ISODate("2026-11-08T13:00:00Z")
}
```

### `comentarios`

```javascript
{
  _id: ObjectId("690f30000000000000000001"),
  publicacao_id: ObjectId("690f20000000000000000001"),
  autor_id: ObjectId("690f00000000000000000002"),
  comentario_pai_id: null,
  comentario_raiz_id: null,
  profundidade: 0,
  conteudo: "A hierarquia está boa; eu aumentaria o contraste dos filtros.",
  status: "publicado",
  editado_em: null,
  criado_em: ISODate("2026-11-08T13:10:00Z"),
  atualizado_em: ISODate("2026-11-08T13:10:00Z")
}
```

### `votos`

```javascript
{
  _id: ObjectId("690f40000000000000000001"),
  publicacao_id: ObjectId("690f20000000000000000001"),
  usuario_id: ObjectId("690f00000000000000000002"),
  valor: 1,
  criado_em: ISODate("2026-11-08T13:11:00Z"),
  atualizado_em: ISODate("2026-11-08T13:11:00Z")
}
```

### `publicacoes_salvas`

```javascript
{
  _id: ObjectId("690f50000000000000000001"),
  usuario_id: ObjectId("690f00000000000000000002"),
  publicacao_id: ObjectId("690f20000000000000000001"),
  criado_em: ISODate("2026-11-08T13:12:00Z")
}
```

### `seguidores`

```javascript
{
  _id: ObjectId("690f60000000000000000001"),
  seguidor_id: ObjectId("690f00000000000000000002"),
  seguido_id: ObjectId("690f00000000000000000001"),
  status: "aceito",
  solicitado_em: ISODate("2026-11-08T13:15:00Z"),
  aceito_em: ISODate("2026-11-08T13:15:00Z"),
  atualizado_em: ISODate("2026-11-08T13:15:00Z")
}
```

### `notificacoes`

```javascript
{
  _id: ObjectId("690f70000000000000000001"),
  destinatario_id: ObjectId("690f00000000000000000001"),
  ator_id: ObjectId("690f00000000000000000002"),
  atores_preview_ids: [ObjectId("690f00000000000000000002")],
  quantidade_atores: 1,
  tipo: "post_upvoted",
  entidade_tipo: "publicacao",
  entidade_id: ObjectId("690f20000000000000000001"),
  publicacao_id: ObjectId("690f20000000000000000001"),
  chave_agrupamento: "post_upvoted:690f20:2026-11-08T13",
  metadados: { versao: 1 },
  lida_em: null,
  criada_em: ISODate("2026-11-08T13:11:00Z"),
  ultimo_evento_em: ISODate("2026-11-08T13:11:00Z")
}
```

### `denuncias`

```javascript
{
  _id: ObjectId("690f80000000000000000001"),
  denunciante_id: ObjectId("690f00000000000000000002"),
  alvo_tipo: "publicacao",
  alvo_id: ObjectId("690f20000000000000000001"),
  motivo: "outro",
  descricao: "Descrição da situação para análise.",
  status: "aberta",
  moderador_id: null,
  nota_resolucao: null,
  criada_em: ISODate("2026-11-08T13:20:00Z"),
  resolvida_em: null
}
```

### `eventos_outbox`

```javascript
{
  _id: ObjectId("690f90000000000000000001"),
  tipo: "voto_registrado",
  agregado_tipo: "publicacao",
  agregado_id: ObjectId("690f20000000000000000001"),
  payload: { versao: 1, usuario_id: "690f00000000000000000002", valor: 1 },
  status: "pendente",
  tentativas: 0,
  criado_em: ISODate("2026-11-08T13:11:00Z"),
  processado_em: null
}
```

## 13. Fontes de verdade e projeções

| Informação | Fonte de verdade | Projeção de leitura |
|---|---|---|
| Voto individual | `votos` | Estado do voto no detalhe do post |
| Score da publicação | Agregação de `votos` | `publicacoes.contadores` |
| Salvamento | `publicacoes_salvas` | Contador da publicação |
| Comentário | `comentarios` | Contador da publicação |
| Follow | `seguidores` com `status = aceito` | Contadores do usuário |
| Score do criador | Publicações válidas | `usuarios.contadores.score` |
| Notificação | `notificacoes` | Contador Redis opcional |
| Feed/ranking | MongoDB | Cache ou Sorted Set Redis opcional |

Contadores não provam a existência de uma relação individual. A existência deve ser consultada na coleção de origem.

## 14. Operações transacionais recomendadas

| Operação | Documentos afetados |
|---|---|
| Votar/trocar/remover voto | `votos`, contadores da publicação e outbox |
| Comentar | `comentarios`, contador da publicação e outbox |
| Excluir comentário | status do comentário, contador e outbox |
| Salvar/remover salvamento | relação de salvamento e contador |
| Aceitar follow | relação, contadores dos dois usuários e outbox |
| Publicar após upload | publicação, contador do autor e outbox |
| Resolver denúncia | denúncia, alvo moderado e outbox |

Se a equipe optar por não usar transações MongoDB, cada fluxo deve ser idempotente e possuir rotina de reconciliação.

## 15. Ordem sugerida para implementação pela equipe

Esta ordem é orientação de dependência, não autorização para alterar o código.

1. Aprovar decisões de produto que afetam schemas e autorização.
2. Evoluir `usuarios` de forma compatível com documentos existentes.
3. Criar `tecnologias` e popular o catálogo inicial.
4. Criar `publicacoes` e integrar Object Storage.
5. Criar `comentarios`.
6. Criar `votos` e `publicacoes_salvas` com índices únicos.
7. Criar `seguidores` e autorização de perfil privado.
8. Criar `eventos_outbox`.
9. Criar `notificacoes` a partir dos eventos.
10. Criar `denuncias` e fluxos mínimos de moderação.
11. Adicionar reconciliação de contadores.
12. Medir consultas antes de acrescentar índices ou cache além do proposto.

## 16. Plano de validação

### Modelagem

- [ ] Produto aprovou enums, limites e ciclos de vida.
- [ ] Segurança aprovou dados públicos, privados e confidenciais.
- [ ] Jurídico aprovou retenção, exclusão e anonimização.
- [ ] Back-end validou viabilidade dos índices e transações.
- [ ] Infraestrutura escolheu Object Storage e estratégia MongoDB.
- [ ] QA recebeu invariantes e casos-limite.

### Dados e índices

- [ ] Índices únicos foram testados com concorrência.
- [ ] Planos de consulta dos feeds foram analisados.
- [ ] Paginação por cursor não produz duplicatas ou lacunas.
- [ ] Documentos antigos recebem defaults ou migração controlada.
- [ ] Contadores podem ser reconstruídos a partir das fontes de verdade.
- [ ] Índices de busca foram escolhidos com base em consultas reais.

### Privacidade e autorização

- [ ] Perfil privado foi testado como visitante, pendente, aceito e proprietário.
- [ ] Conteúdo salvo revalida autorização.
- [ ] Downvote não revela o votante.
- [ ] `senha_hash` nunca aparece em resposta ou log.
- [ ] Moderação não concede acesso indiscriminado a dados confidenciais.
- [ ] Exclusão e bloqueio invalidam acesso conforme a política aprovada.

### Consistência

- [ ] Troca de voto aplica os deltas corretos.
- [ ] Comentário excluído com respostas preserva a árvore.
- [ ] Follow pendente não altera contadores nem concede acesso.
- [ ] Falhas de Redis não causam perda de dados permanentes.
- [ ] Eventos outbox são processados de forma idempotente.
- [ ] Jobs de reconciliação corrigem divergências simuladas.

## 17. Casos de teste de domínio obrigatórios

1. Dois cadastros concorrentes com o mesmo e-mail.
2. Geração concorrente do mesmo username base.
3. Usuário tentando seguir a si mesmo.
4. Solicitação repetida para perfil privado.
5. Leitura de post privado por visitante, pendente, seguidor e autor.
6. Criação de comentário em profundidade 3.
7. Exclusão de comentário raiz com respostas.
8. Upvote repetido e troca de upvote para downvote.
9. Duas tentativas concorrentes de salvar a mesma publicação.
10. Publicação com 11 arquivos, tipo inválido ou limite agregado excedido.
11. Falha de processamento de mídia antes da publicação.
12. Agrupamento concorrente de upvotes na mesma janela.
13. Denúncia com alvo inexistente ou `motivo = outro` sem descrição.
14. Worker processando o mesmo evento outbox duas vezes.
15. Reconciliação de contadores propositalmente divergentes.

## 18. Riscos conhecidos

| Risco | Impacto | Mitigação proposta |
|---|---|---|
| Contadores divergentes | Feed e perfil incorretos | Transações, idempotência e reconciliação |
| Arrays sem limite | Documento crescente | Limites explícitos para mídias, stacks e previews |
| Índices excessivos | Escrita lenta e custo | Criar apenas os que sustentam consultas aprovadas |
| Consulta sem privacidade | Vazamento de conteúdo | Autorização antes da resposta e do cache |
| Referência órfã | Perfil ou conteúdo inconsistente | Exclusão lógica e validação de referência |
| Redis tratado como fonte | Perda de estado de negócio | Reconstrução integral a partir do MongoDB |
| Upload parcialmente concluído | Arquivos órfãos | Estado `processando` e job de limpeza |
| Relação polimórfica inválida | Notificação/denúncia quebrada | Validar `tipo + id` no fluxo de negócio |
| Exclusão sem política | Risco de privacidade | Aprovação jurídica antes da operação definitiva |
| Schema obrigatório aplicado cedo | Quebra de documentos antigos | Defaults, backfill e rollout controlado |

## 19. Reunião de aprovação sugerida

Participantes recomendados: produto, design, responsável pelo back-end, QA, infraestrutura e segurança/privacidade.

Agenda:

1. Confirmar escopo do MVP.
2. Revisar as decisões consolidadas.
3. Preencher a decisão final de `PD-001` a `PD-024`.
4. Aprovar a matriz de permissões.
5. Confirmar limites de upload e textos.
6. Definir Object Storage e disponibilidade de replica set.
7. Aprovar retenção, exclusão e anonimização.
8. Definir responsáveis e ordem de implementação.
9. Registrar alterações solicitadas na modelagem.
10. Assinar o checklist de aceite.

## 20. Aprovação

| Área | Responsável | Estado | Data | Observações |
|---|---|---|---|---|
| Modelagem de dados | — | Entregue para revisão | — | — |
| Produto | — | Pendente | — | — |
| Design | — | Pendente | — | — |
| Back-end | — | Pendente | — | — |
| QA | — | Pendente | — | — |
| Infraestrutura | — | Pendente | — | — |
| Segurança/Privacidade | — | Pendente | — | — |

## 21. Critério de encerramento da modelagem

A modelagem será considerada aprovada quando:

- as decisões `PD-001` a `PD-024` aplicáveis ao MVP estiverem preenchidas;
- a matriz de permissões estiver aprovada;
- retenção e anonimização tiverem responsáveis e política definida;
- os limites de campos e uploads estiverem confirmados;
- o back-end confirmar a viabilidade dos índices e fluxos transacionais;
- alterações solicitadas estiverem refletidas no DER e nos documentos;
- produto, back-end e QA registrarem aprovação na tabela acima.

