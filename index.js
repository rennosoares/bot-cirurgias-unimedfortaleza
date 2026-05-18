const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
const SEU_CHAT_ID    = process.env.SEU_CHAT_ID;
const TELEGRAM_API   = "https://api.telegram.org/bot" + TELEGRAM_TOKEN;

const E = {
  ok:      "\u2705",
  erro:    "\u274C",
  aviso:   "\u26A0\uFE0F",
  lupa:    "\uD83D\uDD0D",
  medico:  "\uD83D\uDC68\u200D\u2695\uFE0F",
  clip:    "\uD83D\uDCCB",
  foto:    "\uD83D\uDCF8",
  pdf:     "\uD83D\uDCC4",
  grafico: "\uD83D\uDCCA",
  festa:   "\uD83C\uDF89",
  lixo:    "\uD83D\uDDD1\uFE0F",
  relogio: "\uD83D\uDCC5",
  robo:    "\uD83E\uDD16",
  balao:   "\uD83D\uDCAC",
};

const MESES = ["Janeiro","Fevereiro","Marco","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

function nomeMes(mes, ano) { return MESES[mes - 1] + " " + ano; }

function parseData(d) {
  if (!d) return null;
  const p = d.split("/");
  if (p.length === 3) return new Date(parseInt(p[2]), parseInt(p[1]) - 1, parseInt(p[0]));
  if (p.length === 2) {
    var ano = new Date().getFullYear();
    return new Date(ano, parseInt(p[1]) - 1, parseInt(p[0]));
  }
  return null;
}

function normalizar(str) {
  return str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, "").trim();
}

const PREPOSICOES = ["da","de","do","das","dos","e"];

function tokens(nome) {
  return normalizar(nome).split(/\s+/).filter(function(t) {
    return t.length > 0 && PREPOSICOES.indexOf(t) === -1;
  });
}

// Retorna o primeiro token com mais de 2 letras (primeiro nome real)
function primeiroNome(nome) {
  var tks = tokens(nome);
  for (var i = 0; i < tks.length; i++) {
    if (tks[i].length > 2) return tks[i];
  }
  return tks[0] || "";
}

// MATCHING — exige que o primeiro nome bata E score >= 0.75
function nomesBatem(nomePlanilha, nomePDF) {
  const tPlanilha = tokens(nomePlanilha);
  const tPDF      = tokens(nomePDF);

  if (tPlanilha.length === 0 || tPDF.length === 0) return false;

  // REGRA 1: primeiro nome deve bater obrigatoriamente
  var pNomePDF      = primeiroNome(nomePDF);
  var pNomePlanilha = primeiroNome(nomePlanilha);

  if (pNomePDF && pNomePlanilha) {
    // Primeiro nome pode ser abreviacao (1-2 letras)
    var primeirosBatem = false;
    if (pNomePDF.length <= 2) {
      primeirosBatem = pNomePlanilha.startsWith(pNomePDF);
    } else if (pNomePlanilha.length <= 2) {
      primeirosBatem = pNomePDF.startsWith(pNomePlanilha);
    } else {
      primeirosBatem = pNomePDF === pNomePlanilha || pNomePDF.includes(pNomePlanilha) || pNomePlanilha.includes(pNomePDF);
    }
    if (!primeirosBatem) return false;
  }

  // REGRA 2: tokens completos e abreviacoes
  const tokensCompletos = tPDF.filter(function(t) { return t.length > 2; });
  const abreviacoes     = tPDF.filter(function(t) { return t.length <= 2; });

  if (tokensCompletos.length === 0) return false;

  var matchesCompletos = 0;
  for (var i = 0; i < tokensCompletos.length; i++) {
    var tc = tokensCompletos[i];
    if (tPlanilha.some(function(tpl) {
      return tpl === tc || tpl.includes(tc) || tc.includes(tpl);
    })) matchesCompletos++;
  }

  var minimoCompletos = tokensCompletos.length >= 2 ? 2 : 1;
  if (matchesCompletos < minimoCompletos) return false;

  var matchesAbrev = 0;
  for (var j = 0; j < abreviacoes.length; j++) {
    var ab = abreviacoes[j];
    if (tPlanilha.some(function(tpl) { return tpl.startsWith(ab); })) matchesAbrev++;
  }

  var totalMatch = matchesCompletos + matchesAbrev;
  var score      = totalMatch / tPDF.length;

  // REGRA 3: threshold mais alto para evitar falsos positivos
  return score >= 0.75;
}

