#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function usage() {
  console.error('Usage: node scripts/sign-extension.mjs <zipPath> <privateKeyPemPath> [--out <sigFile>]');
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();

const zipPath = path.resolve(args[0]);
const keyPath = path.resolve(args[1]);
let outPath = '';
for (let i = 2; i < args.length; i += 1) {
  if (args[i] === '--out') outPath = args[i + 1] ? path.resolve(args[i + 1]) : '';
}

const zipBuf = fs.readFileSync(zipPath);
const privateKey = fs.readFileSync(keyPath, 'utf8');
const sig = crypto.sign(null, zipBuf, privateKey).toString('base64');

if (outPath) fs.writeFileSync(outPath, `${sig}\n`, 'utf8');
process.stdout.write(sig);
