import type { Db } from "../db/index.js";
import { now } from "../db/index.js";
import { hashPassword } from "../crypto.js";
import { uuid, type Role, type User } from "../db/models.js";

export function findUserByEmail(db: Db, email: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as User | undefined;
}
export function findUserById(db: Db, id: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
}
export function findUserByOidcSub(db: Db, sub: string): User | undefined {
  return db.prepare("SELECT * FROM users WHERE oidc_sub = ?").get(sub) as User | undefined;
}
export function countUsers(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
}
export function listUsers(db: Db): User[] {
  return db.prepare("SELECT * FROM users ORDER BY created_at").all() as User[];
}

export function createUser(
  db: Db,
  input: { email: string; name: string; role: Role; password?: string; mustChangePassword?: boolean; authSource?: string; oidcSub?: string },
): User {
  const id = uuid();
  db.prepare(
    "INSERT INTO users (id, email, name, role, password_hash, must_change_password, disabled, auth_source, oidc_sub, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
  ).run(id, input.email.trim().toLowerCase(), input.name.trim(), input.role, input.password ? hashPassword(input.password) : null, input.mustChangePassword ? 1 : 0, input.authSource ?? "local", input.oidcSub ?? null, now());
  return findUserById(db, id)!;
}

export function updateUser(db: Db, id: string, patch: Partial<{ name: string; role: Role; disabled: boolean; password: string; mustChangePassword: boolean; lastLoginAt: string; oidcSub: string | null; authSource: string }>): User {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (patch.name !== undefined) (sets.push("name = ?"), args.push(patch.name.trim()));
  if (patch.role !== undefined) (sets.push("role = ?"), args.push(patch.role));
  if (patch.disabled !== undefined) (sets.push("disabled = ?"), args.push(patch.disabled ? 1 : 0));
  if (patch.password !== undefined) (sets.push("password_hash = ?"), args.push(hashPassword(patch.password)));
  if (patch.mustChangePassword !== undefined) (sets.push("must_change_password = ?"), args.push(patch.mustChangePassword ? 1 : 0));
  if (patch.lastLoginAt !== undefined) (sets.push("last_login_at = ?"), args.push(patch.lastLoginAt));
  if (patch.oidcSub !== undefined) (sets.push("oidc_sub = ?"), args.push(patch.oidcSub));
  if (patch.authSource !== undefined) (sets.push("auth_source = ?"), args.push(patch.authSource));
  if (sets.length) db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  return findUserById(db, id)!;
}

export function deleteUser(db: Db, id: string): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

/** A readable one-time password: four short words and a number. */
export function temporaryPassword(): string {
  const words = ["amber", "birch", "cedar", "delta", "ember", "fjord", "grove", "harbor", "indigo", "juniper", "kestrel", "lumen", "marble", "nectar", "orbit", "pebble", "quartz", "ripple", "saffron", "tundra", "umber", "velvet", "willow", "zephyr"];
  const pick = () => words[Math.floor(Math.random() * words.length)]!;
  return `${pick()}-${pick()}-${pick()}-${Math.floor(10 + Math.random() * 90)}`;
}
