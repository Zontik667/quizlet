(function(){
  'use strict';
  const $ = s => document.querySelector(s);
  const app = $('#app');
  const KEY_D = 'qz_dir_v2'; // только настройка интерфейса; модули и карточки живут в базе данных

  let view = '';      // 'modules' | 'new' | 'edit' | 'cards' | 'learn'
  let cur = null;     // текущий модуль {id,title,cards:[{t,d}]}
  let fc = {order:[], ci:0};
  let L = null;       // состояние заучивания

  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clean = s => s.replace(/\s+/g,' ').trim();
  const norm = s => s.toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();
  function shuffle(a){ a=a.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
  function plural(n){ const a=n%10,b=n%100; return n+' '+((b>10&&b<15)?'карточек':a===1?'карточка':(a>1&&a<5)?'карточки':'карточек'); }

  // ---------- API ----------
  async function serverApi(path, method, body){
    let r;
    try{
      r = await fetch('api'+path, {
        method: method||'GET',
        headers: {'Content-Type':'application/json'},
        body: body ? JSON.stringify(body) : undefined
      });
    }catch(e){ throw new Error('Нет связи с сервером. Запущен ли server.py?'); }
    if(!r.ok){
      let m='Ошибка '+r.status;
      try{ m=(await r.json()).error||m; }catch(e){}
      throw new Error(m);
    }
    return r.status===204 ? null : r.json();
  }
  function toLocal(m){ return {id:m.id, title:m.title, cards:m.cards.map(c=>({t:c.term,d:c.definition}))}; }

  // ---------- режим хранения ----------
  // 'server' — Python + SQLite (server.py).
  // 'local'  — всё в localStorage браузера: так страница работает на GitHub Pages
  //            или при открытии index.html двойным кликом (данные только в этом браузере).
  let mode = null;
  async function init(){
    if(mode) return;
    try{
      const r = await fetch('api/modules');
      const ct = r.headers.get('content-type') || '';
      mode = (r.ok && ct.includes('json')) ? 'server' : 'local';
    }catch(e){ mode = 'local'; }
  }
  const LS_KEY = 'qz_modules_v1';
  function lsRead(){
    try{ const d=JSON.parse(localStorage.getItem(LS_KEY)); if(d && Array.isArray(d.modules)) return d; }catch(e){}
    return {next:1, modules:[]};
  }
  function lsWrite(d){
    try{ localStorage.setItem(LS_KEY, JSON.stringify(d)); }
    catch(e){ throw new Error('Не удалось сохранить в браузере (хранилище недоступно или переполнено)'); }
  }
  function lsValidate(b){
    const title = clean(String((b && b.title) || ''));
    if(!title) throw new Error('Введите название модуля');
    if(title.length>200) throw new Error('Название слишком длинное (максимум 200 символов)');
    const cards = ((b && b.cards) || [])
      .map(c=>({term:clean(String(c.term||'')), definition:clean(String(c.definition||''))}))
      .filter(c=>c.term && c.definition);
    if(!cards.length) throw new Error('Не найдено ни одной корректной карточки');
    return {title, cards};
  }
  async function localApi(path, method, body){
    const m = path.match(/^\/modules(?:\/(\d+))?$/);
    if(!m) throw new Error('Не найдено');
    const id = m[1] ? +m[1] : null;
    const d = lsRead();
    const ts = new Date().toISOString();
    method = method || 'GET';
    if(id===null){
      if(method==='GET') return d.modules.slice()
        .sort((a,b)=>b.updated_at.localeCompare(a.updated_at) || b.id-a.id)
        .map(x=>({id:x.id, title:x.title, updated_at:x.updated_at, cards_count:x.cards.length}));
      if(method==='POST'){
        const v=lsValidate(body);
        const mod={id:d.next++, title:v.title, created_at:ts, updated_at:ts, cards:v.cards};
        d.modules.push(mod); lsWrite(d); return mod;
      }
    } else {
      const mod=d.modules.find(x=>x.id===id);
      if(!mod) throw new Error('Модуль не найден');
      if(method==='GET') return mod;
      if(method==='PUT'){
        const v=lsValidate(body);
        mod.title=v.title; mod.cards=v.cards; mod.updated_at=ts; lsWrite(d); return mod;
      }
      if(method==='DELETE'){ d.modules=d.modules.filter(x=>x.id!==id); lsWrite(d); return null; }
    }
    throw new Error('Метод не поддерживается');
  }
  function api(path, method, body){ return mode==='local' ? localApi(path,method,body) : serverApi(path,method,body); }

  // ---------- парсинг ----------
  function parse(text){
    const out=[], bad=[];
    text.split(/\r?\n/).forEach((line,i)=>{
      if(!line.trim()) return;
      let t,d;
      if(line.includes('\t')){ const k=line.indexOf('\t'); t=line.slice(0,k); d=line.slice(k+1); }
      else { const m=line.match(/^(.*?)\s+[-–—]\s+(.*)$/); if(m){t=m[1];d=m[2];} }
      if(t!==undefined){ t=clean(t); d=clean(d); }
      if(t&&d) out.push({t,d}); else bad.push(i+1);
    });
    return {out,bad};
  }

  // ---------- роутинг ----------
  async function route(){
    await init();
    if(L && L.timer) clearTimeout(L.timer);
    L=null;
    const h = location.hash.replace(/^#/,'') || '/';
    let m;
    if(h==='/') return viewModules();
    if(h==='/new') return viewNew();
    if((m=h.match(/^\/m\/(\d+)\/(edit|cards|learn)$/))){
      const id=+m[1], sub=m[2];
      if(!cur || cur.id!==id || sub==='edit' || sub==='cards' && view==='edit'){
        app.innerHTML='<p class="sub">Загрузка…</p>';
        try{ cur=toLocal(await api('/modules/'+id)); }catch(e){ cur=null; return showError(e); }
      }
      if(sub==='edit') return viewEdit();
      if(sub==='cards') return viewCards();
      return viewLearn();
    }
    location.hash='#/';
  }
  window.addEventListener('hashchange', route);

  function showError(e){
    view='error';
    app.innerHTML='<div class="empty"><h2>Что-то пошло не так</h2><p>'+esc(e.message)+'</p><a class="btn" href="#/">К списку модулей</a></div>';
  }

  // ---------- список модулей ----------
  async function viewModules(){
    view='modules'; cur=null;
    app.innerHTML='<p class="sub">Загрузка…</p>';
    let list;
    try{ list=await api('/modules'); }catch(e){ return showError(e); }
    app.innerHTML =
      '<div class="top"><div><h2>Мои модули</h2><p class="sub">'+(mode==='local'
        ? 'Модули хранятся в этом браузере: на другом устройстве или в другом браузере их не будет.'
        : 'Все модули и карточки хранятся в базе данных.')+'</p></div>'+
      '<a class="btn" href="#/new">+ Новый модуль</a></div>'+
      (list.length
        ? '<div class="grid">'+list.map(m=>'<a class="mod" href="#/m/'+m.id+'/cards"><div class="mt">'+esc(m.title)+'</div><div class="mc">'+plural(m.cards_count)+'</div></a>').join('')+'</div>'
        : '<div class="empty"><h2>Модулей пока нет</h2><p>Создайте первый набор карточек.</p><a class="btn" href="#/new">+ Создать модуль</a></div>');
  }

  // ---------- создание / редактирование ----------
  function editorForm(title, raw, isNew){
    return '<label class="lbl" for="title">Название модуля</label>'+
      '<input type="text" id="title" maxlength="200" placeholder="Например: Английский — Unit 5" value="'+esc(title)+'">'+
      '<label class="lbl" for="input">Карточки</label>'+
      '<p class="sub" style="margin-bottom:8px">Одна строка — одна карточка: <b>Термин [Tab] Определение</b>. Подойдёт и « - » (пробел-тире-пробел).</p>'+
      '<textarea id="input" spellcheck="false" placeholder="apple\tяблоко\nbook - книга\nto run\tбежать"></textarea>'+
      '<div class="row"><button class="btn" id="save">'+(isNew?'Создать модуль':'Сохранить изменения')+'</button>'+
      (isNew?'':'<button class="btn danger" id="del">Удалить модуль</button>')+'</div><div id="msg" class="msg hidden"></div>';
  }
  function msg(t,type){ const m=$('#msg'); m.textContent=t; m.className='msg '+type; }

  async function save(isNew){
    const title=clean($('#title').value);
    const {out,bad}=parse($('#input').value);
    if(!title) return msg('Введите название модуля','err');
    if(!out.length) return msg('Не найдено ни одной карточки. Используйте Tab или « - » между термином и определением.','err');
    const body={title, cards:out.map(c=>({term:c.t,definition:c.d}))};
    $('#save').disabled=true;
    try{
      const m = isNew ? await api('/modules','POST',body) : await api('/modules/'+cur.id,'PUT',body);
      cur=toLocal(m);
      view='';
      location.hash='#/m/'+m.id+'/cards';
      if(bad.length) setTimeout(()=>alert('Некоторые строки пропущены (нет разделителя): '+bad.join(', ')),100);
    }catch(e){ msg(e.message,'err'); $('#save').disabled=false; }
  }

  function viewNew(){
    view='new'; cur=null;
    app.innerHTML='<a class="back" href="#/">← Все модули</a><h2>Новый модуль</h2><p class="sub">Дайте название и вставьте список слов.</p>'+editorForm('','',true);
    $('#save').onclick=()=>save(true);
    $('#title').focus();
  }

  function viewEdit(){
    view='edit';
    shell('edit', editorForm(cur.title, '', false));
    $('#input').value=cur.cards.map(c=>c.t+'\t'+c.d).join('\n');
    $('#save').onclick=()=>save(false);
    $('#del').onclick=async()=>{
      if(!confirm('Удалить модуль «'+cur.title+'» вместе со всеми карточками?')) return;
      try{ await api('/modules/'+cur.id,'DELETE'); cur=null; location.hash='#/'; }
      catch(e){ msg(e.message,'err'); }
    };
  }

  function shell(active, html){
    const id=cur.id;
    const tab=(k,label)=>'<a href="#/m/'+id+'/'+k+'"'+(active===k?' class="active"':'')+'>'+label+'</a>';
    app.innerHTML='<a class="back" href="#/">← Все модули</a>'+
      '<div class="top"><div><h2>'+esc(cur.title)+'</h2><p class="sub">'+plural(cur.cards.length)+'</p></div></div>'+
      '<nav class="tabs">'+tab('cards','Карточки')+tab('learn','Заучивание')+tab('edit','Редактор')+'</nav>'+html;
  }

  // ---------- флэшкарты ----------
  function viewCards(){
    view='cards';
    fc={order:cur.cards.map((_,i)=>i), ci:0};
    shell('cards',
      '<div class="meta"><span id="counter"></span><button class="btn sec small" id="shuffle">🔀 Перемешать</button></div>'+
      '<div class="progress"><div id="cprog"></div></div>'+
      '<div class="scene" id="scene"><div class="flip" id="flip">'+
        '<div class="face"><small>Термин</small><span id="ft"></span></div>'+
        '<div class="face back"><small>Определение</small><span id="fd"></span></div></div></div>'+
      '<div class="nav"><button class="btn sec" id="prev">← Назад</button><button class="btn sec" id="flipBtn">Перевернуть</button><button class="btn" id="next">Вперёд →</button></div>'+
      '<div class="hint">Пробел / ↑ — перевернуть · ← → — листать</div>');
    $('#scene').onclick=flipCard; $('#flipBtn').onclick=flipCard;
    $('#prev').onclick=()=>moveCard(-1); $('#next').onclick=()=>moveCard(1);
    $('#shuffle').onclick=()=>{ fc.order=shuffle(cur.cards.map((_,i)=>i)); fc.ci=0; $('#flip').classList.remove('flipped'); renderCard(); };
    renderCard();
  }
  function renderCard(){
    const n=cur.cards.length, c=cur.cards[fc.order[fc.ci]];
    $('#ft').textContent=c.t; $('#fd').textContent=c.d;
    $('#counter').textContent='Карточка '+(fc.ci+1)+' из '+n;
    $('#cprog').style.width=((fc.ci+1)/n*100)+'%';
    $('#prev').disabled=fc.ci===0; $('#next').disabled=fc.ci===n-1;
  }
  function flipCard(){ const f=$('#flip'); if(f) f.classList.toggle('flipped'); }
  function moveCard(d){
    const n=fc.ci+d; if(n<0||n>=cur.cards.length) return;
    const f=$('#flip');
    if(f.classList.contains('flipped')){
      f.classList.remove('flipped');
      setTimeout(()=>{ if(view==='cards'){ fc.ci=n; renderCard(); } },180);
    } else { fc.ci=n; renderCard(); }
  }

  // ---------- заучивание ----------
  function viewLearn(){
    view='learn';
    let saved='td'; try{ saved=localStorage.getItem(KEY_D)||'td'; }catch(e){}
    shell('learn',
      '<div class="setrow">Спрашивать: <select id="dirSel">'+
      '<option value="td">Термин → Определение</option><option value="dt">Определение → Термин</option><option value="mix">Вперемешку</option></select></div>'+
      '<div id="learnArea"></div>');
    $('#dirSel').value=saved;
    $('#dirSel').onchange=()=>{ try{localStorage.setItem(KEY_D,$('#dirSel').value);}catch(e){} startLearn(); };
    startLearn();
  }

  function startLearn(){
    if(L && L.timer) clearTimeout(L.timer);
    const cards=cur.cards, n=cards.length, mode=$('#dirSel').value;
    const nA = n>=2 ? Math.max(1,Math.round(n*0.28)) : 0;   // этап A — около 28% слов
    const queue=shuffle(cards.map((_,i)=>i)).map((id,k)=>({
      id, stage:k<nA?'A':'B', retry:false,
      rev: mode==='dt' ? true : mode==='mix' ? Math.random()<.5 : false
    }));
    L={queue, idx:0, correct:0, scored:0, locked:false, timer:null};
    renderQ();
  }
  const ask=it=>{const c=cur.cards[it.id];return it.rev?c.d:c.t;};
  const ans=it=>{const c=cur.cards[it.id];return it.rev?c.t:c.d;};

  function head(it){
    const total=L.queue.length;
    const label=it.retry?'Финальная проверка':it.stage==='A'?'Этап A · Выбор ответа':'Этап B · Ввод слова';
    return '<div class="meta"><span>Вопрос '+(L.idx+1)+' из '+total+'</span><span>Верно: '+L.correct+'</span></div>'+
      '<div class="progress"><div style="width:'+(L.idx/total*100)+'%"></div></div>'+
      '<div class="qbox"><span class="stage">'+label+'</span><div class="lab">'+(it.rev?'Определение':'Термин')+'</div><div class="q" id="qtext"></div>';
  }

  function renderQ(){
    const area=$('#learnArea'); if(!area||!L) return;
    if(L.idx>=L.queue.length) return renderResult();
    const it=L.queue[L.idx]; L.locked=false; L.next=null;
    if(it.stage==='A'){
      area.innerHTML=head(it)+'</div><div class="opts" id="opts"></div>';
      $('#qtext').textContent=ask(it);
      const correct=ans(it);
      const pool=[...new Set(cur.cards.map((c,i)=>i===it.id?null:(it.rev?c.t:c.d)).filter(x=>x!==null))].filter(x=>norm(x)!==norm(correct));
      const options=shuffle([correct,...shuffle(pool).slice(0,3)]);
      options.forEach((o,k)=>{
        const b=document.createElement('button'); b.className='opt'; b.dataset.v=o;
        const kb=document.createElement('kbd'); kb.textContent=k+1;
        const sp=document.createElement('span'); sp.textContent=o;
        b.append(kb,sp); b.onclick=()=>pickOpt(b,it,correct);
        $('#opts').append(b);
      });
    } else {
      area.innerHTML=head(it)+'<input type="text" id="ans" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Введите ответ…"><div id="fb"></div></div>'+
        '<div class="row" style="justify-content:center"><button class="btn sec" id="idk">Не знаю</button><button class="btn" id="chk">Проверить</button></div>';
      $('#qtext').textContent=ask(it);
      $('#ans').focus();
      $('#chk').onclick=()=>checkTyped(it);
      $('#idk').onclick=()=>checkTyped(it,true);
    }
  }

  function record(it,ok){
    if(!it.retry){ L.scored++; if(ok) L.correct++; }
    if(!ok && it.stage==='B' && !it.retry) L.queue.push({id:it.id,stage:'B',retry:true,rev:it.rev}); // ошибка → повтор в конце
  }

  function pickOpt(btn,it,correct){
    if(!L||L.locked) return; L.locked=true;
    const ok=btn.dataset.v===correct; record(it,ok);
    document.querySelectorAll('.opt').forEach(b=>{ b.disabled=true; if(b.dataset.v===correct) b.classList.add('ok'); });
    if(!ok) btn.classList.add('bad');
    const mine=L;
    L.timer=setTimeout(()=>{ if(L!==mine) return; L.idx++; renderQ(); }, ok?450:1300);
  }

  function checkTyped(it,skip){
    if(!L||L.locked) return;
    const inp=$('#ans'), correct=ans(it);
    if(!skip && !inp.value.trim()){ inp.focus(); return; }
    L.locked=true;
    const ok=!skip && norm(inp.value)===norm(correct);
    record(it,ok);
    inp.disabled=true; inp.classList.add(ok?'ok':'bad');
    const fb=$('#fb'); fb.className='fb '+(ok?'ok':'bad');
    if(ok) fb.textContent='✓ Верно!';
    else { fb.textContent='✗ Правильно: '; const b=document.createElement('b'); b.textContent=correct; fb.append(b); }
    $('#idk').classList.add('hidden');
    const mine=L; let done=false;
    const next=()=>{ if(done||L!==mine) return; done=true; clearTimeout(mine.timer); mine.idx++; renderQ(); };
    L.next=next;
    const chk=$('#chk'); chk.textContent='Дальше →'; chk.onclick=next; chk.focus();
    if(ok) L.timer=setTimeout(next,700);
  }

  function renderResult(){
    const pct=L.scored?Math.round(L.correct/L.scored*100):0;
    const t=pct>=90?'Отлично! 🎉':pct>=70?'Хороший результат! 👍':pct>=50?'Неплохо, но стоит повторить.':'Нужно ещё потренироваться 💪';
    $('#learnArea').innerHTML='<div class="progress"><div style="width:100%"></div></div><div class="result"><div class="pct">'+pct+'%</div><p>'+t+
      '<br>Правильно с первой попытки: '+L.correct+' из '+L.scored+'</p><button class="btn" id="again">Пройти заново</button></div>';
    $('#again').onclick=startLearn;
  }

  // ---------- клавиатура ----------
  document.addEventListener('keydown',e=>{
    const tag=(e.target.tagName||'').toLowerCase();
    if(view==='cards' && cur && tag!=='textarea' && tag!=='input' && tag!=='select'){
      if(e.code==='Space'||e.key==='ArrowUp'){e.preventDefault();flipCard();}
      else if(e.key==='ArrowLeft') moveCard(-1);
      else if(e.key==='ArrowRight') moveCard(1);
    }
    if(view==='learn' && L && L.idx<L.queue.length){
      const it=L.queue[L.idx];
      if(it.stage==='A' && /^[1-4]$/.test(e.key)){
        const b=document.querySelectorAll('.opt')[+e.key-1]; if(b&&!L.locked) b.click();
      } else if(it.stage==='B' && e.key==='Enter'){
        e.preventDefault();
        if(!L.locked) checkTyped(it); else if(L.next) L.next();
      }
    }
  });

  route();
})();
