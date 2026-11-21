# Contrato de persistência MongoDB — Ierri

Revisado em 21/11/2026 contra `Ierri/back-end`, branch `staging`, commit `d3fc3cce0462585f0b2023fee53484c82990c5a5`. Os schemas acrescentados nesta revisão estão na cópia de trabalho e ainda não representam endpoints implementados.

## Estado verificado

| Coleção | Estado do código | Fonte de verdade / observação |
|---|---|---|
| `usuarios` | Cadastro e autenticação existentes; schema social ampliado nesta revisão | Usuário identificado por `_id`; `email` e `username` normalizados e únicos |
| `tecnologias` | Schema e índices nesta revisão; sem API | Catálogo controlado, itens inativos preservados |
| `publicacoes` | Schema, serviço e API existentes | Mídias incorporadas, 1 a 10; contadores são projeções |
| `uploads_midias` | Schema e fluxo de upload existentes | Estado temporário e vínculo ao post; arquivo no Object Storage |
| `comentarios` | Schema e índices adicionados nesta revisão; sem API na `staging` examinada | Confirmar/mesclar a implementação citada pela equipe antes da entrega da API |
| `votos`, `publicacoes_salvas`, `seguidores` | Schemas e índices nesta revisão; sem fluxos de escrita | Documentos de relação são a fonte de verdade |
| `notificacoes`, `denuncias`, `eventos_outbox` | Apenas especificação | Não declarar em produção antes da implementação |

Redis contém sessões e cache reconstruível. Object Storage contém bytes de mídia. Não há chave estrangeira automática entre documentos MongoDB.

## Contrato dos schemas acrescentados

`usuarios`: preserva `nome`, `email`, `username`, `senha_hash`, `biografia`, `avatar_url`, `criado_em`. Acrescenta `atualizado_em`; `stack_ids` (máximo 20 IDs distintos); `visibilidade_perfil` (`publico`, `privado`); `papeis` (array distinto de `usuario`, `moderador`, `administrador`); `status` (`ativo`, `bloqueado`, `excluido`); `contadores` (`publicacoes`, `seguidores`, `seguindo`, `score`); datas de verificação, aceite e exclusão. Os defaults sociais permitem hidratar documentos antigos, mas `atualizado_em` só passa a existir fisicamente após escrita ou migração. Alteração de `status` exige tratamento de sessões em Redis e verificação no login/guard, ainda não implementados.

`tecnologias`: `nome`, `slug` normalizado, `categoria`, `icone_url`, `ativo`, `criado_em`, `atualizado_em`. O slug é estável e único. Desativar em vez de excluir IDs referenciados por usuários. O fluxo de edição de `stack_ids` deve consultar tecnologias ativas e gravar o array inteiro com validação; o schema sozinho não garante existência da referência.

`votos`: `(publicacao_id, usuario_id)` único; `valor ∈ {1,-1}`; datas de criação e atualização. A troca altera o mesmo documento. `publicacoes_salvas`: `(usuario_id, publicacao_id)` único e `criado_em`. `seguidores`: `(seguidor_id, seguido_id)` único, `status ∈ {pendente,aceito}`, `solicitado_em`, `aceito_em`, `atualizado_em`. Auto-follow é inválido; só `aceito` concede acesso e entra nos contadores.

`comentarios`: publicação e autor por referência; pai e raiz opcionais; profundidade 0, 1 ou 2; texto de 1 a 5000 caracteres; estado `publicado`, `excluido` ou `oculto`; datas de edição e auditoria. O schema valida a forma local da árvore. O serviço deve ler o pai na mesma transação, garantir que pertença à mesma publicação, calcular a raiz e impedir resposta a profundidade 2. Exclusão lógica preserva respostas; a política de contagem deve ser aplicada de modo consistente.

O código de mídia atualmente aceita JPEG, PNG, WebP, MP4 e WebM, com limite de **25 MB por arquivo**, até 10 arquivos, máximo agregado de 200 MB no schema da publicação e vídeo de até 120 segundos. A especificação histórica de 10 MB por imagem e 100 MB por vídeo não corresponde ao upload atual; usar os limites do código até que produto e back-end decidam uma mudança conjunta.

