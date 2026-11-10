-- NotchOS web: initial schema (NOTCHOS-WEB-PLAN.md section 4). MariaDB 10.11.
--
-- Conventions
--   * InnoDB, utf8mb4, foreign keys.
--   * Every DATETIME holds UTC with whole seconds. The API sets the session time zone to
--     +00:00 and passes its own clock as a parameter; the column defaults are a safety net.
--   * Identifiers, hashes and tokens are ASCII and compared byte for byte (ascii_bin).
--     Text typed by people (emails, names, notes) is utf8mb4_unicode_ci.
--   * A migration that has been applied is never edited. Changes go into 002 and up.

CREATE TABLE IF NOT EXISTS licenses (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The key itself is never stored in clear text.
  key_hash               CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
                         COMMENT 'SHA-256 (hex) of the canonical key NOS-XXXXX-XXXXX-XXXXX-XXXXX',
  key_enc                VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
                         COMMENT 'AES-256-GCM copy of the key (secret in KEY_ENC_SECRET), lets the server resend it',
  key_hint               CHAR(4) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL
                         COMMENT 'last 4 characters of the key, for support',
  email                  VARCHAR(254) NOT NULL
                         COMMENT 'PayPal payer email, or the address typed by the admin for a manual license',
  payer_id               VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL
                         COMMENT 'PayPal payer id; NULL for manual licenses',
  plan                   ENUM('monthly','lifetime') NOT NULL,
  status                 ENUM('active','revoked') NOT NULL DEFAULT 'active',
  max_devices            SMALLINT UNSIGNED NOT NULL DEFAULT 1
                         COMMENT 'seats; the admin can raise it for one customer',
  period_end             DATETIME NULL
                         COMMENT 'what the buyer has paid for',
  expires_at             DATETIME NULL
                         COMMENT 'what the app enforces; NULL = lifetime',
  auto_renew             TINYINT(1) NOT NULL DEFAULT 0,
  paypal_subscription_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  transfers_used         INT UNSIGNED NOT NULL DEFAULT 0
                         COMMENT 'seat moves made with transfer: true; limit is settings.transfer_limit',
  source                 ENUM('paypal','manual') NOT NULL,
  note                   TEXT NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_licenses_key_hash (key_hash),
  UNIQUE KEY uq_licenses_paypal_subscription_id (paypal_subscription_id),
  KEY ix_licenses_email (email),
  KEY ix_licenses_payer_id (payer_id),
  KEY ix_licenses_key_hint (key_hint),
  KEY ix_licenses_expires_at (expires_at),
  CONSTRAINT ck_licenses_plan_expiry CHECK (
    (plan = 'lifetime' AND expires_at IS NULL) OR (plan = 'monthly' AND expires_at IS NOT NULL)
  ),
  CONSTRAINT ck_licenses_max_devices CHECK (max_devices >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per time a device held a seat. deactivated_at IS NULL means the seat is in use.
-- Every writer locks the parent licenses row first (SELECT ... FOR UPDATE), so the seat
-- check and the seat write are one atomic step.
CREATE TABLE IF NOT EXISTS activations (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id     BIGINT UNSIGNED NOT NULL,
  device_id      VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
                 COMMENT 'hashed device id sent by the app',
  device_name    VARCHAR(100) NULL,
  app_version    VARCHAR(32) NULL,
  activated_at   DATETIME NOT NULL,
  last_seen_at   DATETIME NOT NULL
                 COMMENT 'updated on activate and refresh only',
  deactivated_at DATETIME NULL
                 COMMENT 'NULL = seat in use',
  PRIMARY KEY (id),
  KEY ix_activations_license_seat (license_id, deactivated_at),
  KEY ix_activations_device_id (device_id),
  CONSTRAINT fk_activations_license FOREIGN KEY (license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One trial per device, ever. The dates are fixed by the first call.
CREATE TABLE IF NOT EXISTS trials (
  device_id   VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at  DATETIME NOT NULL,
  expires_at  DATETIME NOT NULL,
  app_version VARCHAR(32) NULL,
  ip          VARCHAR(45) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  PRIMARY KEY (device_id),
  KEY ix_trials_started_at (started_at),
  KEY ix_trials_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PayPal orders created by this server (phase W3). Capture only accepts ids found here.
CREATE TABLE IF NOT EXISTS checkouts (
  paypal_order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan            ENUM('monthly','lifetime') NOT NULL,
  amount          DECIMAL(10,2) NOT NULL,
  currency        CHAR(3) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  status          VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paypal_order_id),
  KEY ix_checkouts_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every PayPal payment and refund (phase W3). paypal_id makes fulfilment idempotent.
CREATE TABLE IF NOT EXISTS payments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id  BIGINT UNSIGNED NULL,
  kind        ENUM('order','subscription','refund') NOT NULL,
  paypal_id   VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  amount      DECIMAL(10,2) NOT NULL,
  currency    CHAR(3) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  payer_email VARCHAR(254) NULL,
  payer_id    VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status      VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  raw_json    MEDIUMTEXT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_paypal_id (paypal_id),
  KEY ix_payments_license_id (license_id),
  KEY ix_payments_payer_id (payer_id),
  KEY ix_payments_created_at (created_at),
  CONSTRAINT fk_payments_license FOREIGN KEY (license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every PayPal webhook received (phase W3). The primary key makes each event run once.
CREATE TABLE IF NOT EXISTS webhook_events (
  paypal_event_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type      VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  verified        TINYINT(1) NOT NULL DEFAULT 0,
  result          VARCHAR(255) NULL,
  raw_json        MEDIUMTEXT NULL,
  received_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (paypal_event_id),
  KEY ix_webhook_events_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every email sent or failed (phase W3).
CREATE TABLE IF NOT EXISTS email_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id BIGINT UNSIGNED NULL,
  to_email   VARCHAR(254) NOT NULL,
  template   VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  status     VARCHAR(16) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  attempts   INT UNSIGNED NOT NULL DEFAULT 0,
  error      TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_email_log_license_id (license_id),
  KEY ix_email_log_status (status, created_at),
  CONSTRAINT fk_email_log_license FOREIGN KEY (license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- License history shown in the admin: activate, refresh, deny, transfer, deactivate,
-- revoke, renew, trial. Never holds a key, a token or a secret.
CREATE TABLE IF NOT EXISTS events (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  license_id BIGINT UNSIGNED NULL
             COMMENT 'NULL for trial events',
  device_id  VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  type       VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  detail     VARCHAR(255) NULL,
  ip         VARCHAR(45) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_events_license (license_id, id),
  KEY ix_events_device_id (device_id),
  KEY ix_events_type_created (type, created_at),
  CONSTRAINT fk_events_license FOREIGN KEY (license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Admin accounts (phase W2). Created from the command line only; there is no sign-up.
CREATE TABLE IF NOT EXISTS admin_users (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username        VARCHAR(64) NOT NULL,
  password_hash   VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
                  COMMENT 'scrypt',
  totp_secret_enc VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
                  COMMENT 'encrypted authenticator secret; login always needs the 6-digit code',
  last_login_at   DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_sessions (
  id_hash    CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
             COMMENT 'SHA-256 (hex) of the session id; the id itself lives only in the cookie',
  admin_id   INT UNSIGNED NOT NULL,
  ip         VARCHAR(45) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (id_hash),
  KEY ix_admin_sessions_admin_id (admin_id),
  KEY ix_admin_sessions_expires_at (expires_at),
  CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who did what in the admin, and when.
CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id   INT UNSIGNED NULL
             COMMENT 'NULL once the admin account is deleted; the row stays',
  action     VARCHAR(64) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  target     VARCHAR(128) NULL,
  detail     TEXT NULL,
  ip         VARCHAR(45) CHARACTER SET ascii COLLATE ascii_general_ci NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_audit_log_admin_id (admin_id),
  KEY ix_audit_log_created_at (created_at),
  CONSTRAINT fk_audit_log_admin FOREIGN KEY (admin_id) REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Values the admin can change. Prices, paypal_plan_id, download_url and app_version are
-- added when they are known (W2 / W3); nothing is invented here.
CREATE TABLE IF NOT EXISTS settings (
  name  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (name, value) VALUES
  ('trial_days', '7'),
  ('transfer_limit', '2'),
  ('renewal_buffer_hours', '24')
ON DUPLICATE KEY UPDATE name = name;
