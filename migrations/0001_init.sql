-- Crew Plus initial schema.
-- All timestamps are UTC milliseconds since the Unix epoch (INTEGER).
-- IDs are application-generated sortable strings (see src/worker/lib/ids.ts).

PRAGMA foreign_keys = ON;

-- ───────────────────────── Identity & auth ─────────────────────────

-- A login identity: the secret-holder. Owns one or more profiles via profile_members.
CREATE TABLE identities (
  id                 TEXT PRIMARY KEY,
  pin_hash           TEXT NOT NULL,             -- base64 PBKDF2-SHA256 output
  pin_salt           TEXT NOT NULL,             -- base64 16-byte random salt
  pin_iterations     INTEGER NOT NULL,
  recovery_hash      TEXT,                      -- SHA-256 of the one-time recovery code
  admin_secret_hash  TEXT,                      -- PBKDF2 hash of the admin passphrase (admins only)
  admin_secret_salt  TEXT,
  failed_attempts    INTEGER NOT NULL DEFAULT 0,
  locked_until       INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at         INTEGER NOT NULL,
  last_login_at      INTEGER
);

CREATE TABLE sessions (
  token_hash          TEXT PRIMARY KEY,         -- SHA-256 of the random session token; raw token only lives in the cookie
  identity_id         TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  active_profile_id   TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  expires_at          INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  elevated_until      INTEGER NOT NULL DEFAULT 0, -- admin step-up window
  user_agent          TEXT
);
CREATE INDEX idx_sessions_identity ON sessions(identity_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Sliding-window rate limit / lockout buckets (keyed by e.g. "login:ip:<hash>" or "login:handle:<handle>").
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0
);

-- Admin-issued one-time PIN reset codes (assisted recovery).
CREATE TABLE recovery_tokens (
  id           TEXT PRIMARY KEY,
  identity_id  TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  issued_by    TEXT NOT NULL,                   -- admin identity id
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);

-- ───────────────────────── Profiles ─────────────────────────

