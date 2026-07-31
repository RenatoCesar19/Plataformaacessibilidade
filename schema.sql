PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS Usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,
    papel TEXT NOT NULL CHECK (papel IN ('PROFESSOR', 'ALUNO')),
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS PerfisAcessibilidade (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    aluno_id INTEGER NOT NULL UNIQUE,
    debounce_ms INTEGER NOT NULL DEFAULT 500 CHECK (debounce_ms BETWEEN 0 AND 3000),
    tamanho_alvo_px INTEGER NOT NULL DEFAULT 48 CHECK (tamanho_alvo_px >= 44),
    toque_para_selecionar INTEGER NOT NULL DEFAULT 1 CHECK (toque_para_selecionar IN (0, 1)),
    tema TEXT NOT NULL DEFAULT 'PADRAO' CHECK (tema IN ('PADRAO', 'ALTO_CONTRASTE', 'SEPIA')),
    fonte TEXT NOT NULL DEFAULT 'SISTEMA' CHECK (fonte IN ('SISTEMA', 'OPEN_DYSLEXIC')),
    escala_fonte REAL NOT NULL DEFAULT 1.0 CHECK (escala_fonte BETWEEN 0.8 AND 2.5),
    tts_ativo INTEGER NOT NULL DEFAULT 0 CHECK (tts_ativo IN (0, 1)),
    stt_ativo INTEGER NOT NULL DEFAULT 0 CHECK (stt_ativo IN (0, 1)),
    modo_foco INTEGER NOT NULL DEFAULT 0 CHECK (modo_foco IN (0, 1)),
    exibir_progresso INTEGER NOT NULL DEFAULT 1 CHECK (exibir_progresso IN (0, 1)),
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (aluno_id) REFERENCES Usuarios(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS Provas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    professor_id INTEGER,
    titulo TEXT NOT NULL,
    descricao TEXT,
    status TEXT NOT NULL DEFAULT 'RASCUNHO' CHECK (status IN ('RASCUNHO', 'PUBLICADA', 'ARQUIVADA')),
    pdf_original_nome TEXT,
    pdf_original_path TEXT,
    conteudo_json TEXT NOT NULL,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    publicada_em TEXT,
    FOREIGN KEY (professor_id) REFERENCES Usuarios(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS Questoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prova_id INTEGER NOT NULL,
    ordem INTEGER NOT NULL CHECK (ordem > 0),
    tipo TEXT NOT NULL DEFAULT 'MULTIPLA_ESCOLHA' CHECK (tipo IN ('MULTIPLA_ESCOLHA', 'DISSERTATIVA', 'VERDADEIRO_FALSO')),
    enunciado TEXT NOT NULL,
    texto_apoio TEXT,
    alternativas_json TEXT NOT NULL DEFAULT '[]',
    resposta_correta_json TEXT,
    pontuacao REAL NOT NULL DEFAULT 1.0 CHECK (pontuacao >= 0),
    FOREIGN KEY (prova_id) REFERENCES Provas(id) ON DELETE CASCADE,
    UNIQUE (prova_id, ordem)
);

CREATE TABLE IF NOT EXISTS Respostas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prova_id INTEGER NOT NULL,
    questao_id INTEGER NOT NULL,
    aluno_id INTEGER NOT NULL,
    resposta_json TEXT NOT NULL,
    respondida_em TEXT,
    sincronizada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    versao_cliente INTEGER NOT NULL DEFAULT 1,
    idempotency_key TEXT NOT NULL UNIQUE,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (prova_id) REFERENCES Provas(id) ON DELETE CASCADE,
    FOREIGN KEY (questao_id) REFERENCES Questoes(id) ON DELETE CASCADE,
    FOREIGN KEY (aluno_id) REFERENCES Usuarios(id) ON DELETE CASCADE,
    UNIQUE (aluno_id, questao_id)
);

CREATE INDEX IF NOT EXISTS idx_provas_status ON Provas(status);
CREATE INDEX IF NOT EXISTS idx_questoes_prova ON Questoes(prova_id, ordem);
CREATE INDEX IF NOT EXISTS idx_respostas_aluno_prova ON Respostas(aluno_id, prova_id);
