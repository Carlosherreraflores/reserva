/**
 * Ejecuta este script UNA SOLA VEZ para generar el hash de tu contraseña:
 *
 *   node generar-hash.mjs TU_CONTRASEÑA_AQUI
 *
 * Luego copia el resultado y ponlo en .env como ADMIN_PASSWORD_HASH=...
 * Puedes borrar este archivo después.
 */

import bcrypt from 'bcryptjs';

const password = process.argv[2];

if (!password) {
  console.error('❌ Uso: node generar-hash.mjs TU_CONTRASEÑA');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\n✅ Hash generado:\n');
console.log(`ADMIN_PASSWORD_HASH=${hash}`);
console.log('\nCópialo en tu archivo .env\n');
