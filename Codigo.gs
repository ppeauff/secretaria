// ═══════════════════════════════════════════════════════════════════════
// PPEA · Sistema de Bancas — BACKEND (Google Apps Script)
// Escola de Enfermagem Aurora de Afonso Costa · UFF
// ---------------------------------------------------------------------
// Este arquivo é o servidor do sistema. Ele fica preso a uma planilha
// Google (o "banco de dados") no Drive da secretaria do PPEA.
//
// NADA aqui é visível para quem abre o site: o navegador só recebe as
// respostas, nunca o código. Por isso senhas, regras de acesso e
// validações definitivas moram AQUI, e não no db.js.
//
// INSTALAÇÃO: rode a função  instalar()  uma única vez.
// Passo a passo completo em "Manual de Instalacao.md".
// ═══════════════════════════════════════════════════════════════════════

var VERSAO = '1.0.0';

/* Parâmetros de negócio (espelham o db.js) */
var PRAZO_DIAS = 15;
var PRAZO_DOCS_DIAS = 2;

/* Parâmetros de segurança */
var ITERACOES_HASH        = 5000;   // repetições do SHA-256 na senha
var SESSAO_MINUTOS        = 60;     // validade da sessão, renovada a cada uso
var MAX_TENTATIVAS        = 5;      // erros de senha antes do bloqueio
var BLOQUEIO_MINUTOS      = 15;     // duração do bloqueio
var TAMANHO_MINIMO_SENHA  = 10;
var MAX_UPLOAD_BYTES      = 8 * 1024 * 1024;
var LIMITE_CONSULTAS_MIN  = 40;     // consultas públicas por minuto (global)

var ABAS = {
  turmas:    ['id','nome','modalidade','ativa','criadoEm'],
  alunos:    ['id','nome','matricula','turmaId','orientador','coorientador','email','ativo','criadoEm'],
  bancas:    ['id','protocolo','alunoId','turmaId','modalidade','tipoBanca','nome','matricula','orientador',
              'coorientador','orientadorEmail','titulo','email','data','hora','local','apresentacao','artigos',
              'status','foraDoPrazo','observacao','submetidaEm','aprovadaEm','avaliador','documentosEmitidos',
              'documentosEmitidosEm','comissao_json','checklist_json','historico_json'],
  externos:  ['id','protocolo','nome','cpf','email','instituicao','programa','cargo','lattes',
              'titulacao_json','diplomaId','diplomaNome','criadoEm','atualizadoEm'],
  usuarios:  ['id','nome','login','papel','salt','hash','iteracoes','ativo','criadoEm','senhaAlteradaEm',
              'tentativas','bloqueadoAte','ultimoAcesso'],
  sessoes:   ['tokenHash','usuarioId','nome','papel','criadoEm','expiraEm','ultimoUso'],
  auditoria: ['quando','quem','acao','alvo','detalhe'],
  lixeira:   ['tipo','id','excluidoEm','excluidoPor','dados_json'],
  config:    ['chave','valor']
};

/* ═══════════════════════════════════════════════════════════════════════
   PONTOS DE ENTRADA HTTP
   ═══════════════════════════════════════════════════════════════════════ */

function doGet() {
  return json({ ok: true, servico: 'PPEA · Sistema de Bancas', versao: VERSAO });
}

