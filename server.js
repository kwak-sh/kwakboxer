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

const QUESTIONS = [
  {
    question: '세상에서 가장 뜨거운 과일은?',
    choices: ['천도복숭아', '망고', '자몽', '파인애플'],
    answerIndex: 0,
  },
  {
    question: '소가 웃으면 뭐가 될까?',
    choices: ['우유', '우습다', '소극장', '소풍'],
    answerIndex: 1,
  },
  {
    question: '세상에서 가장 아픈 나라는?',
    choices: ['모나코', '아파니스탄', '칠레', '이집트'],
    answerIndex: 1,
  },
  {
    question: '세상에서 가장 추운 바다는?',
    choices: ['홍해', '지중해', '썰렁해', '동해'],
    answerIndex: 2,
  },
  {
    question: '도둑이 가장 싫어하는 아이스크림은?',
    choices: ['누가바', '메로나', '설레임', '스크류바'],
    answerIndex: 0,
  },
];

// ---- single-room game state ----
let players = new Map(); // socketId -> { nickname, score, correctCount, totalTimeMs, answeredThisQuestion }
let state = 'lobby'; // lobby | countdown | question | reveal | finished
let currentQuestionIndex = -1;
let questionStartTime = 0;
let questionTimer = null;

function publicPlayerList() {
  return Array.from(players.values()).map((p) => p.nickname);
}

function resetGame() {
  state = 'lobby';
  currentQuestionIndex = -1;
  questionStartTime = 0;
  for (const p of players.values()) {
    p.score = 0;
    p.correctCount = 0;
    p.totalTimeMs = 0;
    p.answeredThisQuestion = false;
  }
  if (questionTimer) clearTimeout(questionTimer);
}

function clearTimer() {
  if (questionTimer) {
    clearTimeout(questionTimer);
    questionTimer = null;
  }
}

function broadcastLobby() {
  io.emit('lobby:update', { players: publicPlayerList() });
}

function startGame() {
  if (state !== 'lobby' || players.size === 0) return;
  state = 'countdown';
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
  io.emit('game:question', {
    index: currentQuestionIndex,
    total: QUESTIONS.length,
    question: q.question,
    choices: q.choices,
    duration: QUESTION_DURATION_MS,
    startTime: questionStartTime,
  });

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
  io.emit('game:reveal', {
    index: currentQuestionIndex,
    correctIndex: q.answerIndex,
    standings: currentStandings(),
  });

  questionTimer = setTimeout(() => nextQuestion(), REVEAL_DURATION_MS);
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

function finishGame() {
  clearTimer();
  state = 'finished';
  io.emit('game:finished', { leaderboard: currentStandings() });
}

io.on('connection', (socket) => {
  socket.on('join', ({ nickname }) => {
    if (state !== 'lobby') {
      socket.emit('join:error', { message: '게임이 이미 진행 중입니다. 잠시 후 다시 시도해주세요.' });
      return;
    }
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
    });
    socket.emit('join:success', { nickname: clean });
    broadcastLobby();
  });

  socket.on('startGame', () => {
    if (!players.has(socket.id)) return;
    startGame();
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

    socket.emit('game:answerAck', { correct, earnedScore, correctIndex: q.answerIndex });
  });

  socket.on('disconnect', () => {
    if (players.has(socket.id)) {
      players.delete(socket.id);
      if (state === 'lobby') broadcastLobby();
    }
  });

  socket.on('playAgain', () => {
    if (state === 'finished') {
      resetGame();
      broadcastLobby();
      io.emit('game:reset');
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Quiz game server running at http://localhost:${PORT}`);
});
