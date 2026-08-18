// 채팅방 하나 = HeadlessSession 하나.
// claude -p stream-json 모드를 자식 프로세스로 띄워 구조화 이벤트로 대화한다.
// (PTY/TUI 스크래핑 없음 — trust 다이얼로그, 준비 감지, 재전송 안전망 전부 불필요)
const readline = require('readline');
const { EventEmitter } = require('events');
const { parseFileSync, sessionFileFor, summarizeToolUse } = require('./transcript');
const { isTaskTool, applyTaskTool, emptyTaskState, foldTaskOps, taskSummary } = require('./tasks');
const { spawnShell, claudeEnv, looksLikeClaudeMissing, CLAUDE_MISSING_HINT } = require('./platform');

class HeadlessSession extends EventEmitter {
  constructor(room) {
    super();
    this.room = room; // {id, dir, name, sessionId}
    this.state = 'offline'; // offline | starting | working | waiting
    this.child = null;
    this._stderrTail = '';
    this.tasks = emptyTaskState(); // 할 일 목록 (history() 복원 + 실시간 task-op로 갱신)
  }

  spawn() {
    if (this.child) return;
    // 권한 모드는 기본적으로 지정하지 않는다 — settings.json의 전역 설정을 그대로 따른다.
    // 방에서 따로 고른 경우에만 덮어쓴다.
    const perm = this.room.permissionMode ? ` --permission-mode ${this.room.permissionMode}` : '';
    const args =
      '-p --input-format stream-json --output-format stream-json --verbose --include-partial-messages' + perm;
    const cmd = this.room.sessionId
      ? `claude ${args} --resume ${JSON.stringify(this.room.sessionId)}`
      : `claude ${args}`;

    const env = claudeEnv();

    this._setState('starting');
    this.child = spawnShell(cmd, {
      cwd: this.room.dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // 자식이 먼저 죽은 뒤 stdin에 쓰면 EPIPE — 핸들러 없으면 uncaughtException으로 앱 전체가 죽음
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => {});

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this._onEvent(line));

    this.child.stderr.on('data', (d) => {
      this._stderrTail = (this._stderrTail + d.toString()).slice(-2000);
    });

    this.child.on('exit', (code) => {
      const wasStarting = this.state === 'starting';
      this.child = null;
      this._awaitingTurn = false; // 턴 도중 죽어도 대기줄이 갇히지 않게
      this._setState('offline');
      // 대기 중이던 메시지가 있으면 재기동해서 이어서 투입
      if (this.queue?.length && code === 0) {
        const next = this.queue.shift();
        this.spawn();
        this.emit('queue-flushed');
        this._writeUser(next.text, next.images, { emitMessage: false });
      }
      if (code !== 0 && wasStarting) {
        // claude 자체가 없어서 죽은 경우는 stderr 원문 대신 설치 안내를 보여준다
        const detail = looksLikeClaudeMissing(this._stderrTail)
          ? CLAUDE_MISSING_HINT
          : this._stderrTail.trim().slice(-300);
        this.emit('message', {
          role: 'system',
          text: `세션 시작 실패 (exit ${code})\n${detail}`,
          ts: new Date().toISOString(),
        });
      }
    });
  }