// GOOGLE SHEETS
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function salvarPaciente(nome, data) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Atendimentos!A:C",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[data, nome, "PENDENTE"]] },
  });
}

async function listarTodos() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Atendimentos!A:C",
  });
  const rows = res.data.values || [];
  const resultado = [];
  for (var i = 0; i < rows.length; i++) {
    var data   = rows[i][0];
    var nome   = rows[i][1];
    var status = rows[i][2] || "PENDENTE";
    if (nome && nome !== "Nome" && data !== "Data") {
      resultado.push({ linhaSheet: i + 1, data: data || "-", nome: nome, status: status });
    }
  }
  resultado.sort(function(a, b) {
    var da = parseData(a.data);
    var db = parseData(b.data);
    if (!da) return 1;
    if (!db) return -1;
    return db - da;
  });
  return resultado;
}

async function marcarRepassado(linhaSheet) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Atendimentos!C" + linhaSheet,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [["REPASSADO"]] },
  });
}

async function apagarPorLinha(linhaSheet) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: "Atendimentos!A" + linhaSheet + ":C" + linhaSheet,
  });
}

function agruparPorMes(atendimentos) {
  const grupos = {};
  for (var i = 0; i < atendimentos.length; i++) {
    var a = atendimentos[i];
    var d = parseData(a.data);
    var chave = d ? (d.getMonth() + 1) + "/" + d.getFullYear() : "Sem data";
    if (!grupos[chave]) grupos[chave] = [];
    grupos[chave].push(a);
  }
  return grupos;
}

async function enviar(chatId, texto) {
  await axios.post(TELEGRAM_API + "/sendMessage", {
    chat_id: chatId,
    text: texto,
    parse_mode: "Markdown",
  });
}

async function baixarArquivo(fileId) {
  const res = await axios.get(TELEGRAM_API + "/getFile?file_id=" + fileId);
  const filePath = res.data.result.file_path;
  const url = "https://api.telegram.org/file/bot" + TELEGRAM_TOKEN + "/" + filePath;
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(resp.data).toString("base64");
}

async function extrairDadosEtiqueta(imageBase64) {
  try {
    const hoje = new Date().toLocaleDateString("pt-BR");
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            { type: "text", text: "Esta e uma etiqueta de plano de saude.\nHoje e " + hoje + ".\nExtraia as informacoes e responda APENAS em JSON valido, sem markdown:\n{\"nome\": \"nome completo ou null\", \"datas\": [\"DD/MM/AAAA\"]}\nListe TODAS as datas encontradas no array datas.\nSe nao encontrar nenhuma data, retorne array vazio.\nNao invente informacoes." },
          ],
        }],
      },
      { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    console.log("Claude etiqueta:", JSON.stringify(resp.data));
    if (!resp.data || !resp.data.content || !resp.data.content[0]) return { nome: null, data: null };
    const parsed = JSON.parse(resp.data.content[0].text.trim());
    const nome   = parsed.nome || null;
    const datas  = parsed.datas || [];
    var dataMaisProxima = null;
    var menorDiff = Infinity;
    const agora = new Date();
    for (var i = 0; i < datas.length; i++) {
      var d = parseData(datas[i]);
      if (d) {
        var diff = Math.abs(agora - d);
        if (diff < menorDiff) { menorDiff = diff; dataMaisProxima = datas[i]; }
      }
    }
    return { nome: nome, data: dataMaisProxima };
  } catch (err) {
    console.error("Erro Claude etiqueta:", err.message);
    return { nome: null, data: null };
  }
}

async function extrairPacientesPDF(pdfBase64) {
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
            { type: "text", text: "Este e um relatorio de repasse do plano de saude.\nPara cada paciente listado, extraia o nome e a data do procedimento.\nSe o mesmo paciente aparecer em procedimentos diferentes, liste cada ocorrencia separadamente.\nResponda APENAS em JSON valido, sem markdown:\n{\"pacientes\": [{\"nome\": \"nome do paciente\", \"data\": \"DD/MM/AAAA ou DD/MM ou null\"}]}" },
          ],
        }],
      },
      { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    if (!resp.data || !resp.data.content || !resp.data.content[0]) return [];
    const texto = resp.data.content[0].text.trim();
    const parsed = JSON.parse(texto);
    const pacientes = parsed.pacientes || [];
    console.log("PDF extraido: " + pacientes.length + " pacientes");
    for (var i = 0; i < pacientes.length; i++) {
      console.log("PDF[" + i + "]: " + JSON.stringify(pacientes[i]));
    }
    return pacientes;
  } catch (err) {
    console.error("Erro Claude PDF:", err.message);
    return [];
  }
}

