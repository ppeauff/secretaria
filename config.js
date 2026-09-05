/* ═══════════════════════════════════════════════════════════════════════
   PPEA · Sistema de Bancas — CONFIGURAÇÃO
   ---------------------------------------------------------------------
   ESTE É O ÚNICO ARQUIVO QUE VOCÊ PRECISA EDITAR PARA INSTALAR O SISTEMA.
   Nenhuma senha é guardada aqui em modo de produção.

   Passo a passo completo: veja "Manual de Instalacao.md".
   ═══════════════════════════════════════════════════════════════════════ */
window.PPEA_CONFIG = {

  /* ─────────────────────────────────────────────────────────────────
     1) MODO DE OPERAÇÃO
     'api'  → produção. Os dados ficam na planilha Google (via Apps Script).
     'demo' → demonstração/treinamento. Dados fictícios, só neste navegador.
              NUNCA use 'demo' com dados reais de discentes.
     ───────────────────────────────────────────────────────────────── */
  MODO: 'api',

  /* ─────────────────────────────────────────────────────────────────
     2) ENDEREÇO DO BACKEND (obrigatório quando MODO = 'api')
     Cole aqui a URL que o Google Apps Script mostra ao publicar o
     Web App. Ela termina em /exec — nunca em /dev.
     Ex.: 'https://script.google.com/macros/s/AKfycb.../exec'
     ───────────────────────────────────────────────────────────────── */
  API_URL: 'https://script.google.com/macros/s/AKfycbzYbNJ76xybQ4nw-evv-DC4A6ZP4nUFXOk0_OA8Jm5c9Aop_c-X6LAaUfCB4tObU3TbjA/exec',

  /* ─────────────────────────────────────────────────────────────────
     3) PRIVACIDADE DA LISTA DE DISCENTES (portal do aluno)
     true  → o portal já lista todos os discentes ativos da turma ao
             entrar na tela "Selecione seu nome" (sem precisar buscar).
     false → o discente precisa digitar ao menos 3 letras do próprio
             nome; o servidor devolve no máximo 10 resultados.

     ATENÇÃO: mudar aqui NÃO basta. O servidor guarda sua própria cópia
     desta opção na planilha (aba "config"). Depois de mudar este valor,
     rode também no editor do Apps Script:
       ligarListaPublicaDeAlunos()   — para true
       desligarListaPublicaDeAlunos() — para false
     Com true, qualquer visitante do site (sem login) vê nome, matrícula
     e orientador de todos os discentes ativos da turma escolhida — a
     lista deixa de exigir busca. Avalie esse ponto antes de ativar.
     ───────────────────────────────────────────────────────────────── */
  LISTAR_ALUNOS_PUBLICO: true,

  /* ─────────────────────────────────────────────────────────────────
     4) TEMPO DE SESSÃO NO PAINEL DA SECRETARIA (minutos)
     Após esse tempo sem uso o operador precisa entrar de novo.
     O servidor também valida esse prazo — mudar aqui não burla nada.
     ───────────────────────────────────────────────────────────────── */
  SESSAO_MINUTOS: 60,

  /* ─────────────────────────────────────────────────────────────────
     4B) PRAZOS REGIMENTAIS POR FASE (em MESES, contados da data de
     matrícula do discente) — usados no relatório de "Alunos sem banca"
     para avisar quem está perto do prazo ou já atrasado.

     ⚠️ OS VALORES ABAIXO SÃO EXEMPLOS/PLACEHOLDER, NÃO SÃO OFICIAIS.
     Ajuste cada número conforme o regimento real do PPEA antes de usar
     os alertas de atraso para qualquer decisão. Até lá, os alertas
     servem só de indicativo interno de acompanhamento.
     ───────────────────────────────────────────────────────────────── */
  PRAZOS_MESES: {
    mestrado:  { 'defesa-projeto': 6,  'qualificacao': 18, 'defesa-final': 24 },
    doutorado: { 'defesa-projeto': 6,  'qualificacao': 24, 'defesa-final': 48 }
  },

  /* ─────────────────────────────────────────────────────────────────
     5) SOMENTE PARA MODO 'demo'
     Precisa ser ligado de propósito. Sem isso o modo demo não roda.
     A senha abaixo é pública por natureza (está no código-fonte):
     serve apenas para treinamento com dados fictícios.
     ───────────────────────────────────────────────────────────────── */
  PERMITIR_DEMO: false,
  SENHA_DEMO: 'treinamento'
};
