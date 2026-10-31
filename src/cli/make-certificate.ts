/**
 * Makes a private certificate on this machine, for those who prefer not to make it in the dashboard.
 * Nothing leaves the machine.
 *
 *   npx -p @narcisbodea/smstunnel-sdk smstunnel-make-certificate [name] [file]
 *
 * The password is read from the terminal, or from SMSTUNNEL_CERT_PASSWORD when there is no terminal.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { certificateFingerprint, createCertificate } from '../shared/sealed-crypto';

function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const input = process.stdin;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    let answer = '';
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          input.setRawMode(false);
          input.pause();
          input.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(answer);
          return;
        }
        if (char === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          answer = answer.slice(0, -1);
        } else {
          answer += char;
        }
      }
    };
    input.on('data', onData);
  });
}

async function readPassword(): Promise<string> {
  const fromEnvironment = process.env.SMSTUNNEL_CERT_PASSWORD;
  if (fromEnvironment) return fromEnvironment;
  if (!process.stdin.isTTY) {
    throw new Error('No terminal to ask for the password on. Set SMSTUNNEL_CERT_PASSWORD.');
  }
  const password = await askHidden('Certificate password (at least 12 characters): ');
  if ((await askHidden('Repeat the password: ')) !== password) {
    throw new Error("The two passwords don't match.");
  }
  return password;
}

async function main() {
  const [name = 'My certificate', file = 'smstunnel-certificate.json'] = process.argv.slice(2);
  if (existsSync(file)) {
    throw new Error(`${file} already exists. Replacing a certificate locks out your phone and your software.`);
  }
  const { file: certificate } = createCertificate(name, await readPassword());
  writeFileSync(file, JSON.stringify(certificate), { flag: 'wx' });
  console.log(`Saved ${file}`);
  console.log(`Fingerprint: ${certificateFingerprint(certificate.id)}`);
  console.log('');
  console.log('On your phone: SMSTunnel app, Settings, Private certificate, then paste the contents of the file.');
  console.log('To get a QR code instead: dashboard, Apps, Maximum privacy, "I already have one".');
  console.log("Your software needs the file and the password. We can't recover either.");
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
