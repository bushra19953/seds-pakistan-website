const admin = require('firebase-admin');
const fs = require('fs');
const { spawn } = require('child_process');

const logFile = fs.createWriteStream('deploy_token_final.txt');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  logFile.write(line);
}

async function deploy() {
  try {
    const saPath = 'e:\\SEDS WEBSITE UPDATED SHIT\\seds-pakistan-service-account.json';
    log(`Reading service account from ${saPath}`);
    const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
    
    log('Initializing Firebase Admin...');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    log('Getting access token...');
    const tokenResponse = await admin.credential.cert(serviceAccount).getAccessToken();
    const token = tokenResponse.access_token;
    
    log('Got access token. Starting Firebase deploy...');

    const child = spawn('npx.cmd', ['firebase', 'deploy', '--only', 'hosting,functions', '--non-interactive', '--project', 'seds-pakistan', '--token', token, '--debug'], { 
      shell: true,
      env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: saPath }
    });

    child.stdout.on('data', (data) => {
      logFile.write(data);
    });

    child.stderr.on('data', (data) => {
      logFile.write(data);
    });

    child.on('error', (err) => {
      log(`Failed to start child process: ${err.message}`);
    });

    child.on('close', (code) => {
      log(`Child process exited with code ${code}`);
      logFile.end();
      process.exit(code);
    });
  } catch (err) {
    log(`Error: ${err.message}`);
    logFile.end();
    process.exit(1);
  }
}

deploy();