function doPost(e) {
  var req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ ok: false, erro: 'Requisição inválida.' });
  }

  var acao  = String(req.acao || '');
  var dados = req.dados || {};
  var token = String(req.token || '');

  try {
    if (ACOES_PUBLICAS[acao]) {
      if (!liberaConsultaPublica(acao)) {
        return json({ ok: false, erro: 'Muitas consultas em pouco tempo. Aguarde um minuto e tente de novo.' });
      }
      return json(ACOES_PUBLICAS[acao](dados));
    }
    if (ACOES_AUTENTICADAS[acao]) {
      var sessao = validarSessao(token);
      if (!sessao) return json({ ok: false, erro: 'SESSAO_EXPIRADA' });
      return json(ACOES_AUTENTICADAS[acao](dados, sessao));
    }
    return json({ ok: false, erro: 'Ação desconhecida.' });
  } catch (err) {
    registrarAuditoria('sistema', 'erro', acao, String(err && err.message || err));
    return json({ ok: false, erro: 'Erro interno no servidor. A secretaria foi notificada no registro de auditoria.' });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ═══════════════════════════════════════════════════════════════════════
   ACESSO À PLANILHA
   ═══════════════════════════════════════════════════════════════════════ */

function planilha() {
  return SpreadsheetApp.getActiveSpreadsheet();
}
function aba(nome) {
  var sh = planilha().getSheetByName(nome);
  if (!sh) throw new Error('Aba "' + nome + '" não encontrada. Rode a função instalar().');
  return sh;
}
function lerTabela(nome) {
  var sh = aba(nome);
  var valores = sh.getDataRange().getValues();
  if (valores.length < 2) return [];
  var cab = valores[0];
  var saida = [];
  for (var i = 1; i < valores.length; i++) {
    var obj = { _linha: i + 1 };
    for (var c = 0; c < cab.length; c++) obj[cab[c]] = valores[i][c];
    saida.push(obj);
  }
  return saida;
}
function inserirLinha(nome, obj) {
  var sh = aba(nome);
  var cab = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var linha = cab.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  sh.appendRow(linha);
}
function atualizarLinha(nome, numeroLinha, obj) {
  var sh = aba(nome);
  var cab = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var linha = cab.map(function (c) { return obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  sh.getRange(numeroLinha, 1, 1, cab.length).setValues([linha]);
}
function apagarLinha(nome, numeroLinha) {
  aba(nome).deleteRow(numeroLinha);
}

/* Executa uma escrita com trava, para dois operadores não se atropelarem */
function comTrava(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, erro: 'O sistema está ocupado. Tente de novo em alguns segundos.' };
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ═══════════════════════════════════════════════════════════════════════
   UTILITÁRIOS
   ═══════════════════════════════════════════════════════════════════════ */

function agora()      { return new Date().toISOString(); }
function uid(p)       { return (p || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function soDigitos(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }
function texto(s)     { return String(s == null ? '' : s).trim(); }
function verdade(v)   { return v === true || v === 'true' || v === 'TRUE' || v === 1; }
function jsonSeguro(s, padrao) {
  if (s === '' || s === null || s === undefined) return padrao;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch (e) { return padrao; }
}
function normalizar(s) {
  return texto(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}
function diasAte(dataStr) {
  if (!dataStr) return null;
  var hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  var alvo = new Date(String(dataStr) + 'T00:00:00');
  return Math.round((alvo - hoje) / 86400000);
}
/**
 * Corta textos longos antes de gravar. Protege a planilha contra campos
 * gigantes enviados de propósito para travar o sistema.
 */
function limitar(s, max) {
  var t = texto(s);
  return t.length > max ? t.slice(0, max) : t;
}

function registrarAuditoria(quem, acao, alvo, detalhe) {
  try {
    inserirLinha('auditoria', {
      quando: agora(), quem: texto(quem), acao: texto(acao),
      alvo: texto(alvo), detalhe: limitar(detalhe, 500)
    });
  } catch (e) { /* auditoria nunca derruba a operação principal */ }
}

/* Freio simples contra varredura automatizada das consultas públicas. */
function liberaConsultaPublica(acao) {
  var cache = CacheService.getScriptCache();
  var chave = 'rate_' + acao + '_' + Math.floor(Date.now() / 60000);
  var atual = parseInt(cache.get(chave) || '0', 10);
  if (atual >= LIMITE_CONSULTAS_MIN) return false;
  cache.put(chave, String(atual + 1), 120);
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   SENHAS E SESSÕES
   ---------------------------------------------------------------------
   A senha nunca é gravada. Guardamos só o resultado de:
     hash = SHA256 repetido N vezes sobre (salt + senha + pepper)
   O "salt" é único por usuário e fica na planilha.
   O "pepper" é uma chave secreta que fica nas Propriedades do Script —
   fora da planilha. Assim, mesmo que alguém copie a planilha, não
   consegue testar senhas sem também ter acesso ao projeto do script.
   ═══════════════════════════════════════════════════════════════════════ */

function pepper() {
  var props = PropertiesService.getScriptProperties();
  var p = props.getProperty('PEPPER');
  if (!p) { p = bytesAleatorios(32); props.setProperty('PEPPER', p); }
  return p;
}
function bytesAleatorios(n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
  return s;
}
function sha256(txt) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, txt, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += ('0' + b.toString(16)).slice(-2);
  }
  return hex;
}
function calcularHash(senha, salt, iteracoes) {
  var h = salt + senha + pepper();
  for (var i = 0; i < iteracoes; i++) h = sha256(h);
  return h;
}
/** Comparação de tempo constante, para não vazar informação pelo tempo de resposta. */
function iguaisSeguro(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var dif = 0;
  for (var i = 0; i < a.length; i++) dif |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return dif === 0;
}
function senhaAceitavel(senha) {
  senha = String(senha || '');
  if (senha.length < TAMANHO_MINIMO_SENHA) return 'A senha precisa ter ao menos ' + TAMANHO_MINIMO_SENHA + ' caracteres.';
  if (!/[A-Za-zÀ-ÿ]/.test(senha) || !/[0-9]/.test(senha)) return 'A senha precisa misturar letras e números.';
  var fracas = ['12345678910','senha123456','ppea20262026','abcdefghij'];
  if (fracas.indexOf(senha.toLowerCase()) >= 0) return 'Escolha uma senha menos previsível.';
  return null;
}

function validarSessao(token) {
  if (!token) return null;
  var th = sha256(token);
  var sessoes = lerTabela('sessoes');
  for (var i = 0; i < sessoes.length; i++) {
    if (iguaisSeguro(sessoes[i].tokenHash, th)) {
      if (new Date(sessoes[i].expiraEm) < new Date()) { apagarLinha('sessoes', sessoes[i]._linha); return null; }
      // renova a validade a cada uso (sessão deslizante)
      var s = sessoes[i];
      s.ultimoUso = agora();
      s.expiraEm = new Date(Date.now() + SESSAO_MINUTOS * 60000).toISOString();
      atualizarLinha('sessoes', s._linha, s);
      return { usuarioId: s.usuarioId, nome: s.nome, papel: s.papel };
    }
  }
  return null;
}

function limparSessoesExpiradas() {
  var sessoes = lerTabela('sessoes');
  var agoraD = new Date();
  for (var i = sessoes.length - 1; i >= 0; i--) {
    if (new Date(sessoes[i].expiraEm) < agoraD) apagarLinha('sessoes', sessoes[i]._linha);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   VALIDAÇÃO DE BANCA (a validação que vale — a do db.js é só conforto)
   ═══════════════════════════════════════════════════════════════════════ */

function validarBanca(r) {
  var erros = [];
  if (!texto(r.nome))       erros.push('Informe o nome do discente.');
  if (!texto(r.matricula))  erros.push('Informe a matrícula.');
  if (!texto(r.orientador)) erros.push('Informe o orientador.');
  if (!texto(r.titulo))     erros.push('Informe o título do trabalho.');
  if (!texto(r.email))      erros.push('Informe o e-mail institucional do discente.');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto(r.email))) erros.push('E-mail do discente em formato inválido.');
  if (texto(r.orientadorEmail) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto(r.orientadorEmail)))
    erros.push('E-mail do orientador em formato inválido.');
  if (!texto(r.data)) erros.push('Informe a data agendada.');
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(texto(r.data))) erros.push('Data em formato inválido.');
  if (!texto(r.hora)) erros.push('Informe a hora.');
  if (['online','presencial','misto'].indexOf(texto(r.apresentacao)) < 0) erros.push('Selecione a modalidade de apresentação.');
  if (['mestrado','doutorado'].indexOf(texto(r.modalidade)) < 0) erros.push('Modalidade inválida.');
  if (['defesa-projeto','qualificacao','defesa-final'].indexOf(texto(r.tipoBanca)) < 0) erros.push('Tipo de banca inválido.');

  var min = texto(r.modalidade) === 'doutorado' ? 7 : 5;
  var comissao = r.comissao || [];
  var preenchidos = 0;
  for (var i = 0; i < comissao.length; i++) if (texto(comissao[i].nome)) preenchidos++;
  if (preenchidos < min) erros.push('A comissão exige ' + min + ' membros preenchidos (foram enviados ' + preenchidos + ').');
  return erros;
}

/** Monta o registro de banca já limpo, ignorando qualquer campo extra enviado pelo navegador. */
function sanearBanca(r) {
  var comissao = (r.comissao || []).slice(0, 10).map(function (m) {
    return { papel: limitar(m.papel, 60), nome: limitar(m.nome, 120), ppg: limitar(m.ppg, 80),
             instituicao: limitar(m.instituicao, 120), email: limitar(m.email, 120) };
  });
  return {
    modalidade: texto(r.modalidade), tipoBanca: texto(r.tipoBanca),
    alunoId: limitar(r.alunoId, 40), turmaId: limitar(r.turmaId, 40),
    nome: limitar(r.nome, 120), matricula: limitar(r.matricula, 30),
    orientador: limitar(r.orientador, 120), coorientador: limitar(r.coorientador, 120),
    orientadorEmail: limitar(r.orientadorEmail, 120), titulo: limitar(r.titulo, 400),
    email: limitar(r.email, 120), data: texto(r.data), hora: limitar(r.hora, 10),
    local: limitar(r.local, 200), apresentacao: texto(r.apresentacao), artigos: limitar(r.artigos, 1000),
    comissao: comissao
  };
}

function proximoProtocolo(prefixo) {
  var props = PropertiesService.getScriptProperties();
  var seq = parseInt(props.getProperty('SEQ') || '0', 10) + 1;
  props.setProperty('SEQ', String(seq));
  return (prefixo || ('PPEA-' + new Date().getFullYear() + '-')) + ('0000' + seq).slice(-4);
}

function bancaParaObjeto(linha) {
  return {
    id: linha.id, protocolo: linha.protocolo, alunoId: linha.alunoId, turmaId: linha.turmaId,
    modalidade: linha.modalidade, tipoBanca: linha.tipoBanca, nome: linha.nome, matricula: String(linha.matricula),
    orientador: linha.orientador, coorientador: linha.coorientador, orientadorEmail: linha.orientadorEmail,
    titulo: linha.titulo, email: linha.email, data: linha.data, hora: linha.hora, local: linha.local,
    apresentacao: linha.apresentacao, artigos: linha.artigos, status: linha.status,
    foraDoPrazo: verdade(linha.foraDoPrazo), observacao: linha.observacao,
    submetidaEm: linha.submetidaEm, aprovadaEm: linha.aprovadaEm || null, avaliador: linha.avaliador,
    documentosEmitidos: verdade(linha.documentosEmitidos), documentosEmitidosEm: linha.documentosEmitidosEm || null,
    comissao: jsonSeguro(linha.comissao_json, []),
    checklist: jsonSeguro(linha.checklist_json, { convites: false, ata: false, declaracoes: false, sala: false }),
    historico: jsonSeguro(linha.historico_json, [])
  };
}
function objetoParaBanca(b) {
  var l = {};
  for (var k in b) if (['comissao','checklist','historico'].indexOf(k) < 0) l[k] = b[k];
  l.comissao_json  = JSON.stringify(b.comissao || []);
  l.checklist_json = JSON.stringify(b.checklist || {});
  l.historico_json = JSON.stringify(b.historico || []);
  return l;
}
function acharBanca(bancas, protocolo, matricula) {
  for (var i = 0; i < bancas.length; i++) {
    if (texto(bancas[i].protocolo).toLowerCase() === texto(protocolo).toLowerCase() &&
        soDigitos(bancas[i].matricula) === soDigitos(matricula)) return bancas[i];
  }
  return null;
}
function mascararNome(nome) {
  return texto(nome).split(/\s+/).map(function (p, i) {
    return i === 0 ? p : (p.length > 2 ? p.charAt(0) + '.' : p);
  }).join(' ');
}
function mascararCPF(cpf) {
  var d = soDigitos(cpf);
  if (d.length !== 11) return '';
  return '***.' + d.slice(3, 6) + '.' + d.slice(6, 9) + '-**';
}

/* ═══════════════════════════════════════════════════════════════════════
   AÇÕES PÚBLICAS (portal do discente — sem login)
   ═══════════════════════════════════════════════════════════════════════ */

var ACOES_PUBLICAS = {

  turmasPublicas: function (d) {
    var mod = texto(d.modalidade);
    var saida = lerTabela('turmas')
      .filter(function (t) { return verdade(t.ativa) && (!mod || t.modalidade === mod); })
      .map(function (t) { return { id: t.id, nome: t.nome, modalidade: t.modalidade }; });
    return { ok: true, turmas: saida };
  },

  /**
   * Lista os discentes de uma turma. Nunca devolve e-mail: o discente
   * digita o próprio no formulário. Se a lista pública estiver desligada
   * (recomendado), exige busca por nome e devolve no máximo 10 resultados.
   */
  alunosPublicos: function (d) {
    var listaAberta = lerConfig('LISTAR_ALUNOS_PUBLICO', 'false') === 'true';
    var arr = lerTabela('alunos').filter(function (a) {
      return verdade(a.ativo) && a.turmaId === texto(d.turmaId);
    });
    if (!listaAberta) {
      var q = normalizar(d.q);
      if (q.length < 3) return { ok: true, alunos: [], exigeBusca: true };
      arr = arr.filter(function (a) { return normalizar(a.nome).indexOf(q) >= 0; }).slice(0, 10);
    }
    return { ok: true, alunos: arr.map(function (a) {
      return { id: a.id, nome: a.nome, matricula: String(a.matricula),
               orientador: a.orientador, coorientador: a.coorientador || '' };
    }) };
  },

  bancaCriar: function (d) {
    return comTrava(function () {
      var r = sanearBanca(d.registro || {});
      var erros = validarBanca(r);
      if (erros.length) return { ok: false, erros: erros };

      // O discente precisa existir na turma informada — impede cadastro fantasma.
      var alunos = lerTabela('alunos');
      var confere = null;
      for (var i = 0; i < alunos.length; i++) {
        if (verdade(alunos[i].ativo) && soDigitos(alunos[i].matricula) === soDigitos(r.matricula)) { confere = alunos[i]; break; }
      }
      if (!confere) return { ok: false, erro: 'Matrícula não localizada entre os discentes ativos. Procure a secretaria.' };

      var dias = diasAte(r.data);
      var foraDoPrazo = dias !== null && dias < PRAZO_DIAS;
      var status = r.orientadorEmail ? 'aguardando-orientador' : 'pendente';

      var banca = r;
      banca.id = uid('b');
      banca.protocolo = proximoProtocolo();
      banca.alunoId = confere.id;
      banca.turmaId = confere.turmaId;
      banca.status = status;
      banca.foraDoPrazo = foraDoPrazo;
      banca.observacao = '';
      banca.submetidaEm = agora();
      banca.aprovadaEm = '';
      banca.avaliador = '';
      banca.documentosEmitidos = false;
      banca.documentosEmitidosEm = '';
      banca.checklist = { convites: false, ata: false, declaracoes: false, sala: false };
      banca.historico = [{ em: agora(), status: status, por: banca.nome + ' (discente)' }];

      inserirLinha('bancas', objetoParaBanca(banca));
      registrarAuditoria(banca.nome + ' (discente)', 'banca-criada', banca.protocolo,
        banca.tipoBanca + ' · ' + banca.data + (foraDoPrazo ? ' · FORA DO PRAZO' : ''));
      return { ok: true, banca: banca, foraDoPrazo: foraDoPrazo, status: status };
    });
  },

  bancaBuscarParaCorrecao: function (d) {
    var b = acharBanca(lerTabela('bancas'), d.protocolo, d.matricula);
    if (!b) return { ok: false, erro: 'Protocolo não encontrado para essa matrícula.' };
    if (b.status !== 'devolvida') return { ok: false, erro: 'Esta solicitação não está aberta para correção. Situação atual: ' + b.status + '.' };
    var obj = bancaParaObjeto(b);
    var turmas = lerTabela('turmas');
    for (var i = 0; i < turmas.length; i++) if (turmas[i].id === obj.turmaId) obj.turmaNome = turmas[i].nome;
    return { ok: true, banca: obj };
  },

  bancaCorrigir: function (d) {
    return comTrava(function () {
      var bancas = lerTabela('bancas');
      var linha = acharBanca(bancas, d.protocolo, d.matricula);
      if (!linha) return { ok: false, erro: 'Solicitação não encontrada.' };
      if (linha.status !== 'devolvida') return { ok: false, erro: 'Esta solicitação não está aberta para correção.' };

      var r = sanearBanca(d.registro || {});
      var erros = validarBanca(r);
      if (erros.length) return { ok: false, erros: erros };

      var atual = bancaParaObjeto(linha);
      var dias = diasAte(r.data);
      var foraDoPrazo = dias !== null && dias < PRAZO_DIAS;
      var status = r.orientadorEmail ? 'aguardando-orientador' : 'pendente';

      for (var k in r) atual[k] = r[k];
      // campos que o discente não pode reescrever
      atual.protocolo = linha.protocolo;
      atual.id = linha.id;
      atual.matricula = String(linha.matricula);
      atual.alunoId = linha.alunoId;
      atual.turmaId = linha.turmaId;
      atual.status = status;
      atual.foraDoPrazo = foraDoPrazo;
      atual.historico = (atual.historico || []).concat([{ em: agora(), status: status, por: linha.nome + ' (correção do discente)' }]);

      atualizarLinha('bancas', linha._linha, objetoParaBanca(atual));
      registrarAuditoria(linha.nome + ' (discente)', 'banca-corrigida', linha.protocolo, '');
      return { ok: true, banca: atual, foraDoPrazo: foraDoPrazo, status: status };
    });
  },

  consultaProtocolo: function (d) {
    var b = acharBanca(lerTabela('bancas'), d.protocolo, d.matricula);
    if (!b) return { ok: false, erro: 'Protocolo não encontrado para essa matrícula.' };
    return { ok: true, banca: {
      protocolo: b.protocolo, tipoBanca: b.tipoBanca, nome: b.nome, data: b.data, hora: b.hora,
      apresentacao: b.apresentacao, status: b.status, observacao: b.observacao || ''
    } };
  },

  externoSalvar: function (d) {
    return comTrava(function () {
      var dados = d.dados || {};
      var cpf = soDigitos(dados.cpf);
      if (!texto(dados.nome) || !texto(dados.instituicao)) return { ok: false, erro: 'Nome e instituição são obrigatórios.' };
      if (!cpfValido(cpf)) return { ok: false, erro: 'CPF inválido.' };

      var arq = dados.arquivo || null;
      var diplomaId = '', diplomaNome = '';
      if (arq && arq.conteudo) {
        var salvo = salvarDiploma(arq, dados.nome, cpf);
        if (!salvo.ok) return salvo;
        diplomaId = salvo.id; diplomaNome = salvo.nome;
      }

      var externos = lerTabela('externos');
      var existente = null;
      for (var i = 0; i < externos.length; i++) if (soDigitos(externos[i].cpf) === cpf) { existente = externos[i]; break; }

      var registro = {
        id: existente ? existente.id : uid('ext'),
        protocolo: existente ? existente.protocolo : proximoProtocolo('PPEA-EXT-'),
        nome: limitar(dados.nome, 120),
        cpf: "'" + cpf,                       // apóstrofo: a planilha guarda como texto e não come o zero à esquerda
        email: limitar(dados.email, 120),
        instituicao: limitar(dados.instituicao, 160),
        programa: limitar(dados.programa, 160),
        cargo: limitar(dados.cargo, 120),
        lattes: limitar(dados.lattes, 200),
        titulacao_json: JSON.stringify(dados.titulacao || {}),
        diplomaId: diplomaId || (existente ? existente.diplomaId : ''),
        diplomaNome: diplomaNome || (existente ? existente.diplomaNome : ''),
        criadoEm: existente ? existente.criadoEm : agora(),
        atualizadoEm: agora()
      };

      if (existente) atualizarLinha('externos', existente._linha, registro);
      else inserirLinha('externos', registro);

      registrarAuditoria('participante externo', existente ? 'externo-atualizado' : 'externo-criado',
        registro.protocolo, mascararCPF(cpf));
      return { ok: true, protocolo: registro.protocolo, atualizado: !!existente };
    });
  },

  /**
   * Consulta por CPF. Devolve o mínimo necessário para o discente saber
   * que não precisa cadastrar de novo — nome abreviado, sem e-mail,
   * sem CPF, sem link do diploma.
   */
  externoConsulta: function (d) {
    var cpf = soDigitos(d.cpf);
    if (!cpfValido(cpf)) return { ok: false, erro: 'CPF inválido.' };
    var externos = lerTabela('externos');
    for (var i = 0; i < externos.length; i++) {
      if (soDigitos(externos[i].cpf) === cpf) {
        return { ok: true, encontrado: true, nome: mascararNome(externos[i].nome),
                 instituicao: externos[i].instituicao || '', programa: externos[i].programa || '',
                 diploma: !!externos[i].diplomaId };
      }
    }
    return { ok: true, encontrado: false };
  },

  login: function (d) {
    var nome = texto(d.nome);
    var senha = String(d.senha || '');
    if (!nome || !senha) return { ok: false, erro: 'Informe nome e senha.' };

    var usuarios = lerTabela('usuarios');
    var u = null, alvo = normalizar(nome);
    for (var i = 0; i < usuarios.length; i++) {
      if (normalizar(usuarios[i].login) === alvo || normalizar(usuarios[i].nome) === alvo) { u = usuarios[i]; break; }
    }

    // Mensagem idêntica para usuário inexistente e senha errada: não revela quem existe.
    var generico = { ok: false, erro: 'Nome ou senha incorretos.' };
    if (!u || !verdade(u.ativo)) { registrarAuditoria(nome, 'login-negado', '', 'usuário inexistente ou inativo'); return generico; }

    if (u.bloqueadoAte && new Date(u.bloqueadoAte) > new Date()) {
      return { ok: false, erro: 'Acesso bloqueado temporariamente por tentativas erradas. Tente novamente em alguns minutos.' };
    }

    var calculado = calcularHash(senha, u.salt, parseInt(u.iteracoes, 10) || ITERACOES_HASH);
    if (!iguaisSeguro(calculado, u.hash)) {
      u.tentativas = (parseInt(u.tentativas, 10) || 0) + 1;
      if (u.tentativas >= MAX_TENTATIVAS) {
        u.bloqueadoAte = new Date(Date.now() + BLOQUEIO_MINUTOS * 60000).toISOString();
        u.tentativas = 0;
        registrarAuditoria(u.nome, 'login-bloqueado', '', MAX_TENTATIVAS + ' tentativas erradas');
      }
      atualizarLinha('usuarios', u._linha, u);
      registrarAuditoria(u.nome, 'login-negado', '', 'senha incorreta');
      return generico;
    }

    u.tentativas = 0; u.bloqueadoAte = ''; u.ultimoAcesso = agora();
    atualizarLinha('usuarios', u._linha, u);

    var token = bytesAleatorios(32);
    var expiraEm = new Date(Date.now() + SESSAO_MINUTOS * 60000).toISOString();
    inserirLinha('sessoes', {
      tokenHash: sha256(token), usuarioId: u.id, nome: u.nome, papel: u.papel,
      criadoEm: agora(), expiraEm: expiraEm, ultimoUso: agora()
    });
    registrarAuditoria(u.nome, 'login', '', '');
    return { ok: true, token: token, usuario: u.nome, papel: u.papel, expiraEm: expiraEm };
  }
};

function cpfValido(cpf) {
  cpf = soDigitos(cpf);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  var s = 0, i;
  for (i = 0; i < 9; i++) s += parseInt(cpf.charAt(i), 10) * (10 - i);
  var d1 = (s * 10) % 11; if (d1 === 10) d1 = 0;
  if (d1 !== parseInt(cpf.charAt(9), 10)) return false;
  s = 0;
  for (i = 0; i < 10; i++) s += parseInt(cpf.charAt(i), 10) * (11 - i);
  var d2 = (s * 10) % 11; if (d2 === 10) d2 = 0;
  return d2 === parseInt(cpf.charAt(10), 10);
}

/** Grava o diploma na pasta do Drive da secretaria e devolve o id do arquivo. */
function salvarDiploma(arq, nome, cpf) {
  var permitidos = ['application/pdf', 'image/jpeg', 'image/png'];
  if (permitidos.indexOf(String(arq.tipo)) < 0) return { ok: false, erro: 'Formato de arquivo não aceito. Envie PDF, JPG ou PNG.' };
  var bytes;
  try { bytes = Utilities.base64Decode(arq.conteudo); }
  catch (e) { return { ok: false, erro: 'Não foi possível ler o arquivo enviado.' }; }
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, erro: 'Arquivo acima de 8 MB.' };

  var pastaId = lerConfig('PASTA_DIPLOMAS', '');
  if (!pastaId) return { ok: false, erro: 'Pasta de diplomas não configurada. Avise a secretaria.' };

  var extensao = String(arq.tipo) === 'application/pdf' ? '.pdf' : (String(arq.tipo) === 'image/png' ? '.png' : '.jpg');
  var nomeArquivo = 'Diploma ' + limitar(nome, 60) + ' ' + soDigitos(cpf).slice(-4) + extensao;
  var blob = Utilities.newBlob(bytes, arq.tipo, nomeArquivo);
  var arquivo = DriveApp.getFolderById(pastaId).createFile(blob);
  // Herda as permissões da pasta: nada de link público.
  arquivo.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  return { ok: true, id: arquivo.getId(), nome: nomeArquivo };
}

/* ═══════════════════════════════════════════════════════════════════════
   AÇÕES AUTENTICADAS (painel da secretaria — exigem sessão válida)
   ═══════════════════════════════════════════════════════════════════════ */

var ACOES_AUTENTICADAS = {

  logout: function (d, sessao) {
    var sessoes = lerTabela('sessoes');
    for (var i = sessoes.length - 1; i >= 0; i--) {
      if (sessoes[i].usuarioId === sessao.usuarioId) apagarLinha('sessoes', sessoes[i]._linha);
    }
    registrarAuditoria(sessao.nome, 'logout', '', '');
    return { ok: true };
  },

  estado: function (d, sessao) {
    var turmas = lerTabela('turmas');
    var nomeTurma = {};
    turmas.forEach(function (t) { nomeTurma[t.id] = t.nome; });

    var bancas = lerTabela('bancas').map(function (l) {
      var b = bancaParaObjeto(l);
      b.turmaNome = nomeTurma[b.turmaId] || '';
      return b;
    });

    var externos = lerTabela('externos').map(function (x) {
      return { id: x.id, protocolo: x.protocolo, nome: x.nome, cpf: mascararCPF(x.cpf),
               email: x.email, instituicao: x.instituicao, programa: x.programa, cargo: x.cargo,
               lattes: x.lattes, titulacao: jsonSeguro(x.titulacao_json, {}),
               diploma: !!x.diplomaId, criadoEm: x.criadoEm };
    });

    var lixeira = { turmas: [], alunos: [], bancas: [] };
    lerTabela('lixeira').forEach(function (l) {
      var alvo = l.tipo === 'turma' ? 'turmas' : (l.tipo === 'aluno' ? 'alunos' : 'bancas');
      var obj = jsonSeguro(l.dados_json, null);
      if (obj) { obj.excluidoEm = l.excluidoEm; obj.excluidoPor = l.excluidoPor; lixeira[alvo].push(obj); }
    });

    return { ok: true, dados: {
      turmas: turmas.map(function (t) { return { id: t.id, nome: t.nome, modalidade: t.modalidade, ativa: verdade(t.ativa) }; }),
      alunos: lerTabela('alunos').map(function (a) {
        return { id: a.id, nome: a.nome, matricula: String(a.matricula), turmaId: a.turmaId,
                 orientador: a.orientador, coorientador: a.coorientador, email: a.email, ativo: verdade(a.ativo) };
      }),
      bancas: bancas, externos: externos,
      usuarios: lerTabela('usuarios').map(function (u) { return { id: u.id, nome: u.nome, papel: u.papel, ativo: verdade(u.ativo) }; }),
      lixeira: lixeira
    } };
  },

  alterarSenha: function (d, sessao) {
    return comTrava(function () {
      var usuarios = lerTabela('usuarios');
      var u = null;
      for (var i = 0; i < usuarios.length; i++) if (usuarios[i].id === sessao.usuarioId) { u = usuarios[i]; break; }
      if (!u) return { ok: false, erro: 'Usuário não encontrado.' };

      var atualHash = calcularHash(String(d.atual || ''), u.salt, parseInt(u.iteracoes, 10) || ITERACOES_HASH);
      if (!iguaisSeguro(atualHash, u.hash)) {
        registrarAuditoria(u.nome, 'senha-alterada-negada', '', 'senha atual incorreta');
        return { ok: false, erro: 'Senha atual incorreta.' };
      }
      var problema = senhaAceitavel(d.nova);
      if (problema) return { ok: false, erro: problema };

      u.salt = bytesAleatorios(16);
      u.iteracoes = ITERACOES_HASH;
      u.hash = calcularHash(String(d.nova), u.salt, ITERACOES_HASH);
      u.senhaAlteradaEm = agora();
      atualizarLinha('usuarios', u._linha, u);

      // Derruba as outras sessões do usuário: se a senha mudou, o resto sai.
      var sessoes = lerTabela('sessoes');
      for (var s = sessoes.length - 1; s >= 0; s--) if (sessoes[s].usuarioId === u.id) apagarLinha('sessoes', sessoes[s]._linha);

      registrarAuditoria(u.nome, 'senha-alterada', '', '');
      return { ok: true };
    });
  },

  turmaSalvar: function (d, sessao) {
    return comTrava(function () {
      var t = d.turma || {};
      var turmas = lerTabela('turmas');
      if (t.id) {
        for (var i = 0; i < turmas.length; i++) {
          if (turmas[i].id === t.id) {
            var linha = turmas[i];
            if (t.nome !== undefined)       linha.nome = limitar(t.nome, 80);
            if (t.modalidade !== undefined) linha.modalidade = texto(t.modalidade);
            if (t.ativa !== undefined)      linha.ativa = !!t.ativa;
            atualizarLinha('turmas', linha._linha, linha);
            registrarAuditoria(sessao.nome, 'turma-editada', linha.nome, '');
            return { ok: true, turma: { id: linha.id, nome: linha.nome, modalidade: linha.modalidade, ativa: verdade(linha.ativa) } };
          }
        }
        return { ok: false, erro: 'Turma não encontrada.' };
      }
      var nova = { id: uid('t'), nome: limitar(t.nome, 80), modalidade: texto(t.modalidade),
                   ativa: t.ativa === undefined ? true : !!t.ativa, criadoEm: agora() };
      if (!nova.nome) return { ok: false, erro: 'Informe o nome da turma.' };
      inserirLinha('turmas', nova);
      registrarAuditoria(sessao.nome, 'turma-criada', nova.nome, '');
      return { ok: true, turma: nova };
    });
  },

  turmaRemover: function (d, sessao) {
    return comTrava(function () { return moverParaLixeira('turmas', 'turma', d.id, sessao); });
  },

  alunoSalvar: function (d, sessao) {
    return comTrava(function () {
      var a = d.aluno || {};
      var alunos = lerTabela('alunos');
      if (a.id) {
        for (var i = 0; i < alunos.length; i++) {
          if (alunos[i].id === a.id) {
            var linha = alunos[i];
            ['nome','matricula','turmaId','orientador','coorientador','email'].forEach(function (c) {
              if (a[c] !== undefined) linha[c] = limitar(a[c], 160);
            });
            if (a.ativo !== undefined) linha.ativo = !!a.ativo;
            atualizarLinha('alunos', linha._linha, linha);
            registrarAuditoria(sessao.nome, 'discente-editado', linha.nome, '');
            return { ok: true, aluno: linha };
          }
        }
        return { ok: false, erro: 'Discente não encontrado.' };
      }
      var novo = { id: uid('a'), nome: limitar(a.nome, 120), matricula: limitar(a.matricula, 30),
                   turmaId: limitar(a.turmaId, 40), orientador: limitar(a.orientador, 120),
                   coorientador: limitar(a.coorientador, 120), email: limitar(a.email, 120),
                   ativo: a.ativo === undefined ? true : !!a.ativo, criadoEm: agora() };
      if (!novo.nome) return { ok: false, erro: 'Informe o nome do discente.' };
      inserirLinha('alunos', novo);
      registrarAuditoria(sessao.nome, 'discente-criado', novo.nome, '');
      return { ok: true, aluno: novo };
    });
  },

  alunoLote: function (d, sessao) {
    return comTrava(function () {
      var lista = (d.alunos || []).slice(0, 300);
      if (!lista.length) return { ok: false, erro: 'Nenhum discente na lista.' };
      var sh = aba('alunos');
      var cab = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      var linhas = lista.map(function (a) {
        var novo = { id: uid('a'), nome: limitar(a.nome, 120), matricula: limitar(a.matricula, 30),
                     turmaId: limitar(a.turmaId, 40), orientador: limitar(a.orientador, 120),
                     coorientador: limitar(a.coorientador, 120), email: limitar(a.email, 120),
                     ativo: true, criadoEm: agora() };
        return cab.map(function (c) { return novo[c] === undefined ? '' : novo[c]; });
      });
      sh.getRange(sh.getLastRow() + 1, 1, linhas.length, cab.length).setValues(linhas);
      registrarAuditoria(sessao.nome, 'discentes-importados', '', linhas.length + ' registro(s)');
      return { ok: true, total: linhas.length };
    });
  },

  alunoRemover: function (d, sessao) {
    return comTrava(function () { return moverParaLixeira('alunos', 'aluno', d.id, sessao); });
  },

  bancaStatus: function (d, sessao) {
    return comTrava(function () {
      var permitidos = ['pendente','aguardando-orientador','devolvida','aprovada','realizada','cancelada'];
      if (permitidos.indexOf(texto(d.status)) < 0) return { ok: false, erro: 'Situação inválida.' };
      var bancas = lerTabela('bancas');
      for (var i = 0; i < bancas.length; i++) {
        if (bancas[i].id === d.id) {
          var b = bancaParaObjeto(bancas[i]);
          if (texto(d.status) === 'devolvida' && !texto(d.observacao))
            return { ok: false, erro: 'Para devolver, escreva na observação o que o discente deve corrigir.' };
          b.status = texto(d.status);
          b.observacao = limitar(d.observacao, 1000) || b.observacao || '';
          b.historico = (b.historico || []).concat([{ em: agora(), status: b.status, por: sessao.nome }]);
          if (b.status === 'aprovada') {
            b.aprovadaEm = agora(); b.avaliador = sessao.nome;
            b.documentosEmitidos = false; b.documentosEmitidosEm = '';
          }
          if (b.status === 'pendente' || b.status === 'devolvida') b.aprovadaEm = '';
          atualizarLinha('bancas', bancas[i]._linha, objetoParaBanca(b));
          registrarAuditoria(sessao.nome, 'banca-' + b.status, b.protocolo, limitar(d.observacao, 200));
          return { ok: true, banca: b };
        }
      }
      return { ok: false, erro: 'Banca não encontrada.' };
    });
  },

  bancaChecklist: function (d, sessao) {
    return comTrava(function () {
      var bancas = lerTabela('bancas');
      for (var i = 0; i < bancas.length; i++) {
        if (bancas[i].id === d.id) {
          var b = bancaParaObjeto(bancas[i]);
          var c = d.checklist || {};
          b.checklist = { convites: !!c.convites, ata: !!c.ata, declaracoes: !!c.declaracoes, sala: !!c.sala };
          atualizarLinha('bancas', bancas[i]._linha, objetoParaBanca(b));
          return { ok: true, checklist: b.checklist };
        }
      }
      return { ok: false, erro: 'Banca não encontrada.' };
    });
  },

  bancaDocumentos: function (d, sessao) {
    return comTrava(function () {
      var bancas = lerTabela('bancas');
      for (var i = 0; i < bancas.length; i++) {
        if (bancas[i].id === d.id) {
          var b = bancaParaObjeto(bancas[i]);
          b.documentosEmitidos = true;
          b.documentosEmitidosEm = agora();
          b.checklist = { convites: true, ata: true, declaracoes: true, sala: !!(b.checklist && b.checklist.sala) };
          b.historico = (b.historico || []).concat([{ em: agora(), status: 'documentos-emitidos', por: sessao.nome }]);
          atualizarLinha('bancas', bancas[i]._linha, objetoParaBanca(b));
          registrarAuditoria(sessao.nome, 'documentos-emitidos', b.protocolo, '');
          return { ok: true, banca: b };
        }
      }
      return { ok: false, erro: 'Banca não encontrada.' };
    });
  },

  bancaRemover: function (d, sessao) {
    return comTrava(function () { return moverParaLixeira('bancas', 'banca', d.id, sessao); });
  },

  /**
   * Lê os modelos .docx da pasta de modelos no Drive e devolve o conteúdo
   * em base64. O painel chama isso sozinho ao abrir a tela de Documentos,
   * então a secretaria nunca mais precisa anexar arquivo à mão.
   */
  /**
   * Devolve os seis modelos (convite, ata e declaração × mestrado e
   * doutorado) conforme o mapeamento salvo. Também devolve a lista de
   * arquivos disponíveis na pasta, para o painel oferecer a troca.
   */
  modelosCarregar: function (d, sessao) {
    var pastaId = lerConfig('PASTA_MODELOS', '');
    if (!pastaId) return { ok: false, erro: 'Pasta de modelos ainda não configurada. Rode apontarModelos() no Apps Script.' };

    var pasta;
    try { pasta = DriveApp.getFolderById(pastaId); }
    catch (e) { return { ok: false, erro: 'Não consegui abrir a pasta de modelos. Confira se ela está acessível pela conta da secretaria.' }; }

    var disponiveis = varrerModelos(pasta);

    // Primeira vez: tenta adivinhar pelos nomes e já deixa salvo.
    if (!temAlgumModeloDefinido()) autodetectar(disponiveis);

    var modelos = { mestrado: {}, doutorado: {} };
    var faltando = [];

    MODALIDADES.forEach(function (mod) {
      TIPOS_MODELO.forEach(function (tipo) {
        var id = lerConfig(chaveModelo(mod, tipo), '');
        if (!id) { faltando.push({ modalidade: mod, tipo: tipo }); return; }

        var arquivo = arquivoValido(id);
        if (!arquivo) {
          // O arquivo saiu do Drive, foi para a lixeira ou perdeu acesso.
          gravarConfig(chaveModelo(mod, tipo), '');
          faltando.push({ modalidade: mod, tipo: tipo, sumiu: true });
          return;
        }

        var blob = blobDocx(arquivo);
        if (!blob) { faltando.push({ modalidade: mod, tipo: tipo, formato: true }); return; }

        modelos[mod][tipo] = {
          id: id, nome: arquivo.getName(),
          atualizadoEm: arquivo.getLastUpdated().toISOString(),
          conteudo: Utilities.base64Encode(blob.getBytes())
        };
      });
    });

    return { ok: true, modelos: modelos, faltando: faltando, disponiveis: disponiveis.lista };
  },

  /** Grava qual arquivo do Drive corresponde a cada vaga. */
  modelosDefinir: function (d, sessao) {
    return comTrava(function () {
      var mapa = d.mapa || {};
      var gravados = 0;
      for (var chave in mapa) {
        var partes = String(chave).split('_');
        if (MODALIDADES.indexOf(partes[0]) < 0 || TIPOS_MODELO.indexOf(partes[1]) < 0) continue;
        var id = String(mapa[chave] || '');
        if (id && !arquivoValido(id)) return { ok: false, erro: 'Não consegui abrir um dos arquivos escolhidos. Atualize a lista e tente de novo.' };
        gravarConfig(chaveModelo(partes[0], partes[1]), id);
        gravados++;
      }
      registrarAuditoria(sessao.nome, 'modelos-definidos', '', gravados + ' vaga(s)');
      return { ok: true, gravados: gravados };
    });
  },

  restaurar: function (d, sessao) {
    return comTrava(function () {
      var mapa = { turma: 'turmas', aluno: 'alunos', banca: 'bancas' };
      var destino = mapa[texto(d.tipo)];
      if (!destino) return { ok: false, erro: 'Tipo inválido.' };
      var lixo = lerTabela('lixeira');
      for (var i = 0; i < lixo.length; i++) {
        if (lixo[i].id === d.id && lixo[i].tipo === texto(d.tipo)) {
          var obj = jsonSeguro(lixo[i].dados_json, null);
          if (!obj) return { ok: false, erro: 'Registro danificado na lixeira.' };
          delete obj._linha; delete obj.excluidoEm; delete obj.excluidoPor;
          inserirLinha(destino, destino === 'bancas' ? objetoParaBanca(obj) : obj);
          apagarLinha('lixeira', lixo[i]._linha);
          registrarAuditoria(sessao.nome, 'restaurado', texto(d.tipo) + ' ' + d.id, '');
          return { ok: true };
        }
      }
      return { ok: false, erro: 'Item não encontrado na lixeira.' };
    });
  }
};

var MODALIDADES = ['mestrado', 'doutorado'];
var TIPOS_MODELO = ['conv', 'ata', 'decl'];

function chaveModelo(modalidade, tipo) { return 'MODELO_' + modalidade + '_' + tipo; }

function temAlgumModeloDefinido() {
  for (var i = 0; i < MODALIDADES.length; i++) {
    for (var j = 0; j < TIPOS_MODELO.length; j++) {
      if (lerConfig(chaveModelo(MODALIDADES[i], TIPOS_MODELO[j]), '')) return true;
    }
  }
  return false;
}

/** Devolve o arquivo se ele ainda existe e não está na lixeira. */
function arquivoValido(id) {
  try {
    var f = DriveApp.getFileById(id);
    if (f.isTrashed()) return null;
    return f;
  } catch (e) { return null; }
}

/**
 * Percorre a pasta e todas as subpastas (até 4 níveis) juntando os
 * arquivos que servem de modelo, com o tipo e a modalidade que dá para
 * deduzir do nome do arquivo e do caminho da pasta.
 */
function varrerModelos(pastaRaiz) {
  var lista = [];
  var vistos = {};

  function percorrer(pasta, profundidade, caminho) {
    if (profundidade > 4) return;
    if (vistos[pasta.getId()]) return;   // evita atalho que aponta para a própria pasta
    vistos[pasta.getId()] = true;

    var arquivos = pasta.getFiles();
    while (arquivos.hasNext()) {
      var f = arquivos.next();
      if (!ehDocx(f)) continue;
      var completo = caminho + f.getName();
      lista.push({
        id: f.getId(), nome: f.getName(), caminho: caminho || '',
        tipo: classificarModelo(f.getName()),
        modalidade: classificarModalidade(completo),
        profundidade: profundidade,
        atualizadoEm: f.getLastUpdated().getTime()
      });
    }

    var subpastas = pasta.getFolders();
    while (subpastas.hasNext()) {
      var sub = subpastas.next();
      percorrer(sub, profundidade + 1, caminho + sub.getName() + '/');
    }
  }

  percorrer(pastaRaiz, 0, '');
  lista.sort(function (a, b) { return (a.caminho + a.nome).localeCompare(b.caminho + b.nome); });
  return { lista: lista };
}

function ehDocx(arquivo) {
  var t = arquivo.getMimeType();
  return t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || t === 'application/vnd.google-apps.document';
}

/** Deduz a modalidade pelo caminho completo. Sem pista, vale para as duas. */
function classificarModalidade(caminhoCompleto) {
  var n = normalizar(caminhoCompleto);
  var ehMest = /mestrado|mpea/.test(n);
  var ehDout = /doutorado|dpea/.test(n);
  if (ehMest && !ehDout) return 'mestrado';
  if (ehDout && !ehMest) return 'doutorado';
  return '';           // serve para as duas, quando não houver específico
}

/**
 * Preenche as vagas vazias adivinhando pelos nomes: primeiro procura um
 * arquivo da modalidade certa; não achando, aceita um genérico.
 */
function autodetectar(disponiveis) {
  var lista = disponiveis.lista;
  var definidos = 0;

  MODALIDADES.forEach(function (mod) {
    TIPOS_MODELO.forEach(function (tipo) {
      if (lerConfig(chaveModelo(mod, tipo), '')) return;

      var candidatos = lista.filter(function (a) { return a.tipo === tipo; });
      var especificos = candidatos.filter(function (a) { return a.modalidade === mod; });
      var genericos  = candidatos.filter(function (a) { return a.modalidade === ''; });
      var escolha = melhor(especificos) || melhor(genericos);

      if (escolha) { gravarConfig(chaveModelo(mod, tipo), escolha.id); definidos++; }
    });
  });
  return definidos;
}

/** Mais perto da raiz vence; empatando, o mais recente. */
function melhor(lista) {
  if (!lista || !lista.length) return null;
  return lista.slice().sort(function (a, b) {
    if (a.profundidade !== b.profundidade) return a.profundidade - b.profundidade;
    return b.atualizadoEm - a.atualizadoEm;
  })[0];
}

/**
 * Descobre a qual documento o arquivo corresponde, pelo nome.
 * Aceita "convite.docx", "Convite de Banca 2026.docx", "ATA final.docx" etc.
 */
function classificarModelo(nomeArquivo) {
  var n = normalizar(nomeArquivo);
  if (n.indexOf('convite') >= 0) return 'conv';
  if (n.indexOf('declara') >= 0) return 'decl';
  if (/(^|[^a-z])ata([^a-z]|$)/.test(n)) return 'ata';
  return null;
}

/**
 * Devolve o arquivo como .docx. Se for um Documento Google (e não um .docx
 * de verdade), converte na hora.
 */
function blobDocx(arquivo) {
  var DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  var tipo = arquivo.getMimeType();
  if (tipo === DOCX) return arquivo.getBlob();
  if (tipo === 'application/vnd.google-apps.document') {
    try {
      var url = 'https://www.googleapis.com/drive/v3/files/' + arquivo.getId() + '/export?mimeType=' + encodeURIComponent(DOCX);
      return UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob();
    } catch (e) { return null; }
  }
  return null;
}

/** Exclusão é sempre reversível: a linha sai da aba e vai inteira para a lixeira. */
function moverParaLixeira(abaOrigem, tipo, id, sessao) {
  var linhas = lerTabela(abaOrigem);
  for (var i = 0; i < linhas.length; i++) {
    if (linhas[i].id === id) {
      var numeroLinha = linhas[i]._linha;      // guardar ANTES de limpar o objeto
      var rotulo = linhas[i].nome || linhas[i].protocolo || id;
      var obj = abaOrigem === 'bancas' ? bancaParaObjeto(linhas[i]) : linhas[i];
      delete obj._linha;
      inserirLinha('lixeira', {
        tipo: tipo, id: id, excluidoEm: agora(), excluidoPor: sessao.nome, dados_json: JSON.stringify(obj)
      });
      apagarLinha(abaOrigem, numeroLinha);
      registrarAuditoria(sessao.nome, tipo + '-excluido', rotulo, '');
      return { ok: true };
    }
  }
  return { ok: false, erro: 'Registro não encontrado.' };
}

/* ═══════════════════════════════════════════════════════════════════════
   CONFIGURAÇÃO GUARDADA NA PLANILHA (aba "config")
   ═══════════════════════════════════════════════════════════════════════ */

function lerConfig(chave, padrao) {
  var linhas = lerTabela('config');
  for (var i = 0; i < linhas.length; i++) if (linhas[i].chave === chave) return String(linhas[i].valor);
  return padrao;
}
function gravarConfig(chave, valor) {
  var linhas = lerTabela('config');
  for (var i = 0; i < linhas.length; i++) {
    if (linhas[i].chave === chave) { linhas[i].valor = valor; atualizarLinha('config', linhas[i]._linha, linhas[i]); return; }
  }
  inserirLinha('config', { chave: chave, valor: valor });
}

/* ═══════════════════════════════════════════════════════════════════════
   INSTALAÇÃO E MANUTENÇÃO
   (funções para rodar à mão no editor do Apps Script)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Prepara tudo: cria as abas, a pasta de diplomas, a chave secreta,
 * a limpeza automática de sessões e o primeiro usuário administrador.
 * Rode UMA VEZ. Rodar de novo não apaga nada — só completa o que faltar.
 */
function instalar() {
  var ss = planilha();

  Object.keys(ABAS).forEach(function (nome) {
    var sh = ss.getSheetByName(nome);
    if (!sh) sh = ss.insertSheet(nome);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, ABAS[nome].length).setValues([ABAS[nome]]);
      sh.getRange(1, 1, 1, ABAS[nome].length).setFontWeight('bold').setBackground('#0d1b3d').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
  });

  pepper(); // gera a chave secreta se ainda não existir

  if (!lerConfig('PASTA_DIPLOMAS', '')) {
    var pasta = DriveApp.createFolder('PPEA · Diplomas de participantes externos');
    pasta.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    gravarConfig('PASTA_DIPLOMAS', pasta.getId());
  }
  if (!lerConfig('LISTAR_ALUNOS_PUBLICO', '')) gravarConfig('LISTAR_ALUNOS_PUBLICO', 'false');

  // Limpeza diária das sessões vencidas
  var jaTem = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'limparSessoesExpiradas'; });
  if (!jaTem) ScriptApp.newTrigger('limparSessoesExpiradas').timeBased().everyDays(1).atHour(3).create();

  if (!lerTabela('usuarios').length) {
    criarUsuario('Secretaria PPEA', 'tecnico');
  }

  Logger.log('════════════════════════════════════════════');
  Logger.log('Instalação concluída.');
  Logger.log('Pasta de diplomas: ' + lerConfig('PASTA_DIPLOMAS', ''));
  Logger.log('Pasta de modelos: ' + (lerConfig('PASTA_MODELOS', '') || 'AINDA NÃO DEFINIDA — rode definirPastaDeModelos(\'link da pasta\')'));
  Logger.log('Próximo passo: publicar o Web App e colar a URL /exec em config.js.');
  Logger.log('════════════════════════════════════════════');
}