CREATE TABLE profiles (
  id                 TEXT PRIMARY KEY,
  handle             TEXT NOT NULL UNIQUE,      -- normalized lowercase
  handle_display     TEXT NOT NULL,             -- preserves capitalization
  display_name       TEXT NOT NULL,
  bio                TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  website            TEXT NOT NULL DEFAULT '',
  kind               TEXT NOT NULL CHECK (kind IN ('personal','business','ai')),
  ai_class           TEXT CHECK (ai_class IN ('persona','audience')), -- only for kind='ai'
  avatar_media_id    TEXT,
  banner_media_id    TEXT,
  avatar_seed        TEXT NOT NULL,             -- deterministic generated avatar when no upload
  theme_id           TEXT NOT NULL DEFAULT 'aurora-borealis',
  appearance_json    TEXT NOT NULL DEFAULT '{}',
  appearance_version INTEGER NOT NULL DEFAULT 1,
  interests          TEXT NOT NULL DEFAULT '',  -- comma-separated topic slugs
  is_private         INTEGER NOT NULL DEFAULT 0,
  likes_public       INTEGER NOT NULL DEFAULT 1,
  dm_policy          TEXT NOT NULL DEFAULT 'following' CHECK (dm_policy IN ('everyone','following','none')),
  allow_ai_replies   INTEGER NOT NULL DEFAULT 1,
  allow_ai_dms       INTEGER NOT NULL DEFAULT 1,
  allow_ai_discovery INTEGER NOT NULL DEFAULT 1, -- AI accounts may discover/follow/recommend this profile
  notification_prefs TEXT NOT NULL DEFAULT '{}',
  visibility         INTEGER NOT NULL DEFAULT 50 CHECK (visibility BETWEEN 0 AND 100),
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  follower_count     INTEGER NOT NULL DEFAULT 0, -- cached; reconciled from follows
  following_count    INTEGER NOT NULL DEFAULT 0,
  post_count         INTEGER NOT NULL DEFAULT 0,
  counts_dirty       INTEGER NOT NULL DEFAULT 0,
  pinned_post_id     TEXT,
  onboarded          INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_profiles_kind ON profiles(kind, status);
CREATE INDEX idx_profiles_followers ON profiles(follower_count DESC);
CREATE INDEX idx_profiles_dirty ON profiles(counts_dirty) WHERE counts_dirty = 1;
CREATE INDEX idx_profiles_created ON profiles(created_at DESC);

-- Explicit ownership: which identities may act as which profiles.
CREATE TABLE profile_members (
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  identity_id  TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','manager')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (profile_id, identity_id)
);
CREATE INDEX idx_profile_members_identity ON profile_members(identity_id);

CREATE TABLE business_profiles (
  profile_id   TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,
  website      TEXT NOT NULL DEFAULT '',
  created_by   TEXT NOT NULL                    -- identity id
);

CREATE TABLE affiliations (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  affiliate_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  relation_type  TEXT NOT NULL CHECK (relation_type IN ('parent_company','subsidiary','partner','brand','creator_affiliate')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined','removed')),
  requested_by   TEXT NOT NULL,                 -- profile id that initiated
  created_at     INTEGER NOT NULL,
  responded_at   INTEGER,
  UNIQUE (business_id, affiliate_id)
);
CREATE INDEX idx_affiliations_affiliate ON affiliations(affiliate_id, status);

-- Growth & ranking signals per profile (recomputed in the background).
CREATE TABLE profile_scores (
  profile_id     TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  quality        REAL NOT NULL DEFAULT 0.5,
  consistency    REAL NOT NULL DEFAULT 0,
  engagement     REAL NOT NULL DEFAULT 0,
  retention      REAL NOT NULL DEFAULT 1,
  spam_penalty   REAL NOT NULL DEFAULT 0,
  growth_score   REAL NOT NULL DEFAULT 0,
  ai_follows_today INTEGER NOT NULL DEFAULT 0,
  ai_follows_day   TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL
);

-- ───────────────────────── Social graph ─────────────────────────

CREATE TABLE follows (
  follower_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  followee_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source       TEXT NOT NULL DEFAULT 'human' CHECK (source IN ('human','ai')),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows(followee_id, created_at DESC);
CREATE INDEX idx_follows_follower_time ON follows(follower_id, created_at DESC);

CREATE TABLE follow_requests (
  requester_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (requester_id, target_id)
);
CREATE INDEX idx_follow_requests_target ON follow_requests(target_id, created_at DESC);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX idx_blocks_blocked ON blocks(blocked_id);

CREATE TABLE mutes (
  muter_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  muted_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (muter_id, muted_id)
);

-- ───────────────────────── Posts ─────────────────────────

CREATE TABLE posts (
  id                TEXT PRIMARY KEY,
  author_id         TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  text              TEXT NOT NULL DEFAULT '',
  reply_to_id       TEXT REFERENCES posts(id) ON DELETE SET NULL,
  root_id           TEXT,                       -- thread root (self for top-level)
  quote_of_id       TEXT REFERENCES posts(id) ON DELETE SET NULL,
  thread_depth      INTEGER NOT NULL DEFAULT 0,
  ai_generated      INTEGER NOT NULL DEFAULT 0,
  like_count        INTEGER NOT NULL DEFAULT 0,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  repost_count      INTEGER NOT NULL DEFAULT 0,
  quote_count       INTEGER NOT NULL DEFAULT 0,
  quality_score     REAL NOT NULL DEFAULT 0.5,
  content_hash      TEXT NOT NULL DEFAULT '',   -- normalized text hash for duplicate detection
  topics            TEXT NOT NULL DEFAULT '',   -- comma-separated inferred topic slugs
  moderation_status TEXT NOT NULL DEFAULT 'ok' CHECK (moderation_status IN ('ok','flagged','removed')),
  created_at        INTEGER NOT NULL,
  edited_at         INTEGER,
  deleted_at        INTEGER
);
CREATE INDEX idx_posts_author_time ON posts(author_id, created_at DESC);
CREATE INDEX idx_posts_reply_to ON posts(reply_to_id, created_at);
CREATE INDEX idx_posts_root ON posts(root_id, created_at);
CREATE INDEX idx_posts_time ON posts(created_at DESC);
CREATE INDEX idx_posts_quote ON posts(quote_of_id);
CREATE INDEX idx_posts_author_hash ON posts(author_id, content_hash);

CREATE TABLE post_revisions (
  id         TEXT PRIMARY KEY,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_post_revisions_post ON post_revisions(post_id, created_at);

CREATE TABLE likes (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, post_id)
);
CREATE INDEX idx_likes_post ON likes(post_id, created_at DESC);
CREATE INDEX idx_likes_profile_time ON likes(profile_id, created_at DESC);

CREATE TABLE reposts (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, post_id)
);
CREATE INDEX idx_reposts_post ON reposts(post_id);
CREATE INDEX idx_reposts_profile_time ON reposts(profile_id, created_at DESC);

CREATE TABLE hashtags (
  tag          TEXT PRIMARY KEY,                -- lowercase without '#'
  display      TEXT NOT NULL,
  post_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE post_hashtags (
  post_id    TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  author_id  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag)
);
CREATE INDEX idx_post_hashtags_tag_time ON post_hashtags(tag, created_at DESC);
CREATE INDEX idx_post_hashtags_time ON post_hashtags(created_at);

CREATE TABLE mentions (
  post_id     TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, profile_id)
);
CREATE INDEX idx_mentions_profile ON mentions(profile_id);

-- Full-text search over live posts (external content table).
CREATE VIRTUAL TABLE posts_fts USING fts5(text, content='posts', content_rowid='rowid', tokenize='porter unicode61');
CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN
  INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER posts_fts_ad AFTER DELETE ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;
CREATE TRIGGER posts_fts_au AFTER UPDATE OF text ON posts BEGIN
  INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TABLE trends (
  tag           TEXT PRIMARY KEY,
  score         REAL NOT NULL,
  post_count    INTEGER NOT NULL,
  author_count  INTEGER NOT NULL,
  computed_at   INTEGER NOT NULL
);

-- ───────────────────────── Media ─────────────────────────

CREATE TABLE media (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  purpose           TEXT NOT NULL CHECK (purpose IN ('post','message','profile')),
  post_id           TEXT REFERENCES posts(id) ON DELETE SET NULL,
  message_id        TEXT,
  r2_key            TEXT NOT NULL UNIQUE,
  thumb_key         TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('image','video')),
  mime              TEXT NOT NULL,
  size_bytes        INTEGER NOT NULL,
  width             INTEGER,
  height            INTEGER,
  alt_text          TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','expiring','expired','deleting','deleted','failed')),
  moderation_status TEXT NOT NULL DEFAULT 'ok' CHECK (moderation_status IN ('ok','flagged','removed')),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER,                    -- NULL = no automatic expiry (profile assets)
  attached_at       INTEGER,
  delete_attempts   INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  removed_at        INTEGER
);
CREATE INDEX idx_media_expiry ON media(expires_at) WHERE status = 'ready' AND expires_at IS NOT NULL;
CREATE INDEX idx_media_post ON media(post_id);
CREATE INDEX idx_media_message ON media(message_id);
CREATE INDEX idx_media_status ON media(status, created_at);
CREATE INDEX idx_media_unattached ON media(created_at) WHERE attached_at IS NULL;

