const admin = require('./functions/node_modules/firebase-admin');
const fs = require('fs');
const { spawn } = require('child_process');

async function deploy() {
  const serviceAccount = JSON.parse(fs.readFileSync('e:\\SEDS WEBSITE UPDATED SHIT\\seds-pakistan-service-account.json', 'utf8'));
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const tokenResponse = await admin.credential.cert(serviceAccount).getAccessToken();
  const token = tokenResponse.access_token;
  
  console.log('Got access token from service account.');

  const logFile = fs.createWriteStream('deploy_token_final.txt');
  
  const child = spawn('npx.cmd', ['firebase', 'deploy', '--only', 'hosting,functions', '--non-interactive', '--project', 'seds-pakistan', '--token', token, '--debug'], { shell: true });

  child.stdout.on('data', (data) => {
    process.stdout.write(data);
    logFile.write(data);
  });

  child.stderr.on('data', (data) => {
    process.stderr.write(data);
    logFile.write(data);
  });

  child.on('close', (code) => {
    const msg = `\nChild process exited with code ${code}`;
    process.stdout.write(msg);
    logFile.write(msg);
    logFile.end();
  });
}

deploy().catch(console.error);
