// ============================================================
//  BETTING DASHBOARD — Apps Script (planilha do FATUCH / operador LavaFatuch)
//  Cole este código em: Extensões > Apps Script > Code.gs  (na planilha DELE)
//
//  Espelha o Code.gs v6.1 do dashboard (mesma arquitetura de cache no
//  Drive + gatilho de 30 min + leitura via Sheets API sem recálculo).
//  O CONTRATO DE SAÍDA é idêntico ao usado pelo /dashboard/data do app.
//
//  ── LEITURA POR NOME DE CABEÇALHO (linha 3), não por posição fixa ──
//  Motivo: em 12/07/2026 o operador apagou duas colunas ("Parceiro" e
//  "Tipo") que "não usava mais". Como a versão antiga lia por POSIÇÃO
//  fixa (Stake sempre na coluna I), tudo deslizou para a esquerda, o
//  Stake passou a ser lido da coluna "W/L" (texto → 0), a regra
//  `stake <= 0` descartou TODA linha e o dashboard zerou em silêncio
//  (feed ok:true, data:[]). Agora as colunas são localizadas pelo
//  RÓTULO do cabeçalho — mexer/renomear/mover coluna não quebra mais.
//  Se uma coluna OBRIGATÓRIA sumir, o script devolve ERRO VISÍVEL
//  (ok:false) em vez de servir base vazia — o incidente vira aviso, não
//  desaparecimento.
//
//  LAYOUT ATUAL da planilha do Fatuch (12/07/2026):
//    Cabeçalho na LINHA 3, dados a partir da LINHA 4.
//    Data · Esporte · Tipster · CASA · Aposta · Descrição ·
//    Stake (R$) · Odd · W/L · U Investida · P/L (U) · P/L (R$) ·
//    Earn Potencial · Espelho · HOJE · CARTEIRA · MÊS · DAYWEEK · SEMANA
//    • Não há mais coluna "Parceiro" nem "Tipo".
//    • "Espelho" (MGM/365/Pinnacle/7k) vira o parceiro/conta/fornecedor
//      no dashboard — é o agrupamento de conta do Fatuch.
//    • O P/L em R$ (fonte de verdade) fica na coluna "P/L (R$)". Se não
//      vier como número nativo, o lucro é DERIVADO de
//      stake×odd×resultado (calcular_pl do app) em vez de descartar a linha.
//
//  PASSO A PASSO DE INSTALAÇÃO:
//    1) Cole este arquivo inteiro no Code.gs da planilha do Fatuch.
//    2) Editor > Serviços (＋) > "Google Sheets API" > Adicionar.
//       O identificador TEM que ficar como "Sheets".
//    3) Rode rebuildCache() uma vez à mão (autoriza os acessos).
//    4) Acionadores (relógio) > novo gatilho: função rebuildCache,
//       origem "Baseado em tempo", a cada 30 minutos.
//    5) Implantar > Nova implantação > Tipo "App da Web":
//         - Executar como: EU (dono da planilha)
//         - Quem tem acesso: QUALQUER PESSOA
//       Copie a URL /exec e mande para o Feca (vira PLANILHA_LAVAFATUCH_URL).
//    NOTA: se a implantação /exec NÃO mudar, a URL segue a mesma — basta
//    colar o novo código e reimplantar a MESMA implantação (Gerenciar
//    implantações > Editar > Versão "Nova"). Aí o Feca não troca env var.
// ============================================================

const SHEET_NAME     = "BASE";   // <-- CONFIRMAR o nome da aba (gid=0)
const SPREADSHEET_ID = "1XCtZoBnBeq6KSOiwjmAb780Z9FfSsMsr9fjVYMQGa6Y";

// Range lido: da linha 3 (CABEÇALHO) até uma coluna folgada à direita.
// A 1ª linha do range (linha 3) é usada para mapear os cabeçalhos; os
// dados começam na 2ª (linha 4). A largura (AZ) é generosa de propósito —
// como a leitura é por rótulo, colunas a mais são inofensivas e novas
// colunas não escapam do range.
const HEADER_ROW = 3;
const RANGE = SHEET_NAME + "!A" + HEADER_ROW + ":AZ";

// Nome do arquivo de cache no Google Drive (raiz do Meu Drive).
const CACHE_FILE_NAME = "betting-dashboard-cache-fatuch.json";

// ------------------------------------------------------------
// Mapa campo → rótulos de cabeçalho aceitos (comparados normalizados:
// minúsculas, sem acento, espaços colapsados). O 1º rótulo que casar
// vence. Adicione sinônimos aqui se a planilha renomear uma coluna.
// ------------------------------------------------------------
const HEADERS = {
  data:      ["data"],
  esporte:   ["esporte"],
  tipster:   ["tipster"],
  casa:      ["casa"],
  aposta:    ["aposta"],
  descricao: ["descricao", "descricao/evento", "evento"],
  stake:     ["stake (r$)", "stake", "stake r$", "valor", "valor (r$)"],
  odd:       ["odd", "odds"],
  resultado: ["w/l", "resultado", "res"],
  pl:        ["p/l (r$)", "p/l r$", "p/l(r$)", "pl (r$)", "lucro (r$)"],
  // Espelho é o agrupamento de conta/fornecedor do Fatuch (decisão do Feca,
  // 12/07/2026). Não tem o formato "conta [fornecedor]".
  parceiro:  ["espelho", "parceiro"],
};

