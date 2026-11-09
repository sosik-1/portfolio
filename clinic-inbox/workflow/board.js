// [n8n Code 노드] 상담 대장(CSV)을 읽어 상담실장이 보는 화면(HTML)을 만들어요
// 디자인(CSS)은 시안 화면(design/template.html)과 같은 것을 build.mjs가 style 칸에 넣어요.
// 이 화면은 병원 안 PC에서만 열어요.
const buf = await this.helpers.getBinaryDataBuffer(0, "data");
const text = buf.toString("utf8").replace(/^﻿/, "");

// CSV 읽기 (따옴표 안의 쉼표·따옴표·줄바꿈 처리)
function parseCsv(s) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1);
}
const [head, ...body] = parseCsv(text);
const rows = body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ""])));
const data = JSON.stringify(rows).replace(/</g, "\\u003c");

const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>상담 문의함 · 샘플성형외과(예시)</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&family=Hahmlet:wght@600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>__CSS__
.work{min-height:560px}
</style></head><body>
<div class="app">
  <aside class="rail" aria-label="메뉴">
    <div class="brand">
      <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="9" fill="var(--accent)"/><path d="M11 21.5c1.2 1.3 3 2 5.2 2 2.9 0 4.8-1.4 4.8-3.6 0-4.6-9.4-2.6-9.4-7.1 0-2 1.8-3.4 4.4-3.4 1.9 0 3.4.6 4.4 1.6" fill="none" stroke="var(--accent-ink)" stroke-width="2.2" stroke-linecap="round"/></svg>
      <div><b>샘플성형외과(예시)</b><small>상담실 업무 화면</small></div>
    </div>
    <nav class="nav" aria-label="문의 거르기">
      <h4>문의함</h4>
      <button type="button" data-f="all" aria-pressed="true"><span class="dot"></span>받은 문의<span class="count" id="c-all"></span></button>
      <button type="button" data-f="urgent" class="u" aria-pressed="false"><span class="dot" style="background:var(--urgent)"></span>긴급 · 간호팀<span class="count" id="c-urgent"></span></button>
      <button type="button" data-f="warn" aria-pressed="false"><span class="dot" style="background:var(--warn)"></span>주의 표시<span class="count" id="c-warn"></span></button>
      <button type="button" data-f="miss" aria-pressed="false"><span class="dot" style="background:var(--accent)"></span>빠진 정보 있음<span class="count" id="c-miss"></span></button>
    </nav>
    <div class="chlist" id="chlist"></div>
    <div class="me"><div class="avatar">상</div><div><b>상담실장</b><small>n8n 상담 대장 연결</small></div></div>
  </aside>
  <main class="main">
    <header class="topbar">
      <h1>받은 문의</h1><span class="date" id="today"></span>
      <label class="search" for="q"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        <input id="q" type="search" placeholder="접수번호·이름·내용 찾기"></label>
      <button class="btn primary" type="button" onclick="location.reload()">새로 고침</button>
    </header>
    <section class="kpis" id="kpis"></section>
    <section class="work">
      <div class="list"><div class="listhead"><h2 id="listTitle">받은 문의</h2><small>긴급 먼저 · 최근 순</small></div><div class="rows" id="rows"></div></div>
      <div class="detail" id="detail" aria-live="polite"></div>
    </section>
    <section class="dash"><div class="card" style="grid-column:1/-1"><h2>문의 현황</h2><p class="sub">상담 대장 전체 기준</p>
      <div class="split"><div class="bars" id="byProc"></div><div class="bars" id="byCh"></div></div></div></section>
    <footer>n8n이 모은 상담 대장(records/상담대장.csv)을 그대로 보여 줘요. 답변 초안은 상담실장이 검토한 뒤 보내요. AI는 의학적 판단을 하지 않고, 수술 후 증상은 간호팀에 알리는 데까지만 해요.</footer>
  </main>
