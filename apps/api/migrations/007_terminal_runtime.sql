CREATE TABLE terminal_runtime_owners (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
ALTER TABLE terminal_sessions ADD COLUMN runtime_owner_id integer REFERENCES terminal_runtime_owners(id);
CREATE INDEX terminal_sessions_owner_active_idx ON terminal_sessions(runtime_owner_id) WHERE status='active';
-- Existing rows intentionally remain ownerless: only an operator who has verified
-- that all pre-upgrade APIs are stopped can reconcile these legacy sessions.