// Campos SEM os quais a leitura não faz sentido. Se algum faltar no
// cabeçalho, o script LANÇA erro (doGet devolve ok:false) — melhor que
// servir base vazia em silêncio.
const OBRIGATORIOS = ["data", "esporte", "casa", "aposta", "stake", "odd", "resultado"];

// ------------------------------------------------------------
// Entry point GET
//   • normal           → devolve o JSON já pronto do cache (rápido)
//   • ?refresh=1        → reconstrói na hora e devolve fresco (lento)
//   • cache inexistente → fallback: lê ao vivo (lento, só na 1ª vez)
// ------------------------------------------------------------
function doGet(e) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  const forceRefresh = e && e.parameter && e.parameter.refresh === "1";

  try {
    if (forceRefresh) {
      output.setContent(rebuildCache());
      return output;
    }
    const cached = readCache();
    if (cached) {
      output.setContent(cached);
      return output;
    }
    output.setContent(rebuildCache());
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.message }));
  }
  return output;
}

// ------------------------------------------------------------
// rebuildCache — monta o JSON pronto, grava no Drive e devolve.
// É a função do gatilho agendado (a cada 30 min).
// ------------------------------------------------------------
function rebuildCache() {
  const t0 = Date.now();
  const data = getData();
  const payload = JSON.stringify({
    ok: true,
    data: data,
    builtAt: new Date().toISOString(),
    count: data.length,
  });
  writeCache(payload);
  Logger.log("rebuildCache: " + data.length + " apostas em " +
             ((Date.now() - t0) / 1000).toFixed(1) + "s — " +
             (payload.length / 1024 / 1024).toFixed(2) + " MB");
  return payload;
}

// ------------------------------------------------------------
// Helpers de cache em arquivo do Drive
// ------------------------------------------------------------
function _getCacheFile() {
  const it = DriveApp.getFilesByName(CACHE_FILE_NAME);
  return it.hasNext() ? it.next() : null;
}
function writeCache(content) {
  const f = _getCacheFile();
  if (f) { f.setContent(content); return f; }
  return DriveApp.createFile(CACHE_FILE_NAME, content, "application/json");
}
function readCache() {
  const f = _getCacheFile();
  return f ? f.getBlob().getDataAsString() : null;
}

// ------------------------------------------------------------
// Helpers de leitura
// ------------------------------------------------------------

// Célula segura: arrays da Sheets API são "ragged" (linhas com
// células finais vazias vêm mais curtas). Também tolera índice -1
// (coluna opcional não encontrada) devolvendo "".
function _cell(row, i) {
  return (i >= 0 && i < row.length && row[i] != null) ? row[i] : "";
}

// Normaliza um rótulo de cabeçalho para comparação: minúsculas, sem
// acentos, espaços das bordas e internos colapsados.
function _normHeader(s) {
  return String(s == null ? "" : s)
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")  // tira acentos combinantes
    .replace(/\s+/g, " ");
}

// Constrói o mapa campo → índice 0-based a partir da linha de cabeçalho.
// Lança erro se faltar um campo obrigatório (vira ok:false no doGet).
function _mapColunas(header) {
  const idx = {};
  header.forEach(function (h, i) {
    const key = _normHeader(h);
    if (key && !(key in idx)) idx[key] = i;  // 1ª ocorrência vence
  });
  const col = {};
  for (const campo in HEADERS) {
    let achou = -1;
    const rotulos = HEADERS[campo];
    for (let k = 0; k < rotulos.length; k++) {
      if (rotulos[k] in idx) { achou = idx[rotulos[k]]; break; }
    }
    col[campo] = achou;
  }
  const faltando = OBRIGATORIOS.filter(function (c) { return col[c] < 0; });
  if (faltando.length) {
    throw new Error(
      "Colunas obrigatórias não encontradas no cabeçalho (linha " + HEADER_ROW +
      "): " + faltando.join(", ") +
      ". Confira os nomes das colunas na aba '" + SHEET_NAME + "'."
    );
  }
  return col;
}

// Serial do Sheets (dias desde 1899-12-30) → "yyyy-MM-dd" (UTC, sem shift de fuso).
function _serialToISO(serial) {
  const n = Math.floor(serial);
  const d = new Date((n - 25569) * 86400000);
  const m   = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return d.getUTCFullYear() + "-" + m + "-" + day;
}

