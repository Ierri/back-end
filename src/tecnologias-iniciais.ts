// Catálogo sintético e idempotente para desenvolvimento e testes.
// A carga de produção depende de revisão de taxonomia pelo produto.
export const TECNOLOGIAS_INICIAIS = [
  { slug: 'html', nome: 'HTML', categoria: 'Frontend' },
  { slug: 'css', nome: 'CSS', categoria: 'Frontend' },
  { slug: 'javascript', nome: 'JavaScript', categoria: 'Linguagem' },
  { slug: 'typescript', nome: 'TypeScript', categoria: 'Linguagem' },
  { slug: 'react', nome: 'React', categoria: 'Frontend' },
  { slug: 'vue', nome: 'Vue', categoria: 'Frontend' },
  { slug: 'angular', nome: 'Angular', categoria: 'Frontend' },
  { slug: 'node-js', nome: 'Node.js', categoria: 'Backend' },
  { slug: 'nestjs', nome: 'NestJS', categoria: 'Backend' },
  { slug: 'python', nome: 'Python', categoria: 'Linguagem' },
  { slug: 'mongodb', nome: 'MongoDB', categoria: 'Banco de dados' },
  { slug: 'postgresql', nome: 'PostgreSQL', categoria: 'Banco de dados' },
  { slug: 'figma', nome: 'Figma', categoria: 'Design' },
  { slug: 'tailwind-css', nome: 'Tailwind CSS', categoria: 'Frontend' },
] as const;
