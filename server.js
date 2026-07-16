const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

const QUESTION_DURATION_MS = 15000;
const REVEAL_DURATION_MS = 4000;
const LOBBY_COUNTDOWN_MS = 3000;
const HOST_PASSWORD = '1234';
const SESSION_DURATION_MS = 5 * 60 * 1000;

const DEFAULT_QUESTIONS = [
  {
    question: '태양계 행성 중 자전 방향이 다른 행성들과 반대인(역행 자전) 행성은?',
    choices: ['금성', '화성', '목성', '수성'],
    answerIndex: 0,
    reason: '금성은 다른 행성과 반대 방향으로 자전하는 유일한 행성으로, 과거 거대 충돌 등이 원인으로 추정됩니다.',
  },
  {
    question: 'DNA의 이중나선 구조를 처음 밝혀낸 과학자로 널리 알려진 두 사람은?',
    choices: ['다윈과 멘델', '왓슨과 크릭', '프랭클린과 폴링', '슈뢰딩거와 하이젠베르크'],
    answerIndex: 1,
    reason: '왓슨과 크릭은 1953년 로절린드 프랭클린의 X선 회절 데이터를 참고해 DNA 이중나선 구조를 제안했습니다.',
  },
  {
    question: '피타고라스의 정리(a²+b²=c²)가 성립하는 삼각형은?',
    choices: ['정삼각형', '이등변삼각형', '직각삼각형', '둔각삼각형'],
    answerIndex: 2,
    reason: '피타고라스의 정리는 빗변의 제곱이 나머지 두 변의 제곱의 합과 같다는 관계로, 직각삼각형에서만 성립합니다.',
  },
  {
    question: '전통적으로 세계에서 가장 긴 강으로 알려진 강은?',
    choices: ['아마존강', '양쯔강', '미시시피강', '나일강'],
    answerIndex: 3,
    reason: '나일강은 전통적으로 약 6,650km로 세계에서 가장 긴 강으로 알려져 있습니다 (아마존강과의 비교는 여전히 논쟁이 있습니다).',
  },
  {
    question: "원소기호 'Au'가 나타내는 금속은?",
    choices: ['은', '알루미늄', '금', '우라늄'],
    answerIndex: 2,
    reason: "Au는 금을 뜻하는 라틴어 'aurum'에서 유래한 원소기호입니다.",
  },
];

// the active question set for the round about to be/being played — replaced
// whenever the host confirms their own set
let QUESTIONS = DEFAULT_QUESTIONS.map((q) => ({ ...q, choices: [...q.choices] }));

function sanitizeQuestions(raw) {
  if (!Array.isArray(raw) || raw.length !== 5) return null;
  const result = [];
  for (const item of raw) {
    const question = (item && item.question ? item.question : '').toString().trim().slice(0, 200);
    const choicesRaw = item && Array.isArray(item.choices) ? item.choices : [];
    const choices = choicesRaw.map((c) => (c || '').toString().trim().slice(0, 60));
    const answerIndex = Number(item && item.answerIndex);
    const reason = (item && item.reason ? item.reason : '').toString().trim().slice(0, 300);

    if (!question) return null;
    if (choices.length !== 4 || choices.some((c) => !c)) return null;
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) return null;
    if (!reason) return null;

    result.push({ question, choices, answerIndex, reason });
  }
  return result;
}

// ---- single-room game state ----
// players: currently connected sockets, per-round stats
let players = new Map(); // socketId -> { nickname, score, correctCount, totalTimeMs, answeredThisQuestion, mergedThisRound }
// cumulative: persistent across rounds, keyed by nickname
let cumulative = new Map(); // nickname -> { totalScore, totalCorrect, totalTimeMs, gamesPlayed }

let hostSocketId = null; // socket.id of whoever is authoring/starting the current round

let sessionActive = false; // true once the host has entered the password
let sessionExplodeAt = 0;
let explodeTimer = null;
let gameNumber = 0; // increments every time a new session is created, never resets

let state = 'lobby'; // lobby | countdown | question | reveal | finished
let currentQuestionIndex = -1;
let questionStartTime = 0;
let countdownStartTime = 0;
let questionTimer = null;

let currentQuestionPayload = null;
let currentRevealPayload = null;
let currentFinishedPayload = null;

function publicPlayerList() {
  return Array.from(players.values()).map((p) => p.nickname);
}

function clearTimer() {
  if (questionTimer) {
    clearTimeout(questionTimer);
    questionTimer = null;
  }
}

function broadcastLobby() {
  const hostNickname = hostSocketId && players.has(hostSocketId) ? players.get(hostSocketId).nickname : null;
  io.emit('lobby:update', { players: publicPlayerList(), hostNickname });
}

function mergeIntoCumulative(nickname, round) {
  const existing = cumulative.get(nickname) || {
    totalScore: 0,
    totalCorrect: 0,
    totalTimeMs: 0,
    gamesPlayed: 0,
  };
  existing.totalScore += round.score;
  existing.totalCorrect += round.correctCount;
  existing.totalTimeMs += round.totalTimeMs;
  existing.gamesPlayed += 1;
  cumulative.set(nickname, existing);
}