/**
 * Cria um operador e sorteia uma senha provisória.
 * A senha aparece UMA ÚNICA VEZ no registro de execução — copie, entregue
 * à pessoa por um canal seguro e peça que ela troque no primeiro acesso.
 * papel: 'tecnico' ou 'professor'
 */
function criarUsuario(nome, papel) {
  nome = texto(nome) || 'Secretaria PPEA';
  papel = (papel === 'professor') ? 'professor' : 'tecnico';

  var usuarios = lerTabela('usuarios');
  for (var i = 0; i < usuarios.length; i++) {
    if (normalizar(usuarios[i].nome) === normalizar(nome)) { Logger.log('Já existe um usuário com esse nome: ' + nome); return; }
  }

  var senha = senhaProvisoria();
  var salt = bytesAleatorios(16);
  inserirLinha('usuarios', {
    id: uid('u'), nome: nome, login: normalizar(nome), papel: papel,
    salt: salt, hash: calcularHash(senha, salt, ITERACOES_HASH), iteracoes: ITERACOES_HASH,
    ativo: true, criadoEm: agora(), senhaAlteradaEm: '', tentativas: 0, bloqueadoAte: '', ultimoAcesso: ''
  });
  registrarAuditoria('instalação', 'usuario-criado', nome, papel);

  Logger.log('════════════════════════════════════════════');
  Logger.log('Usuário criado: ' + nome + '  (papel: ' + papel + ')');
  Logger.log('SENHA PROVISÓRIA: ' + senha);
  Logger.log('Entregue pessoalmente ou por canal seguro. Ela NÃO poderá ser vista de novo.');
  Logger.log('Peça a troca no primeiro acesso, em Configurações do painel.');
  Logger.log('════════════════════════════════════════════');
}