  _onEvent(line) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }

    // 실시간 진행 신호: 생각/타이핑/도구 준비를 상태줄로, 텍스트 델타는 스트리밍 버블로
    if (ev.type === 'stream_event') {
      const se = ev.event;
      if (!se) return;
      if (se.type === 'content_block_start') {
        const t = se.content_block?.type;
        if (t === 'thinking') this._setActivity('생각 중');
        else if (t === 'text') {
          this._streamText = '';
          this._setActivity('답변 작성 중');
        } else if (t === 'tool_use') {
          this._setActivity(`${se.content_block.name} 실행 중`);
        }
      } else if (se.type === 'content_block_delta') {
        const d = se.delta;
        if (d?.type === 'text_delta' && this._streamText !== null && this._streamText !== undefined) {
          this._streamText += d.text;
          this.emit('stream-text', this._streamText);
        } else if (d?.type === 'thinking_delta') {
          this._setActivity('생각 중');
        }
      }
      return;
    }

    if (ev.type === 'system' && ev.subtype === 'init') {
      if (ev.session_id && ev.session_id !== this.room.sessionId) {
        this.room.sessionId = ev.session_id;
        this.emit('session-id', ev.session_id);
      }
      // 현재 모델·슬래시 커맨드 목록 (자동완성/모델 픽커용).
      // init은 세션 시작값이라 /model로 이미 바꾼 뒤라면 모델은 덮어쓰지 않음
      if (ev.model && !this._lastModel) this._lastModel = ev.model;
      // init의 permissionMode는 전역 설정이 반영된 "실효 모드"라 그대로 표시하면 된다
      if (ev.permissionMode) this.permissionMode = ev.permissionMode;
      this.emit('info', {
        model: this._lastModel || ev.model || null,
        slashCommands: ev.slash_commands || [],
        permissionMode: this.permissionMode || null,
      });
      if (this.state === 'starting') this._setState('working');
      return;
    }

    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      // 매 응답에 실제 사용 모델이 실려 옴 — /model로 중간에 바꿔도 표시가 즉시 따라가게
      // (<synthetic> = 로컬 명령 응답의 가짜 모델명이라 제외)
      if (ev.message.model && !ev.message.model.startsWith('<') && ev.message.model !== this._lastModel) {
        this._lastModel = ev.message.model;
        this.emit('info', { model: ev.message.model, slashCommands: [] });
      }
      // usage 합 = 현재 세션 컨텍스트 크기. 자동 컴팩션·모델 전환 경고의 기준값
      const u = ev.message.usage;
      if (u) {
        const total =
          (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (total > 0) this._contextTokens = total;
      }
      const ts = new Date().toISOString();
      for (const c of ev.message.content) {
        if (c.type === 'text' && c.text && c.text.trim()) {
          this._streamText = null; // 스트리밍 버블 확정 신호
          this.emit('message', { role: 'assistant', text: c.text.trim(), ts });
        } else if (c.type === 'tool_use') {
          // 할 일 도구는 채팅 줄이 아니라 상태 갱신으로 (transcript 복원 경로와 동일한 판정)
          if (isTaskTool(c.name)) {
            this.tasks = applyTaskTool(this.tasks, c.name, c.input || {});
            this.emit('tasks', taskSummary(this.tasks));
          } else {
            this.emit('message', { role: 'tool', text: summarizeToolUse(c), ts });
          }
        }
      }
      return;
    }

    // 권한 모드가 바뀌면 CLI가 status로 알려준다 (앱이 바꿨든 세션 내부에서 바뀌었든)
    if (ev.type === 'system' && ev.subtype === 'status' && ev.permissionMode) {
      if (ev.permissionMode !== this.permissionMode) {
        this.permissionMode = ev.permissionMode;
        this.emit('info', { model: this._lastModel || null, slashCommands: [], permissionMode: ev.permissionMode });
      }
      return;
    }

    if (ev.type === 'control_response') return; // interrupt 응답 등은 무시

    if (ev.type === 'result') {
      this._setActivity(null);
      this.turnStartedAt = null;
      this._awaitingTurn = false;
      clearTimeout(this._intTimer);
      if (this._interrupting) {
        this._interrupting = false;
        this.emit('message', { role: 'system', text: '⏹ 작업을 중단했어요', ts: new Date().toISOString() });
      } else if (ev.is_error) {
        const errText = String(ev.result || ev.subtype || '알 수 없는 오류');
        this.emit('message', {
          role: 'system',
          text: `⚠️ 턴 실패: ${errText.slice(0, 300)}`,
          ts: new Date().toISOString(),
        });
        // 히스토리가 현재 모델 컨텍스트 한도 초과 — /compact 자체도 실패하는 상태라 복구 경로 안내
        if (/prompt is too long/i.test(errText)) {
          const ctx = this._contextTokens
            ? `현재 히스토리 약 ${Math.round(this._contextTokens / 10000)}만 토큰 / 한도 ${Math.round(this._contextLimit() / 10000)}만 토큰. `
            : '';
          this.emit('message', {
            role: 'system',
            text: `💡 대화 히스토리가 현재 모델의 컨텍스트 한도를 초과했어요. ${ctx}/model opus 등 큰 모델로 전환한 뒤 /compact 로 압축하고, 필요하면 원래 모델로 돌아오세요.`,
            ts: new Date().toISOString(),
          });
        }
      }
      if (this._autoCompacting) {
        // 방금 끝난 턴이 자동 /compact — 성공했으면 컨텍스트 카운터 리셋
        this._autoCompacting = false;
        if (!ev.is_error) {
          this._contextTokens = 0;
          this.emit('message', {
            role: 'system',
            text: '🗜️ 자동 압축 완료 — 대화를 계속하세요',
            ts: new Date().toISOString(),
          });
        }
      } else if (!ev.is_error && this._contextTokens && this._contextTokens > this._contextLimit() * 0.8) {
        // TUI의 auto-compact 재현: 한도 80% 초과 시 선제 압축 (한도를 넘기 전에 해야 함)
        this._autoCompacting = true;
        this.emit('message', {
          role: 'system',
          text: `🗜️ 컨텍스트 ${Math.round((this._contextTokens / this._contextLimit()) * 100)}% — 자동 압축 중...`,
          ts: new Date().toISOString(),
        });
        this._writeUser('/compact', [], { emitMessage: false });
        return;
      }
      // 대기줄에 메시지가 있으면 waiting을 거치지 않고 바로 다음 턴 투입 (터미널 큐와 동일)
      if (this.queue?.length) {
        const next = this.queue.shift();
        this.emit('queue-flushed');
        this._writeUser(next.text, next.images, { emitMessage: false });
        return;
      }
      this._setState('waiting');
      this.emit('turn-end');
    }
  }

  // 진행 중인 턴만 중단 (세션은 유지) — Claude Code TUI의 ESC와 동일
  interrupt() {
    if (!this.child || this.state !== 'working') return;
    this._interrupting = true;
    this.child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'int-' + Date.now(),
        request: { subtype: 'interrupt' },
      }) + '\n'
    );
    // result 이벤트가 안 오는 경우 대비 안전망
    clearTimeout(this._intTimer);
    this._intTimer = setTimeout(() => {
      if (this._interrupting) {
        this._interrupting = false;
        this._setState('waiting');
        this.emit('turn-end');
      }
    }, 5000);
  }

  // images: [{media_type, data(base64)}]
  // 턴 진행 중에 온 메시지는 터미널처럼 대기줄에 뒀다가 턴이 끝나면 투입
  send(text, images = []) {
    if (!this.child) this.spawn();
    if (this._awaitingTurn) {
      this.queue = this.queue || [];
      this.queue.push({ text, images });
      this.emit('message', {
        role: 'user',
        text,
        images: images.map((img) => `data:${img.media_type};base64,${img.data}`),
        ts: new Date().toISOString(),
        pending: true, // UI: "대기 중" 표시
      });
      return;
    }
    this._writeUser(text, images, { emitMessage: true });
  }

  // 모델별 컨텍스트 한도 (토큰). Haiku만 200K, 나머지 현행 모델은 1M. 미확인 모델은 보수적으로 200K
  _limitFor(modelId) {
    const m = String(modelId || '').toLowerCase();
    if (/haiku/.test(m)) return 200_000;
    if (/fable|mythos|opus|sonnet/.test(m)) return 1_000_000;
    return 200_000;
  }

  _contextLimit() {
    return this._limitFor(this._lastModel);
  }

  // 터미널처럼 /model 입력 즉시 표시를 갱신 (실제 모델은 다음 응답에서 확정·정정됨)
  _applyOptimisticModel(text) {
    const alias = /^\/model\s+(\S+)/.exec(text || '')?.[1];
    if (!alias) return;
    const known = { fable: 'claude-fable-5', opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5' };
    const base = alias.replace('[1m]', '').toLowerCase();
    const id = known[base] || (base.startsWith('claude-') ? base : null);
    if (!id) return;
    // 히스토리가 새 모델 창에 안 들어가면 다음 턴부터 무조건 Prompt is too long — 전환 전에 경고
    if (this._contextTokens && this._contextTokens > this._limitFor(id)) {
      this.emit('message', {
        role: 'system',
        text: `⚠️ 현재 히스토리(약 ${Math.round(this._contextTokens / 10000)}만 토큰)가 ${alias}의 컨텍스트 한도(${Math.round(this._limitFor(id) / 10000)}만 토큰)를 넘어요. 전환하면 모든 메시지가 "Prompt is too long"으로 실패합니다. 먼저 /compact 로 압축하세요.`,
        ts: new Date().toISOString(),
      });
    }
    this._lastModel = id;
    this.emit('info', { model: id, slashCommands: [] });
  }

  _writeUser(text, images, { emitMessage }) {
    this._applyOptimisticModel(text);
    const content = [
      ...images.map((img) => ({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      })),
      ...(text ? [{ type: 'text', text }] : []),
    ];
    // stdin은 버퍼링되므로 init 전에 써도 안전함 (검증됨)
    this.child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
    );
    if (emitMessage) {
      this.emit('message', {
        role: 'user',
        text,
        images: images.map((img) => `data:${img.media_type};base64,${img.data}`),
        ts: new Date().toISOString(),
      });
    }
    this._awaitingTurn = true;
    this.turnStartedAt = Date.now();
    // 이번 턴의 말만 알림에 쓰도록 비운다. 안 지우면 도구만 돌리고 텍스트 없이 끝난 턴에서
    // 직전 턴의 말이 그대로 알림에 실려 "이미 읽은 메시지"가 다시 온다.
    this.lastSay = null;
    this._setActivity('응답 대기 중');
    if (this.state !== 'starting') this._setState('working');
  }

  _setActivity(label) {
    if (this.activity === label) return;
    this.activity = label;
    this.emit('activity');
  }

  // 이미 돌고 있는 세션의 권한 모드를 바꾼다 (TUI의 shift+tab에 해당).
  // 세션이 안 떠 있으면 다음 spawn 때 인자로 들어가므로 저장만 해두면 된다.
  setPermissionMode(mode) {
    this.room.permissionMode = mode;
    this.permissionMode = mode;
    if (this.child) {
      this.child.stdin.write(
        JSON.stringify({
          type: 'control_request',
          request_id: 'pm-' + Date.now(),
          request: { subtype: 'set_permission_mode', mode },
        }) + '\n'
      );
    }
    this.emit('info', { model: this._lastModel || null, slashCommands: [], permissionMode: mode });
  }

  history() {
    if (!this.room.sessionId) return [];
    const items = parseFileSync(sessionFileFor(this.room.dir, this.room.sessionId));
    // 할 일 상태는 세션 처음부터 접어야 나온다 (증분 도구가 섞여 있어 마지막 것만 봐선 안 됨)
    this.tasks = foldTaskOps(items.filter((i) => i.kind === 'task-op'));
    return items.filter((i) => i.kind === 'msg');
  }

  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  kill() {
    if (this.child) {
      try {
        this.child.stdin.end();
        this.child.kill();
      } catch {}
      this.child = null;
    }
    this._setState('offline');
  }
}

module.exports = { HeadlessSession };
