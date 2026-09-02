/** Append-only. Never edit an entry that has shipped; add a new one. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user','integration_admin','app_admin')),
    password_hash TEXT,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    auth_source TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE plans (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    thought TEXT NOT NULL DEFAULT '',
    facts TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready','handed_off')),
    brief TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX plans_owner ON plans(owner_id, updated_at);
  CREATE TABLE pieces (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('input','transform','output')),
    position INTEGER NOT NULL,
    slots TEXT NOT NULL DEFAULT '{}',
    label TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX pieces_plan ON pieces(plan_id, position);
  CREATE TABLE helper_messages (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL,
    payload TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX helper_messages_plan ON helper_messages(plan_id, created_at);
  CREATE TABLE llm_providers (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('anthropic','openai','openai_compatible')),
    label TEXT NOT NULL,
    model TEXT NOT NULL,
    api_key_enc TEXT,
    base_url TEXT,
    is_active INTEGER NOT NULL DEFAULT 0,
    last_test_at TEXT,
    last_test_ok INTEGER,
    last_test_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE plugin_settings (
    plugin_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1,
    owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    guidance TEXT,
    setup_notes TEXT,
    overrides TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT,
    actor_email TEXT,
    action TEXT NOT NULL,
    target TEXT,
    details TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE oidc_flows (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    redirect_to TEXT,
    created_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE users ADD COLUMN oidc_sub TEXT;
  CREATE UNIQUE INDEX users_oidc_sub ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;
  `,
];