Os validadores Mongoose de documento cobrem criação e `save()`. `updateOne`, operadores de array e atualizações em lote podem não executar validação completa dos invariantes cruzados, mesmo com `runValidators`; em particular, `$inc` ignora os validadores e `$push` não valida o limite do array. Os serviços devem usar transições controladas, filtros de estado e testes de integração. Índices únicos só garantem unicidade depois de criados no banco. [Validação no Mongoose](https://mongoosejs.com/docs/validation.html); [índices únicos no MongoDB](https://www.mongodb.com/docs/manual/core/index-unique/).

## Inventário de índices

| Coleção | Chave | Propósito |
|---|---|---|
| `usuarios` | `{email:1}` único; `{username:1}` único | Login e perfil |
| `usuarios` | `{status:1,criado_em:-1,_id:-1}`; `{papeis:1,status:1}` | Administração |
| `tecnologias` | `{slug:1}` único; `{ativo:1,nome:1,_id:1}` | Catálogo |
| `publicacoes` | `{slug:1}` único; `{status:1,visibilidade:1,publicada_em:-1,_id:-1}`; `{autor_id:1,status:1,publicada_em:-1,_id:-1}`; `{autor_id:1,status:1,visibilidade:1,publicada_em:-1,_id:-1}`; `{status:1,visibilidade:1,"contadores.score":-1,publicada_em:-1}` | Código existente; feed, perfil e ranking |
| `uploads_midias` | `{referencia:1}` único; `{chave_storage:1}` único; `{estado:1,expira_em:1}`; `{expira_em:1,_id:1}`; `{publicacao_id:1,estado:1}` | Código existente; reserva e limpeza |
| `votos` | `{publicacao_id:1,usuario_id:1}` único; `{usuario_id:1,atualizado_em:-1,_id:-1}` | Unicidade e histórico do usuário |
| `publicacoes_salvas` | `{usuario_id:1,publicacao_id:1}` único; `{usuario_id:1,criado_em:-1,_id:-1}` | Estado e lista paginada |
| `seguidores` | `{seguidor_id:1,seguido_id:1}` único; `{seguido_id:1,status:1,solicitado_em:-1,_id:-1}`; `{seguidor_id:1,status:1,atualizado_em:-1,_id:-1}` | Autorização e listas |
| `comentarios` | `{publicacao_id:1,comentario_pai_id:1,criado_em:1,_id:1}`; `{comentario_raiz_id:1,criado_em:1,_id:1}`; `{autor_id:1,criado_em:-1,_id:-1}` | Árvore e histórico |

Não indexar `usuarios.stack_ids` até haver consulta por tecnologia. Antes de implantar, conferir duplicatas/valores incompatíveis em dados existentes, criar índices de modo controlado e comparar `listIndexes` com este inventário. `autoIndex` não substitui migração de índices em produção. Medir `explain` das consultas reais antes de acrescentar índices. Paginação usa `_id` como desempate quando a ordenação inclui data; o índice de ranking atual não tem esse desempate e deve ser revisto quando o ranking for implementado.

Se houver sharding no futuro, escolher a chave de shard antes de aplicar estes índices únicos: a unicidade global em coleções sharded depende de a chave de shard ser prefixo do índice único. O replica set único usado na validação não testa esse cenário. [Restrições de índices únicos](https://www.mongodb.com/docs/manual/core/index-unique/).

## Transações e contadores

**Pré-requisito:** MongoDB em replica set (ou cluster sharded), mesmo em desenvolvimento. Exigir transações; não degradar silenciosamente para duas escritas sem atomicidade. Usar sessão Mongoose com `withTransaction`, `readConcern: snapshot` e `writeConcern: majority` no nível da transação. `withTransaction` já trata os rótulos `TransientTransactionError` e `UnknownTransactionCommitResult`; não acrescentar uma segunda rotina de retry que possa repetir um comando após commit incerto. Definir timeout operacional, chave de idempotência para comandos que precisem de retry externo e releitura do estado após resultado ambíguo. Passar a mesma sessão a toda operação e executá-las em sequência, sem `Promise.all`. Nunca executar upload, Redis, HTTP ou notificação dentro do callback, pois ele pode repetir. [Driver MongoDB](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/); [transações Mongoose](https://mongoosejs.com/docs/transactions.html).

Para cada comando, validar usuário/visibilidade e publicação `status=publicada` **dentro** da transação. A mudança do documento fonte e o `$inc` da projeção entram na mesma sessão. Verificar `matchedCount=1`; caso contrário, abortar. O índice único arbitra corridas. `E11000` ou conflito de escrita exige nova leitura em nova transação; não aplicar `$inc` novamente sem transição comprovada. Repetição do mesmo estado é no-op.

| Transição | Delta no post | Delta no usuário |
|---|---|---|
| voto ausente → `+1` / `-1` | upvotes +1 / downvotes +1; score +1 / -1 | score do autor +1 / -1, se mantido |
| voto `+1` → `-1` | upvotes -1, downvotes +1, score -2 | score do autor -2 |
| voto `-1` → `+1` | downvotes -1, upvotes +1, score +2 | score do autor +2 |
| remover voto | reverter o voto encontrado | reverter o score do autor |
| salvar / remover salvo | salvamentos +1 / -1 somente se inseriu / removeu | — |
| follow pendente → aceito | — | seguidores do destino +1; seguindo da origem +1 |
| criar follow aceito / remover follow aceito | — | +1 / -1 nos dois usuários |
| criar/remover follow pendente | — | nenhum |
| publicar / excluir ou ocultar publicação publicada | — | publicacoes do autor +1 / -1; score do autor +score / -score do post |
| criar comentário publicado / excluir ou ocultar comentário publicado | comentarios +1 / -1 | — |

O `score` do post deve satisfazer `upvotes - downvotes`. O `score` do autor representa a soma dos scores das publicações em estado `publicada`; votos antigos continuam como fonte de verdade se um post sair do estado publicado. Para contadores não negativos, filtrar decrementos com valor atual `>=1`; falha indica divergência e deve abortar e gerar reconciliação. Atualizações concorrentes do mesmo post podem gerar conflitos; tratar com retry controlado no comando externo após verificar o estado. No unfollow, excluir a relação dentro da transação e aplicar delta apenas se o documento excluído era `aceito`. Em conteúdo excluído, impedir novas interações e definir limpeza de relações em tarefa separada; se a política apagar votos/salvos, reconstruir contadores a partir das fontes de verdade. `contadores.comentarios` conta apenas comentários `publicado`; ocultação, exclusão e restauração aplicam delta de acordo com a transição efetiva.

Notificações e cache são efeitos posteriores ao commit. Quando `eventos_outbox` existir, gravar evento na mesma transação e consumir de forma idempotente. Até lá, falha de invalidação Redis não pode alterar o commit MongoDB; o cache de listagem pode ficar incompleto até expirar mesmo quando os itens existentes são revalidados, portanto a invalidação deve ter retry/observabilidade antes de garantir leitura imediatamente atualizada. A criação atual de publicação usa reserva de mídia e compensação, porque Object Storage não participa da transação MongoDB; não se deve chamar esse fluxo de transação atômica. Há estados `processando`/`reservada` que exigem limpeza e reconciliação.

**Reconciliação:** rotina administrativa idempotente agrega votos por publicação, salvos por publicação, follows aceitos por usuário, posts publicados por autor e comentários elegíveis por post. Compara e corrige projeções em lotes pequenos; registra divergências. Executar após migração e periodicamente. A rotina não deve apagar fontes de verdade. Sem implementação dessa rotina e dos serviços transacionais, a consistência dos contadores ainda não está garantida em produção.

## Dados iniciais e migração

O `seed` cria um usuário fictício e agora carrega 14 tecnologias sintéticas de [`src/tecnologias-iniciais.ts`](../../src/tecnologias-iniciais.ts). Continua restrito a MongoDB local com `NODE_ENV=development|test`. A importação usa `slug` e `$setOnInsert`, portanto é repetível e não reativa tecnologias desativadas. Não usar dados pessoais reais nem cópia de produção como fixture. Para testes, gerar IDs e e-mails sintéticos; mídias devem apontar a objetos de teste com limpeza explícita. O conjunto inicial e a taxonomia precisam de revisão do produto antes da carga em produção.

Ordem de implantação: 1) auditar e corrigir dados legados; 2) criar índices únicos e depois secundários; 3) subir replica set e validar transações; 4) implantar serviços transacionais e autorização de status/perfil; 5) habilitar fluxos sociais; 6) executar reconciliação e medir consultas. A ampliação do schema de usuário usa defaults para leitura, mas documentos antigos não ganham campos fisicamente até atualização ou migração.