/** Sorteia uma senha provisória legível: 3 blocos separados por hífen. */
function senhaProvisoria() {
  var alfabeto = 'abcdefghijkmnpqrstuvwxyz23456789'; // sem l, o, 0, 1 — evita confusão ao ditar
  var blocos = [];
  for (var b = 0; b < 3; b++) {
    var s = '';
    for (var i = 0; i < 5; i++) s += alfabeto.charAt(Math.floor(Math.random() * alfabeto.length));
    blocos.push(s);
  }
  return blocos.join('-');
}

/** Sorteia uma nova senha provisória para quem esqueceu a sua. */
function redefinirSenha(nome) {
  var usuarios = lerTabela('usuarios');
  for (var i = 0; i < usuarios.length; i++) {
    if (normalizar(usuarios[i].nome) === normalizar(nome)) {
      var u = usuarios[i];
      var senha = senhaProvisoria();
      u.salt = bytesAleatorios(16);
      u.iteracoes = ITERACOES_HASH;
      u.hash = calcularHash(senha, u.salt, ITERACOES_HASH);
      u.tentativas = 0; u.bloqueadoAte = ''; u.senhaAlteradaEm = '';
      atualizarLinha('usuarios', u._linha, u);
      var sessoes = lerTabela('sessoes');
      for (var s = sessoes.length - 1; s >= 0; s--) if (sessoes[s].usuarioId === u.id) apagarLinha('sessoes', sessoes[s]._linha);
      registrarAuditoria('administração', 'senha-redefinida', u.nome, '');
      Logger.log('Nova senha provisória de ' + u.nome + ': ' + senha);
      return;
    }
  }
  Logger.log('Usuário não encontrado: ' + nome);
}

