// SQLite persistence (Node built-in node:sqlite, no external dependency).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        tokens TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS results_room ON results(room_id, created_at);
    `);
    this.q = {
      saveRoom: this.db.prepare(
        `INSERT INTO rooms (id, state, tokens, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET state = excluded.state, tokens = excluded.tokens, updated_at = excluded.updated_at`
      ),
      allRooms: this.db.prepare(`SELECT id, state, tokens FROM rooms`),
      deleteRoom: this.db.prepare(`DELETE FROM rooms WHERE id = ?`),
      staleRooms: this.db.prepare(`SELECT id FROM rooms WHERE updated_at < ?`),
      saveResult: this.db.prepare(`INSERT OR IGNORE INTO results (id, room_id, data, created_at) VALUES (?, ?, ?, ?)`),
      getResult: this.db.prepare(`SELECT data FROM results WHERE id = ?`),
      roomResults: this.db.prepare(`SELECT data FROM results WHERE room_id = ? ORDER BY created_at DESC LIMIT 50`),
    };
  }

  saveRoom(room, tokens) {
    const draft = room.draft ? { ...room.draft, preview: null } : null;
    this.q.saveRoom.run(room.id, JSON.stringify({ ...room, draft }), JSON.stringify(tokens), room.updatedAt);
  }

  loadRooms() {
    return this.q.allRooms.all().map((r) => ({ room: JSON.parse(r.state), tokens: JSON.parse(r.tokens) }));
  }

  deleteRoom(id) {
    this.q.deleteRoom.run(id);
  }

  staleRoomIds(before) {
    return this.q.staleRooms.all(before).map((r) => r.id);
  }

  saveResult(result) {
    this.q.saveResult.run(result.id, result.roomId, JSON.stringify(result), result.finishedAt);
  }

  getResult(id) {
    const r = this.q.getResult.get(id);
    return r ? JSON.parse(r.data) : null;
  }

  roomResults(roomId) {
    return this.q.roomResults.all(roomId).map((r) => JSON.parse(r.data));
  }

  close() {
    this.db.close();
  }
}
