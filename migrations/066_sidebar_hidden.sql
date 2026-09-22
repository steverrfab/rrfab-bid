-- Per-person sidebar. A JSON array of the nav keys this user has ticked off in
-- Customize, e.g. ["tax","trash"]. Empty array means the normal sidebar.
-- Hiding is not permission: page_access still decides what anyone may open, and
-- a hidden item comes straight back when they untick it in Customize.
ALTER TABLE users ADD COLUMN sidebar_hidden TEXT NOT NULL DEFAULT '[]';
