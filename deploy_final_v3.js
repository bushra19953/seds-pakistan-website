const admin = require('./functions/node_modules/firebase-admin');
const fs = require('fs');
const { spawn } = require('child_process');

async function deploy() {
  const saPath = 'seds-pakistan-service-account.json';
  const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const tokenResponse = await admin.credential.cert(serviceAccount).getAccessToken();
  const token = tokenResponse.access_token;
  
  console.log('Got access token. Starting Firebase Hosting-only deploy with FIREBASE_TOKEN...');

  const logFile = fs.createWriteStream('deploy_token_final_v3.txt');
  
  const child = spawn('npx.cmd', ['firebase', 'deploy', '--only', 'hosting', '--non-interactive', '--project', 'seds-pakistan', '--debug'], { 
    shell: true,
    env: { ...process.env, FIREBASE_TOKEN: token, GOOGLE_APPLICATION_CREDENTIALS: saPath }
  });

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