-- ───────────────────────── Notifications ─────────────────────────

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  recipient_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,                  -- follow, like, reply, mention, repost, quote, message, milestone, follow_request, affiliate, system
  actor_id      TEXT,
  post_id       TEXT,
  group_key     TEXT,                           -- batching key, e.g. like:<post>
  actor_count   INTEGER NOT NULL DEFAULT 1,
  data_json     TEXT NOT NULL DEFAULT '{}',
  read_at       INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, updated_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(recipient_id, read_at);
CREATE INDEX idx_notifications_group ON notifications(recipient_id, group_key, read_at);

-- ───────────────────────── Direct messages ─────────────────────────

CREATE TABLE conversations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('direct','group')),
  direct_key      TEXT UNIQUE,                  -- sorted "a:b" for direct conversations
  title           TEXT,
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL
);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at       INTEGER NOT NULL,
  last_read_at    INTEGER NOT NULL DEFAULT 0,
  muted           INTEGER NOT NULL DEFAULT 0,
  left_at         INTEGER,
  PRIMARY KEY (conversation_id, profile_id)
);
CREATE INDEX idx_conv_members_profile ON conversation_members(profile_id);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id        TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  text             TEXT,
  ai_generated     INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  deleted_at       INTEGER                      -- deleted for everyone: text cleared, media scheduled for deletion
);
CREATE INDEX idx_messages_conv_time ON messages(conversation_id, created_at DESC);

