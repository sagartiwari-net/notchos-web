-- W3a / W5 / W6 foundation: locked prices, coupons, social share submissions, invoices.
-- Lifetime $15 · Monthly $3 · coupons Lifetime-only · social links for admin review.
-- Applied migrations are never edited.

INSERT INTO settings (name, value) VALUES
  ('price_monthly', '3.00'),
  ('price_lifetime', '15.00')
ON DUPLICATE KEY UPDATE value = VALUES(value);

CREATE TABLE IF NOT EXISTS coupons (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                 VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  kind                 ENUM('admin','social') NOT NULL,
  percent              TINYINT UNSIGNED NOT NULL,
  plan_scope           ENUM('lifetime') NOT NULL DEFAULT 'lifetime',
  max_redemptions      INT UNSIGNED NOT NULL DEFAULT 1,
  redemption_count     INT UNSIGNED NOT NULL DEFAULT 0,
  status               ENUM('active','used','expired','void') NOT NULL DEFAULT 'active',
  expires_at           DATETIME NULL,
  created_by_admin_id  INT UNSIGNED NULL,
  social_submission_id BIGINT UNSIGNED NULL,
  note                 VARCHAR(255) NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coupons_code (code),
  KEY ix_coupons_status (status),
  KEY ix_coupons_kind (kind),
  CONSTRAINT fk_coupons_admin FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS social_share_submissions (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contact_email          VARCHAR(255) NOT NULL,
  linkedin_url           VARCHAR(512) NULL,
  facebook_url           VARCHAR(512) NULL,
  instagram_url          VARCHAR(512) NULL,
  instagram_profile_url  VARCHAR(512) NULL,
  x_url                  VARCHAR(512) NULL,
  networks_claimed       TINYINT UNSIGNED NOT NULL,
  percent_requested      TINYINT UNSIGNED NOT NULL,
  coupon_id              BIGINT UNSIGNED NULL,
  status                 ENUM(
                           'submitted',
                           'coupon_issued',
                           'reviewed_ok',
                           'reviewed_bad',
                           'converted_monthly'
                         ) NOT NULL DEFAULT 'submitted',
  admin_note             VARCHAR(512) NULL,
  reviewed_at            DATETIME NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_social_email (contact_email),
  KEY ix_social_status (status),
  KEY ix_social_created (created_at),
  CONSTRAINT fk_social_coupon FOREIGN KEY (coupon_id) REFERENCES coupons (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE coupons
  ADD CONSTRAINT fk_coupons_social
  FOREIGN KEY (social_submission_id) REFERENCES social_share_submissions (id);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  coupon_id      BIGINT UNSIGNED NOT NULL,
  payment_id     BIGINT UNSIGNED NULL,
  license_id     BIGINT UNSIGNED NULL,
  payer_email    VARCHAR(255) NOT NULL,
  payer_id       VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  amount_before  DECIMAL(10,2) NOT NULL,
  amount_after   DECIMAL(10,2) NOT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_redeem_coupon (coupon_id),
  KEY ix_redeem_payer_email (payer_email),
  CONSTRAINT fk_redeem_coupon FOREIGN KEY (coupon_id) REFERENCES coupons (id),
  CONSTRAINT fk_redeem_payment FOREIGN KEY (payment_id) REFERENCES payments (id),
  CONSTRAINT fk_redeem_license FOREIGN KEY (license_id) REFERENCES licenses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS invoices (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  number           VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payment_id       BIGINT UNSIGNED NULL,
  license_id       BIGINT UNSIGNED NULL,
  payer_email      VARCHAR(255) NOT NULL,
  plan             ENUM('monthly','lifetime') NOT NULL,
  currency         CHAR(3) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL DEFAULT 'USD',
  list_amount      DECIMAL(10,2) NOT NULL,
  discount_amount  DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  tax_amount       DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  total_amount     DECIMAL(10,2) NOT NULL,
  coupon_id        BIGINT UNSIGNED NULL,
  coupon_percent   TINYINT UNSIGNED NULL,
  provider         ENUM('paypal','stripe','manual') NOT NULL DEFAULT 'paypal',
  pdf_path         VARCHAR(512) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_invoices_number (number),
  KEY ix_invoices_payer (payer_email),
  KEY ix_invoices_license (license_id),
  CONSTRAINT fk_invoices_payment FOREIGN KEY (payment_id) REFERENCES payments (id),
  CONSTRAINT fk_invoices_license FOREIGN KEY (license_id) REFERENCES licenses (id),
  CONSTRAINT fk_invoices_coupon FOREIGN KEY (coupon_id) REFERENCES coupons (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
