const admin = require('./functions/node_modules/firebase-admin');
const fs = require('fs');
const { spawn } = require('child_process');

async function deploy() {
  const saPath = 'seds-pakistan-service-account.json';
  if (!fs.existsSync(saPath)) {
    console.error(`Error: Service account file not found at ${saPath}`);
    process.exit(1);
  }
  
  const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  
  console.log('Initializing Firebase Admin...');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  console.log('Requesting access token...');
  const tokenResponse = await admin.credential.cert(serviceAccount).getAccessToken();
  const token = tokenResponse.access_token;
  
  console.log('Got access token. Starting Firebase Data-only deploy (Firestore Rules, Indexes, Storage)...');

  const logFile = fs.createWriteStream('deploy_firebase_config.log');
  
  // Deploying only Firestore (rules + indexes) and Storage (rules)
  // According to user request: index, storage and rules are for firebase
  const child = spawn('npx.cmd', ['firebase', 'deploy', '--only', 'firestore,storage', '--non-interactive', '--project', 'seds-pakistan', '--debug'], { 
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
    if (code === 0) {
        console.log('\nDeployment successful.');
    } else {
        console.error('\nDeployment failed.');
    }
  });
}

deploy().catch(console.error);
