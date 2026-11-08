# IR / Ierri — modelagem das coleções sociais

**Tipo de artefato:** especificação conceitual, lógica e física  
**Banco principal:** MongoDB  
**Status:** proposta de modelagem; nenhuma coleção deste documento está declarada como implementada  
**Complemento:** [`modelagem-usuarios.md`](./modelagem-usuarios.md)  
**DER completo:** [`der-completo.dbml`](./der-completo.dbml)

## 1. Escopo

Este documento detalha as coleções:

- `tecnologias`;
- `publicacoes`, incluindo o subdocumento `midias`;
- `comentarios`;
- `votos`;
- `publicacoes_salvas`;
- `seguidores`;
- `notificacoes`;
- `denuncias`;
- `eventos_outbox`.

Todas são propostas para evolução do produto. A única coleção confirmada no back-end atual é `usuarios`, documentada separadamente.

## 2. Princípios de modelagem

1. Dados com crescimento ilimitado ficam em coleções próprias.
2. Dados pequenos, limitados e sempre lidos com o pai podem ser incorporados.
3. Arquivos ficam em Object Storage; o MongoDB guarda metadados e referências.
4. Redis não é fonte de verdade de conteúdo, votos, relações ou notificações.
5. Contadores são projeções denormalizadas e precisam ser reconciliáveis.
6. Exclusão de conteúdo com dependentes é lógica, preservando integridade e contexto.
7. Datas são persistidas em UTC.
8. Listas grandes usam paginação por cursor, não `skip` crescente.
9. Relações polimórficas são validadas pela aplicação, pois não há chave estrangeira obrigatória no MongoDB.

## 3. Visão de relacionamentos

| Origem | Relação | Destino | Cardinalidade |
|---|---|---|---|
| `usuarios` | seleciona | `tecnologias` | N:N, materializada por `stack_ids` limitado |
| `usuarios` | cria | `publicacoes` | 1:N |
| `publicacoes` | incorpora | `midias` | 1:1..10 |
| `usuarios` | escreve | `comentarios` | 1:N |
| `publicacoes` | recebe | `comentarios` | 1:N |
| `comentarios` | responde | `comentarios` | 0..1:N, profundidade máxima 2 |
| `usuarios` | realiza | `votos` | 1:N |
| `publicacoes` | recebe | `votos` | 1:N |
| `usuarios` | salva | `publicacoes` | N:N via `publicacoes_salvas` |
| `usuarios` | segue | `usuarios` | N:N autorreferente via `seguidores` |
| `usuarios` | recebe | `notificacoes` | 1:N |
| `usuarios` | registra | `denuncias` | 1:N |

## 4. `tecnologias`

Catálogo controlado de stacks selecionáveis no perfil.

```javascript
{
  _id: ObjectId,
  nome: String,
  slug: String,
  categoria: String | null,
  icone_url: String | null,
  ativo: Boolean,
  criado_em: Date,
  atualizado_em: Date
}
```

| Campo | Obrigatório | Valor inicial | Regra principal |
|---|---:|---|---|
| `nome` | Sim | — | Nome de exibição, sem espaços externos |
| `slug` | Sim | — | Minúsculo, estável e único |
| `categoria` | Não | `null` | Classificação controlada quando adotada |
| `icone_url` | Não | `null` | Referência para imagem, nunca binário incorporado |
| `ativo` | Sim | `true` | Tecnologia inativa não pode ser adicionada a novos perfis |
| `criado_em` | Sim | Data atual | Imutável |
| `atualizado_em` | Sim | Data atual | Alterado junto do documento |

Índice obrigatório: `{ slug: 1 }`, único.

Tecnologias referenciadas por usuários não devem ser apagadas fisicamente. Devem ser marcadas como inativas para preservar perfis e pesquisas históricas.

## 5. `publicacoes`

Publicação é o agregado principal do domínio social.

```javascript
{
  _id: ObjectId,
  slug: String,
  autor_id: ObjectId,
  conteudo: String,
  midias: [Midia],
  visibilidade: "publico" | "seguidores",
  status: "processando" | "publicada" | "arquivada" | "oculta" | "excluida",
  contadores: {
    upvotes: Number,
    downvotes: Number,
    score: Number,
    comentarios: Number,
    salvamentos: Number
  },
  publicada_em: Date | null,
  editada_em: Date | null,
  criada_em: Date,
  atualizada_em: Date
}
```

