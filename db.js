/* ═══════════════════════════════════════════════════════════════════════
   PPEA · Camada de dados unificada — versão de produção
   ---------------------------------------------------------------------
   Todas as telas (index.html, aluno.html, secretaria.html) conversam com
   os dados APENAS por este arquivo. Ele tem dois modos, definidos em
   config.js:

     MODO 'api'  → fala com o Google Apps Script (planilha = banco).
                   Nenhuma regra sensível vive no navegador; quem decide
                   o que pode ser lido/gravado é o servidor.

     MODO 'demo' → grava em localStorage, com dados fictícios, para
                   treinamento e demonstração. Precisa ser habilitado
                   de propósito (PERMITIR_DEMO: true).

   REGRA DE OURO: este arquivo é público (qualquer pessoa lê o código-
   fonte no navegador). Nunca coloque senha, chave ou dado pessoal aqui.

   Funções que LEEM o cache local são síncronas.
   Funções que GRAVAM ou consultam o servidor devolvem Promise.
   ═══════════════════════════════════════════════════════════════════════ */
(function(global){
'use strict';

const CFG = global.PPEA_CONFIG || {};
const MODO = (CFG.MODO === 'demo') ? 'demo' : 'api';
const API_URL = (CFG.API_URL || '').trim();
const CHAVE = 'ppea_sistema_v2';          // chave do localStorage (modo demo)
const CHAVE_SESSAO = 'ppea_sessao';       // token de sessão (sessionStorage)

const PRAZO_DIAS = 15;        // antecedência mínima para marcar banca
const PRAZO_DOCS_DIAS = 2;    // prazo para emitir/enviar documentos após aprovação

/* ---------------- Diagnóstico de configuração ---------------- */
const PROBLEMA = (function(){
  if(MODO === 'api'){
    if(!API_URL) return 'API_URL não preenchida em config.js. Cole a URL /exec do Web App do Apps Script.';
    if(!/^https:\/\//.test(API_URL)) return 'API_URL inválida em config.js — precisa começar com https://';
    if(/\/dev$/.test(API_URL)) return 'API_URL termina em /dev. Use a URL de implantação, que termina em /exec.';
    return null;
  }
  if(!CFG.PERMITIR_DEMO) return 'MODO "demo" exige PERMITIR_DEMO: true em config.js. Em produção use MODO: "api".';
  return null;
})();

/* ---------------- Tabelas fixas ---------------- */
const TIPOS_LABEL = { 'defesa-projeto':'Defesa de Projeto', 'qualificacao':'Exame de Qualificação', 'defesa-final':'Defesa Final' };
const TIPOS_ORDEM = ['defesa-projeto','qualificacao','defesa-final'];
const STATUS_LABEL = {
  'aguardando-orientador':'Aguardando anuência do orientador',
  'pendente':'Pendente (em análise)',
  'devolvida':'Devolvida / não aprovada',
  'aprovada':'Aprovada',
  'realizada':'Realizada',
  'cancelada':'Cancelada'
};
const COMISSAO = {
  mestrado: [
    {role:'Presidente (Orientador)', sub:'Membro do PPEA',  inst:'UFF'},
    {role:'1º Examinador (Externo)',  sub:'Externo ao MPEA/UFF', inst:''},
    {role:'2º Examinador (Interno)',  sub:'Interno ao MPEA/UFF', inst:'UFF'},
    {role:'Suplente (Externo)',       sub:'Externo ao MPEA/UFF', inst:''},
    {role:'Suplente (Interno)',       sub:'Interno ao MPEA/UFF', inst:'UFF'}
  ],
  doutorado: [
    {role:'Presidente (Orientador)', sub:'Membro do PPEA/UFF', inst:'UFF'},
    {role:'1º Examinador (Interno)',  sub:'Docente UFF', inst:'UFF'},
    {role:'2º Examinador (Interno)',  sub:'Docente UFF', inst:'UFF'},
    {role:'3º Examinador (Externo)',  sub:'Externo à UFF', inst:''},
    {role:'4º Examinador (Externo)',  sub:'Externo à UFF', inst:''},
    {role:'Suplente (Interno)',       sub:'Vinculado à UFF', inst:'UFF'},
    {role:'Suplente (Externo)',       sub:'Externo à UFF', inst:''}
  ]
};

/* ---------------- Utilitários ---------------- */
function uid(p){ return (p||'id')+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function hoje(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
function diasCorridosAte(dataStr){ if(!dataStr) return null; const alvo=new Date(dataStr+'T00:00:00'); return Math.round((alvo-hoje())/86400000); }
function addDias(iso,n){ const d=new Date(iso); d.setDate(d.getDate()+n); return d.toISOString(); }
function fData(s){ if(!s) return '—'; const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m?(m[3]+'/'+m[2]+'/'+m[1]):s; }
function fDataHora(iso){ try{ return new Date(iso).toLocaleString('pt-BR'); }catch(e){ return iso||''; } }
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function soDigitos(s){ return String(s||'').replace(/\D/g,''); }
function cpfValido(cpf){
  cpf=soDigitos(cpf);
  if(cpf.length!==11 || /^(\d)\1{10}$/.test(cpf)) return false;
  let s=0,i;
  for(i=0;i<9;i++) s+=+cpf[i]*(10-i);
  let d1=(s*10)%11; if(d1===10) d1=0; if(d1!==+cpf[9]) return false;
  s=0; for(i=0;i<10;i++) s+=+cpf[i]*(11-i);
  let d2=(s*10)%11; if(d2===10) d2=0;
  return d2===+cpf[10];
}

function debounce(fn, ms){
  let t; return function(){ const ctx=this, args=arguments; clearTimeout(t); t=setTimeout(()=>fn.apply(ctx,args), ms||200); };
}
function copiaAlternativa(texto){
  try{
    const ta=document.createElement('textarea');
    ta.value=texto; ta.setAttribute('readonly',''); ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.select();
    const ok=document.execCommand('copy'); document.body.removeChild(ta); return ok;
  }catch(e){ return false; }
}
function copiarTexto(texto){
  texto = String(texto||'');
  if(global.navigator && navigator.clipboard && global.isSecureContext){
    return navigator.clipboard.writeText(texto).then(()=>true).catch(()=>copiaAlternativa(texto));
  }
  return Promise.resolve(copiaAlternativa(texto));
}

/* ═══════════════════════════════════════════════════════════════════
   SESSÃO (painel da secretaria)
   O token é emitido pelo servidor e guardado em sessionStorage — some
   ao fechar a aba. Nunca guardamos senha no navegador.
   ═══════════════════════════════════════════════════════════════════ */
const Sessao = {
  ler(){
    try{
      const raw=sessionStorage.getItem(CHAVE_SESSAO); if(!raw) return null;
      const s=JSON.parse(raw);
      if(!s || !s.token) return null;
      if(s.expiraEm && new Date(s.expiraEm) < new Date()){ Sessao.limpar(); return null; }
      return s;
    }catch(e){ return null; }
  },
  gravar(s){ try{ sessionStorage.setItem(CHAVE_SESSAO, JSON.stringify(s)); }catch(e){} },
  limpar(){ try{ sessionStorage.removeItem(CHAVE_SESSAO); }catch(e){} },
  token(){ const s=Sessao.ler(); return s?s.token:''; }
};

/* ═══════════════════════════════════════════════════════════════════
   TRANSPORTE — uma única porta de entrada: executar(acao, dados).
   Em 'api' vira POST para o Apps Script; em 'demo' cai no motor local.
   Os dois devolvem o mesmo formato: {ok:true, ...} ou {ok:false, erro}
   ═══════════════════════════════════════════════════════════════════ */
let AVISO_SESSAO = null;   // callback opcional: DB.aoExpirarSessao(fn)

function executar(acao, dados){
  if(PROBLEMA) return Promise.resolve({ok:false, erro:'Configuração: '+PROBLEMA});
  if(MODO === 'demo') return Demo.executar(acao, dados||{});
  return chamarApi(acao, dados||{});
}

function chamarApi(acao, dados){
  const corpo = JSON.stringify({ acao, token: Sessao.token(), dados });
  return fetch(API_URL, {
    method: 'POST',
    // text/plain evita o preflight CORS, que o Apps Script não responde.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: corpo,
    redirect: 'follow'
  })
  .then(r => r.text())
  .then(txt => {
    let j;
    try{ j = JSON.parse(txt); }
    catch(e){
      return {ok:false, erro:'Resposta inesperada do servidor. Verifique se o Web App está publicado com acesso "Qualquer pessoa" e se a URL termina em /exec.'};
    }
    if(j && j.erro === 'SESSAO_EXPIRADA'){
      Sessao.limpar();
      if(AVISO_SESSAO){ try{ AVISO_SESSAO(); }catch(e){} }
      return {ok:false, erro:'Sua sessão expirou. Entre novamente.', sessaoExpirada:true};
    }
    return j;
  })
  .catch(() => ({ok:false, erro:'Não foi possível falar com o servidor. Verifique a conexão e a URL em config.js.'}));
}

/* ═══════════════════════════════════════════════════════════════════
   CACHE DE LEITURA (painel da secretaria)
   O painel baixa o estado inteiro uma vez (DB.sincronizar) e lê dele de
   forma síncrona. Depois de qualquer gravação, sincronize de novo.
   ═══════════════════════════════════════════════════════════════════ */
let CACHE = { turmas:[], alunos:[], bancas:[], externos:[], usuarios:[], lixeira:{turmas:[],alunos:[],bancas:[]} };

function normalizar(d){
  d = d || {};
  return {
    turmas:  d.turmas  || [],
    alunos:  d.alunos  || [],
    bancas:  d.bancas  || [],
    externos:d.externos|| [],
    usuarios:d.usuarios|| [],
    lixeira: Object.assign({turmas:[],alunos:[],bancas:[]}, d.lixeira||{})
  };
}
function sincronizar(){
  return executar('estado', {}).then(j => {
    if(j.ok){ CACHE = normalizar(j.dados); return {ok:true}; }
    return j;
  });
}
function load(){ return CACHE; }

/* ═══════════════════════════════════════════════════════════════════
   VALIDAÇÃO (espelhada no servidor — aqui é só resposta rápida ao usuário)
   ═══════════════════════════════════════════════════════════════════ */
function validarBanca(registro){
  const erros=[];
  if(!registro.nome) erros.push('Informe o nome do discente.');
  if(!registro.matricula) erros.push('Informe a matrícula.');
  if(!registro.orientador) erros.push('Informe o orientador.');
  if(!registro.titulo) erros.push('Informe o título do trabalho.');
  if(!registro.email) erros.push('Informe o e-mail institucional do discente.');
  else if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registro.email)) erros.push('E-mail do discente em formato inválido.');
  if(registro.orientadorEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(registro.orientadorEmail)) erros.push('E-mail do orientador em formato inválido.');
  if(!registro.data) erros.push('Informe a data agendada.');
  if(!registro.hora) erros.push('Informe a hora.');
  if(!registro.apresentacao) erros.push('Selecione a modalidade de apresentação.');
  const min = registro.modalidade==='doutorado'?7:5;
  const preenchidos=(registro.comissao||[]).filter(m=>m.nome&&m.nome.trim()).length;
  if(preenchidos<min) erros.push('A comissão de '+(registro.modalidade==='doutorado'?'Doutorado exige 7':'Mestrado exige 5')+' membros preenchidos (você preencheu '+preenchidos+').');
  return erros;
}

/* ═══════════════════════════════════════════════════════════════════
   REGRAS DE PRAZO E AGREGAÇÕES (cálculo puro, roda no navegador)
   ═══════════════════════════════════════════════════════════════════ */
function statusPrazoDocumentos(banca){
  if(!banca || banca.status!=='aprovada' || banca.documentosEmitidos || !banca.aprovadaEm) return null;
  const venceEm = addDias(banca.aprovadaEm, PRAZO_DOCS_DIAS);
  const diff = Math.ceil((new Date(venceEm) - new Date()) / 86400000);
  return { pendente:true, venceEm, diasRestantes:diff, atrasado: diff<0 };
}
function progressoTurma(turmaId){
  const alunos=CACHE.alunos.filter(a=>a.turmaId===turmaId&&a.ativo);
  const bancas=CACHE.bancas.filter(b=>b.turmaId===turmaId);
  const concluiu=b=>b&&(b.status==='aprovada'||b.status==='realizada');
  let completos=0, pendentesAcao=0, alertasDocs=0;
  alunos.forEach(al=>{
    let n=0;
    TIPOS_ORDEM.forEach(tp=>{
      const b=bancas.find(x=>x.alunoId===al.id&&x.tipoBanca===tp);
      if(b){
        if(concluiu(b)) n++;
        if(b.status==='pendente') pendentesAcao++;
        if(statusPrazoDocumentos(b)) alertasDocs++;
      }
    });
    if(n===3) completos++;
  });
  return { totalAlunos:alunos.length, completos, pendentesAcao, alertasDocs };
}
function todasComAlertaDocs(){
  return CACHE.bancas.map(b=>({banca:b, prazo:statusPrazoDocumentos(b)})).filter(x=>x.prazo);
}

function mascararNome(nome){
  return String(nome||'').split(/\s+/).map((p,i)=> i===0 ? p : (p.length>2 ? p[0]+'.' : p)).join(' ');
}
function mascararCPF(cpf){
  const d=soDigitos(cpf); if(d.length!==11) return '';
  return '***.'+d.slice(3,6)+'.'+d.slice(6,9)+'-**';
}

/* ═══════════════════════════════════════════════════════════════════
   MOTOR DE DEMONSTRAÇÃO (localStorage) — espelha as ações do servidor.
   Só roda quando MODO='demo' e PERMITIR_DEMO=true.
   ═══════════════════════════════════════════════════════════════════ */
const Demo = (function(){
  function vazio(){
    return { turmas:[], alunos:[], bancas:[], externos:[],
      usuarios:[ {id:'u1', nome:'Secretaria PPEA', papel:'tecnico'}, {id:'u2', nome:'Coordenação', papel:'professor'} ],
      lixeira:{turmas:[],alunos:[],bancas:[]}, seq:1 };
  }
  function ler(){
    try{
      const raw=localStorage.getItem(CHAVE);
      if(!raw) return semear();
      const db=JSON.parse(raw);
      return Object.assign(vazio(), db, {lixeira:Object.assign({turmas:[],alunos:[],bancas:[]}, db.lixeira||{})});
    }catch(e){ return semear(); }
  }
  function grava(db){ try{ localStorage.setItem(CHAVE, JSON.stringify(db)); }catch(e){} }

  function semear(force){
    if(!force){ const ex=localStorage.getItem(CHAVE); if(ex){ try{ return JSON.parse(ex); }catch(e){} } }
    const db=vazio();
    const tM1={id:uid('t'),nome:'MPEA 2025.1',modalidade:'mestrado',ativa:true};
    const tM2={id:uid('t'),nome:'MPEA 2024.2',modalidade:'mestrado',ativa:true};
    const tD1={id:uid('t'),nome:'DPEA 2024.1',modalidade:'doutorado',ativa:true};
    db.turmas.push(tM1,tM2,tD1);
    const seed=[
      {nome:'Ana Beatriz Coutinho', turma:tM1, orientador:'Profa. Dra. Sandra Meireles'},
      {nome:'Carlos Eduardo Rangel', turma:tM1, orientador:'Prof. Dr. Marcelo Andrade'},
      {nome:'Fernanda Lopes Vianna', turma:tM1, orientador:'Profa. Dra. Sandra Meireles'},
      {nome:'Juliana Peixoto Farias', turma:tM2, orientador:'Prof. Dr. Ricardo Nogueira'},
      {nome:'Marcos Vinícius Tavares', turma:tM2, orientador:'Profa. Dra. Helena Duarte'},
      {nome:'Patrícia Gomes Albuquerque', turma:tD1, orientador:'Prof. Dr. André Bittencourt'},
      {nome:'Rodrigo Salgado Neves', turma:tD1, orientador:'Profa. Dra. Helena Duarte'},
      {nome:'Vanessa Ribeiro Castro', turma:tD1, orientador:'Prof. Dr. André Bittencourt'}
    ].map((a,i)=>({ id:uid('a'), nome:a.nome, matricula:'2025'+String(100+i), turmaId:a.turma.id,
      orientador:a.orientador, coorientador:'', email:'discente'+(i+1)+'@exemplo.test', ativo:true }));
    db.alunos.push(...seed);

    function nova(aluno,turma,tipo,info,offset){
      const d=new Date(); d.setDate(d.getDate()+(offset||20));
      db.seq++;
      const b={ id:uid('b'), protocolo:'PPEA-'+new Date().getFullYear()+'-'+String(db.seq).padStart(4,'0'),
        alunoId:aluno.id, turmaId:turma.id, turmaNome:turma.nome, modalidade:turma.modalidade, tipoBanca:tipo,
        nome:aluno.nome, matricula:aluno.matricula, orientador:aluno.orientador, coorientador:'',
        orientadorEmail:'', titulo:'estudo sobre práticas assistenciais em enfermagem',
        email:aluno.email, data:d.toISOString().slice(0,10), hora:'14:00', local:'Sala 302 / Google Meet', apresentacao:'misto',
        artigos:'', comissao: COMISSAO[turma.modalidade].map((l,i)=>({ papel:l.role, nome:i<2?('Membro Exemplo '+(i+1)):'', ppg:i===0?'PPEA/UFF':'', instituicao:l.inst, email:'' })),
        status:info.status, foraDoPrazo:!!info.foraDoPrazo, observacao:info.observacao||'',
        checklist:{convites:false,ata:false,declaracoes:false,sala:false},
        historico:[{em:new Date().toISOString(),status:info.status,por:'Sistema (demonstração)'}],
        submetidaEm:new Date().toISOString(), aprovadaEm:info.aprovadaEm||null,
        documentosEmitidos:false, documentosEmitidosEm:null, avaliador:info.avaliador||null };
      db.bancas.push(b); return b;
    }
    const agora=new Date().toISOString();
    nova(seed[0],tM1,'defesa-projeto',{status:'aprovada',aprovadaEm:addDias(agora,-3),avaliador:'Coordenação'},30);
    nova(seed[1],tM1,'qualificacao',{status:'aprovada',aprovadaEm:addDias(agora,-1),avaliador:'Coordenação'},25);
    nova(seed[2],tM1,'defesa-projeto',{status:'pendente'},22);
    nova(seed[3],tM2,'qualificacao',{status:'pendente',foraDoPrazo:true},6);
    nova(seed[4],tM2,'defesa-projeto',{status:'devolvida',observacao:'Falta indicar o segundo suplente interno e confirmar e-mail do 1º examinador.'},18);
    const bAg=nova(seed[5],tD1,'defesa-projeto',{status:'aguardando-orientador'},19); bAg.orientadorEmail='orientador@exemplo.test';
    nova(seed[6],tD1,'defesa-projeto',{status:'realizada',aprovadaEm:addDias(agora,-40),avaliador:'Coordenação'},-30);
    const bOk=nova(seed[7],tD1,'defesa-projeto',{status:'aprovada',aprovadaEm:addDias(agora,-1),avaliador:'Coordenação'},20);
    bOk.documentosEmitidos=true; bOk.documentosEmitidosEm=agora; bOk.checklist={convites:true,ata:true,declaracoes:true,sala:true};
    grava(db); return db;
  }

  function turmaNome(db,id){ const t=db.turmas.find(x=>x.id===id); return t?t.nome:''; }
  function exigeSessao(){ return Sessao.ler() ? null : {ok:false, erro:'SESSAO_EXPIRADA'}; }
  function operador(){ const s=Sessao.ler(); return s?s.usuario:'Operador'; }
  function protocolo(db,prefixo){ db.seq=(db.seq||0)+1; return (prefixo||('PPEA-'+new Date().getFullYear()+'-'))+String(db.seq).padStart(4,'0'); }

  const acoes = {
    /* ---- públicos ---- */
    turmasPublicas(db,d){
      return {ok:true, turmas: db.turmas.filter(t=>t.ativa && (!d.modalidade||t.modalidade===d.modalidade))
        .map(t=>({id:t.id,nome:t.nome,modalidade:t.modalidade}))};
    },
    alunosPublicos(db,d){
      let arr=db.alunos.filter(a=>a.ativo && a.turmaId===d.turmaId);
      if(CFG.LISTAR_ALUNOS_PUBLICO === false){
        const q=(d.q||'').trim().toLowerCase();
        if(q.length<3) return {ok:true, alunos:[], exigeBusca:true};
        arr=arr.filter(a=>a.nome.toLowerCase().indexOf(q)>=0).slice(0,10);
      }
      return {ok:true, alunos: arr.map(a=>({id:a.id,nome:a.nome,matricula:a.matricula,orientador:a.orientador,coorientador:a.coorientador||''}))};
    },
    bancaCriar(db,d){
      const erros=validarBanca(d.registro||{});
      if(erros.length) return {ok:false, erros};
      const r=d.registro;
      const dias=diasCorridosAte(r.data);
      const foraDoPrazo = dias!==null && dias<PRAZO_DIAS;
      const status = r.orientadorEmail ? 'aguardando-orientador' : 'pendente';
      const banca=Object.assign({}, r, {
        id:uid('b'), protocolo:protocolo(db), status, foraDoPrazo, turmaNome:turmaNome(db,r.turmaId),
        checklist:{convites:false,ata:false,declaracoes:false,sala:false},
        historico:[{em:new Date().toISOString(),status,por:r.nome+' (discente)'}],
        submetidaEm:new Date().toISOString(), aprovadaEm:null, documentosEmitidos:false, documentosEmitidosEm:null, avaliador:null
      });
      db.bancas.push(banca);
      return {ok:true, banca, foraDoPrazo, status};
    },
    bancaBuscarParaCorrecao(db,d){
      const b=db.bancas.find(x=>(x.protocolo||'').toLowerCase()===(d.protocolo||'').toLowerCase()
        && soDigitos(x.matricula)===soDigitos(d.matricula));
      if(!b) return {ok:false, erro:'Protocolo não encontrado para essa matrícula.'};
      if(b.status!=='devolvida') return {ok:false, erro:'Esta solicitação não está com status "devolvida". Status atual: '+(STATUS_LABEL[b.status]||b.status)+'.'};
      return {ok:true, banca:Object.assign({}, b, {turmaNome:turmaNome(db,b.turmaId)})};
    },
    bancaCorrigir(db,d){
      const i=db.bancas.findIndex(x=>(x.protocolo||'').toLowerCase()===(d.protocolo||'').toLowerCase()
        && soDigitos(x.matricula)===soDigitos(d.matricula));
      if(i<0) return {ok:false, erro:'Solicitação não encontrada.'};
      if(db.bancas[i].status!=='devolvida') return {ok:false, erro:'Esta solicitação não está aberta para correção.'};
      const erros=validarBanca(d.registro||{}); if(erros.length) return {ok:false, erros};
      const atual=db.bancas[i];
      const dias=diasCorridosAte(d.registro.data);
      const foraDoPrazo = dias!==null && dias<PRAZO_DIAS;
      const status = d.registro.orientadorEmail ? 'aguardando-orientador' : 'pendente';
      const banca=Object.assign({}, atual, d.registro, {status, foraDoPrazo, protocolo:atual.protocolo, id:atual.id, matricula:atual.matricula});
      banca.historico=(atual.historico||[]).concat([{em:new Date().toISOString(),status,por:atual.nome+' (correção do discente)'}]);
      db.bancas[i]=banca;
      return {ok:true, banca, foraDoPrazo, status};
    },
    consultaProtocolo(db,d){
      const b=db.bancas.find(x=>(x.protocolo||'').toLowerCase()===(d.protocolo||'').toLowerCase()
        && soDigitos(x.matricula)===soDigitos(d.matricula));
      if(!b) return {ok:false, erro:'Protocolo não encontrado para essa matrícula.'};
      return {ok:true, banca:{ protocolo:b.protocolo, tipoBanca:b.tipoBanca, nome:b.nome, data:b.data, hora:b.hora,
        apresentacao:b.apresentacao, status:b.status, observacao:b.observacao||'' }};
    },
    externoSalvar(db,d){
      const dados=d.dados||{};
      if(!dados.nome || !dados.instituicao) return {ok:false, erro:'Nome e instituição são obrigatórios.'};
      const cpf=soDigitos(dados.cpf);
      if(!cpfValido(cpf)) return {ok:false, erro:'CPF inválido.'};
      const ja=db.externos.find(x=>soDigitos(x.cpf)===cpf);
      const registro=Object.assign({}, dados, {
        id: ja?ja.id:uid('ext'),
        protocolo: ja?ja.protocolo:protocolo(db,'PPEA-EXT-'),
        criadoEm: ja?ja.criadoEm:new Date().toISOString(), atualizadoEm:new Date().toISOString()
      });
      if(ja) db.externos[db.externos.indexOf(ja)]=registro; else db.externos.push(registro);
      return {ok:true, protocolo:registro.protocolo, atualizado:!!ja};
    },
    externoConsulta(db,d){
      const cpf=soDigitos(d.cpf);
      if(!cpfValido(cpf)) return {ok:false, erro:'CPF inválido.'};
      const r=db.externos.find(x=>soDigitos(x.cpf)===cpf);
      if(!r) return {ok:true, encontrado:false};
      return {ok:true, encontrado:true, nome:mascararNome(r.nome), instituicao:r.instituicao||'', programa:r.programa||'', diploma: !!r.arquivo};
    },

    /* ---- autenticados ---- */
    login(db,d){
      const senha=String(d.senha||'');
      const nome=String(d.nome||'').trim();
      if(!nome) return {ok:false, erro:'Informe seu nome.'};
      if(!CFG.SENHA_DEMO || senha!==CFG.SENHA_DEMO) return {ok:false, erro:'Senha inválida.'};
      const minutos=CFG.SESSAO_MINUTOS||60;
      const s={ token:uid('tk'), usuario:nome, papel:'tecnico', expiraEm:new Date(Date.now()+minutos*60000).toISOString() };
      Sessao.gravar(s);
      return {ok:true, token:s.token, usuario:s.usuario, papel:s.papel, expiraEm:s.expiraEm, demo:true};
    },
    logout(){ Sessao.limpar(); return {ok:true}; },
    alterarSenha(){ return {ok:false, erro:'No modo de demonstração a senha é fixa em config.js. Em produção a troca é feita no servidor.'}; },
    estado(db){
      const e=exigeSessao(); if(e) return e;
      return {ok:true, dados:{ turmas:db.turmas, alunos:db.alunos,
        bancas:db.bancas.map(b=>Object.assign({}, b, {turmaNome:turmaNome(db,b.turmaId)})),
        externos:db.externos.map(x=>Object.assign({}, x, {cpf:mascararCPF(x.cpf)})),
        usuarios:db.usuarios, lixeira:db.lixeira }};
    },
    turmaSalvar(db,d){
      const e=exigeSessao(); if(e) return e;
      const t=d.turma||{};
      if(t.id){ const i=db.turmas.findIndex(x=>x.id===t.id); if(i>-1) db.turmas[i]=Object.assign({},db.turmas[i],t); }
      else { t.id=uid('t'); if(t.ativa===undefined) t.ativa=true; db.turmas.push(t); }
      return {ok:true, turma:t};
    },
    turmaRemover(db,d){
      const e=exigeSessao(); if(e) return e;
      const i=db.turmas.findIndex(t=>t.id===d.id); if(i<0) return {ok:false, erro:'Turma não encontrada.'};
      const [t]=db.turmas.splice(i,1); t.excluidoEm=new Date().toISOString(); t.excluidoPor=operador(); db.lixeira.turmas.push(t);
      return {ok:true};
    },
    alunoSalvar(db,d){
      const e=exigeSessao(); if(e) return e;
      const a=d.aluno||{};
      if(a.id){ const i=db.alunos.findIndex(x=>x.id===a.id); if(i>-1) db.alunos[i]=Object.assign({},db.alunos[i],a); }
      else { a.id=uid('a'); if(a.ativo===undefined) a.ativo=true; db.alunos.push(a); }
      return {ok:true, aluno:a};
    },
    alunoLote(db,d){
      const e=exigeSessao(); if(e) return e;
      (d.alunos||[]).forEach(a=>{ a.id=uid('a'); if(a.ativo===undefined)a.ativo=true; db.alunos.push(a); });
      return {ok:true, total:(d.alunos||[]).length};
    },
    alunoRemover(db,d){
      const e=exigeSessao(); if(e) return e;
      const i=db.alunos.findIndex(a=>a.id===d.id); if(i<0) return {ok:false, erro:'Aluno não encontrado.'};
      const [a]=db.alunos.splice(i,1); a.excluidoEm=new Date().toISOString(); a.excluidoPor=operador(); db.lixeira.alunos.push(a);
      return {ok:true};
    },
    bancaStatus(db,d){
      const e=exigeSessao(); if(e) return e;
      const i=db.bancas.findIndex(b=>b.id===d.id); if(i<0) return {ok:false, erro:'Banca não encontrada.'};
      const b=db.bancas[i];
      b.status=d.status; b.observacao=d.observacao||b.observacao||'';
      b.historico=(b.historico||[]).concat([{em:new Date().toISOString(),status:d.status,por:operador()}]);
      if(d.status==='aprovada'){ b.aprovadaEm=new Date().toISOString(); b.avaliador=operador(); b.documentosEmitidos=false; b.documentosEmitidosEm=null; }
      if(d.status==='pendente'||d.status==='devolvida'){ b.aprovadaEm=null; }
      return {ok:true, banca:b};
    },
    bancaChecklist(db,d){
      const e=exigeSessao(); if(e) return e;
      const i=db.bancas.findIndex(b=>b.id===d.id); if(i<0) return {ok:false, erro:'Banca não encontrada.'};
      db.bancas[i].checklist=d.checklist; return {ok:true, checklist:d.checklist};
    },
    bancaDocumentos(db,d){
      const e=exigeSessao(); if(e) return e;
      const i=db.bancas.findIndex(b=>b.id===d.id); if(i<0) return {ok:false, erro:'Banca não encontrada.'};
      const b=db.bancas[i];
      b.documentosEmitidos=true; b.documentosEmitidosEm=new Date().toISOString();
      b.checklist=Object.assign({sala:false}, b.checklist||{}, {convites:true,ata:true,declaracoes:true});
      b.historico=(b.historico||[]).concat([{em:new Date().toISOString(),status:'documentos-emitidos',por:operador()}]);
      return {ok:true, banca:b};
    },
    bancaRemover(db,d){
      const e=exigeSessao(); if(e) return e;
      const i=db.bancas.findIndex(b=>b.id===d.id); if(i<0) return {ok:false, erro:'Banca não encontrada.'};
      const [b]=db.bancas.splice(i,1); b.excluidoEm=new Date().toISOString(); b.excluidoPor=operador(); db.lixeira.bancas.push(b);
      return {ok:true};
    },
    restaurar(db,d){
      const e=exigeSessao(); if(e) return e;
      const mapa={turma:'turmas',aluno:'alunos',banca:'bancas'}; const campo=mapa[d.tipo];
      if(!campo) return {ok:false, erro:'Tipo inválido.'};
      const i=db.lixeira[campo].findIndex(x=>x.id===d.id); if(i<0) return {ok:false, erro:'Item não encontrado na lixeira.'};
      const [item]=db.lixeira[campo].splice(i,1); delete item.excluidoEm; delete item.excluidoPor;
      db[campo].push(item); return {ok:true};
    },
    modelosCarregar(){
      return {ok:false, erro:'No modo de demonstração os modelos são anexados à mão. A carga automática do Drive funciona no modo de produção.'};
    },
    reiniciarDemo(){ try{ localStorage.removeItem(CHAVE); }catch(e){} semear(true); return {ok:true}; }
  };

  function executarDemo(acao, dados){
    return new Promise(resolve=>{
      setTimeout(()=>{                       // simula latência de rede
        const fn=acoes[acao];
        if(!fn) return resolve({ok:false, erro:'Ação desconhecida: '+acao});
        const db=ler();
        let r;
        try{ r=fn(db, dados||{}); }catch(err){ return resolve({ok:false, erro:'Erro interno (demo): '+err.message}); }
        grava(db);
        resolve(r);
      }, 60);
    });
  }
  return { executar: executarDemo };
})();

/* ═══════════════════════════════════════════════════════════════════
   API PÚBLICA DO MÓDULO
   ═══════════════════════════════════════════════════════════════════ */
global.DB = {
  /* configuração / diagnóstico */
  MODO, PROBLEMA, CHAVE, PRAZO_DIAS, PRAZO_DOCS_DIAS,
  TIPOS_LABEL, TIPOS_ORDEM, STATUS_LABEL, COMISSAO,
  ehDemo: ()=> MODO==='demo',
  listaAlunosPublica: ()=> CFG.LISTAR_ALUNOS_PUBLICO !== false,
  aoExpirarSessao: fn => { AVISO_SESSAO = fn; },

  /* utilitários */
  uid, diasCorridosAte, addDias, fData, fDataHora, escapeHtml, debounce, copiarTexto, soDigitos, cpfValido,
  validarBanca, statusPrazoDocumentos,

  /* sessão */
  login: (nome,senha)=> executar('login',{nome,senha}).then(j=>{
    if(j.ok && j.token) Sessao.gravar({token:j.token, usuario:j.usuario, papel:j.papel, expiraEm:j.expiraEm});
    return j;
  }),
  logout: ()=> executar('logout',{}).then(j=>{ Sessao.limpar(); return j; }),
  sessao: ()=> Sessao.ler(),
  alterarSenha: (atual,nova)=> executar('alterarSenha',{atual,nova}),

  /* leitura do painel (cache) */
  sincronizar, load, progressoTurma, todasComAlertaDocs,

  /* portal do discente (sempre servidor) */
  listarTurmas: modalidade => executar('turmasPublicas',{modalidade}),
  listarAlunos: (turmaId,q) => executar('alunosPublicos',{turmaId,q}),
  criarBanca: registro => executar('bancaCriar',{registro}),
  buscarParaCorrecao: (protocolo,matricula) => executar('bancaBuscarParaCorrecao',{protocolo,matricula}),
  corrigirBanca: (protocolo,matricula,registro) => executar('bancaCorrigir',{protocolo,matricula,registro}),
  consultarProtocolo: (protocolo,matricula) => executar('consultaProtocolo',{protocolo,matricula}),
  salvarExterno: dados => executar('externoSalvar',{dados}),
  consultarExternoPorCPF: cpf => executar('externoConsulta',{cpf}),

  /* painel da secretaria (exigem sessão válida no servidor) */
  salvarTurma: turma => executar('turmaSalvar',{turma}),
  removerTurma: id => executar('turmaRemover',{id}),
  salvarAluno: aluno => executar('alunoSalvar',{aluno}),
  salvarAlunosLote: alunos => executar('alunoLote',{alunos}),
  removerAluno: id => executar('alunoRemover',{id}),
  atualizarStatusBanca: (id,status,observacao) => executar('bancaStatus',{id,status,observacao}),
  atualizarChecklist: (id,checklist) => executar('bancaChecklist',{id,checklist}),
  marcarDocumentosEmitidos: id => executar('bancaDocumentos',{id}),
  removerBanca: id => executar('bancaRemover',{id}),
  restaurar: (tipo,id) => executar('restaurar',{tipo,id}),
  carregarModelos: () => executar('modelosCarregar',{}),
  reiniciarDemo: ()=> MODO==='demo' ? executar('reiniciarDemo',{}) : Promise.resolve({ok:false, erro:'Disponível apenas no modo de demonstração.'})
};

if(PROBLEMA && global.console) console.error('[PPEA] '+PROBLEMA);
})(window);
