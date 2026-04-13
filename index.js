const express = require("express");
const axios = require("axios");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const SHEET_ID        = process.env.GOOGLE_SHEET_ID;
const SEU_CHAT_ID     = process.env.SEU_CHAT_ID;
const TELEGRAM_API    = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

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
    range: "Atendimentos!A:B",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[data, nome]] },
  });
}

async function listarAtendimentos() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Atendimentos!A:B",
  });
  const rows = res.data.values || [];
  const resultado = [];
  for (let i = 0; i < rows.length; i++) {
    const [data, nome] = rows[i];
    if (nome && nome !== "Nome") {
      resultado.push({ linhaSheet: i + 1, data: data || "-", nome });
    }
  }
  resultado.sort((a, b) => {
    const parseData = d => {
      const p = d.split("/");
      if (p.length === 3) return new Date(p[2], p[1] - 1, p[0]);
      return new Date(0);
    };
    return parseData(a.data) - parseData(b.data);
  });
  return resultado;
}

async function apagarPorLinha(linhaSheet) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `Atendimentos!A${linhaSheet}:B${linhaSheet}`,
  });
}

async function enviar(chatId, texto) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: texto,
    parse_mode: "Markdown",
  });
}

async function baixarArquivo(fileId) {
  const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = data.result.file_path;
  const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
  const resp = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(resp.data).toString("base64");
}

async function extrairDadosEtiqueta(imageBase64) {
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageBase64 } },
            { type: "text", text: `Esta Ã© uma etiqueta de plano de saÃºde.\nExtraia as informaÃ§Ãµes e responda APENAS em JSON, sem markdown:\n{\n  "nome": "nome completo do paciente ou null",\n  "data": "data do atendimento no formato DD/MM/AAAA ou null"\n}\nSe nÃ£o encontrar algum campo, coloque null. NÃ£o invente informaÃ§Ãµes.` },
          ],
        }],
      },
      { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    console.log("Resposta Claude:", JSON.stringify(resp.data));
    if (!resp.data?.content?.[0]) return { nome: null, data: null };
    return JSON.parse(resp.data.content[0].text.trim());
  } catch (err) {
    console.error("Erro Claude:", err?.response?.data || err.message);
    return { nome: null, data: null };
  }
}

async function extrairNomesPDF(pdfBase64) {
  try {
    const resp = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{
          role: "user",
          content: [
            { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
            { type: "text", text: `Este Ã© um relatÃ³rio de repasse do plano de saÃºde.\nListe TODOS os nomes de pacientes encontrados.\nResponda APENAS com os nomes, um por linha, sem numeraÃ§Ã£o.` },
          ],
        }],
      },
      { headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" } }
    );
    if (!resp.data?.content?.[0]) return [];
    return resp.data.content[0].text.trim().split("\n").map(n => n.trim()).filter(Boolean);
  } catch (err) {
    console.error("Erro Claude PDF:", err?.response?.data || err.message);
    return [];
  }
}

