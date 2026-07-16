const socket = io();

const screens = {
  join: document.getElementById('screen-join'),
  lobby: document.getElementById('screen-lobby'),
  question: document.getElementById('screen-question'),
  result: document.getElementById('screen-result'),
};

function showScreen(name) {
  Object.values(screens).forEach((el) => el.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

const joinForm = document.getElementById('join-form');
const nicknameInput = document.getElementById('nickname-input');
const joinError = document.getElementById('join-error');
const playerList = document.getElementById('player-list');
const hostLabel = document.getElementById('host-label');
const waitingForHost = document.getElementById('waiting-for-host');
const hostPasswordPanel = document.getElementById('host-password-panel');
const hostPasswordForm = document.getElementById('host-password-form');
const hostPasswordInput = document.getElementById('host-password-input');
const hostPasswordError = document.getElementById('host-password-error');
const hostPanel = document.getElementById('host-panel');
const questionAuthorList = document.getElementById('question-author-list');
const hostError = document.getElementById('host-error');
const submitQuestionsBtn = document.getElementById('submit-questions-btn');
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownValue = document.getElementById('countdown-value');
const questionProgress = document.getElementById('question-progress');
const questionText = document.getElementById('question-text');
const choicesEl = document.getElementById('choices');
const answerFeedback = document.getElementById('answer-feedback');
const roundLeaderboardBody = document.getElementById('round-leaderboard-body');
const cumulativeLeaderboardBody = document.getElementById('cumulative-leaderboard-body');
const playAgainBtn = document.getElementById('play-again-btn');
const cornerTimer = document.getElementById('corner-timer');
const timerValue = document.getElementById('timer-value');
const explosionTimer = document.getElementById('explosion-timer');
const explosionValue = document.getElementById('explosion-value');

let currentQuestionIndex = -1;
let hasAnsweredThisQuestion = false;
let questionTickInterval = null;
let countdownTickInterval = null;
let explosionTickInterval = null;
let isHost = false;

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinError.classList.add('hidden');
  socket.emit('join', { nickname: nicknameInput.value.trim() });
});

socket.on('join:error', ({ message }) => {
  joinError.textContent = message;
  joinError.classList.remove('hidden');
});

socket.on('join:success', () => {
  showScreen('lobby');
});

socket.on('lobby:update', ({ players, hostNickname }) => {
  playerList.innerHTML = '';
  players.forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name === hostNickname ? `👑 ${name}` : name;
    playerList.appendChild(li);
  });

  hostLabel.textContent = hostNickname ? `호스트: ${hostNickname}` : '';

  if (!isHost) {
    waitingForHost.classList.toggle('hidden', !hostNickname);
  }
});

socket.on('host:passwordRequired', () => {
  isHost = true;
  waitingForHost.classList.add('hidden');
  hostPanel.classList.add('hidden');
  hostPasswordPanel.classList.remove('hidden');
  hostPasswordError.classList.add('hidden');
  hostPasswordInput.value = '';
});

hostPasswordForm.addEventListener('submit', (e) => {
  e.preventDefault();
  hostPasswordError.classList.add('hidden');
  socket.emit('host:verifyPassword', { password: hostPasswordInput.value });
});

socket.on('host:passwordError', ({ message }) => {
  hostPasswordError.textContent = message;
  hostPasswordError.classList.remove('hidden');
});

socket.on('host:assigned', ({ questions }) => {
  isHost = true;
  waitingForHost.classList.add('hidden');
  hostPasswordPanel.classList.add('hidden');
  hostPanel.classList.remove('hidden');
  hostError.classList.add('hidden');
  renderAuthoringForm(questions);
});

socket.on('host:error', ({ message }) => {
  hostError.textContent = message;
  hostError.classList.remove('hidden');
});

socket.on('game:sessionTimer', ({ explodeAt }) => {
  startExplosionTimer(explodeAt);
});

socket.on('game:exploded', () => {
  stopCornerTimer();
  stopExplosionTimer();
  clearInterval(countdownTickInterval);
  countdownOverlay.classList.add('hidden');

  isHost = false;
  currentQuestionIndex = -1;
  hasAnsweredThisQuestion = false;

  nicknameInput.value = '';
  joinError.textContent = '⏰ 게임 시간이 종료되어 초기화되었습니다. 다시 입장해주세요.';
  joinError.classList.remove('hidden');

  waitingForHost.classList.add('hidden');
  hostPasswordPanel.classList.add('hidden');
  hostPanel.classList.add('hidden');

  showScreen('join');
});