</div>
<script>
const ROWS=${data};
const CH_COLOR={"카카오톡":"#e0b400","인스타 DM":"#c13584","네이버 톡톡":"#03a94d","홈페이지":"#64748b"};
const IC='<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v5M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const chc=c=>CH_COLOR[c]||"#94a3b8";
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const num=id=>Number(String(id).replace(/\\D/g,""))||0;
const isU=r=>r["급한 정도"]==="긴급", isW=r=>!!(r["광고 주의"]||/주민번호/.test(r["비고"]));
ROWS.sort((a,b)=>isU(a)!==isU(b)?(isU(a)?-1:1):num(b["접수번호"])-num(a["접수번호"]));
// 주소 끝에 #R-1063 처럼 접수번호를 붙이면 그 문의를 바로 열어요 (알림에서 바로 들어올 때)
const want=decodeURIComponent(location.hash.slice(1));
const st={f:"all",q:"",sel:(ROWS.find(r=>r["접수번호"]===want)||ROWS[0]||{})["접수번호"]};
const pill=u=>u==="긴급"?'<span class="pill p-u">긴급</span>':u==="보통"?'<span class="pill p-m">보통</span>':'<span class="pill p-l">'+esc(u||"-")+'</span>';
// 원문에서 AI로 보낼 때 가린 부분을 노랗게 표시 (대조표 '가린 정보'를 보고 찾음)
const marked=(o,mj)=>{let m=[];try{m=JSON.parse(mj||"[]")}catch(e){}
  m.sort((a,b)=>b[1].length-a[1].length);
  const S=String.fromCharCode(1),E=String.fromCharCode(2);let t=String(o);
  m.forEach((e,k)=>{t=t.split(e[1]).join(S+k+E)});
  t=esc(t);
  m.forEach((e,k)=>{t=t.split(S+k+E).join('<mark title="AI에는 '+esc(e[0])+'(으)로 보냈어요">'+esc(e[1])+'</mark>')});
  return t.split('[주민번호]').join('<span class="tag">[주민번호]</span>');};
const tagged=s=>esc(s).replace(/\\[(?:환자|연락처|이메일|계정)\\d+\\]|\\[주민번호\\]/g,m=>'<span class="tag">'+m+'</span>');
function pass(r){ if(st.f==="urgent"&&!isU(r))return false; if(st.f==="warn"&&!isW(r))return false; if(st.f==="miss"&&!r["빠진 정보"])return false;
  return !st.q||Object.values(r).join(" ").includes(st.q); }
