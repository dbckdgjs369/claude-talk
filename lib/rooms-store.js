// rooms.json 영속화 (userData 디렉토리)
// 형식: { rooms: [...], ignoredSessions: [...] } — 구버전(배열)에서 자동 마이그레이션
const fs = require('fs');
const path = require('path');

class RoomsStore {
  constructor(userDataDir) {
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

  save() {
    const rooms = this.rooms.map(({ id, dir, name, aiTitle, sessionId, lastPreview, lastTime, model, slashCommands }) => ({
      id, dir, name, aiTitle, sessionId, lastPreview, lastTime, model, slashCommands,
    }));
    fs.writeFileSync(this.file, JSON.stringify({ rooms, ignoredSessions: [...this.ignoredSessions] }, null, 2));
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