async function cruzarEDarBaixa(pendentes, pacientesPDF) {
  const repassados = [];
  const ausentes   = [];

  // Cada entrada do PDF e tratada individualmente — SEM agrupamento
  // Isso evita falsos positivos no agrupamento
  const baixasPorNomePDF = {};

  // Conta ocorrencias por nome no PDF (agrupando apenas nomes identicos ou quase identicos)
  const contagemPDF = {};
  for (var i = 0; i < pacientesPDF.length; i++) {
    var p = pacientesPDF[i];
    var nomePDF = p.nome;
    var dataPDF = p.data || null;

    // Agrupa apenas se score >= 0.9 (praticamente identicos)
    var chaveExistente = null;
    var chaves = Object.keys(contagemPDF);
    for (var j = 0; j < chaves.length; j++) {
      // Para agrupamento usa criterio mais restrito: primeiro nome E sobrenome final iguais
      var tA = tokens(chaves[j]);
      var tB = tokens(nomePDF);
      if (tA.length > 0 && tB.length > 0 && tA[0] === tB[0] && tA[tA.length-1] === tB[tB.length-1]) {
        chaveExistente = chaves[j];
        break;
      }
    }
    if (chaveExistente) {
      contagemPDF[chaveExistente].ocorrencias.push(dataPDF);
    } else {
      contagemPDF[nomePDF] = { ocorrencias: [dataPDF] };
    }
  }

  console.log("Agrupamento PDF final:");
  var chavesPDF2 = Object.keys(contagemPDF);
  for (var x = 0; x < chavesPDF2.length; x++) {
    console.log("  " + chavesPDF2[x] + " x" + contagemPDF[chavesPDF2[x]].ocorrencias.length);
  }

  const baixasDadas = {};

  // Ordena pendentes do mais antigo para o mais recente
  const ordenados = pendentes.slice().sort(function(a, b) {
    var da = parseData(a.data);
    var db = parseData(b.data);
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });

  for (var k = 0; k < ordenados.length; k++) {
    var a = ordenados[k];
    var nomePDFCorr = null;
    var chavesPDF = Object.keys(contagemPDF);
    for (var m = 0; m < chavesPDF.length; m++) {
      if (nomesBatem(a.nome, chavesPDF[m]) || nomesBatem(chavesPDF[m], a.nome)) {
        nomePDFCorr = chavesPDF[m];
        break;
      }
    }

    console.log("Buscando [" + a.nome + "] -> " + (nomePDFCorr || "NENHUMA"));

    if (!nomePDFCorr) {
      ausentes.push(E.erro + " " + a.nome + " (" + a.data + ")");
      continue;
    }

    if (!baixasDadas[nomePDFCorr]) baixasDadas[nomePDFCorr] = 0;
    var totalNoPDF   = contagemPDF[nomePDFCorr].ocorrencias.length;
    var jaFoiBaixado = baixasDadas[nomePDFCorr];

    if (jaFoiBaixado >= totalNoPDF) {
      ausentes.push(E.erro + " " + a.nome + " (" + a.data + ") — mais registros que ocorrencias no PDF");
      continue;
    }

    // Verifica data — nao da baixa se registro e de mes posterior ao PDF
    var dataRegistro = parseData(a.data);
    var dataPDFCorr  = contagemPDF[nomePDFCorr].ocorrencias[jaFoiBaixado] ? parseData(contagemPDF[nomePDFCorr].ocorrencias[jaFoiBaixado]) : null;

    if (dataRegistro && dataPDFCorr) {
      var mesRegistro = dataRegistro.getFullYear() * 12 + dataRegistro.getMonth();
      var mesPDF      = dataPDFCorr.getFullYear() * 12 + dataPDFCorr.getMonth();
      if (mesRegistro > mesPDF) {
        console.log("BLOQUEADO por data futura: " + a.nome);
        ausentes.push(E.erro + " " + a.nome + " (" + a.data + ") — procedimento posterior ao repasse");
        continue;
      }
    }

    await marcarRepassado(a.linhaSheet);
    baixasDadas[nomePDFCorr]++;
    repassados.push(E.ok + " " + a.nome + " (" + a.data + ")");
    console.log("BAIXA DADA: " + a.nome);
  }

  return { repassados: repassados, ausentes: ausentes };
}

