CREATE TABLE effect_vfs_live_images (
  volume_key TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL,
  image BLOB NOT NULL,
  digest TEXT NOT NULL
) STRICT;

CREATE TABLE effect_vfs_live_images_schema (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version = 1)
) STRICT;

INSERT INTO effect_vfs_live_images_schema (id, version) VALUES (1, 1);