function currentStandings() {
  return Array.from(players.values())
    .map((p) => ({
      nickname: p.nickname,
      score: p.score,
      correctCount: p.correctCount,
      totalTimeMs: p.totalTimeMs,
    }))
    .sort((a, b) => b.score - a.score || b.correctCount - a.correctCount || a.totalTimeMs - b.totalTimeMs);
}

function cumulativeStandings() {
  return Array.from(cumulative.entries())
    .map(([nickname, c]) => ({
      nickname,
      totalScore: c.totalScore,
      totalCorrect: c.totalCorrect,
      totalTimeMs: c.totalTimeMs,
      gamesPlayed: c.gamesPlayed,
    }))
    .sort((a, b) => b.totalScore - a.totalScore || b.totalCorrect - a.totalCorrect || a.totalTimeMs - b.totalTimeMs);
}

function createSession() {
  sessionActive = true;
  sessionExplodeAt = Date.now() + SESSION_DURATION_MS;
  gameNumber += 1;
  if (explodeTimer) clearTimeout(explodeTimer);
  explodeTimer = setTimeout(explodeGame, SESSION_DURATION_MS);
  io.emit('game:sessionTimer', { explodeAt: sessionExplodeAt, gameNumber });
}

function explodeGame() {
  clearTimer();
  if (explodeTimer) {
    clearTimeout(explodeTimer);
    explodeTimer = null;
  }

  sessionActive = false;
  sessionExplodeAt = 0;

  players = new Map();
  cumulative = new Map();
  hostSocketId = null;

  state = 'lobby';
  currentQuestionIndex = -1;
  questionStartTime = 0;
  currentQuestionPayload = null;
  currentRevealPayload = null;
  currentFinishedPayload = null;
  QUESTIONS = DEFAULT_QUESTIONS.map((q) => ({ ...q, choices: [...q.choices] }));

  io.emit('game:exploded');
}

function startNewRound() {
  clearTimer();
  state = 'lobby';
  currentQuestionIndex = -1;
  questionStartTime = 0;
  currentQuestionPayload = null;
  currentRevealPayload = null;
  currentFinishedPayload = null;
  for (const p of players.values()) {
    p.score = 0;
    p.correctCount = 0;
    p.totalTimeMs = 0;
    p.answeredThisQuestion = false;
    p.mergedThisRound = false;
  }

  if (!hostSocketId || !players.has(hostSocketId)) {
    hostSocketId = players.keys().next().value || null;
  }
  if (hostSocketId) {
    io.to(hostSocketId).emit('host:assigned', { questions: QUESTIONS });
  }
}

function startGame() {
  if (state !== 'lobby' || players.size === 0) return;
  state = 'countdown';
  countdownStartTime = Date.now();
  io.emit('game:countdown', { duration: LOBBY_COUNTDOWN_MS });
  questionTimer = setTimeout(() => {
    currentQuestionIndex = -1;
    nextQuestion();
  }, LOBBY_COUNTDOWN_MS);
}

function nextQuestion() {
  clearTimer();
  currentQuestionIndex += 1;

  if (currentQuestionIndex >= QUESTIONS.length) {
    finishGame();
    return;
  }

  state = 'question';
  questionStartTime = Date.now();
  for (const p of players.values()) p.answeredThisQuestion = false;

  const q = QUESTIONS[currentQuestionIndex];
  currentQuestionPayload = {
    index: currentQuestionIndex,
    total: QUESTIONS.length,
    question: q.question,
    choices: q.choices,
    duration: QUESTION_DURATION_MS,
    startTime: questionStartTime,
  };
  currentRevealPayload = null;
  io.emit('game:question', currentQuestionPayload);

  questionTimer = setTimeout(() => endQuestion(), QUESTION_DURATION_MS);
}

function endQuestion() {
  clearTimer();
  state = 'reveal';

  // anyone who never answered pays the full duration as their time penalty
  for (const p of players.values()) {
    if (!p.answeredThisQuestion) {
      p.totalTimeMs += QUESTION_DURATION_MS;
    }
  }

  const q = QUESTIONS[currentQuestionIndex];
  currentRevealPayload = {
    index: currentQuestionIndex,
    correctIndex: q.answerIndex,
    reason: q.reason,
    standings: currentStandings(),
  };
  io.emit('game:reveal', currentRevealPayload);

  questionTimer = setTimeout(() => nextQuestion(), REVEAL_DURATION_MS);
}

function finishGame() {
  clearTimer();
  state = 'finished';

  for (const p of players.values()) {
    if (!p.mergedThisRound) {
      mergeIntoCumulative(p.nickname, p);
      p.mergedThisRound = true;
    }
  }

  currentFinishedPayload = {
    roundLeaderboard: currentStandings(),
    cumulativeLeaderboard: cumulativeStandings(),
  };
  io.emit('game:finished', currentFinishedPayload);
}

