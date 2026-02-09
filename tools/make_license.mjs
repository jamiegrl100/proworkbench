import fs from 'node:fs';
import crypto from 'node:crypto';

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

const privPath = process.env.PROWORKBENCH_LICENSE_PRIVATE_KEY_PATH || 'keys/proworkbench_license_private.pem';
const priv = fs.readFileSync(privPath, 'utf8');

const sub = process.argv[2] || 'customer';
const expDays = Number(process.argv[3] || 365);
const exp = Math.floor(Date.now() / 1000) + expDays * 24 * 3600;

const payload = {
  iss: 'proworkbench',
  sub,
  tier: 'pro',
  features: ['one_click_tunnel', 'guided_diagnostics'],
  exp,
};

const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = crypto.sign(null, payloadBuf, priv);

console.log(`${b64url(payloadBuf)}.${b64url(sig)}`);
