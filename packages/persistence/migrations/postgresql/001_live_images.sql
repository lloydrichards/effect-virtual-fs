BEGIN;

CREATE TABLE public.effect_vfs_live_images (
  volume_key text PRIMARY KEY,
  generation bigint NOT NULL,
  image bytea NOT NULL,
  digest text NOT NULL
);

COMMENT ON TABLE public.effect_vfs_live_images IS 'effect-vfs-live-images:1';

COMMIT;