app.post("/webhook", async function(req, res) {
  res.sendStatus(200);
  const msg = req.body && req.body.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const texto  = (msg.text || "").trim();
  if (chatId !== SEU_CHAT_ID) { await enviar(chatId, "Acesso nao autorizado."); return; }

  try {

    if (msg.photo) {
      await enviar(chatId, E.lupa + " Analisando etiqueta...");
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const base64 = await baixarArquivo(fileId);
      const dados  = await extrairDadosEtiqueta(base64);
      if (!dados.nome) { await enviar(chatId, E.aviso + " Nao consegui identificar o nome.\nTente uma foto mais nitida e bem iluminada."); return; }
      const dataFinal  = dados.data || new Date().toLocaleDateString("pt-BR");
      const origemData = dados.data ? "Data da etiqueta" : "Data de hoje";
      await salvarPaciente(dados.nome, dataFinal);
      await enviar(chatId, E.ok + " *Paciente registrado!*\n\n" + E.medico + " " + dados.nome + "\n" + E.relogio + " " + origemData + ": " + dataFinal);
      return;
    }

    if (msg.document) {
      const doc = msg.document;
      if (!doc.file_name || !doc.file_name.toLowerCase().endsWith(".pdf")) { await enviar(chatId, E.aviso + " Envie o relatorio em formato PDF."); return; }
      await enviar(chatId, E.pdf + " Lendo relatorio do plano... aguarde.");
      const base64       = await baixarArquivo(doc.file_id);
      const pacientesPDF = await extrairPacientesPDF(base64);
      const atendimentos = await listarTodos();
      const pendentes    = atendimentos.filter(function(a) { return a.status !== "REPASSADO"; });
      if (pendentes.length === 0) { await enviar(chatId, E.festa + " Nenhum atendimento pendente. Tudo ja foi repassado!"); return; }
      await enviar(chatId, E.lupa + " Cruzando dados e dando baixa automatica...");
      const resultado = await cruzarEDarBaixa(pendentes, pacientesPDF);
      const total     = resultado.repassados.length + resultado.ausentes.length;
      var relatorio = E.grafico + " *Relatorio de Cruzamento*\n\n";
      relatorio += "Pendentes verificados: *" + total + "*\n";
      relatorio += E.ok + " Baixa dada: *" + resultado.repassados.length + "*\n";
      relatorio += E.erro + " Ainda pendentes: *" + resultado.ausentes.length + "*\n";
      if (resultado.repassados.length > 0) relatorio += "\n*Repassados agora:*\n" + resultado.repassados.join("\n");
      if (resultado.ausentes.length > 0) relatorio += "\n\n*Ainda nao encontrados:*\n" + resultado.ausentes.join("\n");
      if (resultado.ausentes.length === 0) relatorio += "\n\n" + E.festa + " Todos os pendentes foram repassados!";
      await enviar(chatId, relatorio);
      return;
    }

    const cmd = texto.toLowerCase().trim();

    if (cmd === "resumo") {
      const todos  = await listarTodos();
      const grupos = agruparPorMes(todos);
      const chaves = Object.keys(grupos);
      if (chaves.length === 0) { await enviar(chatId, E.aviso + " Nenhum atendimento registrado ainda."); return; }
      var msg2 = E.grafico + " *Procedimentos por mes*\n\n";
      var totalGeral = 0;
      for (var i = 0; i < chaves.length; i++) {
        var grupo  = grupos[chaves[i]];
        var partes = chaves[i].split("/");
        var label  = partes.length === 2 ? nomeMes(parseInt(partes[0]), partes[1]) : chaves[i];
        var repas  = grupo.filter(function(a) { return a.status === "REPASSADO"; }).length;
        var pend   = grupo.filter(function(a) { return a.status !== "REPASSADO"; }).length;
        msg2 += "*" + label + "* — " + grupo.length + " procedimentos\n";
        msg2 += E.ok + " Repassados: " + repas + "   " + E.erro + " Pendentes: " + pend + "\n\n";
        totalGeral += grupo.length;
      }
      msg2 += "Total geral: *" + totalGeral + " procedimentos*";
      await enviar(chatId, msg2);

    } else if (cmd === "pendentes") {
      const todos     = await listarTodos();
      const pendentes = todos.filter(function(a) { return a.status !== "REPASSADO"; });
      if (pendentes.length === 0) { await enviar(chatId, E.festa + " Nenhum atendimento pendente. Tudo repassado!"); return; }
      const grupos = agruparPorMes(pendentes);
      const chaves = Object.keys(grupos);
      var msg2 = E.clip + " *Atendimentos pendentes*\n\n";
      var contador = 1;
      for (var i = 0; i < chaves.length; i++) {
        var grupo  = grupos[chaves[i]];
        var partes = chaves[i].split("/");
        var label  = partes.length === 2 ? nomeMes(parseInt(partes[0]), partes[1]) : chaves[i];
        msg2 += "*" + label + "* — " + grupo.length + " pendentes\n";
        for (var j = 0; j < grupo.length; j++) {
          msg2 += contador + ". " + grupo[j].nome + " _(" + grupo[j].data + ")_\n";
          contador++;
        }
        msg2 += "\n";
      }
      msg2 += "Total pendente: *" + pendentes.length + "*\n\n";
      msg2 += E.lixo + " Para remover: *apagar 1*, *apagar 2*...";
      await enviar(chatId, msg2);

    } else if (cmd === "lista") {
      const todos = await listarTodos();
      if (todos.length === 0) { await enviar(chatId, E.aviso + " Nenhum atendimento registrado ainda."); return; }
      const grupos = agruparPorMes(todos);
      const chaves = Object.keys(grupos);
      var msg2 = E.clip + " *Todos os atendimentos*\n\n";
      for (var i = 0; i < chaves.length; i++) {
        var grupo  = grupos[chaves[i]];
        var partes = chaves[i].split("/");
        var label  = partes.length === 2 ? nomeMes(parseInt(partes[0]), partes[1]) : chaves[i];
        msg2 += "*" + label + "*\n";
        for (var j = 0; j < grupo.length; j++) {
          var a = grupo[j];
          msg2 += (a.status === "REPASSADO" ? E.ok : E.erro) + " " + a.nome + " _(" + a.data + ")_\n";
        }
        msg2 += "\n";
      }
      await enviar(chatId, msg2);

    } else if (cmd.startsWith("apagar ")) {
      const param  = texto.substring(7).trim();
      const numero = parseInt(param);
      const todos     = await listarTodos();
      const pendentes = todos.filter(function(a) { return a.status !== "REPASSADO"; });
      if (pendentes.length === 0) { await enviar(chatId, E.aviso + " Nenhum atendimento pendente para remover."); return; }
      if (isNaN(numero) || numero < 1 || numero > pendentes.length) {
        await enviar(chatId, E.aviso + " Numero invalido.\n\nHa *" + pendentes.length + "* atendimentos pendentes.\nDigite *pendentes* para ver os numeros.");
        return;
      }
      const paciente = pendentes[numero - 1];
      await apagarPorLinha(paciente.linhaSheet);
      await enviar(chatId, E.lixo + " *Removido com sucesso!*\n\n" + E.medico + " " + paciente.nome + "\n" + E.relogio + " " + paciente.data);

    } else if (cmd === "ajuda") {
      await enviar(chatId,
        E.robo + " *Bot de Atendimentos*\n\n" +
        E.foto + " Envie uma *foto da etiqueta* para registrar um paciente\n" +
        E.pdf + " Envie o *PDF do plano* para cruzar e dar baixa automatica\n\n" +
        E.balao + " *Comandos:*\n\n" +
        "*pendentes* — atendimentos ainda nao repassados\n" +
        "*resumo* — total de procedimentos por mes\n" +
        "*lista* — todos os atendimentos com status\n" +
        "*apagar 1* — remove o pendente de numero 1\n" +
        "*ajuda* — exibe este menu"
      );
    } else {
      await enviar(chatId, "Nao entendi. Digite *ajuda* para ver os comandos.");
    }

  } catch (err) {
    console.error(err.message);
    await enviar(chatId, E.aviso + " Ocorreu um erro interno. Tente novamente.");
  }
});

app.get("/", function(req, res) { res.send("Bot ativo"); });
const PORT = process.env.PORT || 3000;
app.listen(PORT, function() { console.log("Rodando na porta " + PORT); });