function normalizar(nome) {
  return nome.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function cruzar(atendimentos, nomesPDF) {
  const normPDF = nomesPDF.map(normalizar);
  const repassados = [], ausentes = [];
  for (const { nome, data } of atendimentos) {
    if (!nome) continue;
    const norm = normalizar(nome);
    const achou = normPDF.some(n => n.includes(norm) || norm.includes(n));
    if (achou) repassados.push(`â ${nome} (${data})`);
    else        ausentes.push(`â ${nome} (${data})`);
  }
  return { repassados, ausentes };
}

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const texto  = msg.text?.trim() || "";
  if (chatId !== SEU_CHAT_ID) { await enviar(chatId, "â Acesso nÃ£o autorizado."); return; }

  try {
    if (msg.photo) {
      await enviar(chatId, "ð Analisando etiqueta...");
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      const base64 = await baixarArquivo(fileId);
      const dados  = await extrairDadosEtiqueta(base64);
      if (!dados.nome) { await enviar(chatId, "â ï¸ NÃ£o consegui identificar o nome. Tente uma foto mais nÃ­tida."); return; }
      const dataFinal  = dados.data || new Date().toLocaleDateString("pt-BR");
      const origemData = dados.data ? "ð Data da etiqueta" : "ð Data de hoje";
      await salvarPaciente(dados.nome, dataFinal);
      await enviar(chatId, `â *Registrado!*\nð¤ *${dados.nome}*\n${origemData}: ${dataFinal}`);
      return;
    }

    if (msg.document) {
      const doc = msg.document;
      if (!doc.file_name?.toLowerCase().endsWith(".pdf")) { await enviar(chatId, "â ï¸ Envie o relatÃ³rio em formato PDF."); return; }
      await enviar(chatId, "ð Lendo PDF do plano... aguarde.");
      const base64       = await baixarArquivo(doc.file_id);
      const nomesPDF     = await extrairNomesPDF(base64);
      const atendimentos = await listarAtendimentos();
      if (atendimentos.length === 0) { await enviar(chatId, "â ï¸ Nenhum atendimento registrado ainda."); return; }
      const { repassados, ausentes } = cruzar(atendimentos, nomesPDF);
      const total = repassados.length + ausentes.length;
      let relatorio = `ð *RelatÃ³rio do MÃªs*\n\nTotal atendido: ${total}\nâ Repassados: ${repassados.length}\nâ NÃ£o encontrados: ${ausentes.length}\n`;
      if (ausentes.length > 0) relatorio += `\n*Ausentes no plano:*\n${ausentes.join("\n")}`;
      else relatorio += `\nð Todos repassados!`;
      await enviar(chatId, relatorio);
      return;
    }

    const cmd = texto.toLowerCase().trim();

    if (cmd === "resumo") {
      const atendimentos = await listarAtendimentos();
      await enviar(chatId, `ð *Resumo*\nTotal registrado: *${atendimentos.length} pacientes*`);

    } else if (cmd === "lista") {
      const atendimentos = await listarAtendimentos();
      if (atendimentos.length === 0) { await enviar(chatId, "Nenhum paciente registrado ainda."); return; }
      let lista = `ð *Pacientes registrados*\nâââââââââââââââââ\n`;
      atendimentos.forEach((a, i) => { lista += `${i + 1}. ${a.nome} _(${a.data})_\n`; });
      lista += `\nTotal: *${atendimentos.length}*\n_Para remover: *apagar 1*, *apagar 2*..._`;
      await enviar(chatId, lista);

    } else if (cmd.startsWith("apagar ")) {
      const param = texto.substring(7).trim();
      const numero = parseInt(param);
      const atendimentos = await listarAtendimentos();
      if (atendimentos.length === 0) { await enviar(chatId, "â ï¸ Nenhum paciente registrado."); return; }

      if (!isNaN(numero)) {
        if (numero < 1 || numero > atendimentos.length) {
          await enviar(chatId, `â ï¸ NÃºmero invÃ¡lido. A lista tem *${atendimentos.length}* pacientes.\n\nEnvie *lista* para ver os nÃºmeros.`);
          return;
        }
        const paciente = atendimentos[numero - 1];
        await apagarPorLinha(paciente.linhaSheet);
        await enviar(chatId, `ðï¸ *${paciente.nome}* (${paciente.data}) removido com sucesso.`);
      } else {
        const normBusca  = normalizar(param);
        const encontrado = atendimentos.find(a => normalizar(a.nome).includes(normBusca));
        if (!encontrado) { await enviar(chatId, `â ï¸ NÃ£o encontrei *${param}*.\n\nEnvie *lista* para ver os pacientes cadastrados.`); return; }
        await apagarPorLinha(encontrado.linhaSheet);
        await enviar(chatId, `ðï¸ *${encontrado.nome}* (${encontrado.data}) removido com sucesso.`);
      }

    } else if (cmd === "ajuda") {
      await enviar(chatId,
        `ð¤ *Bot de Atendimentos*\n\n` +
        `ð¸ *Foto da etiqueta* â registra o paciente\n` +
        `ð *PDF do plano* â gera relatÃ³rio\n\n` +
        `ð¬ *Comandos:*\n` +
        `â¢ *resumo* â total registrado\n` +
        `â¢ *lista* â todos os pacientes numerados\n` +
        `â¢ *apagar 1* â remove o paciente nÂº 1\n` +
        `â¢ *apagar JoÃ£o Silva* â remove por nome\n` +
        `â¢ *ajuda* â este menu`
      );
    } else {
      await enviar(chatId, `NÃ£o entendi. Envie *ajuda* para ver os comandos.`);
    }

  } catch (err) {
    console.error(err?.response?.data || err.message);
    await enviar(chatId, "â ï¸ Ocorreu um erro. Tente novamente.");
  }
});

app.get("/", (_, res) => res.send("Bot ativo â"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