function render(){
  const c={all:ROWS.length,urgent:ROWS.filter(isU).length,warn:ROWS.filter(isW).length,miss:ROWS.filter(r=>r["빠진 정보"]).length};
  Object.entries(c).forEach(([k,v])=>document.getElementById("c-"+k).textContent=v);
  const ch={};ROWS.forEach(r=>ch[r["채널"]]=(ch[r["채널"]]||0)+1);
  document.getElementById("chlist").innerHTML='<h4>채널</h4>'+Object.keys(ch).map(k=>'<div><span class="chdot" style="background:'+chc(k)+'"></span><span>'+esc(k)+'</span><span>'+ch[k]+'</span></div>').join("");
  document.getElementById("kpis").innerHTML='<div class="kpi"><small>받은 문의</small><b>'+c.all+'</b><em>상담 대장 전체</em></div><div class="kpi u"><small>긴급 · 간호팀 알림</small><b>'+c.urgent+'</b><em>수술 후 증상</em></div><div class="kpi w"><small>주의 표시</small><b>'+c.warn+'</b><em>의료광고 · 민감정보</em></div><div class="kpi"><small>빠진 정보 있음</small><b>'+c.miss+'</b><em>손님께 더 물어볼 것</em></div>';
  const list=ROWS.filter(pass);
  document.getElementById("listTitle").textContent={all:"받은 문의",urgent:"긴급 · 간호팀",warn:"주의 표시",miss:"빠진 정보 있음"}[st.f]+" "+list.length+"건";
  document.getElementById("rows").innerHTML=list.map(r=>{const id=r["접수번호"];
    return '<button type="button" class="row '+(id===st.sel?"sel ":"")+(isU(r)?"urgent":isW(r)?"warn":"")+'" data-id="'+esc(id)+'"><div class="l1"><span class="mono">'+esc(id)+'</span><span class="chdot" style="background:'+chc(r["채널"])+'"></span><span>'+esc(r["채널"])+' · '+esc(r["이름"]||"이름 없음")+'</span><span class="time mono">'+esc(r["접수시각"].slice(5))+'</span></div><div class="sum">'+esc(r["요약"])+'</div><div class="l3">'+pill(r["급한 정도"])+(r["광고 주의"]?'<span class="pill p-w">광고 주의</span>':'')+(/주민번호/.test(r["비고"])?'<span class="pill p-w">민감정보</span>':'')+'<span class="soft">'+esc(r["시술"])+'</span></div></button>';}).join("")||'<div class="empty">조건에 맞는 문의가 없어요.</div>';
  const r=ROWS.find(x=>x["접수번호"]===st.sel), d=document.getElementById("detail");
  if(!r){d.innerHTML='<div class="empty">아직 들어온 문의가 없어요.</div>';}
  else{
    let al="";
    if(isU(r)) al+='<div class="alert u">'+IC+'<div><b>긴급 · 간호팀에 알렸어요</b>수술 후 증상 문의예요. AI는 증상을 판단하지 않아요. 간호팀이 직접 전화로 확인해 주세요.</div></div>';
    if(r["광고 주의"]) al+='<div class="alert w">'+IC+'<div><b>의료광고 '+esc(r["광고 주의"])+'</b>전후 사진·할인 약속은 메신저로 하지 말고 내원 상담으로 안내해 주세요.</div></div>';
    if(r["비고"]) al+='<div class="alert w">'+IC+'<div><b>확인할 것</b>'+esc(r["비고"])+'</div></div>';
    d.innerHTML='<div class="dhead"><div><span class="idchip">'+esc(r["접수번호"])+'</span><h2>'+esc(r["요약"])+'</h2><div class="meta"><span><span class="chdot" style="display:inline-block;margin-right:6px;background:'+chc(r["채널"])+'"></span>'+esc(r["채널"])+'</span><span>'+esc(r["접수시각"])+' 접수</span><span>'+esc(r["이름"]||"이름 없음")+' '+esc(r["연락처"])+'</span></div></div><div class="right">'+pill(r["급한 정도"])+'<span class="pill p-l">담당 '+esc(r["담당 부서"])+'</span></div></div>'+al
      +(r["문의 원문"]
        ? '<div class="sect"><h3><span class="n">1</span>문의 원문</h3><div class="textbox">'+marked(r["문의 원문"],r["가린 정보"])+'</div><div class="cap"><mark>노란 부분</mark>은 가려서 AI에 보냈어요. AI는 [환자1] 같은 표시만 받았어요. 주민번호는 병원 안에서도 가려 둬요.</div><details><summary>AI에는 이렇게 보냈어요</summary><div class="textbox ai" style="margin-top:6px">'+tagged(r["가린 문의 내용"])+'</div></details></div>'
        : '<div class="sect"><h3><span class="n">1</span>문의 내용</h3><div class="textbox ai">'+tagged(r["가린 문의 내용"])+'</div><div class="cap">원문을 저장하기 전에 들어온 문의라 가린 글만 남아 있어요.</div></div>')
      +'<div class="sect"><h3><span class="n">2</span>AI 분류 결과</h3><div class="facts"><div><small>시술 종류</small><b>'+esc(r["시술"])+'</b></div><div><small>문의 종류</small><b>'+esc(r["문의 종류"])+'</b></div><div><small>급한 정도</small><b>'+pill(r["급한 정도"])+'</b></div><div><small>담당 부서</small><b>'+esc(r["담당 부서"])+'</b></div><div><small>빠진 정보</small><b class="'+(r["빠진 정보"]?"miss":"")+'">'+esc(r["빠진 정보"]||"없음")+'</b></div></div></div>'
      +'<div class="sect"><h3><span class="n">3</span>답변 초안 · 상담실장 검토 후 발송</h3><div class="editor"><div class="bar"><span class="pill p-m">AI 초안</span>고쳐서 쓰세요. 이 화면에서 보내지는 않아요</div><textarea id="draft" aria-label="답변 초안">'+esc(r["답변 초안"])+'</textarea><div class="foot"><span class="note">상태: '+esc(r["상태"])+'</span><button type="button" class="btn primary" id="copy">초안 복사</button></div></div></div>';
    document.getElementById("copy").onclick=async e=>{try{await navigator.clipboard.writeText(document.getElementById("draft").value);e.target.textContent="복사했어요";}catch{e.target.textContent="복사가 막혔어요";}};
  }
  const bars=(id,k,t)=>{const c={};ROWS.forEach(r=>c[r[k]]=(c[r[k]]||0)+1);const e=Object.entries(c).sort((a,b)=>b[1]-a[1]),m=Math.max(1,...e.map(x=>x[1]));
    document.getElementById(id).innerHTML='<small style="color:var(--muted);font-size:12px">'+t+'</small>'+e.map(([n,v])=>'<div class="bar"><span>'+esc(n)+'</span><span class="t"><i style="width:'+(v/m*100)+'%'+(k==="채널"?';background:'+chc(n):'')+'"></i></span><b>'+v+'</b></div>').join("");};
  bars("byProc","시술","시술별"); bars("byCh","채널","채널별");
}
document.querySelectorAll(".nav button").forEach(b=>b.onclick=()=>{st.f=b.dataset.f;document.querySelectorAll(".nav button").forEach(x=>x.setAttribute("aria-pressed",x===b));render();});
document.getElementById("rows").addEventListener("click",e=>{const b=e.target.closest("[data-id]");if(b){st.sel=b.dataset.id;render();}});
document.getElementById("q").oninput=e=>{st.q=e.target.value;render();};
document.getElementById("today").textContent=new Date().toLocaleDateString("ko-KR",{month:"long",day:"numeric",weekday:"short"});
render();
</script></body></html>`;
return [{ json: { html } }];