### Dicionário essencial

| Campo | Obrigatório | Valor inicial | Regra principal |
|---|---:|---|---|
| `slug` | Sim | Gerado | Único e estável para URL |
| `autor_id` | Sim | — | Referência a usuário existente e apto a publicar |
| `conteudo` | Sim | — | Texto não vazio após normalização |
| `midias` | Sim | — | De 1 a 10 subdocumentos |
| `visibilidade` | Sim | Conforme perfil | Autor privado força `seguidores` |
| `status` | Sim | `processando` | Apenas `publicada` participa do feed normal |
| `contadores.*` | Sim | `0` | Projeções derivadas; valores não negativos, salvo score |
| `publicada_em` | Condicional | `null` | Obrigatória ao alcançar `publicada` |
| `editada_em` | Não | `null` | Data da última edição de conteúdo |
| `criada_em` | Sim | Data atual | Data original |
| `atualizada_em` | Sim | Data atual | Qualquer alteração persistente |

### Subdocumento `midias`

```javascript
{
  _id: ObjectId,
  tipo: "imagem" | "video",
  url: String,
  chave_storage: String,
  mime_type: String,
  tamanho_bytes: Number,
  largura: Number | null,
  altura: Number | null,
  duracao_segundos: Number | null,
  texto_alternativo: String | null,
  ordem: Number
}
```

Invariantes de mídia:

- `ordem` é única dentro da publicação e forma sequência de `0` a `n - 1`;
- imagem exige `largura` e `altura`, mas não exige duração;
- vídeo exige `duracao_segundos`; dimensões são recomendadas;
- `chave_storage` identifica o objeto físico e não deve ser exposta como credencial;
- até 10 arquivos e 200 MB agregados;
- imagens: JPEG, PNG ou WebP, até 10 MB cada;
- vídeos: MP4/H.264 ou WebM, até 100 MB e 120 segundos cada;
- MIME type, assinatura binária e tamanho precisam concordar.

Mídias são incorporadas porque têm cardinalidade limitada, pertencem exclusivamente à publicação e são lidas junto dela. O bloco `publicacao_midias` no DER é apenas uma representação visual desse subdocumento.

### Ciclo de vida

```text
processando ──sucesso──> publicada ──autor──> arquivada
     │                       │
     │ falha                 ├──moderação──> oculta
     └──> excluida           └──autor/admin──> excluida
```

- `processando`: upload ou validação ainda em andamento;
- `publicada`: conteúdo elegível para consultas autorizadas;
- `arquivada`: removida do feed pelo autor sem representar infração;
- `oculta`: indisponível por decisão de moderação;
- `excluida`: exclusão lógica aguardando política de retenção.

### Índices

```javascript
{ slug: 1 }                                                        // unique
{ autor_id: 1, publicada_em: -1 }
{ status: 1, visibilidade: 1, publicada_em: -1 }
{ status: 1, visibilidade: 1, "contadores.score": -1, publicada_em: -1 }
```

Pesquisa por conteúdo deve escolher entre índice textual nativo e Atlas Search. Não se recomenda criar ambos sem consulta e medição reais.

## 6. `comentarios`

```javascript
{
  _id: ObjectId,
  publicacao_id: ObjectId,
  autor_id: ObjectId,
  comentario_pai_id: ObjectId | null,
  comentario_raiz_id: ObjectId | null,
  profundidade: 0 | 1 | 2,
  conteudo: String,
  status: "publicado" | "excluido" | "oculto",
  editado_em: Date | null,
  criado_em: Date,
  atualizado_em: Date
}
```

### Invariantes da árvore

| Profundidade | `comentario_pai_id` | `comentario_raiz_id` |
|---:|---|---|
| `0` | `null` | `null` |
| `1` | Comentário de profundidade `0` | ID do mesmo comentário raiz |
| `2` | Comentário de profundidade `1` | ID do ancestral de profundidade `0` |

Além disso:

1. Pai, raiz e resposta devem pertencer à mesma publicação.
2. Não são permitidos ciclos ou profundidade acima de 2.
3. Excluir comentário com respostas muda o status para `excluido` e preserva o nó.
4. Moderação usa `oculto`, diferenciando-a da ação do autor.
5. `editado_em` muda apenas em edição do conteúdo; `atualizado_em` cobre qualquer alteração.

Índices:

```javascript
{ publicacao_id: 1, comentario_pai_id: 1, criado_em: 1 }
{ comentario_raiz_id: 1, criado_em: 1 }
{ autor_id: 1, criado_em: -1 }
```

## 7. `votos`

```javascript
{
  _id: ObjectId,
  publicacao_id: ObjectId,
  usuario_id: ObjectId,
  valor: 1 | -1,
  criado_em: Date,
  atualizado_em: Date
}
```

Índice único obrigatório: `{ publicacao_id: 1, usuario_id: 1 }`.

Regras:

- um usuário mantém no máximo um voto por publicação;
- repetir o mesmo voto não altera contadores;
- trocar o voto atualiza o documento existente;
- remover o voto remove o documento e reverte o contador;
- downvote não revela identidade nem gera notificação;
- `publicacoes.contadores.score` deve sempre equivaler a `upvotes - downvotes`.

| Transição | Δ upvotes | Δ downvotes | Δ score |
|---|---:|---:|---:|
| Sem voto → `1` | +1 | 0 | +1 |
| Sem voto → `-1` | 0 | +1 | -1 |
| `1` → `-1` | -1 | +1 | -2 |
| `-1` → `1` | +1 | -1 | +2 |
| `1` → sem voto | -1 | 0 | -1 |
| `-1` → sem voto | 0 | -1 | +1 |

## 8. `publicacoes_salvas`

```javascript
{
  _id: ObjectId,
  usuario_id: ObjectId,
  publicacao_id: ObjectId,
  criado_em: Date
}
```

Índices:

```javascript
{ usuario_id: 1, publicacao_id: 1 }  // unique
{ usuario_id: 1, criado_em: -1 }
```

O índice único torna o salvamento idempotente. A existência do documento é a fonte de verdade; `publicacoes.contadores.salvamentos` é apenas projeção. Salvar não concede acesso permanente a uma publicação que depois se torne inacessível.

## 9. `seguidores`

```javascript
{
  _id: ObjectId,
  seguidor_id: ObjectId,
  seguido_id: ObjectId,
  status: "pendente" | "aceito",
  solicitado_em: Date,
  aceito_em: Date | null,
  atualizado_em: Date
}
```

Invariantes:

1. `seguidor_id != seguido_id`.
2. O par é único.
3. Perfil público cria vínculo `aceito` com `aceito_em` preenchido.
4. Perfil privado cria vínculo `pendente` com `aceito_em = null`.
5. Aceitação muda o mesmo documento para `aceito`.
6. Recusa ou unfollow remove o documento.
7. Apenas `aceito` incrementa contadores e autoriza conteúdo para seguidores.

Índices:

```javascript
{ seguidor_id: 1, seguido_id: 1 }                  // unique
{ seguido_id: 1, status: 1, solicitado_em: -1 }   // solicitações e seguidores
{ seguidor_id: 1, status: 1, atualizado_em: -1 }  // seguindo
```

## 10. `notificacoes`

```javascript
{
  _id: ObjectId,
  destinatario_id: ObjectId,
  ator_id: ObjectId | null,
  atores_preview_ids: [ObjectId],
  quantidade_atores: Number,
  tipo: NotificationType,
  entidade_tipo: "publicacao" | "comentario" | "usuario",
  entidade_id: ObjectId,
  publicacao_id: ObjectId | null,
  chave_agrupamento: String | null,
  metadados: Object,
  lida_em: Date | null,
  criada_em: Date,
  ultimo_evento_em: Date
}
```

Tipos permitidos:

- `post_commented`;
- `comment_replied`;
- `post_upvoted`;
- `follow_requested`;
- `user_followed`;
- `follow_accepted`;
- `post_trending`.

Regras:

- comentários e respostas geram notificações individuais;
- downvotes não geram notificações;
- upvotes da mesma publicação podem ser agrupados por destinatário e janela de tempo;
- `atores_preview_ids` deve ser pequeno e sem duplicatas;
- `quantidade_atores >= atores_preview_ids.length`;
- `ultimo_evento_em >= criada_em`;
- `metadados` deve ser pequeno, versionável e não conter segredos nem cópias integrais de entidades;
- `entidade_tipo + entidade_id` é referência polimórfica e deve ser validada;
- notificações antigas podem preservar um resumo mínimo quando a entidade original for excluída.

Índices:

```javascript
{ destinatario_id: 1, criada_em: -1 }
{ destinatario_id: 1, lida_em: 1, criada_em: -1 }
{ destinatario_id: 1, chave_agrupamento: 1 } // unique parcial quando a chave existir
```

A chave de agrupamento deve incluir o tipo, a publicação e o intervalo, por exemplo `post_upvoted:{publicacaoId}:2026-11-08T14`.

## 11. `denuncias`

```javascript
{
  _id: ObjectId,
  denunciante_id: ObjectId,
  alvo_tipo: "publicacao" | "comentario" | "usuario",
  alvo_id: ObjectId,
  motivo: "spam" | "assedio" | "inapropriado" | "direitos_autorais" | "outro",
  descricao: String | null,
  status: "aberta" | "em_analise" | "resolvida" | "descartada",
  moderador_id: ObjectId | null,
  nota_resolucao: String | null,
  criada_em: Date,
  resolvida_em: Date | null
}
```

Invariantes:

- `alvo_tipo` determina em qual coleção `alvo_id` deve existir;
- `em_analise` exige `moderador_id`;
- `resolvida` ou `descartada` exige `moderador_id` e `resolvida_em`;
- `aberta` exige `moderador_id = null` e `resolvida_em = null`;
- `motivo = outro` deve exigir descrição;
- a denúncia não deve ser apagada junto com o alvo, pois integra o histórico de moderação.

Índices:

```javascript
{ status: 1, criada_em: 1 }
{ alvo_tipo: 1, alvo_id: 1 }
{ denunciante_id: 1, criada_em: -1 }
```

Prevenção de abuso deve combinar rate limit com detecção de denúncias abertas repetidas para o mesmo denunciante e alvo.

## 12. `eventos_outbox`

```javascript
{
  _id: ObjectId,
  tipo: String,
  agregado_tipo: String,
  agregado_id: ObjectId,
  payload: Object,
  status: "pendente" | "processado" | "falhou",
  tentativas: Number,
  criado_em: Date,
  processado_em: Date | null
}
```

Regras:

- o evento nasce na mesma transação MongoDB da alteração que o originou;
- `tentativas` começa em zero e nunca diminui;
- `pendente` e `falhou` exigem `processado_em = null`;
- `processado` exige `processado_em` preenchido;
- consumidores devem usar `_id` como chave de idempotência;
- `payload` contém apenas os dados necessários ao consumidor e deve ser versionável;
- eventos processados podem receber TTL somente depois do prazo de auditoria definido.

Índices:

```javascript
{ status: 1, criado_em: 1 }
{ agregado_tipo: 1, agregado_id: 1, criado_em: 1 }
{ processado_em: 1 } // TTL opcional e somente para processados
```

## 13. Fontes de verdade e projeções

| Informação | Fonte de verdade | Projeção |
|---|---|---|
| Voto individual | `votos` | — |
| Upvotes/downvotes/score do post | Agregação de `votos` | `publicacoes.contadores` |
| Salvamento individual | `publicacoes_salvas` | — |
| Total de salvamentos | Agregação de `publicacoes_salvas` | `publicacoes.contadores.salvamentos` |
| Comentário existente | `comentarios` | — |
| Total de comentários | Comentários válidos da publicação | `publicacoes.contadores.comentarios` |
| Relação de follow | `seguidores` | — |
| Totais de seguidores/seguindo | Relações `aceito` | `usuarios.contadores` |
| Score do criador | Publicações válidas do usuário | `usuarios.contadores.score` |
| Conteúdo e estado da publicação | `publicacoes` | Cache/feed Redis opcional |
| Notificação durável | `notificacoes` | Total não lido em Redis opcional |