## Verificação executada

Em 21/11/2026, um replica set MongoDB temporário foi iniciado apenas para a revisão. As seis coleções com schemas novos ou ampliados criaram seus índices; os índices únicos rejeitaram duplicatas de `tecnologias.slug`, do par de seguidores, do par de salvos e do par de votos (`E11000`). Uma transação que inseriu um voto e incrementou o score do autor foi abortada e ambas as escritas foram revertidas; a transação seguinte confirmou ambas. O teste temporário não foi mantido no repositório. Os testes de schema permanentes cobrem validação de documentos e declaração dos índices. Esta verificação não comprova o estado, a carga ou os índices de um banco de produção.

## Pendências observadas na revisão integral

1. A implementação de comentários mencionada no feedback não consta na `staging` lida; o schema desta revisão não substitui o serviço/API da equipe. Confirmar branch/PR e confrontar os contratos antes de mesclar.
2. `loadById` e listagem de publicações hoje só liberam `visibilidade=seguidores` ao autor; a regra de seguidores aceitos ainda precisa entrar no serviço e na política de cache.
3. `status=bloqueado|excluido` do usuário foi modelado, mas autenticação e guard ainda não o verificam. Não usar o campo como controle de acesso até essa mudança.
4. `visibilidade_perfil=privado` não força `publicacoes.visibilidade=seguidores` no serviço atual.
5. Criar ou remover publicação não atualiza `usuarios.contadores.publicacoes`; votos, salvos e follows ainda não têm serviços transacionais.
6. O schema de publicação valida `publicada_em` no `validate` de documento; a transição atual usa `findOneAndUpdate` e, portanto, a regra de estado precisa de verificação no serviço ou validação de atualização específica.
7. `upload` e limpeza dependem de coordenação com Object Storage; observar estados órfãos e objetos sem documento.
8. A invalidação do cache de páginas pode falhar após commit; a revalidação dos itens já em cache não detecta um novo post que ficou fora da página. Definir TTL, retry e métrica de atraso para essa projeção.

Estas pendências são limites de implementação, não validações já concluídas.
