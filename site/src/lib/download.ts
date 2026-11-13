/**
 * Public Mac app download.
 *
 * The file URL is a fixed name so emails, bookmarks, and old posts always get the
 * current build. Versioned DMGs may still exist on disk for archives; do not link them
 * from the site or mail.
 */
export const APP_VERSION = '0.8.37';

/**
 * Stable file on disk is always `/downloads/NotchOS.dmg`.
 * Query `v=` busts browser/HTTP caches when APP_VERSION changes (same path, new bytes).
 */
export const DMG_PATH = `/downloads/NotchOS.dmg?v=${APP_VERSION}`;

/** Suggested filename for the browser "Save as" dialog. */
export const DMG_FILENAME = 'NotchOS.dmg';