// Número tolerante: aceita number nativo ou string "1.234,56"/"1,31".
function _num(v) {
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[R$\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Deriva o lucro (P/L em R$) igual ao calcular_pl do app, quando a planilha
// não entrega P/L (R$) como número. Retorno = valor − stake.
function _derivarLucro(stake, odd, resultado) {
  switch (resultado) {
    case "W":  return stake * odd - stake;
    case "L":  return -stake;
    case "V":  return 0;
    case "HW": return (stake / 2) * odd + stake / 2 - stake;
    case "HL": return -stake / 2;
    default:   return null;
  }
}

// ------------------------------------------------------------
// Lê e normaliza os dados — via Sheets API (sem recálculo).
// Contrato de saída idêntico ao /dashboard/data do app.
// ------------------------------------------------------------
function getData() {
  const resp = Sheets.Spreadsheets.Values.get(
    SPREADSHEET_ID,
    RANGE,
    { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" }
  );

  const values = resp.values || [];
  if (values.length < 2) return [];        // só cabeçalho (ou vazio) → nada a ler
  const col = _mapColunas(values[0]);      // values[0] = linha 3 (cabeçalho)
  const rows = [];

  for (let ri = 1; ri < values.length; ri++) {   // dados a partir da linha 4
    const row = values[ri];

    // ── Resultado (aceita "w" minúsculo) ────────────────────
    let resultado = String(_cell(row, col.resultado)).trim().toUpperCase();
    const encerrada = ["W","L","V","HW","HL"].includes(resultado);

    // ── Stake ───────────────────────────────────────────────
    const stake = _num(_cell(row, col.stake));
    if (stake <= 0) continue;

    // ── Odd ─────────────────────────────────────────────────
    const odd = _num(_cell(row, col.odd));

    // ── Lucro ───────────────────────────────────────────────
    // Encerrada: P/L R$ da planilha é a fonte de verdade (deriva se faltar).
    // ABERTA (planilhada antes do encerramento, sem resultado válido): entra no
    // feed marcada, lucro 0 — o dashboard a LISTA mas NÃO a conta em métrica.
    let lucro;
    if (encerrada) {
      const rawPL = _cell(row, col.pl);
      lucro = (typeof rawPL === 'number') ? parseFloat(rawPL.toFixed(2))
                                          : _derivarLucro(stake, odd, resultado);
      if (lucro === null || isNaN(lucro)) continue;
      lucro = parseFloat(Number(lucro).toFixed(2));
    } else {
      resultado = "ABERTA";
      lucro = 0;
    }

    // ── Data ────────────────────────────────────────────────
    const rawData = _cell(row, col.data);
    let dataISO = "";
    if (typeof rawData === 'number' && rawData > 0) {
      dataISO = _serialToISO(rawData);
    } else {
      const parts = String(rawData).split("/");
      if (parts.length === 3) {
        dataISO = `${parts[2]}-${parts[1].padStart(2,"0")}-${parts[0].padStart(2,"0")}`;
      }
    }
    if (!dataISO) continue;

    // ── Parceiro / conta / fornecedor (vem da coluna "Espelho") ──
    // Sem formato "conta [fornecedor]" na planilha do Fatuch → conta e
    // fornecedor recebem o próprio Espelho (o dashboard agrupa por ele nas
    // abas Fornecedores & Parceiros e Custos). Ainda assim respeitamos o
    // formato "conta [fornecedor]" caso alguém passe a usá-lo no futuro.
    const espelhoRaw = String(_cell(row, col.parceiro)).trim();
    let conta = espelhoRaw, fornecedor = espelhoRaw;
    const m = espelhoRaw.match(/^(.+?)\s*\[(.+?)\]$/);
    if (m) { conta = m[1].trim(); fornecedor = m[2].trim(); }

    rows.push({
      data:      dataISO,
      esporte:   String(_cell(row, col.esporte)).trim(),
      tipster:   String(_cell(row, col.tipster)).trim(),
      casa:      String(_cell(row, col.casa)).trim(),
      parceiro:  espelhoRaw,
      conta,
      fornecedor,
      aposta:    String(_cell(row, col.aposta)).trim(),
      descricao: String(_cell(row, col.descricao)).trim(),
      stake,
      odd,
      resultado,
      lucro,
    });
  }

  return rows;
}

// ------------------------------------------------------------
// Teste — mostra o tempo de leitura e os totais (rode à mão)
// ------------------------------------------------------------
function testar() {
  const t0 = Date.now();
  const rows = getData();
  const segs = ((Date.now() - t0) / 1000).toFixed(1);
  const lucroTotal = rows.reduce((a, r) => a + r.lucro, 0);
  const stakeTotal = rows.reduce((a, r) => a + r.stake, 0);
  Logger.log("Leitura via Sheets API: " + segs + "s");
  Logger.log("Total apostas: " + rows.length);
  Logger.log("Lucro total: R$ " + lucroTotal.toFixed(2));
  Logger.log("Stake total: R$ " + stakeTotal.toFixed(2));
  Logger.log("ROI: " + (lucroTotal / stakeTotal * 100).toFixed(2) + "%");
}