CREATE TABLE message_hidden (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, profile_id)
);

-- ───────────────────────── Milestones ─────────────────────────

CREATE TABLE milestones (
  profile_id        TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  level             INTEGER NOT NULL CHECK (level BETWEEN 1 AND 8),
  threshold         INTEGER NOT NULL,
  follower_count_at INTEGER NOT NULL,
  achieved_at       INTEGER NOT NULL,
  PRIMARY KEY (profile_id, level)
);

-- ───────────────────────── Moderation ─────────────────────────

CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('post','profile','message','media')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  resolution   TEXT,
  resolved_by  TEXT,
  resolved_at  INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (reporter_id, target_type, target_id)
);
CREATE INDEX idx_reports_status ON reports(status, created_at DESC);

-- ───────────────────────── Administration ─────────────────────────

CREATE TABLE admin_roles (
  identity_id  TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','moderator')),
  granted_by   TEXT,
  granted_at   INTEGER NOT NULL
);

CREATE TABLE admin_audit (
  id                 TEXT PRIMARY KEY,
  actor_identity_id  TEXT NOT NULL,
  actor_profile_id   TEXT,
  action             TEXT NOT NULL,
  target_type        TEXT,
  target_id          TEXT,
  before_json        TEXT,
  after_json         TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX idx_admin_audit_time ON admin_audit(created_at DESC);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

CREATE TABLE ops_log (
  id          TEXT PRIMARY KEY,
  level       TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  source      TEXT NOT NULL,
  message     TEXT NOT NULL,
  data_json   TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_ops_log_time ON ops_log(created_at DESC);
CREATE INDEX idx_ops_log_level ON ops_log(level, created_at DESC);

-- ───────────────────────── AI population ─────────────────────────

CREATE TABLE ai_agents (
  profile_id        TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  archetype         TEXT NOT NULL,
  personality_json  TEXT NOT NULL,              -- traits, voice, quirks, dislikes
  interests         TEXT NOT NULL,              -- comma-separated topic slugs
  keywords          TEXT NOT NULL DEFAULT '',   -- comma-separated lowercase keywords
  activity_level    TEXT NOT NULL CHECK (activity_level IN ('daily','regular','occasional','rare')),
  chattiness        REAL NOT NULL DEFAULT 0.5,  -- propensity to reply vs. just like
  selectivity       REAL NOT NULL DEFAULT 0.5,  -- higher = harder to impress
  enabled           INTEGER NOT NULL DEFAULT 1,
  state             TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','queued','active','paused','disabled')),
  next_wake_at      INTEGER NOT NULL DEFAULT 0,
  last_active_at    INTEGER,
  actions_day       TEXT NOT NULL DEFAULT '',
  actions_today     INTEGER NOT NULL DEFAULT 0,
  generations_today INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_ai_agents_wake ON ai_agents(enabled, next_wake_at);

CREATE TABLE ai_memories (
  id                 TEXT PRIMARY KEY,
  agent_id           TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject_profile_id TEXT,                      -- who the memory is about (NULL = self/general)
  kind               TEXT NOT NULL CHECK (kind IN ('own_post','interaction','preference','conversation_summary','fact')),
  content            TEXT NOT NULL,
  certainty          TEXT NOT NULL DEFAULT 'known' CHECK (certainty IN ('known','inferred','uncertain')),
  source_ref         TEXT,                      -- post/conversation id the memory came from
  scope              TEXT NOT NULL DEFAULT 'public' CHECK (scope IN ('public','dm')),
  weight             REAL NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER
);
CREATE INDEX idx_ai_memories_agent_subject ON ai_memories(agent_id, subject_profile_id, created_at DESC);
CREATE INDEX idx_ai_memories_agent_time ON ai_memories(agent_id, created_at DESC);

-- One row per (agent, target, kind) decision; also the dedupe ledger.
CREATE TABLE ai_interactions (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_profile_id TEXT,
  post_id           TEXT,
  kind              TEXT NOT NULL,              -- like, reply, repost, follow, unfollow, post, dm_reply, skip
  dedupe_key        TEXT NOT NULL UNIQUE,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_ai_interactions_agent_time ON ai_interactions(agent_id, created_at DESC);
CREATE INDEX idx_ai_interactions_target_time ON ai_interactions(target_profile_id, kind, created_at DESC);
CREATE INDEX idx_ai_interactions_post ON ai_interactions(post_id, kind);
CREATE INDEX idx_ai_interactions_kind_time ON ai_interactions(kind, created_at);

-- Job ledger for queue idempotency and operational visibility.
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  queue       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  dedupe_key  TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','skipped','failed','dead')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_jobs_status ON jobs(status, updated_at DESC);
CREATE INDEX idx_jobs_created ON jobs(created_at);

CREATE TABLE ai_usage (
  day            TEXT NOT NULL,                 -- YYYY-MM-DD UTC
  model          TEXT NOT NULL,
  task           TEXT NOT NULL,
  calls          INTEGER NOT NULL DEFAULT 0,
  errors         INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, model, task)
);

-- ───────────────────────── Count maintenance ─────────────────────────
-- Cached counters are maintained in the same statement as the relationship row, so they
-- cannot drift on success/failure. A background reconciler re-derives them from the
-- relationship tables (see src/worker/jobs/reconcile.ts).

CREATE TRIGGER follows_ai AFTER INSERT ON follows BEGIN
  UPDATE profiles SET follower_count = follower_count + 1 WHERE id = new.followee_id;
  UPDATE profiles SET following_count = following_count + 1 WHERE id = new.follower_id;
END;
CREATE TRIGGER follows_ad AFTER DELETE ON follows BEGIN
  UPDATE profiles SET follower_count = MAX(follower_count - 1, 0) WHERE id = old.followee_id;
  UPDATE profiles SET following_count = MAX(following_count - 1, 0) WHERE id = old.follower_id;
END;
CREATE TRIGGER likes_ai AFTER INSERT ON likes BEGIN
  UPDATE posts SET like_count = like_count + 1 WHERE id = new.post_id;
END;
CREATE TRIGGER likes_ad AFTER DELETE ON likes BEGIN
  UPDATE posts SET like_count = MAX(like_count - 1, 0) WHERE id = old.post_id;
END;
CREATE TRIGGER reposts_ai AFTER INSERT ON reposts BEGIN
  UPDATE posts SET repost_count = repost_count + 1 WHERE id = new.post_id;
END;
CREATE TRIGGER reposts_ad AFTER DELETE ON reposts BEGIN
  UPDATE posts SET repost_count = MAX(repost_count - 1, 0) WHERE id = old.post_id;
END;
