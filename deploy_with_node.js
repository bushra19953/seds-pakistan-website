const { spawn } = require('child_process');
const fs = require('fs');

const logFile = fs.createWriteStream('deploy_node_log.txt');

const env = { ...process.env, GOOGLE_APPLICATION_CREDENTIALS: 'e:\\SEDS WEBSITE UPDATED SHIT\\seds-pakistan-service-account.json' };

const child = spawn('npx.cmd', ['firebase', 'deploy', '--only', 'hosting,functions', '--non-interactive', '--project', 'seds-pakistan', '--debug'], { env, shell: true });

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