/** Tira o acesso de alguém sem apagar o histórico de decisões dessa pessoa. */
function desativarUsuario(nome) {
  var usuarios = lerTabela('usuarios');
  for (var i = 0; i < usuarios.length; i++) {
    if (normalizar(usuarios[i].nome) === normalizar(nome)) {
      var u = usuarios[i];
      u.ativo = false;
      atualizarLinha('usuarios', u._linha, u);
      var sessoes = lerTabela('sessoes');
      for (var s = sessoes.length - 1; s >= 0; s--) if (sessoes[s].usuarioId === u.id) apagarLinha('sessoes', sessoes[s]._linha);
      registrarAuditoria('administração', 'usuario-desativado', u.nome, '');
      Logger.log('Usuário desativado: ' + u.nome);
      return;
    }
  }
  Logger.log('Usuário não encontrado: ' + nome);
}

/** Liga ou desliga a listagem pública de discentes no portal. */
function definirListaPublicaDeAlunos(ligada) {
  gravarConfig('LISTAR_ALUNOS_PUBLICO', ligada ? 'true' : 'false');
  Logger.log('Listagem pública de discentes: ' + (ligada ? 'LIGADA' : 'DESLIGADA'));
  Logger.log('Ajuste também LISTAR_ALUNOS_PUBLICO em config.js, para as duas pontas combinarem.');
}

