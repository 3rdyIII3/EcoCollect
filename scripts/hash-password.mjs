/**
 * Prints a bcrypt hash for a password, so you can paste it into db/migrate.mjs or
 * update a user by hand.
 *
 *   node scripts/hash-password.mjs "admin123"
 */
import bcrypt from 'bcryptjs';

const password = process.argv[2];

if (!password) {
  console.error('Usage: node scripts/hash-password.mjs "<password>"');
  process.exit(1);
}

// Same floor as api/auth/password.js. Length is the only rule that reliably helps;
// composition rules push people toward Password1!, which is easier to guess than a
// long passphrase.
if (password.length < 12) {
  console.warn('Warning: the app requires at least 12 characters.');
}
if (['admin123', 'password', 'password123', 'ecocollect'].includes(password.toLowerCase())) {
  console.warn('Warning: this is a default or well-known password and is blocked by the app.');
}

// Cost 12, matching api/auth/login.js and api/auth/password.js.
console.log(await bcrypt.hash(password, 12));
