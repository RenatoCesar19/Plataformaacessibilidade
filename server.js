const express = require('express');
const multer = require('multer');
const pdf = require('pdf-parse');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_PATH = path.join(DATA_DIR, 'pai.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new sqlite3.Database(DB_PATH);
db.run('PRAGMA foreign_keys = ON');

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function onRun(error) {
    if (error) return reject(error);
    resolve({ lastID: this.lastID, changes: this.changes });
  });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
});
const exec = (sql) => new Promise((resolve, reject) => db.exec(sql, (error) => error ? reject(error) : resolve()));

function normalizeText(value) {
  return String(value || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function parseQuestions(pdfText) {
  const lines = normalizeText(pdfText).split('\n').map((line) => line.trim()).filter(Boolean);
  const questionStart = /^(\d{1,3})\s*[.)\-:]\s*(.+)$/;
  const alternativeStart = /^([A-Da-d])\s*[.)\-:]\s*(.+)$/;
  const questions = [];
  let current = null;
  let previousWasAlternative = false;

  for (const line of lines) {
    const question = line.match(questionStart);
    const alternative = line.match(alternativeStart);
    if (question) {
      if (current) questions.push(current);
      current = { ordem: Number(question[1]), tipo: 'MULTIPLA_ESCOLHA', enunciado: question[2], texto_apoio: null, alternativas: [] };
      previousWasAlternative = false;
      continue;
    }
    if (!current) continue;
    if (alternative) {
      current.alternativas.push({ id: alternative[1].toUpperCase(), texto: alternative[2] });
      previousWasAlternative = true;
      continue;
    }
    if (previousWasAlternative && current.alternativas.length > 0) {
      const last = current.alternativas[current.alternativas.length - 1];
      last.texto = `${last.texto} ${line}`;
    } else {
      current.enunciado = `${current.enunciado} ${line}`;
    }
  }
  if (current) questions.push(current);

  if (questions.length === 0 && normalizeText(pdfText)) {
    questions.push({
      ordem: 1,
      tipo: 'DISSERTATIVA',
      enunciado: normalizeText(pdfText),
      texto_apoio: 'O PDF não apresentou um padrão de alternativas reconhecível. Revise esta questão antes de publicar.',
      alternativas: []
    });
  }

  return questions.map((question, index) => ({
    ...question,
    ordem: index + 1,
    tipo: question.alternativas.length > 0 ? 'MULTIPLA_ESCOLHA' : 'DISSERTATIVA'
  }));
}

function toExamJson(prova, questions) {
  return {
    id: prova.id,
    titulo: prova.titulo,
    descricao: prova.descricao,
    versao: '1.0',
    status: prova.status,
    metadados: {
      idioma: 'pt-BR',
      total_questoes: questions.length,
      origem: { arquivo: prova.pdf_original_nome, processado_em: prova.criado_em }
    },
    questoes: questions.map((question) => ({
      id: question.id,
      ordem: question.ordem,
      tipo: question.tipo,
      enunciado: question.enunciado,
      texto_apoio: question.texto_apoio,
      alternativas: JSON.parse(question.alternativas_json),
      recursos_acessibilidade: { texto_para_narracao: question.enunciado, descricao_imagem: null }
    }))
  };
}

async function initializeDatabase() {
  const schema = await fsp.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await exec(schema);
}

