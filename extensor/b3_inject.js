// Mundo MAIN (só na Bet365): lê as RESPOSTAS de /sportshistoryapi/summary e
// /sportshistoryapi/confirmation (formato texto proprietário `F|00;chave=valor;…|01;…|`) que
// a própria página baixa, e repassa objetos limpos ao content script — para tratar igual às
// outras casas passivas (Betfair/Pinnacle).
//
// SÓ PASSIVO — POR QUE NÃO HÁ REPLAY: até a v0.6.2 este arquivo re-emitia as buscas por conta
// própria (replay), reaproveitando os headers da requisição que a página tinha feito. Não
// funciona: o header `x-net-sync-term` rotaciona A CADA requisição e o servidor o exige.
// Provado ao vivo na sessão 178, do frame `members.bet365.bet.br` e com a sessão logada:
//   • mesma URL, com os headers da página  → 200 com o payload `F|…`
//   • mesma URL, só com cookie (sem token) → 200 com corpo VAZIO (`len: 0`)
//   • mesma URL, com um token VENCIDO      → HTML da página de 404
// Não temos como gerar um token válido (vem de código ofuscado da casa). Quem consegue chamar
// a API é a PRÓPRIA página → o content script dirige a UI (rola a lista p/ paginar, abre
// "Detalhes da Aposta" p/ o confirmation) e este arquivo só escuta. Ver
// docs/PLANO_BET365_CAPTURA_API.md.
//
// POR QUE PRECISA DO DETALHE: o `summary` NÃO traz jogo/mercado/liga nem o código `BR` — só a
// seleção crua, odd, stake, retorno, o esporte (`CL`) e as pernas de bet builder. O
// `confirmation?bsid=` completa.
//
// DEDUP: a chave estável é o `BR` (código do comprovante — do confirmation). O `ID` numérico do
// summary MUDA quando a aposta resolve (namespace D1→D0), então serve só de `bsid` para buscar o
// detalhe na mesma visão.
(function () {
  const RX_SUM = /\/sportshistoryapi\/summary/i;
  const RX_CONF = /\/sportshistoryapi\/confirmation/i;
  const byBsid = new Map();       // bsid(string) → bilhete mesclado (summary + confirmation)
  let respostas = 0;              // respostas de summary/confirmation que o hook viu (autodiagnóstico)
  let outrasHistory = 0;          // requisições com "history" no path que NÃO casaram os regex —
                                  // se isto for >0 com `respostas`=0, o endpoint mudou de nome.
  const LOG = (...a) => { try { console.log("[SharpenUp b3_inject]", ...a); } catch (e) {} };
  LOG("hook instalado em", location.href);

  const of = window.fetch;        // fetch ORIGINAL (o wrapper embrulha este)

  // ── parser do formato F|… ──────────────────────────────────────────────────────
  function parseRecords(blob) {
    const recs = [];
    for (const chunk of String(blob || "").split("|")) {
      const c = chunk.trim();
      if (!c || c === "F") continue;
      const parts = c.split(";");
      const kv = {};
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        const eq = p.indexOf("=");
        if (eq > -1) kv[p.slice(0, eq)] = p.slice(eq + 1);
      }
      recs.push([parts[0], kv]);
    }
    return recs;
  }

  // summary → { cursor:PT, bets:[{bsid,bs,stake,oddFrac,rt,tipo,sels}] }
  // Registros: 00 header (PT=cursor) · 01 bilhete · 03 seleção · 04 perna de BET BUILDER
  // (mesmo jogo: NA=seleção, N2=mercado) · 02 TY=SD/ST (stake/retorno).
  function parseSummary(blob) {
    const recs = parseRecords(blob);
    let cursor = null;
    const bets = [];
    let cur = null;
    for (const [code, kv] of recs) {
      if (code === "00") { if (kv.PT) cursor = kv.PT; continue; }
      if (code === "01") {
        if (cur) bets.push(cur);
        cur = { bsid: kv.ID || "", bs: kv.BS, tp: kv.TP || "", sels: [],
                stake: null, ts: null, oddFrac: "", rt: null, tipo: "" };
      } else if (code === "03" && cur) {
        // `na` é a seleção; quando vierem pernas 04 depois, esse mesmo `na` é o JOGO
        // (bet builder). Quem decide é o formatador, olhando se `subs` tem item.
        cur.sels.push({ na: kv.NA || kv.FN || "", od: kv.OD || "", cl: kv.CL || "", subs: [] });
        if (!cur.oddFrac) cur.oddFrac = kv.OD || "";
      } else if (code === "04" && cur && cur.sels.length && "NA" in kv) {
        // Bet builder: cada 04 é uma perna do MESMO jogo da seleção 03 anterior. Sem isto o
        // bilhete sai "reduzido" — só o nome do jogo, sem os mercados (bug visto na s178).
        cur.sels[cur.sels.length - 1].subs.push({ na: kv.NA || "", mercado: kv.N2 || "" });
      } else if (code === "02" && cur) {
        if (kv.TY === "SD") { if ("ST" in kv) cur.stake = kv.ST; if ("TS" in kv) cur.ts = kv.TS; cur.tipo = kv.NA || ""; }
        else if (kv.TY === "ST") {
          if ("RT" in kv) cur.rt = kv.RT;                 // ausente = aberta
          if (cur.stake == null && "ST" in kv) cur.stake = kv.ST;
        }
      }
    }
    if (cur) bets.push(cur);
    return { cursor, bets };
  }

  // confirmation → { br, da, bs, tipo, rt, ts, legs:[{sel,oddFrac,kickoff,cl,liga,jogo,mercado,subs}] }
  // Estrutura REAL (payload capturado na s178, não a suposta):
  //   00           cabeçalho — BR (código), DA (colocação), BS, NA (tipo)
  //   02 (com NA)  EVENTO/perna — NA=seleção (ou o jogo, em bet builder), FN=jogo, L3=liga,
  //                MN=mercado, TP=kickoff, CL=esporte, OD=odd
  //   03 (com NA)  perna do BET BUILDER dentro do 02 anterior — NA=seleção, N2=mercado
  //   01 TY=CS     linha final — RT (retorno) e TS (stake total)
  //   01 TY=DI     início do bloco KYC (nome, endereço, CPF) → IGNORAR daqui pra frente
  function parseConfirmation(blob) {
    const recs = parseRecords(blob);
    if (!recs.length) return null;
    const head = recs[0][1];
    // Guarda: sem `BR` no cabeçalho não é um confirmation (é HTML de erro/404, por exemplo).
    // Sem esta checagem o parser devolvia um objeto com código VAZIO e o bilhete subia sem
    // chave de dedup, silenciosamente — foi assim que o replay quebrado passou despercebido.
    if (!head || !("BR" in head)) return null;
    const out = { br: head.BR || "", da: head.DA || "", bs: head.BS, tipo: head.NA || "",
                  rt: null, ts: null, legs: [] };
    let sensivel = false;   // depois de 01;TY=DI vêm dados pessoais — nunca viram perna
    let atual = null;
    for (const [code, kv] of recs) {
      if (kv.TY === "CS") { if ("RT" in kv) out.rt = kv.RT; if ("TS" in kv) out.ts = kv.TS; }
      if (code === "01" && kv.TY === "DI") { sensivel = true; atual = null; continue; }
      if (sensivel) continue;
      if (code === "02" && "NA" in kv && !("VA" in kv)) {
        atual = { sel: kv.NA || "", oddFrac: kv.OD || "", kickoff: kv.TP || "",
                  cl: kv.CL || "", liga: kv.L3 || "", jogo: kv.FN || "",
                  mercado: kv.MN || "", subs: [] };
        out.legs.push(atual);
      } else if (code === "03" && atual && "NA" in kv) {
        atual.subs.push({ na: kv.NA || "", mercado: kv.N2 || "" });
      }
    }
    return out;
  }

  // ── emissão ao content ─────────────────────────────────────────────────────────
  // A área de membros da Bet365 roda em OUTRA origem (`members.bet365.bet.br`) — na prática,
  // num iframe dentro da página que o usuário vê. O `b3_inject` roda em todos os frames
  // (`all_frames`), mas o `content.js` só existe no TOP → postar só na própria window deixaria
  // o inject do iframe gritando para dentro do iframe, sem ninguém ouvindo (sintoma: "Hook
  // ATIVO · respostas 0"). Por isso emitimos na própria window E no topo (postMessage
  // cross-origin é permitido). `href`/`topo` identificam o frame no autodiagnóstico.
  // `fim` = o driver deste frame terminou de abrir os detalhes (fim autoritativo, evita o
  // robô ficar esperando o timeout de inatividade). `driver` = contadores p/ o log do content.
  function enviar(fim, driver) {
    const msg = { __sharpenupB3Data: true, hook: true, href: location.href,
                  topo: window.top === window, bets: Array.from(byBsid.values()),
                  respostas: respostas, history: outrasHistory,
                  fim: !!fim, driver: driver || null };
    try { window.postMessage(msg, "*"); } catch (e) {}
    try { if (window.top && window.top !== window) window.top.postMessage(msg, "*"); } catch (e) {}
  }

  // ── captura passiva das respostas (summary/confirmation que a página faz) ───────
  function forward(url, text) {
    const u = String(url);
    if (RX_SUM.test(u)) {
      const r = parseSummary(text);
      if (!r || !r.bets.length) return false;
      respostas++;
      const settled = /settled=1/i.test(u);
      for (const b of r.bets) if (b.bsid) mergeSummary(b, settled);
      enviar();
      return true;
    }
    if (RX_CONF.test(u)) {
      const bsid = _param(u, "bsid");
      const c = parseConfirmation(text);
      if (!c) { LOG("confirmation sem BR (resposta inválida) · bsid", bsid); return false; }
      respostas++;
      if (bsid) mergeConf(bsid, c);
      // DIAGNÓSTICO (s180): descobrir se dá pra abrir a confirmação por ROTA/ID, pulando a lista
      // e o "Mostrar Mais" quebrado. Loga a rota do frame + a URL da API no momento em que a
      // confirmação abre. Se a rota carregar o bsid, o robô navega direto em cada bilhete.
      LOG("CONFIRM abriu · bsid=" + bsid + " · code=" + (c.br || "") + " · rota=" + location.href + " · api=" + String(u).slice(0, 220));
      enviar();
      return true;
    }
    return false;
  }

  function mergeSummary(b, settled) {
    const ex = byBsid.get(b.bsid) || { bsid: b.bsid };
    ex.aberta = b.bs === "0";
    ex.tp = b.tp; ex.stake = b.stake; ex.ts = b.ts; ex.oddFrac = b.oddFrac; ex.rt = b.rt; ex.tipo = b.tipo;
    ex.sels = b.sels;
    byBsid.set(b.bsid, ex);
  }
  function mergeConf(bsid, c) {
    const ex = byBsid.get(bsid) || { bsid: bsid };
    ex.code = c.br; ex.da = c.da; ex.legs = c.legs;
    if (c.ts != null) ex.ts = c.ts;
    if (c.rt != null && ex.rt == null) ex.rt = c.rt;   // não sobrescreve o RT do summary (realizado)
    if (!ex.tipo) ex.tipo = c.tipo;
    if (c.bs != null) ex.aberta = c.bs === "0";
    byBsid.set(bsid, ex);
  }

  function _param(u, k) { try { return new URL(u, location.origin).searchParams.get(k) || ""; } catch (e) { return ""; } }

  // Diagnóstico: requisição com "history" no path que NÃO é o summary/confirmation esperado.
  // Se virem `respostas=0` mas `history>0`, o endpoint foi renomeado — o log guarda a URL real
  // e o conserto vira ajuste de regex, sem mais uma rodada às cegas.
  function contarHistory(url) {
    const u = String(url || "");
    if (!/history/i.test(u) || RX_CONF.test(u)) return;
    outrasHistory++;
    if (outrasHistory <= 5) LOG("URL com 'history' fora do padrão:", u.slice(0, 200));
  }

  // ── driver de UI (abre "Detalhes da Aposta" de cada bilhete) ───────────────────
  // POR QUE AQUI E NÃO NO content.js: a lista do Histórico é renderizada DENTRO do iframe
  // `members.bet365.bet.br` — outra origem. O `content.js` roda só no frame de cima
  // (`all_frames:false`) e não alcança esse DOM. Este inject já roda dentro do iframe, então
  // é ele quem clica. Nos frames que não têm a lista, o driver sai na hora (guarda `temLista`)
  // — resolve o conflito de dois frames de membros rodando ao mesmo tempo.
  //
  // POR QUE UM CLIQUE POR BILHETE: só a página consegue chamar o `confirmation` (o token
  // `x-net-sync-term` é exigido e rotaciona). Abrir o detalhe é o gesto que a faz chamar.
  //
  // POR QUE SELETOR POR CLASSE E NÃO POR TEXTO (fix s180): até a v0.6.4 o driver achava os
  // botões pelo texto exato "Detalhes da Aposta"/"Voltar". O botão voltar renderiza "‹ Voltar"
  // (com a setinha) → o casamento exato falhava, caía no `history.back()` e a navegação
  // embolava depois do 1º-2º bilhete (destrinchava 1 de 38). Os nomes de classe foram mapeados
  // via Inspecionar (s180) e não mudam com idioma nem com a setinha.
  //
  // LISTA REINICIA NO TOPO ao voltar de um detalhe (e perde as páginas de "Mostrar Mais"). Por
  // isso, a cada volta o driver RE-EXPANDE com "Mostrar Mais" até o card alvo aparecer
  // (`revelarAte`) — funciona reiniciando ou não. Custa O(n²) de rolagem no pior caso, mas
  // completa a janela; para "Últimas 24/48h" (lista curta) é rápido.
  const MAX_DET = 600;            // teto de detalhes por rodada (trava de tempo)
  let driverRodando = false;
  let jaVarri = false;            // este frame já fez uma varredura completa → ignora re-pedidos
                                  // (o content re-pede "detalhar"; sem isso, a 2ª rodada clica
                                  //  bilhetes já com código e gasta 8s por falha à toa)

  // Seletores reais da área de Histórico (mapeados via Inspecionar, s180).
  const SEL_DETALHE = ".h-BetSummary_BetDetails";       // botão "Detalhes da Aposta" de cada card
  const SEL_MAIS    = ".hl-SummaryRenderer_ShowMore";   // "Mostrar Mais" (carrega a próxima página)
  const SEL_VOLTAR  = ".hl-BackButtonWithHistory";      // "‹ Voltar"
  const SEL_LISTA   = ".hl-SummaryRenderer_Container";  // presente = estamos na LISTA
  const SEL_CONF    = ".h-BetConfirmation";             // presente = estamos no DETALHE

  const qs  = (s) => document.querySelector(s);
  const qsa = (s) => Array.from(document.querySelectorAll(s));
  function clicar(el) { try { if (el) { el.click(); return true; } } catch (e) {} return false; }
  const espera = (ms) => new Promise((r) => setTimeout(r, ms));

  // Clique "forte": o "Mostrar Mais" da bet365 NÃO responde ao .click() sintético (os botões
  // "Detalhes"/"Voltar" respondem, este não) — precisa da sequência real de eventos de
  // ponteiro/mouse. Mira o elemento realmente no topo daquelas coordenadas (caso o alvo do
  // handler seja um filho/overlay do container).
  function clicarForte(el) {
    if (!el) return false;
    try {
      try { el.scrollIntoView({ block: "center" }); } catch (e) {}
      const r = el.getBoundingClientRect();
      const cx = Math.floor(r.left + r.width / 2), cy = Math.floor(r.top + r.height / 2);
      const alvo = document.elementFromPoint(cx, cy) || el;
      const base = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
      const seq = [["pointerover", 1], ["pointerenter", 1], ["mouseover", 0], ["pointerdown", 1],
                   ["mousedown", 0], ["pointerup", 1], ["mouseup", 0], ["click", 0]];
      for (const [tipo, ptr] of seq) {
        let ev = null;
        try { ev = ptr ? new PointerEvent(tipo, base) : new MouseEvent(tipo, base); }
        catch (e) { try { ev = new MouseEvent(tipo, base); } catch (e2) { ev = null; } }
        if (ev) { try { alvo.dispatchEvent(ev); } catch (e) {} }
      }
      try { if (typeof alvo.click === "function") alvo.click(); } catch (e) {}
      return true;
    } catch (e) { try { el.click(); return true; } catch (e2) { return false; } }
  }

  // Botões de detalhe: classe primeiro; se a classe mudar de skin, cai no texto (nó-folha).
  function botoesDetalhe() {
    const porClasse = qsa(SEL_DETALHE);
    if (porClasse.length) return porClasse;
    const out = [];
    for (const el of document.querySelectorAll("div,span,a,button")) {
      if (el.children.length) continue;
      if ((el.textContent || "").trim() === "Detalhes da Aposta") out.push(el.closest(SEL_DETALHE) || el);
    }
    return out;
  }
  function botaoVoltar() {
    const porClasse = qs(SEL_VOLTAR);
    if (porClasse) return porClasse;
    for (const el of document.querySelectorAll("div,span,a,button")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (t === "Voltar" || t === "‹ Voltar" || /^[‹<]\s*Voltar$/.test(t)) return el;
    }
    return null;
  }
  function temLista() { return !!(qs(SEL_LISTA) || botoesDetalhe().length); }

  // "Mostrar Mais": classe primeiro, texto como fallback (nó-folha).
  function botaoMais() {
    const c = qs(SEL_MAIS);
    if (c) return c;
    for (const el of document.querySelectorAll("div,span,a,button")) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim().toLowerCase();
      if (t === "mostrar mais" || t === "show more" || t === "carregar mais") return el.closest(SEL_MAIS) || el;
    }
    return null;
  }

  // Rola a lista até o FUNDO para materializar o "Mostrar Mais" — depois do "Voltar" a lista
  // reinicia no topo e o botão do rodapé pode nem estar no DOM (só renderiza quando se rola até
  // lá). Rola o último card à vista + a página + os ancestrais roláveis.
  function rolarFundo() {
    const cards = botoesDetalhe();
    const alvo = cards.length ? cards[cards.length - 1] : qs(SEL_LISTA);
    if (alvo) { try { alvo.scrollIntoView({ block: "end" }); } catch (e) {} }
    try { (document.scrollingElement || document.documentElement).scrollTop = 1e7; } catch (e) {}
    let el = alvo;
    for (let i = 0; el && i < 8; i++) {
      try { if (el.scrollHeight - el.clientHeight > 20) el.scrollTop = el.scrollHeight; } catch (e) {}
      el = el.parentElement;
    }
  }

  // Espera surgir um código NOVO (o confirmation daquele clique chegou), com teto. Retorna
  // assim que chega — clique que produz código sai em ~1s, não nos 8s.
  async function esperarCodigo(antes, limiteMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < limiteMs) {
      let n = 0; for (const b of byBsid.values()) if (b.code) n++;
      if (n > antes) return true;
      await espera(150);
    }
    return false;
  }

  // Garante que estamos na LISTA (não numa confirmation esquecida). Clica "Voltar" e espera a
  // lista reaparecer, com retentativas — NÃO desiste na primeira leitura vazia (o SPA
  // re-renderiza com atraso; desistir cedo era o bug da v0.6.4).
  async function garantirLista(tentativas) {
    for (let k = 0; k < (tentativas || 12); k++) {
      if (qs(SEL_LISTA) || botoesDetalhe().length) return true;
      // Alterna: tenta o botão "‹ Voltar" e o history.back(). Se o clique no botão não navegar
      // (o handler pode não responder a .click()), o history.back() cobre — e vice-versa. Sem
      // isso, ficar só no botão travava o driver no 1º bilhete quando o clique não pegava.
      const v = botaoVoltar();
      if (v && k % 2 === 0) clicar(v);
      else { try { history.back(); } catch (e) {} }
      await espera(450);
    }
    return !!(qs(SEL_LISTA) || botoesDetalhe().length);
  }

  // O nó do TEXTO "Mostrar Mais" dentro do wrapper (o wrapper tem 500px, o texto/handler fica só
  // à esquerda — clicar o wrapper/centro não aciona).
  function acharTextoMais(mais) {
    if (mais && !mais.children.length && /mostrar mais/i.test(mais.textContent || "")) return mais;
    if (mais) for (const el of mais.querySelectorAll("*")) {
      if (el.children.length) continue;
      if (/mostrar mais/i.test(el.textContent || "")) return el;
    }
    return mais;
  }

  // O "Mostrar Mais" da bet365 é BUGADO: falha até no clique humano — o Feca precisa clicar
  // dezenas/centenas de vezes até carregar. Então MARTELAMOS: cliques rápidos mirando o NÓ DO
  // TEXTO (não o wrapper vazio) até a lista crescer, com teto de tempo. É o mesmo que o humano
  // faz, na velocidade da máquina.
  async function acionarMais(mais, n) {
    const alvo = acharTextoMais(mais);
    const t0 = Date.now();
    let cliques = 0;
    while (Date.now() - t0 < 30000) {            // até 30s martelando ESTA página
      try { alvo.click(); } catch (e) {}
      clicarForte(alvo);                          // clique por coordenada NO TEXTO (centro do texto, não do wrapper)
      cliques += 2;
      await espera(50);
      if (botoesDetalhe().length > n) { LOG("Mostrar Mais: OK após " + cliques + " clique(s) — " + n + " → " + botoesDetalhe().length); return true; }
      if (cliques % 40 === 0) { enviar(false, { expandindo: true }); try { alvo.scrollIntoView({ block: "center" }); } catch (e) {} }
    }
    LOG("Mostrar Mais: FALHOU após " + cliques + " clique(s) em 30s (botão bugado da bet365)");
    return false;
  }

  // Carrega páginas via "Mostrar Mais" até haver MAIS de `alvo` botões de detalhe, ou até o
  // "Mostrar Mais" sumir / parar de crescer (fim).
  async function revelarAte(alvo) {
    let estagnou = 0;
    for (let passo = 0; passo < 300; passo++) {
      const n = botoesDetalhe().length;
      if (n > alvo) return n;
      rolarFundo();                              // materializa o "Mostrar Mais" no rodapé
      await espera(300);
      const mais = botaoMais();
      if (!mais) { LOG("Mostrar Mais: não encontrado (cards=" + n + ") = fim da lista"); return n; }
      try { mais.scrollIntoView({ block: "center" }); } catch (e) {}
      await espera(200);
      const cresceu = await acionarMais(mais, n);
      if (!cresceu) { LOG("Mostrar Mais: nenhum método carregou (cards=" + n + ")"); estagnou++; if (estagnou >= 2) return botoesDetalhe().length; }
      else estagnou = 0;
    }
    return botoesDetalhe().length;
  }

  async function detalhar(jaTem) {
    if (driverRodando || jaVarri) return;
    if (!temLista()) return;                     // frame sem a lista não dirige
    driverRodando = true;
    let feitos = 0, pulados = 0, falhas = 0, proc = 0, falhasSeguidas = 0;
    try {
      await garantirLista();
      while (proc < MAX_DET) {
        const disp = await revelarAte(proc);     // garante o card `proc` carregado (re-expande)
        if (proc >= disp) break;                 // acabou a lista
        const btn = botoesDetalhe()[proc];
        if (!btn) break;
        try { btn.scrollIntoView({ block: "center" }); } catch (e) {}
        await espera(150);
        let comCodigo = 0; for (const b of byBsid.values()) if (b.code) comCodigo++;
        if (!clicar(btn)) { falhas++; proc++; await garantirLista(); continue; }
        const ok = await esperarCodigo(comCodigo, 8000);
        if (ok) { feitos++; falhasSeguidas = 0; } else { falhas++; falhasSeguidas++; }
        enviar();
        await garantirLista();                   // clica "Voltar" e espera a lista voltar
        proc++;
        // Aborta se 5 cliques seguidos não tiraram NENHUM código sem nunca ter tirado um: é
        // frame errado (hidden/stale) ou tudo já capturado. Num frame bom o 1º clique já sai
        // com código → nunca chega aqui. Evita queimar 40s+ à toa.
        if (falhasSeguidas >= 5 && feitos === 0) { LOG("driver: abortado (5 falhas sem código — frame errado?)"); break; }
      }
    } catch (e) {
      LOG("driver erro:", e && e.message);
    } finally {
      driverRodando = false;
      if (feitos > 0) jaVarri = true;            // só marca varrido se realmente trabalhou
      LOG("driver: " + feitos + " detalhe(s) · " + pulados + " pulado(s) · " + falhas + " falha(s)");
      enviar(true, { feitos: feitos, pulados: pulados, falhas: falhas });
    }
  }

  // ── DETALHAMENTO POR ROTA (s180 — o método bom) ───────────────────────────────
  // Em vez de clicar "Detalhes" → Voltar → "Mostrar Mais", navega DIRETO para a rota da
  // confirmação de cada bilhete: `#/HICO/BSSB/C<bsid>/D1/`. Provado ao vivo: essa rota carrega a
  // confirmation (a própria página faz a chamada, com o token dela) e o hook captura o código BR
  // + jogo/mercado/liga. NÃO mexe na lista → sem Voltar, sem reset, sem o "Mostrar Mais" bugado.
  // A rota vem do próprio summary (campo `PD=#HICO#BSSB#C<id>#D1#`), mas basta o ID (bsid).
  // Só o frame de membros (que capturou os summaries → `byBsid` populado) tem a hash do app.
  let rotaRodando = false;
  const _volta = { hash: "" };
  async function detalharPorRota(jaTem) {
    if (rotaRodando || jaVarri) return;
    if (!byBsid.size) return;                      // frame sem summaries não é o de membros
    rotaRodando = true;
    const conhecidos = new Set(jaTem || []);
    _volta.hash = location.hash || "";             // p/ voltar à lista no fim
    let feitos = 0, pulados = 0, falhas = 0;
    try {
      const alvos = [];
      for (const [bsid, t] of byBsid) {
        if (t.code) continue;                      // já tem detalhe (rodada anterior/re-hidratado)
        if (conhecidos.has(String(bsid))) { pulados++; continue; }
        alvos.push(bsid);
      }
      LOG("rota: detalhando " + alvos.length + " bilhete(s) por hash");
      for (const bsid of alvos) {
        let antes = 0; for (const b of byBsid.values()) if (b.code) antes++;
        try { location.hash = "#/HICO/BSSB/C" + bsid + "/D1/"; } catch (e) {}
        const ok = await esperarCodigo(antes, 8000);
        if (ok) feitos++; else falhas++;
        enviar();
        await espera(300);
      }
    } catch (e) {
      LOG("rota erro:", e && e.message);
    } finally {
      try { location.hash = _volta.hash || "#/HISU/"; } catch (e) {}  // volta p/ a lista
      rotaRodando = false;
      if (feitos > 0) jaVarri = true;
      LOG("driver(rota): " + feitos + " detalhe(s) · " + pulados + " pulado(s) · " + falhas + " falha(s)");
      enviar(true, { feitos: feitos, pulados: pulados, falhas: falhas });
    }
  }

  // O content script pede o acumulado ao iniciar o robô → re-envia tudo (a 1ª resposta pode ter
  // vindo no load, antes de o content estar ouvindo). Repassa aos frames FILHOS: o content só
  // alcança a própria window, e quem vê as chamadas é o inject dentro do iframe de membros.
  window.addEventListener("message", (ev) => {
    const d = ev.data;
    if (!d || !d.__sharpenupB3Req) return;
    const saltos = (typeof d.saltos === "number" ? d.saltos : 0) + 1;
    if (saltos <= 4) {
      for (let i = 0; i < window.frames.length && i < 24; i++) {
        try { window.frames[i].postMessage({ __sharpenupB3Req: true, acao: d.acao,
                                             jaTem: d.jaTem, saltos: saltos }, "*"); } catch (e) {}
      }
    }
    enviar();
    if (d.acao === "detalhar") detalharPorRota(d.jaTem);   // rota por hash (não clica na lista)
  });

  // ── fetch ──
  if (of && !of.__suB3W) {
    const w = function (...a) {
      const url = (a[0] && a[0].url) || a[0];
      try { if (!RX_SUM.test(String(url))) contarHistory(url); } catch (e) {}
      return of.apply(this, a).then((r) => {
        try { if (RX_SUM.test(String(url)) || RX_CONF.test(String(url))) r.clone().text().then((t) => forward(url, t)); } catch (e) {}
        return r;
      });
    };
    w.__suB3W = true;
    window.fetch = w;
  }

  // ── XMLHttpRequest ──
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  if (!os.__suB3W) {
    XMLHttpRequest.prototype.open = function (m, u) { this.__suB3U = u; return oo.apply(this, arguments); };
    const s = function (body) {
      try {
        const u = this.__suB3U;
        if (!RX_SUM.test(String(u))) contarHistory(u);
        if (RX_SUM.test(String(u)) || RX_CONF.test(String(u))) {
          this.addEventListener("load", () => { try { forward(u, this.responseText); } catch (e) {} });
        }
      } catch (e) {}
      return os.apply(this, arguments);
    };
    s.__suB3W = true;
    XMLHttpRequest.prototype.send = s;
  }
})();
