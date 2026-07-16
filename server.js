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
    question: '태양계 행성 중 자전 방향이 다른 행성들과 반대인(역행 자전) 행성은?',
    choices: ['금성', '화성', '목성', '수성'],
    answerIndex: 0,
  },
  {
    question: 'DNA의 이중나선 구조를 처음 밝혀낸 과학자로 널리 알려진 두 사람은?',
    choices: ['다윈과 멘델', '왓슨과 크릭', '프랭클린과 폴링', '슈뢰딩거와 하이젠베르크'],
    answerIndex: 1,
  },
  {
    question: '피타고라스의 정리(a²+b²=c²)가 성립하는 삼각형은?',
    choices: ['정삼각형', '이등변삼각형', '직각삼각형', '둔각삼각형'],
    answerIndex: 2,
  },
  {
    question: '전통적으로 세계에서 가장 긴 강으로 알려진 강은?',
    choices: ['아마존강', '양쯔강', '미시시피강', '나일강'],
    answerIndex: 3,
  },
  {
    question: "원소기호 'Au'가 나타내는 금속은?",
    choices: ['은', '알루미늄', '금', '우라늄'],
    answerIndex: 2,
  },
];

// ---- single-room game state ----
// players: currently connected sockets, per-round stats
let players = new Map(); // socketId -> { nickname, score, correctCount, totalTimeMs, answeredThisQuestion, mergedThisRound }
// cumulative: persistent across rounds, keyed by nickname
let cumulative = new Map(); // nickname -> { totalScore, totalCorrect, totalTimeMs, gamesPlayed }

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
  io.emit('lobby:update', { players: publicPlayerList() });
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
    broadcastLobby();

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
    const p = players.get(socket.id);
    if (p) {
      // a round is under way and this player never got merged into the
      // cumulative totals yet — fold in whatever they earned so far
      if (currentQuestionIndex >= 0 && !p.mergedThisRound) {
        mergeIntoCumulative(p.nickname, p);
        p.mergedThisRound = true;
      }
      players.delete(socket.id);
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
