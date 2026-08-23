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
  API_URL: 'https://script.google.com/macros/s/AKfycby1BaZPqnshc9v5WxV9P5CqTQuAjlO9VmR752l1PMOVsz_qo58WaUKbL1K82IuiBawzFg/exec',

  /* ─────────────────────────────────────────────────────────────────
     3) PRIVACIDADE DA LISTA DE DISCENTES (portal do aluno)
     true  → o portal lista todos os discentes ativos da turma.
     false → o discente precisa digitar ao menos 3 letras do próprio
             nome; o servidor devolve no máximo 10 resultados.
             Recomendado quando o portal fica aberto na internet.
     ───────────────────────────────────────────────────────────────── */
  LISTAR_ALUNOS_PUBLICO: false,

  /* ─────────────────────────────────────────────────────────────────
     4) TEMPO DE SESSÃO NO PAINEL DA SECRETARIA (minutos)
     Após esse tempo sem uso o operador precisa entrar de novo.
     O servidor também valida esse prazo — mudar aqui não burla nada.
     ───────────────────────────────────────────────────────────────── */
  SESSAO_MINUTOS: 60,

  /* ─────────────────────────────────────────────────────────────────
     5) SOMENTE PARA MODO 'demo'
     Precisa ser ligado de propósito. Sem isso o modo demo não roda.
     A senha abaixo é pública por natureza (está no código-fonte):
     serve apenas para treinamento com dados fictícios.
     ───────────────────────────────────────────────────────────────── */
  PERMITIR_DEMO: false,
  SENHA_DEMO: 'treinamento'
};