Toda projeção deve poder ser reconstruída sem depender do Redis.

## 14. Operações que exigem consistência conjunta

| Operação | Alterações atômicas recomendadas |
|---|---|
| Votar/trocar/remover voto | `votos` + contadores da publicação + evento outbox |
| Comentar | `comentarios` + contador da publicação + evento outbox |
| Excluir comentário | status do comentário + contador da publicação + evento outbox |
| Salvar/remover salvamento | `publicacoes_salvas` + contador da publicação |
| Aceitar/unfollow | `seguidores` + dois conjuntos de contadores + evento outbox |
| Publicar após upload | status/datas da publicação + contador do autor + evento outbox |
| Moderar conteúdo | denúncia + status do alvo + evento outbox |

Transações MongoDB exigem replica set. Sem transações, as operações precisam ser idempotentes e acompanhadas por reconciliação.

## 15. Exclusão e retenção

| Entidade | Estratégia proposta | Motivo |
|---|---|---|
| Tecnologia usada | Desativação | Preservar referências históricas |
| Publicação | Exclusão lógica | Preservar denúncias e consistência temporária |
| Comentário com respostas | Exclusão lógica | Preservar árvore |
| Comentário sem respostas | Lógica por uniformidade | Auditoria e moderação |
| Voto | Exclusão física | Relação reversível sem conteúdo próprio |
| Salvamento | Exclusão física | Relação reversível |
| Follow recusado/removido | Exclusão física | Estado atual é suficiente no MVP |
| Notificação | Retenção configurável | Histórico do usuário e custo de armazenamento |
| Denúncia | Retenção administrativa | Auditoria |
| Outbox processado | TTL posterior | Limpeza operacional controlada |

Prazos concretos de retenção e anonimização dependem de decisão jurídica e de produto.

## 16. Paginação e consultas

- Feed cronológico: cursor `(publicada_em, _id)`.
- Ranking: cursor `(contadores.score, publicada_em, _id)`.
- Posts do autor: cursor `(publicada_em, _id)` filtrado por `autor_id`.
- Comentários raiz: cursor `(criado_em, _id)` com `comentario_pai_id = null`.
- Respostas: mesma ordenação, filtrada por pai ou raiz.
- Salvos: cursor `(criado_em, _id)` por usuário.
- Seguidores e seguindo: cursor `(atualizado_em, _id)` com `status = aceito`.
- Solicitações: cursor `(solicitado_em, _id)` com `status = pendente`.
- Notificações: cursor `(criada_em, _id)` por destinatário.
- Fila de denúncias: cursor `(criada_em, _id)` por status.

Filtros de privacidade e status precisam ser aplicados antes de retornar os documentos, inclusive em resultados de busca e cache.

## 17. Decisões pendentes

1. Limites mínimo e máximo de `conteudo` em publicações e comentários.
2. Política para edição ou troca de mídias depois da publicação.
3. Se uma publicação arquivada pode voltar a `publicada`.
4. Janela definitiva de agrupamento de upvotes.
5. Marcos de `post_trending` e seu destinatário exato.
6. Retenção de notificações, denúncias, arquivos excluídos e outbox.
7. Estratégia de busca: texto nativo ou Atlas Search.
8. Se unfollow e recusas precisam de histórico de auditoria em fase posterior.
9. Política de visibilidade de conteúdo salvo que se torne privado, oculto ou excluído.
10. Prazo e forma de anonimização de contas e conteúdo excluídos.

## 18. Critérios de aceite da modelagem

- Todas as coleções possuem finalidade, campos, índices e invariantes definidos.
- Subdocumentos e coleções físicas estão diferenciados.
- Relacionamentos ilimitados não foram incorporados a usuários ou publicações.
- Fontes de verdade e contadores derivados estão identificados.
- Privacidade de perfil e anonimato de downvote estão preservados.
- Ciclos de vida de publicação, comentário, follow, denúncia e outbox estão definidos.
- Índices correspondem às consultas principais.
- Exclusão lógica e física têm critérios explícitos.
- Pendências de produto não são apresentadas como requisitos aprovados.


