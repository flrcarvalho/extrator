// Mundo MAIN (só na Superbet): escuta as RESPOSTAS que a própria página recebe da
// API de tickets (a lista de bilhetes, JSON perfeito) e repassa ao content script.
// NÃO faz requisição nova, NÃO altera nada — só lê o que a página já baixa. Assim a
// extensão pega o dado exato do site, sem clicar e sem adivinhar auth/headers. O robô
// só ROLA a lista p/ a página paginar (comportamento humano).
//
// Acumula tudo que captura e RE-ENVIA sob demanda (o content script pede ao iniciar)
// — assim não perde a 1ª página, que a página busca no load antes do content estar
// pronto pra ouvir.
(function () {
  const RX = /\/user\/\d+\/tickets/;   // endpoint da LISTA de bilhetes do usuário
  const all = [];
  const seen = new Set();

  function postAll() {
    if (all.length) { try { window.postMessage({ __sharpenupSBData: true, tickets: all }, "*"); } catch (e) {} }
  }

  function forward(url, text) {
    if (!RX.test(String(url)) || typeof text !== "string") return;
    try {
      const j = JSON.parse(text);
      const arr = Array.isArray(j) ? j : (j.data || j.tickets || []);
      let added = false;
      for (const t of arr) {
        const c = t && t.ticketId;
        if (c && !seen.has(c)) { seen.add(c); all.push(t); added = true; }
      }
      if (added) postAll();
    } catch (e) {}
  }

  // O content script pede o acumulado ao iniciar o robô → re-envia tudo.
  window.addEventListener("message", (ev) => { if (ev.data && ev.data.__sharpenupSBReq) postAll(); });

  // fetch
  const of = window.fetch;
  if (of && !of.__suW) {
    const w = function (...a) {
      const url = (a[0] && a[0].url) || a[0];
      return of.apply(this, a).then((r) => {
        try { if (RX.test(String(url))) r.clone().text().then((t) => forward(url, t)); } catch (e) {}
        return r;
      });
    };
    w.__suW = true;
    window.fetch = w;
  }

  // XMLHttpRequest
  const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  if (!os.__suW) {
    XMLHttpRequest.prototype.open = function (m, u) { this.__suU = u; return oo.apply(this, arguments); };
    const s = function () {
      try {
        if (RX.test(String(this.__suU))) {
          this.addEventListener("load", () => { try { forward(this.__suU, this.responseText); } catch (e) {} });
        }
      } catch (e) {}
      return os.apply(this, arguments);
    };
    s.__suW = true;
    XMLHttpRequest.prototype.send = s;
  }
})();
