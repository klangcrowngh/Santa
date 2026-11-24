import { randomBytes, randomInt } from 'node:crypto';
import { budget, isBudget } from '../docs/budget/settings.js';

export class SantaError extends Error {}

export function userName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return Array.from(name).slice(0, 80).join('').trim() || 'Участник';
}

export function createSantaStore(db, { organizerId, transaction, migrate = false }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'drawn')),
      amount INTEGER,
      draw_round INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS participants (
      event_id TEXT REFERENCES events(id),
      user_id INTEGER,
      name TEXT NOT NULL,
      username TEXT,
      budget INTEGER,
      recipient_id INTEGER,
      PRIMARY KEY (event_id, user_id),
      UNIQUE (event_id, recipient_id),
      CHECK (recipient_id IS NULL OR recipient_id <> user_id)
    );
    CREATE INDEX IF NOT EXISTS participants_by_user ON participants(user_id);
    CREATE TABLE IF NOT EXISTS pending_titles (user_id INTEGER PRIMARY KEY);
  `);

  const event = (id) => db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  const member = (id, userId) => db.prepare(
    'SELECT * FROM participants WHERE event_id = ? AND user_id = ?',
  ).get(id, userId);
  const roster = (id) => db.prepare(
    'SELECT * FROM participants WHERE event_id = ? ORDER BY rowid',
  ).all(id);

  if (migrate) transaction(() => {
    const columns = db.prepare('PRAGMA table_info(events)').all();
    if (columns.some(({ name }) => name === 'draw_round')) return;
    db.exec(`
      ALTER TABLE events ADD COLUMN draw_round INTEGER NOT NULL DEFAULT 0;
      UPDATE events SET draw_round = 1 WHERE status = 'drawn';
    `);
  });

  function openEvent(id) {
    const current = event(id);
    if (!current) throw new SantaError('Обмен не найден. Проверьте ссылку-приглашение.');
    if (current.status !== 'open') throw new SantaError('Жеребьёвка уже прошла.');
    return current;
  }

  function addParticipant(id, user) {
    db.prepare(`
      INSERT INTO participants (event_id, user_id, name, username) VALUES (?, ?, ?, ?)
      ON CONFLICT(event_id, user_id) DO UPDATE SET name = excluded.name, username = excluded.username
    `).run(id, user.id, userName(user), user.username ?? null);
  }

  const cancelTitle = (userId) =>
    db.prepare('DELETE FROM pending_titles WHERE user_id = ?').run(userId);
  const canCreate = (userId) => organizerId === undefined || userId === organizerId;

  return {
    event,
    member,
    roster,
    list(userId) {
      return db.prepare(`
        SELECT e.* FROM events e JOIN participants p ON e.id = p.event_id
        WHERE p.user_id = ? ORDER BY e.status DESC, e.rowid DESC
      `).all(userId);
    },
    canCreate,
    requestTitle: (userId) =>
      db.prepare('INSERT OR IGNORE INTO pending_titles VALUES (?)').run(userId),
    needsTitle: (userId) => Boolean(db.prepare(
      'SELECT 1 FROM pending_titles WHERE user_id = ?',
    ).get(userId)),
    cancelTitle,
    create(title, user) {
      if (!canCreate(user.id)) throw new SantaError('Создавать обмен может только организатор.');
      if (typeof title !== 'string' || !title.trim() || Array.from(title.trim()).length > 48) {
        throw new SantaError('Введите название обмена длиной от 1 до 48 символов.');
      }
      return transaction(() => {
        const id = randomBytes(12).toString('base64url');
        db.prepare('INSERT INTO events (id, title, owner_id) VALUES (?, ?, ?)')
          .run(id, title.trim().replace(/\s+/g, ' '), user.id);
        addParticipant(id, user);
        cancelTitle(user.id);
        return event(id);
      });
    },
    join(id, user) {
      return transaction(() => {
        if (!member(id, user.id)) openEvent(id);
        addParticipant(id, user);
      });
    },
    setBudget(id, userId, value) {
      if (!isBudget(value)) throw new SantaError('Выберите сумму в пределах шкалы бюджета.');
      return transaction(() => {
        openEvent(id);
        if (!member(id, userId)) throw new SantaError('Сначала присоединитесь к обмену.');
        db.prepare('UPDATE participants SET budget = ? WHERE event_id = ? AND user_id = ?')
          .run(value, id, userId);
      });
    },
    remove(id, actorId, targetId) {
      return transaction(() => {
        const current = openEvent(id);
        if (targetId === current.owner_id) {
          throw new SantaError('Организатор участвует в своём обмене.');
        }
        if (actorId !== current.owner_id) {
          throw new SantaError('Убирать участников может только организатор.');
        }
        db.prepare('DELETE FROM participants WHERE event_id = ? AND user_id = ?').run(id, targetId);
      });
    },
    draw(id, actorId, expectedRound = 0) {
      return transaction(() => {
        const current = event(id);
        if (!current) throw new SantaError('Обмен не найден.');
        if (current.owner_id !== actorId) throw new SantaError('Жеребьёвку запускает организатор.');
        if (current.draw_round !== expectedRound) {
          throw new SantaError('Жеребьёвка уже обновилась. Откройте актуальный результат.');
        }
        const participants = roster(id);
        drawReady(participants);
        const givers = participants.map(({ user_id }) => user_id);
        const recipients = [...givers];
        do {
          for (let index = recipients.length - 1; index > 0; index--) {
            const other = randomInt(index + 1);
            [recipients[index], recipients[other]] = [recipients[other], recipients[index]];
          }
        } while (recipients.some((recipient, index) => recipient === givers[index])
          || (expectedRound > 0 && givers.length > 2
            && recipients.every((recipient, index) => recipient === participants[index].recipient_id)));
        const update = db.prepare(
          'UPDATE participants SET recipient_id = ? WHERE event_id = ? AND user_id = ?',
        );
        if (expectedRound > 0) {
          db.prepare('UPDATE participants SET recipient_id = NULL WHERE event_id = ?').run(id);
        }
        givers.forEach((giver, index) => update.run(recipients[index], id, giver));
        db.prepare("UPDATE events SET status = 'drawn', amount = ?, draw_round = draw_round + 1 WHERE id = ?")
          .run(current.amount ?? average(participants), id);
        return givers;
      });
    },
  };
}

export function average(participants) {
  return Math.round(participants.reduce((sum, person) => sum + (person.budget ?? budget.initial), 0) / participants.length);
}

export function drawReady(participants) {
  if (participants.length < 2) throw new SantaError('Для жеребьёвки нужны хотя бы два участника.');
}
