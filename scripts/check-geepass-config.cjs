/**
 * Check Geepass configuration status
 * Run this while Chat2API is running to inspect current Geepass settings
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Read the encrypted store directly (requires decryption with electron-store)
const Store = require('electron-store');

const storagePath = path.join(os.homedir(), '.chat2api');
const store = new Store({
  name: 'data',
  cwd: storagePath,
  encryptionKey: 'chat2api-fixed-encryption-key-v1',
});

const config = store.get('config');
const geepass = config?.geepass || {};

console.log('\n=== Geepass Configuration Status ===\n');
console.log('Enabled:', geepass.enabled ?? false);
console.log('Token exists:', !!geepass.token);
if (geepass.token) {
  const masked = geepass.token.slice(0, 8) + '...' + geepass.token.slice(-8);
  console.log('Token (masked):', masked);
}
console.log('Type:', geepass.type ?? 'not set (defaults to 20110)');
console.log('\nGeepass will be active:', !!(geepass.enabled && geepass.token?.trim()));
console.log('');
