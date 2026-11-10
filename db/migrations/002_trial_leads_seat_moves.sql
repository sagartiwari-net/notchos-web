-- Trial website leads + optional email on trials + seat move history for support.
-- See Lumen/NOTCHOS-TRIAL-SEAT-PLAN.md. Applied migrations are never edited.

-- Website email capture before download. Does not start a trial.
CREATE TABLE IF NOT EXISTS trial_leads (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email                     VARCHAR(254) NOT NULL,
  status                    ENUM('new','mailed','bounced','converted') NOT NULL DEFAULT 'new',
  download_sent_at          DATETIME NULL,
  resend_count              INT UNSIGNED NOT NULL DEFAULT 0,
  converted_trial_device_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  converted_license_id      BIGINT UNSIGNED NULL,
  ip                        VARCHAR(45) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  user_agent                VARCHAR(512) NULL,
  created_at                DATETIME NOT NULL,
  updated_at                DATETIME NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_trial_leads_email (email),
  KEY ix_trial_leads_status (status),
  KEY ix_trial_leads_created_at (created_at),
  CONSTRAINT fk_trial_leads_license FOREIGN KEY (converted_license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Optional support email on a device trial; still one trial per device forever.
ALTER TABLE trials
  ADD COLUMN email VARCHAR(254) NULL AFTER device_id,
  ADD COLUMN lead_id BIGINT UNSIGNED NULL AFTER ip,
  ADD KEY ix_trials_email (email),
  ADD CONSTRAINT fk_trials_lead FOREIGN KEY (lead_id) REFERENCES trial_leads (id);

-- Support-first log of unlink / transfer / admin free-seat.
CREATE TABLE IF NOT EXISTS seat_moves (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id             BIGINT UNSIGNED NOT NULL,
  email                  VARCHAR(254) NOT NULL,
  key_hint               CHAR(4) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  from_device_id         VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  from_device_name       VARCHAR(100) NULL,
  to_device_id           VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_device_name         VARCHAR(100) NULL,
  reason                 ENUM(
                           'user_deactivate',
                           'user_transfer',
                           'admin_free_seat',
                           'admin_revoke'
                         ) NOT NULL,
  transfers_used_after   INT UNSIGNED NOT NULL,
  transfers_left_after   INT UNSIGNED NOT NULL,
  actor                  ENUM('user','admin','system') NOT NULL,
  admin_id               INT UNSIGNED NULL,
  ip                     VARCHAR(45) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  detail                 VARCHAR(512) NULL,
  created_at             DATETIME NOT NULL,
  PRIMARY KEY (id),
  KEY ix_seat_moves_license (license_id, created_at),
  KEY ix_seat_moves_email (email, created_at),
  KEY ix_seat_moves_from_device (from_device_id),
  KEY ix_seat_moves_to_device (to_device_id),
  KEY ix_seat_moves_created_at (created_at),
  CONSTRAINT fk_seat_moves_license FOREIGN KEY (license_id) REFERENCES licenses (id),
  CONSTRAINT fk_seat_moves_admin FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
