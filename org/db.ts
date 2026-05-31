import Database from "better-sqlite3";
import path from "path";

const db = new Database(path.join(__dirname, "..", "data.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS bots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    token     TEXT    NOT NULL UNIQUE,
    username  TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    status    TEXT    NOT NULL DEFAULT 'active',
    added_at  INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// migrate: add status column if it doesn't exist yet
try {
  db.exec("ALTER TABLE bots ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
} catch {}

export interface BotRecord {
  id: number;
  token: string;
  username: string;
  name: string;
  status: string;
  added_at: number;
}

export const botsDb = {
  getAll(): BotRecord[] {
    return db.prepare("SELECT * FROM bots ORDER BY added_at DESC").all() as BotRecord[];
  },

  getById(id: number): BotRecord | undefined {
    return db.prepare("SELECT * FROM bots WHERE id = ?").get(id) as BotRecord | undefined;
  },

  add(token: string, username: string, name: string): BotRecord {
    return db
      .prepare("INSERT INTO bots (token, username, name) VALUES (?, ?, ?) RETURNING *")
      .get(token, username, name) as BotRecord;
  },

  remove(id: number): void {
    db.prepare("DELETE FROM bots WHERE id = ?").run(id);
  },

  findByToken(token: string): BotRecord | undefined {
    return db.prepare("SELECT * FROM bots WHERE token = ?").get(token) as BotRecord | undefined;
  },
};

export default db;
