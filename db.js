/* ═══════════════════════════════════════════════════════════════════════
   PPEA · Camada de dados unificada (Versão visual)
   ---------------------------------------------------------------------
   Este arquivo simula, em localStorage, a mesma "fonte única de dados"
   que hoje vive na planilha/Apps Script. Todas as páginas (aluno.html,
   secretaria.html) importam este script e leem/gravam por aqui — por
   isso uma marcação de banca feita pelo aluno já aparece no painel da
   secretaria sem recarregar nada manualmente.

   Para plugar no backend real (Google Apps Script, API própria etc.):
   troque o corpo das funções de leitura/escrita (DB.load/DB.save e as
   funções de ação abaixo) por chamadas fetch(API_URL,...) mantendo os
   MESMOS nomes e formatos de retorno. O resto do front-end não precisa
   mudar.
   ═══════════════════════════════════════════════════════════════════════ */
(function(global){
  const CHAVE = 'ppea_sistema_v1';
  const PRAZO_DIAS = 15;        // antecedência mínima p/ marcar banca
  const PRAZO_DOCS_DIAS = 2;    // prazo p/ emitir e enviar documentos após aprovação

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

  function uid(p){ return (p||'id')+'_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
  function hoje(){ const d=new Date(); d.setHours(0,0,0,0); return d; }
  function diasCorridosAte(dataStr){ if(!dataStr) return null; const alvo=new Date(dataStr+'T00:00:00'); return Math.round((alvo-hoje())/86400000); }
  function addDias(iso,n){ const d=new Date(iso); d.setDate(d.getDate()+n); return d.toISOString(); }
  function fData(s){ if(!s) return '—'; const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m?(m[3]+'/'+m[2]+'/'+m[1]):s; }
  function fDataHora(iso){ try{ return new Date(iso).toLocaleString('pt-BR'); }catch(e){ return iso||''; } }
  function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  /* ---------------- Persistência ---------------- */
  function vazio(){
    return { turmas:[], alunos:[], bancas:[], externos:[], usuarios:[
        {nome:'Secretaria PPEA', papel:'tecnico', senha:'ppea2026'},
        {nome:'Coordenação', papel:'professor', senha:'ppea2026'}
      ], lixeira:{turmas:[],alunos:[],bancas:[]}, seq:1 };
  }
  function load(){
    try{
      const raw=localStorage.getItem(CHAVE);
      if(!raw) return semear();
      const db=JSON.parse(raw);
      db.turmas=db.turmas||[]; db.alunos=db.alunos||[]; db.bancas=db.bancas||[]; db.externos=db.externos||[];
      db.usuarios=db.usuarios||vazio().usuarios; db.lixeira=db.lixeira||{turmas:[],alunos:[],bancas:[]};
      return db;
    }catch(e){ return semear(); }
  }
  function save(db){ localStorage.setItem(CHAVE, JSON.stringify(db)); }
  function reset(){ localStorage.removeItem(CHAVE); return semear(true); }

  /* ---------------- Dados de demonstração ---------------- */
  function semear(force){
    if(!force){ const existente=localStorage.getItem(CHAVE); if(existente) return JSON.parse(existente); }
    const db=vazio();
    const tM1={id:uid('t'),nome:'MPEA 2025.1',modalidade:'mestrado',ativa:true};
    const tM2={id:uid('t'),nome:'MPEA 2024.2',modalidade:'mestrado',ativa:true};
    const tD1={id:uid('t'),nome:'DPEA 2024.1',modalidade:'doutorado',ativa:true};
    db.turmas.push(tM1,tM2,tD1);

    const alunosSeed=[
      {nome:'Ana Beatriz Coutinho', turma:tM1, orientador:'Profa. Dra. Sandra Meireles'},
      {nome:'Carlos Eduardo Rangel', turma:tM1, orientador:'Prof. Dr. Marcelo Andrade'},
      {nome:'Fernanda Lopes Vianna', turma:tM1, orientador:'Profa. Dra. Sandra Meireles'},
      {nome:'Juliana Peixoto Farias', turma:tM2, orientador:'Prof. Dr. Ricardo Nogueira'},
      {nome:'Marcos Vinícius Tavares', turma:tM2, orientador:'Profa. Dra. Helena Duarte'},
      {nome:'Patrícia Gomes Albuquerque', turma:tD1, orientador:'Prof. Dr. André Bittencourt'},
      {nome:'Rodrigo Salgado Neves', turma:tD1, orientador:'Profa. Dra. Helena Duarte'},
      {nome:'Vanessa Ribeiro Castro', turma:tD1, orientador:'Prof. Dr. André Bittencourt'}
    ].map((a,i)=>({ id:uid('a'), nome:a.nome, matricula:'2025'+String(100+i), turmaId:a.turma.id,
      orientador:a.orientador, coorientador:'', email:'aluno'+(i+1)+'@id.uff.br', ativo:true }));
    db.alunos.push(...alunosSeed);

    function novaBanca(aluno,turma,tipo,statusInfo,offsetDiasData){
      const d=new Date(); d.setDate(d.getDate()+(offsetDiasData||20));
      const dataStr=d.toISOString().slice(0,10);
      db.seq++;
      const banca={
        id:uid('b'), protocolo:'PPEA-2026-'+String(db.seq).padStart(4,'0'),
        alunoId:aluno.id, turmaId:turma.id, modalidade:turma.modalidade, tipoBanca:tipo,
        nome:aluno.nome, matricula:aluno.matricula, orientador:aluno.orientador, coorientador:aluno.coorientador,
        orientadorEmail:'', titulo:'estudo sobre práticas assistenciais em enfermagem',
        email:aluno.email, data:dataStr, hora:'14:00', local:'Sala 302 / Google Meet', apresentacao:'misto',
        artigos:'', comissao: COMISSAO[turma.modalidade].map((l,i)=>({ papel:l.role, nome:i<2?('Membro Exemplo '+(i+1)):'', ppg:i===0?'PPEA/UFF':'', instituicao:l.inst, email:'' })),
        status:statusInfo.status, foraDoPrazo:!!statusInfo.foraDoPrazo, observacao:statusInfo.observacao||'',
        checklist:{convites:false,ata:false,declaracoes:false,sala:false},
        historico:[{em:new Date().toISOString(),status:statusInfo.status,por:'Sistema (demo)'}],
        submetidaEm:new Date().toISOString(), aprovadaEm:statusInfo.aprovadaEm||null,
        documentosEmitidos:false, documentosEmitidosEm:null, avaliador:statusInfo.avaliador||null
      };
      db.bancas.push(banca);
      return banca;
    }
    // aprovada há 3 dias -> atrasada para emissão de documentos (>2 dias)
    novaBanca(alunosSeed[0],tM1,'defesa-projeto',{status:'aprovada',aprovadaEm:addDias(new Date().toISOString(),-3),avaliador:'Coordenação'},30);
    // aprovada ontem -> ainda dentro do prazo, mas alerta amarelo
    novaBanca(alunosSeed[1],tM1,'qualificacao',{status:'aprovada',aprovadaEm:addDias(new Date().toISOString(),-1),avaliador:'Coordenação'},25);
    // pendente dentro do prazo
    novaBanca(alunosSeed[2],tM1,'defesa-projeto',{status:'pendente'},22);
    // pendente fora do prazo (menos de 15 dias)
    novaBanca(alunosSeed[3],tM2,'qualificacao',{status:'pendente',foraDoPrazo:true},6);
    // devolvida (não aprovada) com observação
    novaBanca(alunosSeed[4],tM2,'defesa-projeto',{status:'devolvida',observacao:'Falta indicar o segundo suplente interno e confirmar e-mail do 1º examinador.'},18);
    // aguardando orientador
    const bAg=novaBanca(alunosSeed[5],tD1,'defesa-projeto',{status:'aguardando-orientador'},19); bAg.orientadorEmail='andre.bittencourt@id.uff.br';
    // realizada (fluxo completo)
    novaBanca(alunosSeed[6],tD1,'defesa-projeto',{status:'realizada',aprovadaEm:addDias(new Date().toISOString(),-40),avaliador:'Coordenação'},-30);
    // uma banca de doutorado aprovada, documentos já emitidos (para mostrar estado "em dia")
    const bOk=novaBanca(alunosSeed[7],tD1,'defesa-projeto',{status:'aprovada',aprovadaEm:addDias(new Date().toISOString(),-1),avaliador:'Coordenação'},20);
    bOk.documentosEmitidos=true; bOk.documentosEmitidosEm=new Date().toISOString(); bOk.checklist={convites:true,ata:true,declaracoes:true,sala:true};

    save(db);
    return db;
  }

  /* ---------------- Regras de prazo de documentos ---------------- */
  // retorna {pendente, venceEm(iso), diasRestantes, atrasado}
  function statusPrazoDocumentos(banca){
    if(banca.status!=='aprovada' || banca.documentosEmitidos || !banca.aprovadaEm) return null;
    const venceEm = addDias(banca.aprovadaEm, PRAZO_DOCS_DIAS);
    const diff = Math.ceil((new Date(venceEm) - new Date()) / 86400000);
    return { pendente:true, venceEm, diasRestantes:diff, atrasado: diff<0 };
  }

  /* ---------------- Ações: Turmas ---------------- */
  function listarTurmas(modalidade){ const db=load(); return db.turmas.filter(t=>t.ativa && (!modalidade||t.modalidade===modalidade)); }
  function salvarTurma(turma){
    const db=load();
    if(turma.id){ const i=db.turmas.findIndex(t=>t.id===turma.id); if(i>-1) db.turmas[i]=Object.assign({},db.turmas[i],turma); }
    else { turma.id=uid('t'); if(turma.ativa===undefined) turma.ativa=true; db.turmas.push(turma); }
    save(db); return turma;
  }
  function removerTurma(id){ const db=load(); const i=db.turmas.findIndex(t=>t.id===id); if(i>-1){ const [t]=db.turmas.splice(i,1); t.excluidoEm=new Date().toISOString(); db.lixeira.turmas.push(t); save(db); } }

  /* ---------------- Ações: Alunos ---------------- */
  function listarAlunos(turmaId){ const db=load(); return db.alunos.filter(a=>a.ativo && (!turmaId||a.turmaId===turmaId)); }
  function salvarAluno(aluno){
    const db=load();
    if(aluno.id){ const i=db.alunos.findIndex(a=>a.id===aluno.id); if(i>-1) db.alunos[i]=Object.assign({},db.alunos[i],aluno); }
    else { aluno.id=uid('a'); if(aluno.ativo===undefined) aluno.ativo=true; db.alunos.push(aluno); }
    save(db); return aluno;
  }
  function salvarAlunosLote(alunos){ const db=load(); alunos.forEach(a=>{ a.id=uid('a'); if(a.ativo===undefined)a.ativo=true; db.alunos.push(a); }); save(db); }
  function removerAluno(id){ const db=load(); const i=db.alunos.findIndex(a=>a.id===id); if(i>-1){ const [a]=db.alunos.splice(i,1); a.excluidoEm=new Date().toISOString(); db.lixeira.alunos.push(a); save(db); } }

  /* ---------------- Ações: Bancas ---------------- */
  function proximoProtocolo(db){ db.seq=(db.seq||0)+1; return 'PPEA-'+new Date().getFullYear()+'-'+String(db.seq).padStart(4,'0'); }
  function validarBanca(registro){
    const erros=[];
    if(!registro.nome) erros.push('Informe o nome do discente.');
    if(!registro.orientador) erros.push('Informe o orientador.');
    if(!registro.titulo) erros.push('Informe o título do trabalho.');
    if(!registro.email) erros.push('Informe o e-mail institucional do discente.');
    if(!registro.data) erros.push('Informe a data agendada.');
    if(!registro.hora) erros.push('Informe a hora.');
    if(!registro.apresentacao) erros.push('Selecione a modalidade de apresentação.');
    const min = registro.modalidade==='doutorado'?7:5;
    const preenchidos=(registro.comissao||[]).filter(m=>m.nome&&m.nome.trim()).length;
    if(preenchidos<min) erros.push('A comissão de '+(registro.modalidade==='doutorado'?'Doutorado exige 7':'Mestrado exige 5')+' membros preenchidos (você preencheu '+preenchidos+').');
    return erros;
  }
  function criarBanca(registro){
    const erros=validarBanca(registro);
    if(erros.length) return {ok:false, erros};
    const db=load();
    const dias=diasCorridosAte(registro.data);
    const foraDoPrazo = dias!==null && dias<PRAZO_DIAS;
    const status = registro.orientadorEmail ? 'aguardando-orientador' : 'pendente';
    const banca=Object.assign({}, registro, {
      id:uid('b'), protocolo:proximoProtocolo(db), status, foraDoPrazo,
      checklist:{convites:false,ata:false,declaracoes:false,sala:false},
      historico:[{em:new Date().toISOString(),status,por:registro.nome+' (discente)'}],
      submetidaEm:new Date().toISOString(), aprovadaEm:null, documentosEmitidos:false, documentosEmitidosEm:null, avaliador:null
    });
    db.bancas.push(banca); save(db);
    return {ok:true, banca, foraDoPrazo, status};
  }
  function corrigirBanca(bancaId, registro){
    const db=load(); const i=db.bancas.findIndex(b=>b.id===bancaId); if(i<0) return {ok:false, erro:'Solicitação não encontrada.'};
    const erros=validarBanca(registro); if(erros.length) return {ok:false, erros};
    const dias=diasCorridosAte(registro.data); const foraDoPrazo = dias!==null && dias<PRAZO_DIAS;
    const status = registro.orientadorEmail ? 'aguardando-orientador' : 'pendente';
    const atual=db.bancas[i];
    const banca=Object.assign({}, atual, registro, { status, foraDoPrazo, protocolo:atual.protocolo, id:atual.id });
    banca.historico=(atual.historico||[]).concat([{em:new Date().toISOString(),status,por:registro.nome+' (correção do discente)'}]);
    db.bancas[i]=banca; save(db);
    return {ok:true, banca, foraDoPrazo, status};
  }
  function buscarPorToken(bancaId){ const db=load(); return db.bancas.find(b=>b.id===bancaId)||null; }
  function buscarPorProtocolo(numero){ const db=load(); return db.bancas.find(b=>(b.protocolo||'').toLowerCase()===(numero||'').toLowerCase())||null; }

  function atualizarStatusBanca(id, status, observacao, avaliador){
    const db=load(); const i=db.bancas.findIndex(b=>b.id===id); if(i<0) return {ok:false, erro:'Banca não encontrada.'};
    const b=db.bancas[i];
    b.status=status; b.observacao=observacao||b.observacao||'';
    b.historico=(b.historico||[]).concat([{em:new Date().toISOString(),status,por:avaliador||'Avaliador'}]);
    if(status==='aprovada'){ b.aprovadaEm=new Date().toISOString(); b.avaliador=avaliador||b.avaliador||''; b.documentosEmitidos=false; b.documentosEmitidosEm=null; }
    if(status==='pendente'||status==='devolvida'){ b.aprovadaEm=null; }
    save(db); return {ok:true, banca:b};
  }
  function atualizarChecklist(id, checklist){
    const db=load(); const i=db.bancas.findIndex(b=>b.id===id); if(i<0) return {ok:false};
    db.bancas[i].checklist=checklist; save(db); return {ok:true, checklist};
  }
  function marcarDocumentosEmitidos(id, avaliador){
    const db=load(); const i=db.bancas.findIndex(b=>b.id===id); if(i<0) return {ok:false};
    const b=db.bancas[i];
    b.documentosEmitidos=true; b.documentosEmitidosEm=new Date().toISOString();
    b.checklist=Object.assign({convites:true,ata:true,declaracoes:true,sala:b.checklist?b.checklist.sala:false}, {convites:true,ata:true,declaracoes:true});
    b.historico=(b.historico||[]).concat([{em:new Date().toISOString(),status:'documentos-emitidos',por:avaliador||'Secretaria'}]);
    save(db); return {ok:true, banca:b};
  }
  function removerBanca(id){ const db=load(); const i=db.bancas.findIndex(b=>b.id===id); if(i>-1){ const [b]=db.bancas.splice(i,1); b.excluidoEm=new Date().toISOString(); db.lixeira.bancas.push(b); save(db); } }

  /* ---------------- Ações: Externos ---------------- */
  function salvarExterno(dados){
    const db=load(); db.seq=(db.seq||0)+1;
    const registro=Object.assign({}, dados, { id:uid('ext'), protocolo:'PPEA-EXT-'+String(db.seq).padStart(4,'0'), criadoEm:new Date().toISOString() });
    db.externos.push(registro); save(db); return {ok:true, protocolo:registro.protocolo};
  }
  function consultarExternoPorCPF(cpf){
    const db=load(); const digits=s=>String(s||'').replace(/\D/g,'');
    const r=db.externos.find(x=>digits(x.cpf)===digits(cpf));
    return r ? {encontrado:true, nome:r.nome, instituicao:r.instituicao, programa:r.programa, diplomaUrl: r.arquivo? '#' : null} : {encontrado:false};
  }

  /* ---------------- Login (demo) ---------------- */
  function login(nome, senha){
    const db=load();
    const u=db.usuarios.find(x=>x.senha===senha);
    if(!u) return {ok:false, erro:'Senha inválida.'};
    return {ok:true, usuario: nome && nome.trim() ? nome.trim() : u.nome, papel:u.papel};
  }
  function alterarSenha(senhaAtual, novaSenha){
    const db=load(); const u=db.usuarios.find(x=>x.senha===senhaAtual);
    if(!u) return {ok:false, erro:'Senha atual incorreta.'};
    u.senha=novaSenha; save(db); return {ok:true};
  }

  /* ---------------- Lixeira ---------------- */
  function restaurar(tipo,id){
    const db=load(); const mapa={turma:'turmas',aluno:'alunos',banca:'bancas'}; const campo=mapa[tipo]; if(!campo) return {ok:false};
    const idx=db.lixeira[campo].findIndex(x=>x.id===id); if(idx<0) return {ok:false};
    const [item]=db.lixeira[campo].splice(idx,1); delete item.excluidoEm;
    db[campo].push(item); save(db); return {ok:true};
  }

  /* ---------------- Agregações usadas pelos painéis ---------------- */
  function progressoTurma(turmaId){
    const db=load();
    const alunos=db.alunos.filter(a=>a.turmaId===turmaId&&a.ativo);
    const bancas=db.bancas.filter(b=>b.turmaId===turmaId);
    const concluiu=b=>b&&(b.status==='aprovada'||b.status==='realizada');
    let completos=0, pendentesAcao=0, alertasDocs=0;
    alunos.forEach(al=>{
      let n=0;
      TIPOS_ORDEM.forEach(tp=>{
        const b=bancas.find(x=>x.alunoId===al.id&&x.tipoBanca===tp);
        if(b){
          if(concluiu(b)) n++;
          if(b.status==='pendente') pendentesAcao++;
          const pz=statusPrazoDocumentos(b); if(pz) alertasDocs++;
        }
      });
      if(n===3) completos++;
    });
    return { totalAlunos:alunos.length, completos, pendentesAcao, alertasDocs };
  }
  function todasComAlertaDocs(){
    const db=load();
    return db.bancas.map(b=>({banca:b, prazo:statusPrazoDocumentos(b)})).filter(x=>x.prazo);
  }

  global.DB = {
    CHAVE, PRAZO_DIAS, PRAZO_DOCS_DIAS, TIPOS_LABEL, TIPOS_ORDEM, STATUS_LABEL, COMISSAO,
    uid, diasCorridosAte, addDias, fData, fDataHora, escapeHtml,
    load, save, reset,
    listarTurmas, salvarTurma, removerTurma,
    listarAlunos, salvarAluno, salvarAlunosLote, removerAluno,
    criarBanca, corrigirBanca, buscarPorToken, buscarPorProtocolo,
    atualizarStatusBanca, atualizarChecklist, marcarDocumentosEmitidos, removerBanca,
    salvarExterno, consultarExternoPorCPF,
    login, alterarSenha, restaurar,
    statusPrazoDocumentos, progressoTurma, todasComAlertaDocs
  };
})(window);