/**
 * Aponta o sistema para a pasta do Drive onde ficam convite.docx, ata.docx
 * e declaracao.docx. Aceita o ID ou o link inteiro da pasta.
 * A pasta precisa estar acessível pela conta que roda este script.
 */
function definirPastaDeModelos(idOuUrl) {
  var texto = String(idOuUrl || '').trim();
  var achado = texto.match(/[-\w]{25,}/);
  if (!achado) { Logger.log('Não reconheci um ID de pasta em: ' + texto); return; }
  var id = achado[0];

  var pasta;
  try { pasta = DriveApp.getFolderById(id); }
  catch (e) {
    Logger.log('Não consegui abrir essa pasta. Confira se ela pertence à conta da secretaria ou foi compartilhada com ela.');
    return;
  }

  gravarConfig('PASTA_MODELOS', id);
  Logger.log('Pasta de modelos definida: ' + pasta.getName());

  var disponiveis = varrerModelos(pasta);
  Logger.log('Arquivos de modelo encontrados: ' + disponiveis.lista.length);

  var definidos = autodetectar(disponiveis);
  Logger.log(definidos ? (definidos + ' vaga(s) preenchida(s) automaticamente.') : 'Nenhuma vaga nova preenchida (já estavam definidas).');
  Logger.log('');

  var rotulo = { conv: 'Convite', ata: 'Ata', decl: 'Declaração' };
  var faltou = false;
  MODALIDADES.forEach(function (mod) {
    Logger.log(mod.toUpperCase());
    TIPOS_MODELO.forEach(function (tipo) {
      var id = lerConfig(chaveModelo(mod, tipo), '');
      var arq = id ? arquivoValido(id) : null;
      if (!arq) { faltou = true; Logger.log('  ' + rotulo[tipo] + ': *** NÃO DEFINIDO ***'); return; }
      Logger.log('  ' + rotulo[tipo] + ': ' + arq.getName());
    });
  });

  if (faltou) {
    Logger.log('');
    Logger.log('As vagas em branco podem ser escolhidas na tela Documentos do painel,');
    Logger.log('ou preenchidas sozinhas se você indicar a modalidade no nome do arquivo');
    Logger.log('ou da subpasta (ex.: "Mestrado/ata.docx", "ata doutorado.docx").');
  }
}