function startExplosionTimer(explodeAt) {
  explosionTimer.classList.remove('hidden');
  clearInterval(explosionTickInterval);

  function tick() {
    const remaining = Math.max(0, explodeAt - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    explosionValue.textContent = `${minutes}:${String(seconds).padStart(2, '0')}`;
    explosionTimer.classList.toggle('warning', totalSeconds <= 30);
    if (remaining <= 0) {
      clearInterval(explosionTickInterval);
    }
  }

  tick();
  explosionTickInterval = setInterval(tick, 250);
}

function stopExplosionTimer() {
  clearInterval(explosionTickInterval);
  explosionTimer.classList.add('hidden');
}

function renderAuthoringForm(questions) {
  questionAuthorList.innerHTML = '';
  questions.forEach((q, qi) => {
    const block = document.createElement('div');
    block.className = 'qa-block';

    const label = document.createElement('label');
    label.textContent = `문제 ${qi + 1}`;
    block.appendChild(label);

    const questionInput = document.createElement('input');
    questionInput.type = 'text';
    questionInput.className = 'qa-question';
    questionInput.maxLength = 200;
    questionInput.value = q.question;
    block.appendChild(questionInput);

    const choicesWrap = document.createElement('div');
    choicesWrap.className = 'qa-choices';

    q.choices.forEach((choiceText, ci) => {
      const row = document.createElement('div');
      row.className = 'qa-choice-row';

      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `qa-correct-${qi}`;
      radio.value = String(ci);
      radio.checked = ci === q.answerIndex;
      row.appendChild(radio);

      const choiceInput = document.createElement('input');
      choiceInput.type = 'text';
      choiceInput.className = 'qa-choice';
      choiceInput.maxLength = 60;
      choiceInput.value = choiceText;
      row.appendChild(choiceInput);

      choicesWrap.appendChild(row);
    });

    block.appendChild(choicesWrap);
    questionAuthorList.appendChild(block);
  });
}

function collectQuestionsFromForm() {
  return Array.from(questionAuthorList.children).map((block, qi) => {
    const question = block.querySelector('.qa-question').value.trim();
    const choices = Array.from(block.querySelectorAll('.qa-choice')).map((el) => el.value.trim());
    const checkedRadio = block.querySelector(`input[name="qa-correct-${qi}"]:checked`);
    const answerIndex = checkedRadio ? Number(checkedRadio.value) : -1;
    return { question, choices, answerIndex };
  });
}

submitQuestionsBtn.addEventListener('click', () => {
  hostError.classList.add('hidden');
  socket.emit('host:submitQuestions', { questions: collectQuestionsFromForm() });
});

socket.on('game:countdown', ({ duration }) => {
  countdownOverlay.classList.remove('hidden');
  let remaining = Math.ceil(duration / 1000);
  countdownValue.textContent = remaining;
  clearInterval(countdownTickInterval);
  countdownTickInterval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(countdownTickInterval);
      countdownOverlay.classList.add('hidden');
    } else {
      countdownValue.textContent = remaining;
    }
  }, 1000);
});

socket.on('game:question', ({ index, total, question, choices, duration, startTime }) => {
  showScreen('question');
  currentQuestionIndex = index;
  hasAnsweredThisQuestion = false;

  questionProgress.textContent = `문제 ${index + 1} / ${total}`;
  questionText.textContent = question;
  answerFeedback.classList.add('hidden');
  answerFeedback.textContent = '';

  choicesEl.innerHTML = '';
  choices.forEach((choiceText, choiceIndex) => {
    const btn = document.createElement('button');
    btn.className = 'choice-btn';
    btn.textContent = choiceText;
    btn.addEventListener('click', () => selectAnswer(choiceIndex, btn));
    choicesEl.appendChild(btn);
  });

  startCornerTimer(startTime, duration);
});

function selectAnswer(choiceIndex, btnEl) {
  if (hasAnsweredThisQuestion) return;
  hasAnsweredThisQuestion = true;

  Array.from(choicesEl.children).forEach((btn) => (btn.disabled = true));
  btnEl.dataset.selected = 'true';

  socket.emit('submitAnswer', { choiceIndex, questionIndex: currentQuestionIndex });
}

socket.on('game:answerAck', ({ correct, earnedScore }) => {
  answerFeedback.classList.remove('hidden');
  if (correct) {
    answerFeedback.textContent = `✅ 정답! +${earnedScore}점`;
    answerFeedback.style.color = '#1b6b25';
  } else {
    answerFeedback.textContent = '❌ 오답';
    answerFeedback.style.color = '#a01717';
  }
});

socket.on('game:reveal', ({ correctIndex }) => {
  stopCornerTimer();
  Array.from(choicesEl.children).forEach((btn, idx) => {
    btn.disabled = true;
    if (idx === correctIndex) {
      btn.classList.add('correct');
    } else if (btn.dataset.selected === 'true') {
      btn.classList.add('wrong');
    }
  });
  if (!hasAnsweredThisQuestion) {
    answerFeedback.classList.remove('hidden');
    answerFeedback.textContent = '⏱️ 시간 초과';
    answerFeedback.style.color = '#a01717';
  }
});

socket.on('game:finished', ({ roundLeaderboard, cumulativeLeaderboard }) => {
  stopCornerTimer();
  showScreen('result');

  roundLeaderboardBody.innerHTML = '';
  roundLeaderboard.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${p.nickname}</td>
      <td>${p.correctCount}</td>
      <td>${(p.totalTimeMs / 1000).toFixed(1)}초</td>
      <td>${p.score}</td>
    `;
    roundLeaderboardBody.appendChild(tr);
  });

  cumulativeLeaderboardBody.innerHTML = '';
  cumulativeLeaderboard.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${p.nickname}</td>
      <td>${p.gamesPlayed}</td>
      <td>${p.totalCorrect}</td>
      <td>${(p.totalTimeMs / 1000).toFixed(1)}초</td>
      <td>${p.totalScore}</td>
    `;
    cumulativeLeaderboardBody.appendChild(tr);
  });
});

playAgainBtn.addEventListener('click', () => {
  socket.emit('playAgain');
});

socket.on('game:reset', () => {
  showScreen('lobby');
});

function startCornerTimer(startTime, duration) {
  cornerTimer.classList.remove('hidden');
  cornerTimer.classList.remove('warning');
  clearInterval(questionTickInterval);

  function tick() {
    const remaining = Math.max(0, duration - (Date.now() - startTime));
    const seconds = Math.ceil(remaining / 1000);
    timerValue.textContent = seconds;
    cornerTimer.classList.toggle('warning', seconds <= 5);
    if (remaining <= 0) {
      clearInterval(questionTickInterval);
    }
  }

  tick();
  questionTickInterval = setInterval(tick, 100);
}

function stopCornerTimer() {
  clearInterval(questionTickInterval);
  cornerTimer.classList.add('hidden');
}
