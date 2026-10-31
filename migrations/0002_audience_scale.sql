-- Scale the AI audience to ~1M accounts per deployment.
-- Audience accounts are plain profile rows (no ai_agents row) addressed by a dense, indexed slot
-- so growth can walk them with range reads instead of random scans.

ALTER TABLE profiles ADD COLUMN audience_slot INTEGER;
ALTER TABLE profiles ADD COLUMN primary_topic TEXT;
CREATE UNIQUE INDEX idx_profiles_audience_slot ON profiles(audience_slot) WHERE audience_slot IS NOT NULL;
-- Lets "everyone except audience" queries use an index instead of scanning a million rows.
CREATE INDEX idx_profiles_class ON profiles(kind, ai_class, status);

-- Per-profile position in the audience ring (−1 = not started).
ALTER TABLE profile_scores ADD COLUMN audience_cursor INTEGER NOT NULL DEFAULT -1;

-- How many likes the audience engagement job has delivered to a post.
ALTER TABLE posts ADD COLUMN audience_likes INTEGER NOT NULL DEFAULT 0;

-- Migrate audience accounts created by the earlier batch path.
UPDATE profiles
SET audience_slot = (SELECT COUNT(*) FROM profiles p2 WHERE p2.ai_class = 'audience' AND p2.rowid < profiles.rowid),
    primary_topic = CASE WHEN instr(interests, ',') > 0 THEN substr(interests, 1, instr(interests, ',') - 1) ELSE interests END,
    appearance_json = '{}'
WHERE ai_class = 'audience';
DELETE FROM ai_agents WHERE archetype = 'audience';
DELETE FROM profile_scores WHERE profile_id IN (SELECT id FROM profiles WHERE ai_class = 'audience');

-- Decaying count of AI followers lost to attrition (feeds the retention score).
ALTER TABLE profile_scores ADD COLUMN churn_30d REAL NOT NULL DEFAULT 0;
