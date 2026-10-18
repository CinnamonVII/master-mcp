/**
 * Single source of truth for the version string.
 *
 * Kept in code rather than read from package.json so the compiled `dist`
 * build has no runtime dependency on the package layout.
 */
export const VERSION = '1.0.0';
