// Mundo MAIN (só na Betfair): escuta as RESPOSTAS que a própria página recebe da API
// de bilhetes resolvidos (POST /activity/sportsbook — JSON perfeito) e repassa ao
// content script. NÃO faz requisição nova, NÃO altera nada — só lê o que a página já
// baixa. O robô só ROLA a lista p/ a página paginar (levas de 10, cursor nextPageIndex).
// Espelho do bn_inject.js / sb_inject.js / be_inject.js.
//
// Acumula tudo que captura e RE-ENVIA sob demanda (o content script pede ao iniciar)
// — assim não perde a 1ª página, que a página busca no load antes do content estar
// pronto pra ouvir.
//
// FIM AUTORITATIVO: cada resposta traz "moreAvailable". `moreAvailable:false` = fim real
// da lista → sinaliza `fim:true` p/ o robô parar de verdade (nunca no primeiro obstáculo).
//
// POR QUE ISTO EXISTE: o bilhete da Betfair (a lista HTML) NÃO mostra data — por isso o
// fluxo antigo exigia o extrato CSV (AccountStatement) casado por ID, e a perda (que não
// gera linha no extrato) ficava por interpolação. Este JSON traz `settledDate` de TODO
// bilhete, perda inclusive → data de resolução exata e fim do upload duplo.
(function () {
  const RX = /\/activity\/sportsbook/i;   // endpoint da LISTA de bilhetes resolvidos
  const all = [];
  const seen = new Set();
  let fimReal = false;
  let respostas = 0;   // quantas respostas de /activity/sportsbook o hook viu (diagnóstico)
  const LOG = (...a) => { try { console.log("[SharpenUp bf_inject]", ...a); } catch (e) {} };
  LOG("hook instalado em", location.href);

  // SEMPRE responde (mesmo com 0 bets) → o content script sabe que o hook está VIVO e
  // quantas respostas foram vistas. É o autodiagnóstico do "0 coletado" (sem console):
  // hook:true = injeção OK; respostas>0 = viu a API; bets>0 = leu os bilhetes.
  function enviar() {
    try {
      window.postMessage({ __sharpenupBFData: true, hook: true, bets: all, fim: fimReal, respostas: respostas }, "*");
    } catch (e) {}
  }

  function forward(url, text) {
    if (!RX.test(String(url))) return;
    respostas++;
    LOG("resposta capturada:", String(url).slice(0, 120), "· bytes:", (text || "").length);
    if (typeof text !== "string") { enviar(); return; }
    try {
      const j = JSON.parse(text);
      const arr = Array.isArray(j && j.bets) ? j.bets : [];
      LOG("bets no JSON:", arr.length, "· moreAvailable:", j && j.moreAvailable);
      for (const t of arr) {
        const c = t && t.betId;
        if (c && !seen.has(c)) { seen.add(c); all.push(t); }
      }
      // moreAvailable === false → não há próxima página → fim autoritativo da lista.
      if (j && j.moreAvailable === false) fimReal = true;
      LOG("total acumulado:", all.length, "· fim:", fimReal);
    } catch (e) { LOG("erro ao parsear JSON:", e && e.message); }
    enviar();
  }

  // O content script pede o estado ao iniciar o robô → responde SEMPRE (reporta hook vivo).
  window.addEventListener("message", (ev) => { if (ev.data && ev.data.__sharpenupBFReq) enviar(); });

  // fetch
  const of = window.fetch;
  if (of && !of.__suBFW) {
    const w = function (...a) {
      const url = (a[0] && a[0].url) || a[0];
      return of.apply(this, a).then((r) => {
        try { if (RX.test(String(url))) r.clone().text().then((t) => forward(url, t)); } catch (e) {}
        return r;
      });
    };
    w.__suBFW = true;
    window.fetch = w;
  }

  // XMLHttpRequest
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  if (!os.__suBFW) {
    XMLHttpRequest.prototype.open = function (m, u) { this.__suBFU = u; return oo.apply(this, arguments); };
    const s = function () {
      try {
        if (RX.test(String(this.__suBFU))) {
          this.addEventListener("load", () => { try { forward(this.__suBFU, this.responseText); } catch (e) {} });
        }
      } catch (e) {}
      return os.apply(this, arguments);
    };
    s.__suBFW = true;
    XMLHttpRequest.prototype.send = s;
  }
})();