/** Faz uma cópia datada da planilha inteira, na mesma pasta. */
function backupManual() {
  var arquivo = DriveApp.getFileById(planilha().getId());
  var nome = 'Backup Sistema de Bancas PPEA ' + new Date().toISOString().slice(0, 10);
  var pastas = arquivo.getParents();
  var copia = pastas.hasNext() ? arquivo.makeCopy(nome, pastas.next()) : arquivo.makeCopy(nome);
  registrarAuditoria('administração', 'backup', nome, '');
  Logger.log('Backup criado: ' + copia.getUrl());
}

/* ═══════════════════════════════════════════════════════════════════════
   ATALHOS PARA RODAR NO EDITOR
   ---------------------------------------------------------------------
   O seletor de funções do Apps Script executa a função sem passar nada.
   As funções que precisam de informação (o link da pasta, o nome de uma
   pessoa) não funcionam por ali direto — por isso os atalhos abaixo, que
   já trazem o dado dentro.

   Para usar: escolha o atalho no seletor do topo e clique em Executar.
   Para mudar o nome de alguém, edite a linha e salve antes de executar.
   ═══════════════════════════════════════════════════════════════════════ */

/** Aponta o sistema para a pasta de modelos (convite, ata, declaração). */
function apontarModelos() {
  definirPastaDeModelos('https://drive.google.com/drive/folders/1uUSc5uVXWUg5cKsXlIRyeXEcq3QnQ-g-');
}

