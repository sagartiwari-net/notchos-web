-- Store the coupon intent on a checkout so capture can redeem it after PayPal pays.

ALTER TABLE checkouts
  ADD COLUMN coupon_code VARCHAR(32) CHARACTER SET ascii COLLATE ascii_general_ci NULL
    AFTER currency;