io.on('connection', (socket) => {
  socket.on('join', ({ nickname }) => {
    const clean = (nickname || '').toString().trim().slice(0, 12);
    if (!clean) {
      socket.emit('join:error', { message: '닉네임을 입력해주세요.' });
      return;
    }
    const nameTaken = Array.from(players.values()).some((p) => p.nickname === clean);
    if (nameTaken) {
      socket.emit('join:error', { message: '이미 사용중인 닉네임입니다.' });
      return;
    }

    players.set(socket.id, {
      nickname: clean,
      score: 0,
      correctCount: 0,
      totalTimeMs: 0,
      answeredThisQuestion: false,
      mergedThisRound: false,
    });
    socket.emit('join:success', { nickname: clean });

    if (!hostSocketId && state === 'lobby') {
      hostSocketId = socket.id;
      if (sessionActive) {
        socket.emit('host:assigned', { questions: QUESTIONS });
      } else {
        socket.emit('host:passwordRequired');
      }
    }

    broadcastLobby();

    if (sessionActive) {
      socket.emit('game:sessionTimer', { explodeAt: sessionExplodeAt, gameNumber });
    }

    // let latecomers jump straight into whatever is happening right now
    switch (state) {
      case 'countdown': {
        const remaining = Math.max(0, LOBBY_COUNTDOWN_MS - (Date.now() - countdownStartTime));
        socket.emit('game:countdown', { duration: remaining });
        break;
      }
      case 'question':
        if (currentQuestionPayload) socket.emit('game:question', currentQuestionPayload);
        break;
      case 'reveal':
        if (currentQuestionPayload) socket.emit('game:question', currentQuestionPayload);
        if (currentRevealPayload) socket.emit('game:reveal', currentRevealPayload);
        break;
      case 'finished':
        if (currentFinishedPayload) socket.emit('game:finished', currentFinishedPayload);
        break;
      default:
        break;
    }
  });

  socket.on('host:verifyPassword', ({ password } = {}) => {
    if (socket.id !== hostSocketId) return;
    if (sessionActive) return;

    if (password !== HOST_PASSWORD) {
      socket.emit('host:passwordError', { message: '비밀번호가 올바르지 않습니다.' });
      return;
    }

    createSession();
    socket.emit('host:assigned', { questions: QUESTIONS });
  });

  socket.on('host:submitQuestions', ({ questions } = {}) => {
    if (socket.id !== hostSocketId) return;
    if (state !== 'lobby') return;
    if (!sessionActive) return;

    const sanitized = sanitizeQuestions(questions);
    if (!sanitized) {
      socket.emit('host:error', {
        message: '문제 5개 모두 제목과 4개의 선택지, 정답을 입력해주세요.',
      });
      return;
    }

    QUESTIONS = sanitized;
    startGame();
  });

  socket.on('host:nextQuestion', () => {
    if (socket.id !== hostSocketId) return;
    if (state !== 'reveal') return;
    nextQuestion();
  });

  socket.on('submitAnswer', ({ choiceIndex, questionIndex }) => {
    const player = players.get(socket.id);
    if (!player) return;
    if (state !== 'question') return;
    if (questionIndex !== currentQuestionIndex) return;
    if (player.answeredThisQuestion) return;

    player.answeredThisQuestion = true;
    const elapsed = Math.min(Date.now() - questionStartTime, QUESTION_DURATION_MS);
    const q = QUESTIONS[currentQuestionIndex];
    const correct = choiceIndex === q.answerIndex;

    let earnedScore = 0;
    if (correct) {
      const timeLeftRatio = Math.max(0, (QUESTION_DURATION_MS - elapsed) / QUESTION_DURATION_MS);
      earnedScore = Math.round(500 + 500 * timeLeftRatio);
      player.score += earnedScore;
      player.correctCount += 1;
      player.totalTimeMs += elapsed;
    } else {
      player.totalTimeMs += QUESTION_DURATION_MS;
    }

    socket.emit('game:answerAck', { correct, earnedScore, correctIndex: q.answerIndex, reason: q.reason });

    const allAnswered = players.size > 0 && Array.from(players.values()).every((p) => p.answeredThisQuestion);
    if (allAnswered) {
      endQuestion();
    }
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.id);
    if (p) {
      // a round is under way and this player never got merged into the
      // cumulative totals yet — fold in whatever they earned so far
      if (currentQuestionIndex >= 0 && !p.mergedThisRound) {
        mergeIntoCumulative(p.nickname, p);
        p.mergedThisRound = true;
      }
      players.delete(socket.id);

      if (socket.id === hostSocketId) {
        hostSocketId = null;
        if (state === 'lobby') {
          const nextHostId = players.keys().next().value || null;
          if (nextHostId) {
            hostSocketId = nextHostId;
            if (sessionActive) {
              io.to(nextHostId).emit('host:assigned', { questions: QUESTIONS });
            } else {
              io.to(nextHostId).emit('host:passwordRequired');
            }
          }
        }
      }

      broadcastLobby();
    }
  });

  socket.on('playAgain', () => {
    if (state !== 'finished') return;
    startNewRound();
    broadcastLobby();
    io.emit('game:reset');
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Quiz game server running at http://localhost:${PORT}`);
});