/**
 * Esquece o mapeamento atual dos modelos e adivinha tudo de novo pelos
 * nomes dos arquivos. Use depois de reorganizar a pasta no Drive.
 */
function redefinirModelos() {
  MODALIDADES.forEach(function (mod) {
    TIPOS_MODELO.forEach(function (tipo) { gravarConfig(chaveModelo(mod, tipo), ''); });
  });
  Logger.log('Mapeamento anterior apagado. Redetectando...');
  apontarModelos();
}

/** Cria o acesso pessoal do Roger. */
function criarAcessoRoger() {
  criarUsuario('Roger da Silva Nunes', 'tecnico');
}

/** Cria o acesso da coordenação. */
function criarAcessoCoordenacao() {
  criarUsuario('Ana Carla Dantas Cavalcanti', 'professor');
}

/**
 * Cria o acesso de mais alguém.
 * Troque o nome e o papel na linha abaixo, salve e execute.
 * Papel: 'tecnico' (secretaria) ou 'professor' (coordenação e avaliadores).
 */
function criarOutroAcesso() {
  criarUsuario('Nome Completo da Pessoa', 'tecnico');
}

/** Sorteia uma senha nova para quem esqueceu a sua. Troque o nome antes de executar. */
function gerarSenhaNova() {
  redefinirSenha('Secretaria PPEA');
}

/** Tira o acesso de alguém, preservando o histórico. Troque o nome antes de executar. */
function tirarAcesso() {
  desativarUsuario('Nome Completo da Pessoa');
}

/** Desliga a listagem pública de discentes (recomendado). */
function desligarListaPublicaDeAlunos() {
  definirListaPublicaDeAlunos(false);
}

/** Liga a listagem pública de discentes. Ajuste também o config.js. */
function ligarListaPublicaDeAlunos() {
  definirListaPublicaDeAlunos(true);
}
