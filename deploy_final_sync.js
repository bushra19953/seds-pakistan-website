const admin = require('firebase-admin');
const fs = require('fs');
const { spawnSync } = require('child_process');

async function deploy() {
  const saPath = 'e:\\SEDS WEBSITE UPDATED SHIT\\seds-pakistan-service-account.json';
  const serviceAccount = JSON.parse(fs.readFileSync(saPath, 'utf8'));
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const tokenResponse = await admin.credential.cert(serviceAccount).getAccessToken();
  const token = tokenResponse.access_token;
  
  console.log('Got access token from service account.');

  const result = spawnSync('npx.cmd', ['firebase', 'deploy', '--only', 'hosting,functions', '--non-interactive', '--project', 'seds-pakistan', '--token', token, '--debug'], { 
    shell: true, 
    encoding: 'utf8',
    env: { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: saPath }
  });

  fs.writeFileSync('deploy_final_log_sync.txt', result.stdout + '\n' + result.stderr);
  console.log(`Exited with code ${result.status}`);
}

deploy().catch(console.error);