const storage = multer.diskStorage({
  destination: (_request, _file, callback) => callback(null, UPLOAD_DIR),
  filename: (_request, file, callback) => callback(null, `${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_request, file, callback) => callback(null, file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf')
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/health', (_request, response) => response.json({ status: 'ok' }));

app.post('/upload-prova', upload.single('arquivo'), async (request, response, next) => {
  try {
    if (!request.file) return response.status(400).json({ erro: 'Envie um arquivo PDF no campo "arquivo".' });
    const titulo = normalizeText(request.body.titulo) || path.basename(request.file.originalname, path.extname(request.file.originalname));
    const professorId = request.body.professor_id ? Number(request.body.professor_id) : null;
    if (request.body.professor_id && !Number.isInteger(professorId)) return response.status(400).json({ erro: 'professor_id deve ser um número inteiro.' });

    const parsedPdf = await pdf(await fsp.readFile(request.file.path));
    const parsedQuestions = parseQuestions(parsedPdf.text);
    if (!parsedQuestions.length) return response.status(422).json({ erro: 'Não foi possível extrair texto ou questões do PDF.' });

    await run('BEGIN TRANSACTION');
    try {
      const provisionalJson = JSON.stringify({ versao: '1.0', questoes: [] });
      const created = await run(
        'INSERT INTO Provas (professor_id, titulo, descricao, status, pdf_original_nome, pdf_original_path, conteudo_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [professorId, titulo, normalizeText(request.body.descricao) || null, 'RASCUNHO', request.file.originalname, request.file.path, provisionalJson]
      );
      const questionRows = [];
      for (const question of parsedQuestions) {
        const inserted = await run(
          'INSERT INTO Questoes (prova_id, ordem, tipo, enunciado, texto_apoio, alternativas_json) VALUES (?, ?, ?, ?, ?, ?)',
          [created.lastID, question.ordem, question.tipo, question.enunciado, question.texto_apoio, JSON.stringify(question.alternativas)]
        );
        questionRows.push({ id: inserted.lastID, ...question, alternativas_json: JSON.stringify(question.alternativas) });
      }
      const prova = await get('SELECT * FROM Provas WHERE id = ?', [created.lastID]);
      const examJson = toExamJson(prova, questionRows);
      await run('UPDATE Provas SET conteudo_json = ?, atualizado_em = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(examJson), created.lastID]);
      await run('COMMIT');
      return response.status(201).json(examJson);
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.get('/provas', async (_request, response, next) => {
  try {
    const provas = await all('SELECT * FROM Provas WHERE status != ? ORDER BY criado_em DESC', ['ARQUIVADA']);
    const result = await Promise.all(provas.map(async (prova) => {
      const questions = await all('SELECT * FROM Questoes WHERE prova_id = ? ORDER BY ordem', [prova.id]);
      return toExamJson(prova, questions);
    }));
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.post('/sincronizar', async (request, response, next) => {
  try {
    const alunoId = Number(request.body.aluno_id);
    const answers = request.body.respostas;
    if (!Number.isInteger(alunoId) || !Array.isArray(answers) || answers.length === 0) {
      return response.status(400).json({ erro: 'Informe aluno_id e ao menos uma resposta.' });
    }

    const saved = [];
    const rejected = [];
    await run('BEGIN TRANSACTION');
    try {
      for (const answer of answers) {
        const provaId = Number(answer.prova_id);
        const questaoId = Number(answer.questao_id);
        const key = String(answer.idempotency_key || '').trim();
        if (!Number.isInteger(provaId) || !Number.isInteger(questaoId) || !key || answer.resposta === undefined) {
          rejected.push({ idempotency_key: key || null, motivo: 'Dados de resposta incompletos ou inválidos.' });
          continue;
        }
        const existing = await get('SELECT id FROM Respostas WHERE idempotency_key = ?', [key]);
        if (existing) {
          saved.push({ idempotency_key: key, status: 'JA_PROCESSADA', resposta_id: existing.id });
          continue;
        }
        const question = await get('SELECT id FROM Questoes WHERE id = ? AND prova_id = ?', [questaoId, provaId]);
        if (!question) {
          rejected.push({ idempotency_key: key, motivo: 'Questão não pertence à prova informada.' });
          continue;
        }
        await run(
          `INSERT INTO Respostas (prova_id, questao_id, aluno_id, resposta_json, respondida_em, versao_cliente, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(aluno_id, questao_id) DO UPDATE SET
             resposta_json = excluded.resposta_json,
             respondida_em = excluded.respondida_em,
             sincronizada_em = CURRENT_TIMESTAMP,
             versao_cliente = excluded.versao_cliente,
             idempotency_key = excluded.idempotency_key,
             atualizado_em = CURRENT_TIMESTAMP`,
          [provaId, questaoId, alunoId, JSON.stringify(answer.resposta), answer.respondida_em || new Date().toISOString(), Number(answer.versao_cliente) || 1, key]
        );
        const row = await get('SELECT id FROM Respostas WHERE idempotency_key = ?', [key]);
        saved.push({ idempotency_key: key, status: 'SINCRONIZADA', resposta_id: row.id });
      }
      await run('COMMIT');
    } catch (error) {
      await run('ROLLBACK');
      throw error;
    }
    response.status(rejected.length ? 207 : 200).json({ sincronizadas: saved, rejeitadas: rejected });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) return response.status(400).json({ erro: error.message });
  console.error(error);
  response.status(500).json({ erro: 'Erro interno do servidor.' });
});

initializeDatabase()
  .then(() => app.listen(PORT, () => console.log(`PAI disponível em http://localhost:${PORT}`)))
  .catch((error) => { console.error('Falha ao inicializar o banco:', error); process.exit(1); });
