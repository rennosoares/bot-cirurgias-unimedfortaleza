const express = require(“express”);
const axios = require(“axios”);
const { google } = require(“googleapis”);

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
scopes: [“https://www.googleapis.com/auth/spreadsheets”],
});
return google.sheets({ version: “v4”, auth });
}

async function salvarPaciente(nome, data) {
const sheets = await getSheetsClient();
await sheets.spreadsheets.values.append({
spreadsheetId: SHEET_ID,
range: “Atendimentos!A:B”,
valueInputOption: “USER_ENTERED”,
requestBody: { values: [[data, nome]] },
});
}

async function listarAtendimentos() {
const sheets = await getSheetsClient();
const res = await sheets.spreadsheets.values.get({
spreadsheetId: SHEET_ID,
range: “Atendimentos!A:B”,
});
const rows = res.data.values || [];
const resultado = [];
for (let i = 0; i < rows.length; i++) {
const [data, nome] = rows[i];
if (nome && nome !== “Nome”) {
resultado.push({ linhaSheet: i + 1, data: data || “-”, nome });
}
}
resultado.sort((a, b) => {
const parseData = d => {
const p = d.split(”/”);
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
parse_mode: “Markdown”,
});
}

async function baixarArquivo(fileId) {
const { data } = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
const filePath = data.result.file_path;
const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
const resp = await axios.get(url, { responseType: “arraybuffer” });
return Buffer.from(resp.data).toString(“base64”);
}

async function extrairDadosEtiqueta(imageBase64) {
try {
const resp = await axios.post(
“https://api.anthropic.com/v1/messages”,
{
model: “claude-sonnet-4-6”,
max_tokens: 200,
messages: [{
role: “user”,
content: [
{ type: “image”, source: { type: “base64”, media_type: “image/jpeg”, data: imageBase64 } },
{ type: “text”, text: “Esta e uma etiqueta de plano de saude.\nExtraia as informacoes e responda APENAS em JSON, sem markdown:\n{\n  "nome": "nome completo do paciente ou null",\n  "data": "data do atendimento no formato DD/MM/AAAA ou null"\n}\nSe nao encontrar algum campo, coloque null. Nao invente informacoes.” },
],
}],
},
{ headers: { “x-api-key”: ANTHROPIC_KEY, “anthropic-version”: “2023-06-01”, “content-type”: “application/json” } }
);
console.log(“Resposta Claude:”, JSON.stringify(resp.data));
if (!resp.data?.content?.[0]) return { nome: null, data: null };
return JSON.parse(resp.data.content[0].text.trim());
} catch (err) {
console.error(“Erro Claude:”, err?.response?.data || err.message);
return { nome: null, data: null };
}
}

async function extrairNomesPDF(pdfBase64) {
try {
const resp = await axios.post(
“https://api.anthropic.com/v1/messages”,
{
model: “claude-sonnet-4-6”,
max_tokens: 2000,
messages: [{
role: “user”,
content: [
{ type: “document”, source: { type: “base64”, media_type: “application/pdf”, data: pdfBase64 } },
{ type: “text”, text: “Este e um relatorio de repasse do plano de saude.\nListe TODOS os nomes de pacientes encontrados.\nResponda APENAS com os nomes, um por linha, sem numeracao.” },
],
}],
},
{ headers: { “x-api-key”: ANTHROPIC_KEY, “anthropic-version”: “2023-06-01”, “content-type”: “application/json” } }
);
if (!resp.data?.content?.[0]) return [];
return resp.data.content[0].text.trim().split(”\n”).map(n => n.trim()).filter(Boolean);
} catch (err) {
console.error(“Erro Claude PDF:”, err?.response?.data || err.message);
return [];
}
}

function normalizar(nome) {
return nome.toLowerCase().normalize(“NFD”).replace(/[\u0300-\u036f]/g, “”).trim();
}

function cruzar(atendimentos, nomesPDF) {
const normPDF = nomesPDF.map(normalizar);
const repassados = [], ausentes = [];
for (const { nome, data } of atendimentos) {
if (!nome) continue;
const norm = normalizar(nome);
const achou = normPDF.some(n => n.includes(norm) || norm.includes(n));
if (achou) repassados.push(”[OK] “ + nome + “ (” + data + “)”);
else        ausentes.push(”[FALTA] “ + nome + “ (” + data + “)”);
}
return { repassados, ausentes };
}

app.post(”/webhook”, async (req, res) => {
res.sendStatus(200);
const msg = req.body?.message;
if (!msg) return;
const chatId = String(msg.chat.id);
const texto  = msg.text?.trim() || “”;
if (chatId !== SEU_CHAT_ID) { await enviar(chatId, “Acesso nao autorizado.”); return; }

try {
if (msg.photo) {
await enviar(chatId, “Analisando etiqueta…”);
const fileId = msg.photo[msg.photo.length - 1].file_id;
const base64 = await baixarArquivo(fileId);
const dados  = await extrairDadosEtiqueta(base64);
if (!dados.nome) { await enviar(chatId, “Nao consegui identificar o nome. Tente uma foto mais nitida.”); return; }
const dataFinal  = dados.data || new Date().toLocaleDateString(“pt-BR”);
const origemData = dados.data ? “Data da etiqueta” : “Data de hoje”;
await salvarPaciente(dados.nome, dataFinal);
await enviar(chatId, “*Registrado!*\nNome: *” + dados.nome + “*\n” + origemData + “: “ + dataFinal);
return;
}

```
if (msg.document) {
  const doc = msg.document;
  if (!doc.file_name?.toLowerCase().endsWith(".pdf")) { await enviar(chatId, "Envie o relatorio em formato PDF."); return; }
  await enviar(chatId, "Lendo PDF do plano... aguarde.");
  const base64       = await baixarArquivo(doc.file_id);
  const nomesPDF     = await extrairNomesPDF(base64);
  const atendimentos = await listarAtendimentos();
  if (atendimentos.length === 0) { await enviar(chatId, "Nenhum atendimento registrado ainda."); return; }
  const { repassados, ausentes } = cruzar(atendimentos, nomesPDF);
  const total = repassados.length + ausentes.length;
  let relatorio = "*Relatorio do Mes*\n\n";
  relatorio += "Total atendido: " + total + "\n";
  relatorio += "Repassados: " + repassados.length + "\n";
  relatorio += "Nao encontrados: " + ausentes.length + "\n";
  if (ausentes.length > 0) relatorio += "\n*Ausentes no plano:*\n" + ausentes.join("\n");
  else relatorio += "\nTodos repassados!";
  await enviar(chatId, relatorio);
  return;
}

const cmd = texto.toLowerCase().trim();

if (cmd === "resumo") {
  const atendimentos = await listarAtendimentos();
  await enviar(chatId, "*Resumo*\nTotal registrado: *" + atendimentos.length + " pacientes*");

} else if (cmd === "lista") {
  const atendimentos = await listarAtendimentos();
  if (atendimentos.length === 0) { await enviar(chatId, "Nenhum paciente registrado ainda."); return; }
  let lista = "*Pacientes registrados*\n\n";
  atendimentos.forEach((a, i) => {
    lista += (i + 1) + ". " + a.nome + " _(" + a.data + ")_\n";
  });
  lista += "\nTotal: *" + atendimentos.length + "*\n\n";
  lista += "*Para remover:*\n";
  atendimentos.forEach((a, i) => {
    const primeiroNome = a.nome.split(" ")[0];
    lista += "apagar " + (i + 1) + "  ->  " + primeiroNome + "\n";
  });
  await enviar(chatId, lista);

} else if (cmd.startsWith("apagar ")) {
  const param = texto.substring(7).trim();
  const numero = parseInt(param);
  const atendimentos = await listarAtendimentos();
  if (atendimentos.length === 0) { await enviar(chatId, "Nenhum paciente registrado."); return; }

  if (!isNaN(numero)) {
    if (numero < 1 || numero > atendimentos.length) {
      await enviar(chatId, "Numero invalido. A lista tem *" + atendimentos.length + "* pacientes.\nEnvie *lista* para ver.");
      return;
    }
    const paciente = atendimentos[numero - 1];
    await apagarPorLinha(paciente.linhaSheet);
    await enviar(chatId, "*" + paciente.nome + "* removido com sucesso.");
  } else {
    const normBusca  = normalizar(param);
    const encontrado = atendimentos.find(a => normalizar(a.nome).includes(normBusca));
    if (!encontrado) { await enviar(chatId, "Nao encontrei *" + param + "*.\nEnvie *lista* para ver os pacientes."); return; }
    await apagarPorLinha(encontrado.linhaSheet);
    await enviar(chatId, "*" + encontrado.nome + "* removido com sucesso.");
  }

} else if (cmd === "ajuda") {
  await enviar(chatId,
    "*Bot de Atendimentos*\n\n" +
    "Foto da etiqueta -> registra o paciente\n" +
    "PDF do plano -> gera relatorio\n\n" +
    "*Comandos:*\n" +
    "- *resumo* -> total registrado\n" +
    "- *lista* -> pacientes numerados com opcao de remover\n" +
    "- *apagar 1* -> remove o paciente nr 1\n" +
    "- *apagar [nome]* -> remove por nome\n" +
    "- *ajuda* -> este menu"
  );
} else {
  await enviar(chatId, "Nao entendi. Envie *ajuda* para ver os comandos.");
}
```

} catch (err) {
console.error(err?.response?.data || err.message);
await enviar(chatId, “Ocorreu um erro. Tente novamente.”);
}
});

app.get(”/”, (_, res) => res.send(“Bot ativo”));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));