// rooms.json 영속화 (userData 디렉토리)
// 형식: { rooms: [...], ignoredSessions: [...] } — 구버전(배열)에서 자동 마이그레이션
const fs = require('fs');
const path = require('path');

class RoomsStore {
  // onError: 저장 실패를 사용자에게 알릴 콜백. 없으면 콘솔에만 남긴다.
  constructor(userDataDir, onError) {
    this.onError = onError;
    this.file = path.join(userDataDir, 'rooms.json');
    const data = this._load();
    this.rooms = data.rooms;
    this.ignoredSessions = new Set(data.ignoredSessions);
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data)) return { rooms: data, ignoredSessions: [] }; // 구버전
      return { rooms: data.rooms || [], ignoredSessions: data.ignoredSessions || [] };
    } catch {
      return { rooms: [], ignoredSessions: [] };
    }
  }

  // 저장 실패가 앱을 죽이면 안 된다. 이건 4초마다 도는 pollFileChanges 타이머에서도 불리는데,
  // 타이머 콜백에서 새는 예외는 uncaughtException이 되어 메인 프로세스를 통째로 내린다.
  // (실제로 겪은 케이스: userData 디렉토리가 밑에서 사라짐. 그 외 디스크 꽉 참·권한·백신 잠금 등)
  save() {
    const rooms = this.rooms.map(({ id, dir, name, aiTitle, sessionId, lastPreview, lastTime, model, slashCommands }) => ({
      id, dir, name, aiTitle, sessionId, lastPreview, lastTime, model, slashCommands,
    }));
    const json = JSON.stringify({ rooms, ignoredSessions: [...this.ignoredSessions] }, null, 2);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true }); // 디렉토리가 없어졌을 수도
      fs.writeFileSync(this.file, json);
      this.lastSaveError = null;
    } catch (err) {
      // 다음 저장 때 다시 시도한다 — 메모리 상태는 멀쩡하므로 앱은 계속 쓸 수 있다.
      // 다만 조용히 넘기면 "방이 사라졌다"로만 드러나므로 한 번은 알린다.
      if (this.lastSaveError !== err.code) {
        console.error('rooms.json 저장 실패:', err.message);
        this.onError?.(err);
      }
      this.lastSaveError = err.code;
    }
  }

  add(room) {
    this.rooms.push(room);
    this.save();
    return room;
  }

  remove(id) {
    const room = this.get(id);
    // 삭제한 과거 세션이 다음 시작 때 다시 합류하지 않도록 기억
    if (room?.sessionId) this.ignoredSessions.add(room.sessionId);
    this.rooms = this.rooms.filter((r) => r.id !== id);
    this.save();
  }

  get(id) {
    return this.rooms.find((r) => r.id === id);
  }
}

module.exports = { RoomsStore };
